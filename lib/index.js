/**
 * dsh-session-delete — host half.
 *
 * DSH can archive a Session but never deletes one: the workspace registry's
 * Delete only unregisters a Workspace ("its sessions will appear under
 * Ungrouped") and the JSONL persistence seam documents "Nothing deletes
 * session files". This plugin closes that gap: it serves the
 * /api/dsh-session-delete route family over the shared loopback trust fence and
 * performs a real removal —
 *
 *   1. refuse while the Session is loaded in memory (a live writer owns it),
 *   2. detach it from every Workspace through the registry entity API,
 *   3. remove <sessionsRoot>/<projectKey>/<sessionId> recursively,
 *   4. drop the session_projcache record (best effort),
 *   5. emit `api-session/removed` so every open client drops the row.
 *
 * The browser half (./client) contributes the "Delete session" row to
 * `sidebar.workspaces.session.menu.item` and asks for a confirmation first.
 */
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promises as fsp } from "node:fs";

/** Stable cordis plugin name. */
const name = "session-delete";
/** Services required before the route family can mount. */
const inject = ["webServer"];

/** Route paths (the client bundle mirrors these literals). */
const ROUTES = {
  info: "/api/dsh-session-delete/info",
  remove: "/api/dsh-session-delete/delete"
};

/** A Session id is a `session-…` slug used verbatim as one directory name. */
const SESSION_ID_PATTERN = /^session-[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Hard cap so a hostile id cannot become a path-length problem. */
const MAX_SESSION_ID_LENGTH = 200;
/** Refuse request bodies larger than this. */
const MAX_BODY_BYTES = 64 * 1024;

//#region loopback trust fence
/**
 * IPv4 127/8 predicate (four decimal octets, first == 127).
 * @param v4 - candidate dotted-quad address.
 * @returns whether the address is in 127/8.
 */
function isIPv4Loopback(v4) {
  const parts = v4.split(".");
  return (
    parts.length === 4 &&
    parts[0] === "127" &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

/**
 * Whether a socket remote address names the loopback range (127/8, ::1, IPv4-mapped).
 * @param address - `socket.remoteAddress`, possibly undefined.
 * @returns whether the peer is local.
 */
function isLoopbackAddress(address) {
  if (address === undefined) return false;
  const normalized = address.toLowerCase();
  if (normalized === "::1") return true;
  if (normalized.startsWith("::ffff:")) return isIPv4Loopback(normalized.slice(7));
  return isIPv4Loopback(normalized);
}

/**
 * Whether a normalized URL hostname names the loopback authority (localhost, [::1], 127/8).
 * @param hostname - parsed hostname.
 * @returns whether the hostname is loopback.
 */
function isLoopbackHostname(hostname) {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  return isIPv4Loopback(hostname);
}

/**
 * Request-level trust fence: a loopback socket address AND a loopback Host
 * header, plus browser same-origin markers. The socket address is
 * authoritative; X-Forwarded-For is never trusted.
 * @param request - the incoming HTTP request.
 * @returns whether the request may enter the route family.
 */
function isLoopbackRequest(request) {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false;
  const host = request.headers.host;
  if (typeof host !== "string") return false;
  let hostUrl;
  try {
    hostUrl = new URL("http://" + host);
  } catch {
    return false;
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false;
  if (request.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}
//#endregion

//#region http helpers
/**
 * Write one JSON response.
 * @param res - the server response.
 * @param status - HTTP status code.
 * @param payload - JSON-serializable body.
 */
function writeJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-length", Buffer.byteLength(body));
  res.end(body);
}

/**
 * Enforce the fence and the method before a handler runs.
 * @param req - the incoming HTTP request.
 * @param res - the server response.
 * @returns whether the handler should continue.
 */
function guard(req, res) {
  if (!isLoopbackRequest(req)) {
    writeJson(res, 403, { ok: false, error: { code: "forbidden", message: "forbidden" } });
    return false;
  }
  if (req.method !== "POST") {
    writeJson(res, 405, {
      ok: false,
      error: { code: "method-not-allowed", message: "use POST" }
    });
    return false;
  }
  return true;
}

/**
 * Read and parse a bounded JSON request body.
 * @param req - the incoming HTTP request.
 * @returns the parsed body ({} for an empty body).
 */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text === "") return {};
  const parsed = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("request body must be a JSON object");
  }
  return parsed;
}

/**
 * Render an unknown thrown value as a message.
 * @param error - the thrown value.
 * @returns a human-readable message.
 */
function message(error) {
  return error instanceof Error ? error.message : String(error);
}
//#endregion

//#region session locations
/**
 * The Session root in play. The live persistence service is authoritative;
 * `$DSH_HOME/sessions` is consulted only when that service is unreachable, so a
 * mismatched DSH_HOME can never make one deletion span two unrelated homes.
 * @param ctx - host plugin context.
 * @returns a single-element root list.
 */
function sessionRoots(ctx) {
  try {
    const root = ctx.sessionPersistence?.root;
    if (typeof root === "string" && root.trim() !== "") return [root];
  } catch {
    /* service not reachable — fall back below */
  }
  const home = typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME.trim() !== ""
    ? process.env.DSH_HOME
    : join(homedir(), ".dsh");
  return [join(home, "sessions")];
}

/**
 * Every existing `<root>/<projectKey>/<sessionId>` directory for one Session.
 *
 * The project key is a lossy encoding of the Session's cwd, so it cannot be
 * inverted; the root is scanned instead. The persistence backend re-reads the
 * directory tree on every `list()`, so a removal needs no cache invalidation.
 * @param root - a Session root.
 * @param sessionId - the Session id (already validated).
 * @returns the absolute directory paths that exist.
 */
async function listSessionDirs(root, sessionId) {
  const found = [];
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(root, entry.name, sessionId);
    try {
      const info = await fsp.stat(candidate);
      if (info.isDirectory()) found.push(candidate);
    } catch {
      /* not in this project */
    }
  }
  return found;
}

/**
 * Whether `target` is a strict descendant of `root`.
 * @param root - the containing directory.
 * @param target - the candidate path.
 * @returns whether target is inside root.
 */
function isInside(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Whether a Session id is safe to use as a single path segment.
 * @param sessionId - the untrusted id.
 * @returns whether the id may be used.
 */
function isSafeSessionId(sessionId) {
  if (typeof sessionId !== "string") return false;
  if (sessionId.length === 0 || sessionId.length > MAX_SESSION_ID_LENGTH) return false;
  if (!SESSION_ID_PATTERN.test(sessionId)) return false;
  return !sessionId.includes("..");
}
//#endregion

//#region host state probes
/**
 * The live (loaded in memory) Session for an id, when there is one.
 * @param ctx - host plugin context.
 * @param sessionId - the Session id.
 * @returns the in-memory Session, or undefined.
 */
function liveSession(ctx, sessionId) {
  try {
    const sessions = ctx.sessions;
    if (sessions === undefined || sessions === null) return undefined;
    if (typeof sessions.get !== "function") return undefined;
    return sessions.get(sessionId);
  } catch {
    return undefined;
  }
}

/**
 * Ids of every Session currently held in memory.
 * @param ctx - host plugin context.
 * @returns the live Session ids ([] when the service is unreachable).
 */
function liveSessionIds(ctx) {
  try {
    const sessions = ctx.sessions;
    if (sessions === undefined || sessions === null) return [];
    if (typeof sessions.list !== "function") return [];
    const listed = sessions.list();
    if (!Array.isArray(listed)) return [];
    return listed.map((session) => session?.id).filter((id) => typeof id === "string");
  } catch {
    return [];
  }
}
//#endregion

//#region deletion
/**
 * Detach a Session from every Workspace through the registry entity API, so
 * the persisted `sessionIds` no longer reference a deleted Session. Failures are
 * collected as warnings: the on-disk removal is what the user asked for.
 * @param ctx - host plugin context.
 * @param sessionId - the Session id.
 * @param warnings - accumulator for non-fatal problems.
 */
async function detachFromWorkspaces(ctx, sessionId, warnings) {
  let registry;
  try {
    registry = ctx.workspaceRegistry;
  } catch (error) {
    warnings.push(`workspaceRegistry 不可用: ${message(error)}`);
    return;
  }
  if (registry === undefined || registry === null) {
    warnings.push("workspaceRegistry 不可用，已跳过工作区解绑");
    return;
  }
  let entries = [];
  try {
    entries = typeof registry.list === "function" ? registry.list() : [];
  } catch (error) {
    warnings.push(`读取工作区列表失败: ${message(error)}`);
  }
  for (const entry of Array.isArray(entries) ? entries : []) {
    const entity =
      entry !== null && typeof entry === "object" && typeof entry.detachSession === "function"
        ? entry
        : typeof registry.get === "function"
          ? registry.get(entry?.id)
          : undefined;
    if (entity === undefined || entity === null || typeof entity.detachSession !== "function") continue;
    try {
      await entity.detachSession(sessionId);
    } catch (error) {
      warnings.push(`工作区 ${entry?.title ?? entry?.id ?? "?"} 解绑失败: ${message(error)}`);
    }
  }
  if (typeof registry.unpinSession === "function") {
    try {
      await registry.unpinSession(sessionId);
    } catch (error) {
      warnings.push(`取消置顶失败: ${message(error)}`);
    }
  }
}

/**
 * Drop the session_projcache record for a Session (best effort). A leftover
 * record is only read when a Session header exists, but leaving it behind would
 * make a same-id Session inherit stale projections.
 * @param sessionId - the Session id.
 * @param roots - the Session roots in play (their parents are DSH homes).
 * @param warnings - accumulator for non-fatal problems.
 */
async function removeProjectionCaches(sessionId, roots, warnings) {
  // `storages/` sits beside `sessions/` under the DSH home, so a root's parent
  // is the only home worth touching: guessing at $DSH_HOME or ~/.dsh could reach
  // an unrelated profile.
  const homes = new Set(roots.map((root) => dirname(root)));
  for (const home of homes) {
    const file = join(home, "storages", "session_projcache", "sessions", `${sessionId}.json`);
    try {
      await fsp.rm(file, { force: true });
    } catch (error) {
      warnings.push(`投影缓存清理失败 (${file}): ${message(error)}`);
    }
  }
}

/**
 * Permanently delete one Session.
 * @param ctx - host plugin context.
 * @param sessionId - the untrusted Session id from the request body.
 * @returns the HTTP status and JSON body to answer with.
 */
async function deleteSession(ctx, sessionId) {
  if (!isSafeSessionId(sessionId)) {
    return {
      status: 400,
      body: { ok: false, error: { code: "bad-request", message: `非法的会话 id: ${String(sessionId)}` } }
    };
  }

  const roots = sessionRoots(ctx);
  const targets = [];
  for (const root of roots) {
    for (const dir of await listSessionDirs(root, sessionId)) targets.push({ root, dir });
  }
  if (targets.length === 0) {
    return {
      status: 404,
      body: {
        ok: false,
        error: {
          code: "not-found",
          message: `没有找到会话 ${sessionId} 的日志目录（可能已被删除）`,
          value: { sessionRoots: roots }
        }
      }
    };
  }

  if (liveSession(ctx, sessionId) !== undefined) {
    return {
      status: 409,
      body: {
        ok: false,
        error: {
          code: "session-active",
          message: "该会话当前处于打开/运行状态，请先切换到其他会话，再回来删除。"
        }
      }
    };
  }

  const warnings = [];
  await detachFromWorkspaces(ctx, sessionId, warnings);

  const removed = [];
  const failed = [];
  for (const { root, dir } of targets) {
    if (!isInside(root, dir)) {
      failed.push({ dir, message: "路径不在会话根目录内，已跳过" });
      continue;
    }
    try {
      await fsp.rm(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch (error) {
      failed.push({ dir, message: message(error) });
    }
  }

  if (failed.length > 0) {
    return {
      status: 500,
      body: {
        ok: false,
        error: {
          code: "delete-failed",
          message: `部分会话文件删除失败：${failed.map((entry) => entry.message).join("; ")}`
        },
        value: { sessionId, removedDirectories: removed, failed, warnings }
      }
    };
  }

  await removeProjectionCaches(sessionId, roots, warnings);

  try {
    ctx.emit("api-session/removed", sessionId);
  } catch (error) {
    warnings.push(`广播会话移除事件失败: ${message(error)}`);
  }

  return {
    status: 200,
    body: { ok: true, value: { sessionId, removedDirectories: removed, warnings } }
  };
}
//#endregion

//#region routes
/**
 * Build the /api/dsh-session-delete route family.
 * @param ctx - host plugin context carrying webServer/sessionPersistence/workspaceRegistry.
 * @returns the route list for ctx.webServer.register.
 */
function makeRoutes(ctx) {
  return [
    {
      kind: "exact",
      path: ROUTES.info,
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        try {
          const roots = sessionRoots(ctx);
          writeJson(res, 200, {
            ok: true,
            value: { sessionRoots: roots, liveSessionIds: liveSessionIds(ctx) }
          });
        } catch (error) {
          writeJson(res, 500, { ok: false, error: { code: "internal", message: message(error) } });
        }
      }
    },
    {
      kind: "exact",
      path: ROUTES.remove,
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        let payload;
        try {
          payload = await readJsonBody(req);
        } catch (error) {
          writeJson(res, 400, { ok: false, error: { code: "bad-request", message: message(error) } });
          return;
        }
        try {
          const result = await deleteSession(ctx, payload.sessionId);
          writeJson(res, result.status, result.body);
        } catch (error) {
          ctx.logger?.warn?.(error);
          writeJson(res, 500, { ok: false, error: { code: "internal", message: message(error) } });
        }
      }
    }
  ];
}

/**
 * Mount the route family.
 * @param ctx - host plugin context carrying webServer.
 */
function apply(ctx) {
  const routes = makeRoutes(ctx);
  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.webServer.register(route));
    return () => {
      for (const dispose of disposers.splice(0)) dispose();
    };
  }, "dsh-session-delete: routes");
}
//#endregion

export { ROUTES, apply, inject, name };
