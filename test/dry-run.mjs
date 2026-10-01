/**
 * Offline dry run for the host half: builds a throwaway sessions root and a
 * fake cordis context, then drives the registered route handlers directly.
 * Run:  $env:ELECTRON_RUN_AS_NODE='1'; & '<exe>' test\dry-run.mjs
 * (or plain `node test\dry-run.mjs`).
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";

const SESSION_ID = "session-4148d392-311d-4705-a6b2-37b55c72ec9d";
const OTHER_ID = "session-62b55e9a-3032-4932-b5b6-6c09b249484f";

const home = mkdtempSync(join(tmpdir(), "dsh-session-delete-"));
const root = join(home, "sessions");
const project = join(root, "--C-Users-ln-Documents-fake--");
const sessionDir = join(project, SESSION_ID);
const otherDir = join(project, OTHER_ID);
const cacheDir = join(home, "storages", "session_projcache", "sessions");

mkdirSync(sessionDir, { recursive: true });
mkdirSync(otherDir, { recursive: true });
mkdirSync(cacheDir, { recursive: true });
writeFileSync(join(sessionDir, "session.v4.jsonl.zstd"), "log");
writeFileSync(join(otherDir, "session.v4.jsonl.zstd"), "keep me");
writeFileSync(join(cacheDir, `${SESSION_ID}.json`), "{}");
writeFileSync(join(cacheDir, `${OTHER_ID}.json`), "{}");

// Point the DSH_HOME fallback at the throwaway home too, so this harness can
// never reach the real profile even if the persistence service is stubbed out.
process.env.DSH_HOME = home;

const calls = { detached: [], unpinned: [], emitted: [] };
const workspace = {
  id: "ea243f60-aa4c-455b-8822-b4629a858ba1",
  title: "DSHWorkSpace",
  detachSession: async (id) => calls.detached.push(id)
};

const routes = [];
const ctx = {
  sessionPersistence: { root },
  sessions: {
    get: () => undefined,
    list: () => []
  },
  workspaceRegistry: {
    list: () => [workspace],
    get: (id) => (id === workspace.id ? workspace : undefined),
    unpinSession: async (id) => calls.unpinned.push(id)
  },
  emit: (event, payload) => calls.emitted.push([event, payload]),
  logger: { warn: (error) => console.warn("[warn]", error) },
  webServer: { register: (route) => (routes.push(route), () => {}) },
  effect: (callback) => callback()
};

apply(ctx);
console.log("registered routes:", routes.map((route) => `${route.kind} ${route.path}`).join(", "));

function fakeRequest(body) {
  const text = JSON.stringify(body);
  const chunks = [Buffer.from(text, "utf8")];
  return {
    method: "POST",
    url: "/api/dsh-session-delete/delete",
    socket: { remoteAddress: "127.0.0.1" },
    headers: { host: "127.0.0.1:19387", "sec-fetch-site": "same-origin" },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    }
  };
}

function fakeResponse() {
  const captured = { status: 0, body: undefined };
  return {
    captured,
    setHeader() {},
    set statusCode(value) {
      captured.status = value;
    },
    get statusCode() {
      return captured.status;
    },
    end(text) {
      captured.body = JSON.parse(text);
    }
  };
}

async function callRoute(path, body) {
  const route = routes.find((candidate) => candidate.path === path);
  if (route === undefined) throw new Error(`no route ${path}`);
  const request = fakeRequest(body);
  const response = fakeResponse();
  await route.handler(request, response);
  return { status: response.captured.status, body: response.captured.body };
}

const failures = [];
const check = (label, condition) => {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}`);
  if (!condition) failures.push(label);
};

// 1. info
const info = await callRoute("/api/dsh-session-delete/info", {});
check("info returns 200 with the live session root", info.status === 200 && info.body.value.sessionRoots[0] === root);

// 2. bad id
const bad = await callRoute("/api/dsh-session-delete/delete", { sessionId: "../../evil" });
check("traversal id is rejected with 400", bad.status === 400 && bad.body.error.code === "bad-request");

// 3. unknown id
const missing = await callRoute("/api/dsh-session-delete/delete", { sessionId: "session-does-not-exist" });
check("unknown id returns 404", missing.status === 404 && missing.body.error.code === "not-found");

// 4. foreign host is fenced
const route = routes.find((candidate) => candidate.path === "/api/dsh-session-delete/delete");
const foreignReq = fakeRequest({ sessionId: SESSION_ID });
foreignReq.headers.host = "evil.example.com";
const foreignRes = fakeResponse();
await route.handler(foreignReq, foreignRes);
check("non-loopback Host is refused with 403", foreignRes.captured.status === 403);

// 5. live session is refused while a fake in-memory session exists
ctx.sessions.get = (id) => (id === SESSION_ID ? { id } : undefined);
const active = await callRoute("/api/dsh-session-delete/delete", { sessionId: SESSION_ID });
check("live session returns 409", active.status === 409 && active.body.error.code === "session-active");
ctx.sessions.get = () => undefined;

// 6. the real delete
const done = await callRoute("/api/dsh-session-delete/delete", { sessionId: SESSION_ID });
if (done.status !== 200) console.log("delete response:", JSON.stringify(done, null, 2));
check("delete returns 200", done.status === 200);
check("session directory is gone", !existsSync(sessionDir));
check("sibling session directory is untouched", existsSync(join(otherDir, "session.v4.jsonl.zstd")));
check("projection cache record is gone", !existsSync(join(cacheDir, `${SESSION_ID}.json`)));
check("sibling projection cache is untouched", existsSync(join(cacheDir, `${OTHER_ID}.json`)));
check("workspace detachSession was called", calls.detached.includes(SESSION_ID));
check("unpinSession was called", calls.unpinned.includes(SESSION_ID));
check(
  "api-session/removed was emitted",
  calls.emitted.some(([event, payload]) => event === "api-session/removed" && payload === SESSION_ID)
);

// 7. second delete is a clean 404
const again = await callRoute("/api/dsh-session-delete/delete", { sessionId: SESSION_ID });
check("second delete returns 404", again.status === 404);

rmSync(home, { recursive: true, force: true });
console.log(failures.length === 0 ? "\nALL CHECKS PASSED" : `\n${failures.length} CHECK(S) FAILED`);
process.exit(failures.length === 0 ? 0 : 1);
