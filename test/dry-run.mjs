/**
 * Offline dry run for the host half: builds a throwaway sessions root and a
 * fake cordis context, then drives the registered route handlers directly.
 * Run:  $env:ELECTRON_RUN_AS_NODE='1'; & '<exe>' test\dry-run.mjs
 * (or plain `node test\dry-run.mjs`).
 *
 * Caveat learned the hard way: a fake context cannot prove that the real host
 * resolves `ctx.sessions` or dispatches `workspace/session-activity`. Always
 * follow this up against a restarted DSH with `POST /api/dsh-session-delete/info`,
 * whose `services` and `activityWaterfall` fields report what really resolved.
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";

const SESSION_ID = "session-4148d392-311d-4705-a6b2-37b55c72ec9d";
const OTHER_ID = "session-62b55e9a-3032-4932-b5b6-6c09b249484f";
const STUBBORN_ID = "session-20bac24a-7276-4161-b3b4-71be800072d6";
const HELD_ID = "session-9f4c1a77-2c60-4f0e-9a1f-77b0c2d5e310";
/** Lower bound of one resurrection verification round (host RESURRECTION_DELAY_MS). */
const RESURRECTION_ROUNDS_MIN_MS = 300;
/** Lower bound of a stop that has to be waited out (host ACTIVITY_SETTLE_ROUNDS * _DELAY_MS). */
const ACTIVITY_SETTLE_MIN_MS = 2500;

const home = mkdtempSync(join(tmpdir(), "dsh-session-delete-"));
const root = join(home, "sessions");
const project = join(root, "--C-Users-ln-Documents-fake--");
const sessionDir = join(project, SESSION_ID);
const otherDir = join(project, OTHER_ID);
const stubbornDir = join(project, STUBBORN_ID);
const heldDir = join(project, HELD_ID);
const cacheDir = join(home, "storages", "session_projcache", "sessions");

for (const dir of [sessionDir, otherDir, stubbornDir, heldDir]) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session.v4.jsonl.zstd"), "log");
}
mkdirSync(cacheDir, { recursive: true });
writeFileSync(join(cacheDir, `${SESSION_ID}.json`), "{}");
writeFileSync(join(cacheDir, `${OTHER_ID}.json`), "{}");

// Point the DSH_HOME fallback at the throwaway home too, so this harness can
// never reach the real profile even if the persistence service is stubbed out.
process.env.DSH_HOME = home;

const calls = { detached: [], unpinned: [], emitted: [], stopped: [], asked: [] };
const workspace = {
  id: "ea243f60-aa4c-455b-8822-b4629a858ba1",
  title: "DSHWorkSpace",
  detachSession: async (id) => calls.detached.push(id)
};

/** Sessions the fake in-memory store claims to hold. */
const loaded = new Set();
/**
 * Session id → the activity entries `workspace/session-activity` reports. This is
 * the ONLY liveness signal the host half may trust: a live Agent exists for any
 * Session a window has open, busy or not.
 */
const activity = new Map();
/** Sessions whose `workspace/session-stop` actually stops the reported work. */
const stopsSettle = new Set();
/**
 * Sessions the fake persistence layer still tracks as created-but-unmaterialized.
 * Those are listed by `sessionPersistence.list()` even with no file on disk, so
 * they are a second way a deleted Session can survive as a sidebar row.
 */
const pending = new Set();

const routes = [];
const ctx = {
  sessionPersistence: {
    root,
    hasPendingSession: (id) => pending.has(id)
  },
  sessions: {
    get: (id) => (loaded.has(id) ? { id } : undefined),
    list: () => [...loaded].map((id) => ({ id }))
  },
  workspaceRegistry: {
    list: () => [workspace],
    get: (id) => (id === workspace.id ? workspace : undefined),
    unpinSession: async (id) => calls.unpinned.push(id)
  },
  waterfall: async (event, payload, fallback) => {
    calls.asked.push([event, payload?.sessionId]);
    const reported = activity.get(payload?.sessionId);
    if (reported !== undefined) return reported;
    return await fallback();
  },
  parallel: async (event, payload) => {
    calls.stopped.push([event, payload]);
    if (event === "workspace/session-stop" && stopsSettle.has(payload.sessionId)) activity.delete(payload.sessionId);
  },
  emit: (event, payload) => calls.emitted.push([event, payload]),
  logger: { warn: (error) => console.warn("[warn]", error) },
  webServer: { register: (route) => (routes.push(route), () => {}) },
  effect: (callback) => callback()
};

apply(ctx);
console.log("registered routes:", routes.map((route) => `${route.kind} ${route.path}`).join(", "));

function fakeRequest(body, url = "/api/dsh-session-delete/delete") {
  const text = JSON.stringify(body);
  const chunks = [Buffer.from(text, "utf8")];
  return {
    method: "POST",
    url,
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

async function callRoute(path, body, url) {
  const route = routes.find((candidate) => candidate.path === path);
  if (route === undefined) throw new Error(`no route ${path}`);
  const request = fakeRequest(body, url ?? path);
  const response = fakeResponse();
  await route.handler(request, response);
  return { status: response.captured.status, body: response.captured.body };
}

const failures = [];
const check = (label, condition) => {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}`);
  if (!condition) failures.push(label);
};

/** Whether a warning list carries one code. Warnings are `{code, params, message}`. */
const warningsHave = (warnings, code) =>
  Array.isArray(warnings) && warnings.some((entry) => entry?.code === code);

// 1. info reports the roots AND what actually resolved. A `false` here is the
//    signature of the original bug: the liveness question could not be asked at
//    all, so "running" silently degraded to "never running".
activity.set(SESSION_ID, [{ kind: "turn", items: [{ id: "t1" }] }]);
const info = await callRoute("/api/dsh-session-delete/info", {});
check("info returns 200 with the live session root", info.status === 200 && info.body.value.sessionRoots[0] === root);
check(
  "info reports every service as resolved",
  info.body.value.services.sessions === true &&
    info.body.value.services.workspaceRegistry === true &&
    info.body.value.services.sessionPersistence === true
);
check("info reports the activity waterfall as available", info.body.value.activityWaterfall === true);
check(
  "info reports the loaded Session it holds",
  Array.isArray(info.body.value.liveSessionIds) && info.body.value.liveSessionIds.length === 0
);

// 2. `?sessionId=` answers the liveness question for one Session, which is how a
//    refused delete is diagnosed without guessing.
const probed = await callRoute("/api/dsh-session-delete/info", {}, `/api/dsh-session-delete/info?sessionId=${SESSION_ID}`);
check(
  "info?sessionId= reports the activity it sees",
  probed.body.value.activity?.asked === true && probed.body.value.activity.summary === "turn×1"
);
const probedIdle = await callRoute("/api/dsh-session-delete/info", {}, `/api/dsh-session-delete/info?sessionId=${OTHER_ID}`);
check("info?sessionId= reports an idle Session as idle", probedIdle.body.value.activity?.summary === "");

// 3. bad id
const bad = await callRoute("/api/dsh-session-delete/delete", { sessionId: "../../evil" });
check("traversal id is rejected with 400", bad.status === 400 && bad.body.error.code === "bad-request");

// 4. unknown id
const missing = await callRoute("/api/dsh-session-delete/delete", { sessionId: "session-does-not-exist" });
check("unknown id returns 404", missing.status === 404 && missing.body.error.code === "not-found");

// 5. foreign host is fenced
const route = routes.find((candidate) => candidate.path === "/api/dsh-session-delete/delete");
const foreignReq = fakeRequest({ sessionId: SESSION_ID });
foreignReq.headers.host = "evil.example.com";
const foreignRes = fakeResponse();
await route.handler(foreignReq, foreignRes);
check("non-loopback Host is refused with 403", foreignRes.captured.status === 403);

// 6. Running work is stopped and then deleted — the case that used to be refused
//    outright because a merely-loaded Agent was mistaken for a busy one. The
//    waterfall reports work until `session-stop` lands, so this also proves the
//    answer is re-polled instead of assumed.
activity.set(SESSION_ID, [{ kind: "turn", items: [{ id: "t1" }] }]);
stopsSettle.add(SESSION_ID);
loaded.add(SESSION_ID);
const startedAt = Date.now();
const done = await callRoute("/api/dsh-session-delete/delete", { sessionId: SESSION_ID });
const elapsed = Date.now() - startedAt;
if (done.status !== 200) console.log("delete response:", JSON.stringify(done, null, 2));
check("a Session with stoppable work still deletes with 200", done.status === 200);
check(
  "the running Session was asked to stop first",
  calls.stopped.some(([event, payload]) => event === "workspace/session-stop" && payload.sessionId === SESSION_ID)
);
check(
  "the activity question was re-asked until it settled",
  calls.asked.filter(([event, id]) => event === "workspace/session-activity" && id === SESSION_ID).length >= 2
);
// A Session still resident in memory can flush its header back to disk a moment
// after the removal, which is exactly how a deleted conversation reappeared on
// the next start. When one was resident, a second look is therefore mandatory
// rather than conditional on the first sweep having caught anything. The
// concurrent-writer *outcome* is inherently racy to stage here, so this asserts
// the verification pass really runs.
check("a resident Session forces a delayed verification pass", elapsed >= RESURRECTION_ROUNDS_MIN_MS);
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
loaded.delete(SESSION_ID);
stopsSettle.delete(SESSION_ID);

// 7. second delete is a clean 404
const again = await callRoute("/api/dsh-session-delete/delete", { sessionId: SESSION_ID });
check("second delete returns 404", again.status === 404);

// 8. Work that will not settle is refused with a precise message — and only
//    after stopping was actually attempted, so the user is never told to go
//    stop something themselves that they have no way to stop. STUBBORN_ID is
//    absent from `stopsSettle`, so `session-stop` never clears it.
activity.set(STUBBORN_ID, [{ kind: "turn", items: [{ id: "t1" }] }]);
const stubbornStarted = Date.now();
const stubborn = await callRoute("/api/dsh-session-delete/delete", { sessionId: STUBBORN_ID });
const stubbornElapsed = Date.now() - stubbornStarted;
if (stubborn.status === 200) console.log("stubborn response:", JSON.stringify(stubborn, null, 2));
check(
  "work that never settles is refused with 409 session-active",
  stubborn.status === 409 && stubborn.body.error.code === "session-active"
);
check("the refusal names what is still running", stubborn.body.error?.message?.includes("turn×1") === true);
check(
  "the refusal also carries the values the dialog localizes with",
  stubborn.body.error?.params?.work === "turn×1" && stubborn.body.error.params.seconds === 3
);
check("the stop was still attempted before refusing", stubbornElapsed >= ACTIVITY_SETTLE_MIN_MS);
check("the refused delete left the log directory alone", existsSync(join(stubbornDir, "session.v4.jsonl.zstd")));

// 9. An idle Session deletes fast, with no verification pass and no stop.
const quickStart = Date.now();
const quick = await callRoute("/api/dsh-session-delete/delete", { sessionId: OTHER_ID });
const quickElapsed = Date.now() - quickStart;
check("an idle Session deletes with 200", quick.status === 200);
check("an idle Session skips the verification pass", quickElapsed < RESURRECTION_ROUNDS_MIN_MS);
check("the sibling log really is gone", !existsSync(otherDir));

// 10. Without the waterfall the liveness question cannot be asked at all. That
//     must degrade to "proceed, and say so" rather than "refuse everything" —
//     over-refusing an idle session is the bug this whole revision fixes.
delete ctx.waterfall;
const blind = await callRoute("/api/dsh-session-delete/delete", { sessionId: STUBBORN_ID });
check("a missing activity waterfall still deletes with 200", blind.status === 200);
check(
  "a missing activity waterfall is reported as a warning",
  Array.isArray(blind.body.value?.warnings) && warningsHave(blind.body.value.warnings, "activity-unavailable")
);
check(
  "every warning carries a locale-neutral code and an English fallback",
  blind.body.value.warnings.every(
    (entry) => typeof entry?.code === "string" && entry.code !== "" && typeof entry.message === "string" && entry.message !== ""
  )
);
check(
  "no warning ships prose in a hard-coded language",
  blind.body.value.warnings.every((entry) => !/[\u4e00-\u9fff]/u.test(entry.message))
);
const blindInfo = await callRoute("/api/dsh-session-delete/info", {});
check("info reports the waterfall as unavailable", blindInfo.body.value.activityWaterfall === false);

// 11. The files can be gone while the Session is still listed. The corpus is
//     live-preferred and the persistence layer also lists sessions this process
//     created but never materialized, so a row can outlive its log — that is the
//     "deleted session is stranded under Ungrouped until restart" report. The
//     deletion must still succeed, but it has to say who is holding the row
//     instead of reporting a clean success.
pending.add(HELD_ID);
const held = await callRoute("/api/dsh-session-delete/delete", { sessionId: HELD_ID });
check("a Session held by the persistence layer still deletes with 200", held.status === 200);
check("its log directory is really gone", !existsSync(join(heldDir, "session.v4.jsonl.zstd")));
check(
  "the surviving list entry is reported as a warning",
  Array.isArray(held.body.value?.warnings) && warningsHave(held.body.value.warnings, "corpus-held-pending")
);
const heldInfo = await callRoute("/api/dsh-session-delete/info", {}, `?sessionId=${HELD_ID}`);
check("info answers the corpus question for one id", heldInfo.body.value.corpus?.pending === true);
check("info reports it as still listed after the files are gone", heldInfo.body.value.corpus?.listed === null || heldInfo.body.value.corpus?.listed === false);
pending.delete(HELD_ID);
const freedInfo = await callRoute("/api/dsh-session-delete/info", {}, `?sessionId=${HELD_ID}`);
check("a Session nothing holds reports no pending entry", freedInfo.body.value.corpus?.pending === false);

// 12. The other holder is the host's own in-memory store, and its consequence is
//     different from the persistence layer's: that instance can write the log
//     back, so the note has to say the Session may return after a restart rather
//     than merely that the row lags behind.
mkdirSync(heldDir, { recursive: true });
writeFileSync(join(heldDir, "session.v4.jsonl.zstd"), "log");
loaded.add(HELD_ID);
const resident = await callRoute("/api/dsh-session-delete/delete", { sessionId: HELD_ID });
check("a Session resident in the host store still deletes with 200", resident.status === 200);
check(
  "the resident Session was asked to stop first",
  calls.stopped.some(([event, payload]) => event === "workspace/session-stop" && payload.sessionId === HELD_ID)
);
check(
  "the warning distinguishes a resident Session from a pending one",
  warningsHave(resident.body.value.warnings, "corpus-held-live")
);
check(
  "a resident Session is not reported as a pending one",
  warningsHave(resident.body.value.warnings, "corpus-held-pending") === false
);
loaded.delete(HELD_ID);

// A clean deletion must not carry the corpus warning; otherwise the warning is
// noise and the user learns to ignore it.
const quiet = await callRoute("/api/dsh-session-delete/info", {}, `?sessionId=${OTHER_ID}`);
check("a Session that is gone reports no live or pending holder", quiet.body.value.corpus?.live === false && quiet.body.value.corpus?.pending === false);

rmSync(home, { recursive: true, force: true });
console.log(failures.length === 0 ? "\nALL CHECKS PASSED" : `\n${failures.length} CHECK(S) FAILED`);
process.exit(failures.length === 0 ? 0 : 1);
