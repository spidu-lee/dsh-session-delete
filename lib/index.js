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
 *   1. ask `workspace/session-activity` what still runs for the Session, ask
 *      those owners to stop through `workspace/session-stop` — the same fan-out
 *      `archive` runs for `stopActivity` — and re-poll until it settles,
 *   2. stop a Session that is merely loaded in memory, so it cannot flush its
 *      header back to disk after the removal,
 *   3. detach it from every Workspace through the registry entity API,
 *   4. remove <sessionsRoot>/<projectKey>/<sessionId> recursively, then re-check
 *      for a directory a racing writer put back,
 *   5. drop the session_projcache record (best effort),
 *   6. emit `api-session/removed` so every open client drops the row.
 *
 * The browser half (./client) contributes the "Delete session" row to
 * `sidebar.workspaces.session.menu.item` and asks for a confirmation first.
 */
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promises as fsp } from "node:fs";

/** Stable cordis plugin name. */
const name = "session-delete";
/**
 * Services required before the route family can mount. `sessions` is declared
 * rather than merely looked up because it drives the "resident, so verify the
 * removal twice" policy: unresolved, that policy silently degrades to "never
 * resident", which is the failure mode that let a deleted Session be written
 * back to disk.
 *
 * `agents` is deliberately NOT declared. Presence in the Agent registry means
 * "loaded in this process", which is true for any Session a window opened and is
 * never a busy signal — DSH keeps the Agent alive after a turn ends. Running work
 * is detected through the `workspace/session-activity` waterfall instead, which
 * is what `archiveSession` itself asks.
 */
const inject = ["webServer", "sessions"];

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
/**
 * Removal re-check: a Session still loaded in memory can flush its header back
 * to disk a fraction of a second after the removal, so the directory is stat-ed
 * again this many times, this far apart, before the removal is called done.
 */
const RESURRECTION_ROUNDS = 4;
const RESURRECTION_DELAY_MS = 350;
/**
 * How long to wait for a stop request to actually take effect. `session-stop`
 * resolves once every provider's request was *issued*, while the stopped work
 * settles on its own, so "running" has to be re-asked rather than assumed — and
 * a removal must not start while a turn is still draining into the log.
 */
const ACTIVITY_SETTLE_ROUNDS = 12;
const ACTIVITY_SETTLE_DELAY_MS = 250;

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

/**
 * Record one non-fatal problem in a locale-neutral shape. The host has no idea
 * which language the requesting window is in, so a warning travels as a code
 * plus its parameters and the dialog renders it through the plugin's own
 * dictionaries; `message` is the English sentence used as the fallback for a
 * code the browser half does not know yet, and for host-side logs.
 * @param warnings - accumulator for non-fatal problems.
 * @param code - the stable warning code (`warning.<code>` is the locale key).
 * @param params - values interpolated into the localized sentence.
 * @param text - the English fallback sentence.
 */
function warn(warnings, code, params, text) {
  warnings.push({ code, params: params ?? {}, message: text });
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
 * Resolve one host service: the injected property when it is declared, otherwise
 * the registry lookup. A missing service must never look like "no such Session",
 * so every caller here distinguishes undefined (not mounted) from a real answer.
 * @param ctx - host plugin context.
 * @param name - service key.
 * @returns the service, or undefined when it is not mounted.
 */
function service(ctx, name) {
  try {
    const declared = ctx[name];
    if (declared !== undefined && declared !== null) return declared;
  } catch {
    /* not declared on this context */
  }
  try {
    const registered = ctx.get?.(name);
    if (registered !== undefined && registered !== null) return registered;
  } catch {
    /* not mounted */
  }
  return undefined;
}

/**
 * The Session loaded in the host's in-memory store, when there is one.
 * @param ctx - host plugin context.
 * @param sessionId - the Session id.
 * @returns the in-memory Session, or undefined.
 */
function liveSession(ctx, sessionId) {
  try {
    const sessions = service(ctx, "sessions");
    if (typeof sessions?.get !== "function") return undefined;
    return sessions.get(sessionId);
  } catch {
    return undefined;
  }
}

/**
 * Why the Session may still be remembered even though its files are gone. The
 * corpus is live-preferred, and the persistence layer also lists sessions this
 * process created but never materialized — neither source notices a deleted
 * directory on its own. Each note states its own consequence, rather than lumping
 * "still remembered" and "will come back" into one alarming sentence.
 * @param ctx - host plugin context.
 * @param sessionId - the Session id.
 * @returns one note per source that still holds the Session.
 */
function corpusNotes(ctx, sessionId) {
  const notes = [];
  if (liveSession(ctx, sessionId) !== undefined) {
    notes.push({
      code: "corpus-held-live",
      params: {},
      message:
        "the host still holds a live Session instance for it, so the log can be flushed back to disk and the conversation can be listed again after a restart"
    });
  }
  try {
    const persistence = service(ctx, "sessionPersistence");
    if (typeof persistence?.hasPendingSession === "function" && persistence.hasPendingSession(sessionId)) {
      notes.push({
        code: "corpus-held-pending",
        params: {},
        message:
          "the persistence layer still lists it as created but never materialized; that record lives only inside this process and goes away with it"
      });
    }
  } catch {
    /* an unreadable probe must not fail the deletion */
  }
  return notes;
}

/**
 * Answer "why is this Session still listed?" for one id, entry by entry. The
 * corpus is live-preferred and the persistence layer also lists sessions this
 * process created but never materialized, so a deleted directory does not by
 * itself remove the row. Every probe is individually guarded: a missing service
 * reports `null` ("could not ask") rather than quietly reading as `false`.
 * @param ctx - host plugin context.
 * @param sessionId - the Session id.
 * @returns the per-source answers.
 */
async function corpusDiagnosis(ctx, sessionId) {
  const diagnosis = { live: null, pending: null, listed: null, persisted: null };
  try {
    diagnosis.live = liveSession(ctx, sessionId) !== undefined;
  } catch {
    /* leave it null */
  }
  try {
    const persistence = service(ctx, "sessionPersistence");
    if (typeof persistence?.hasPendingSession === "function") {
      diagnosis.pending = persistence.hasPendingSession(sessionId) === true;
    }
  } catch {
    /* leave it null */
  }
  try {
    const query = service(ctx, "sessionQuery");
    if (typeof query?.listSessions === "function") {
      const records = await query.listSessions();
      const found = Array.isArray(records) ? records.find((record) => record?.header?.id === sessionId) : undefined;
      diagnosis.listed = found !== undefined;
      if (found !== undefined) diagnosis.persisted = found.persisted === true;
    }
  } catch {
    /* leave it null */
  }
  return diagnosis;
}

/**
 * What still runs for a Session, as reported by the `workspace/session-activity`
 * waterfall — the exact question `archiveSession` asks before it writes. This,
 * and not the mere presence of a live Agent, is what "running" means: DSH keeps
 * an Agent alive for a Session that is open and idle, so `agents.get` answers
 * "loaded" for a Session whose writer is doing nothing at all.
 * @param ctx - host plugin context.
 * @param sessionId - the Session id.
 * @returns the reported activity entries, or null when the question cannot be asked.
 */
async function sessionActivity(ctx, sessionId) {
  if (typeof ctx.waterfall !== "function") return null;
  try {
    const reported = await ctx.waterfall("workspace/session-activity", { sessionId }, () => Promise.resolve([]));
    return Array.isArray(reported) ? reported : null;
  } catch {
    return null;
  }
}

/**
 * Poll `workspace/session-activity` until it reports nothing, because
 * `session-stop` only guarantees the requests were issued.
 * @param ctx - host plugin context.
 * @param sessionId - the Session id.
 * @returns the activity still reported after waiting (empty when it settled).
 */
async function waitForActivityToSettle(ctx, sessionId) {
  let reported = await sessionActivity(ctx, sessionId);
  for (let round = 0; round < ACTIVITY_SETTLE_ROUNDS && Array.isArray(reported) && reported.length > 0; round += 1) {
    await delay(ACTIVITY_SETTLE_DELAY_MS);
    reported = await sessionActivity(ctx, sessionId);
  }
  return Array.isArray(reported) ? reported : [];
}

/**
 * Render reported activity for a human. Providers own their kind keys and this
 * package deliberately does not enumerate them, so an unknown key is shown
 * rather than hidden.
 * @param entries - SessionActivity entries from the waterfall.
 * @returns a joined description.
 */
function describeActivity(entries) {
  return entries
    .map((entry) => {
      const kind = typeof entry?.kind === "string" ? entry.kind : "?";
      const count = Array.isArray(entry?.items) ? entry.items.length : 0;
      return count > 0 ? `${kind}×${count}` : kind;
    })
    .join("、");
}

/**
 * Ids one store currently holds.
 * @param ctx - host plugin context.
 * @param name - store service key (`sessions` or `agents`).
 * @returns the ids, or null when the store is not mounted. `[]` means mounted
 * and empty; keeping the two apart is what makes `/info` diagnostic.
 */
function liveIds(ctx, name) {
  try {
    const store = service(ctx, name);
    if (typeof store?.list !== "function") return null;
    const listed = store.list();
    if (!Array.isArray(listed)) return null;
    return listed.map((entry) => entry?.id).filter((id) => typeof id === "string");
  } catch {
    return null;
  }
}

/**
 * Ask every owner to stop this Session's work — the same fan-out `archive`
 * performs for `stopActivity`. Called both for work the activity waterfall
 * reported and for a Session that is merely loaded: an idle resident can still
 * flush its header back to disk after the removal, which is exactly what made a
 * deleted conversation reappear on the next start.
 * @param ctx - host plugin context.
 * @param sessionId - the Session id.
 * @param warnings - accumulator for non-fatal problems.
 */
async function stopSessionActivity(ctx, sessionId, warnings) {
  try {
    await ctx.parallel("workspace/session-stop", { sessionId });
  } catch (error) {
    warn(
      warnings,
      "activity-stop-failed",
      { reason: message(error) },
      `could not ask the session's owners to stop: ${message(error)}`
    );
  }
}

/**
 * Whether the filesystem still reports a path.
 * @param target - absolute path.
 * @returns whether it exists.
 */
async function exists(target) {
  try {
    await fsp.stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Wait, so a racing writer gets a chance to show itself before it is checked for.
 * @param ms - milliseconds to wait.
 * @returns a promise settling after the delay.
 */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
  const registry = service(ctx, "workspaceRegistry");
  if (registry === undefined || registry === null) {
    warn(
      warnings,
      "workspace-registry-missing",
      {},
      "the workspace registry is unavailable, so workspace links were left alone"
    );
    return;
  }
  let entries = [];
  try {
    entries = typeof registry.list === "function" ? registry.list() : [];
  } catch (error) {
    warn(
      warnings,
      "workspace-list-failed",
      { reason: message(error) },
      `could not read the workspace list: ${message(error)}`
    );
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
      const workspace = entry?.title ?? entry?.id ?? "?";
      warn(
        warnings,
        "workspace-detach-failed",
        { workspace, reason: message(error) },
        `could not detach the session from workspace ${workspace}: ${message(error)}`
      );
    }
  }
  if (typeof registry.unpinSession === "function") {
    try {
      await registry.unpinSession(sessionId);
    } catch (error) {
      warn(
        warnings,
        "unpin-failed",
        { reason: message(error) },
        `could not unpin the session: ${message(error)}`
      );
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
      warn(
        warnings,
        "projection-cache-failed",
        { file, reason: message(error) },
        `could not remove the projection cache record ${file}: ${message(error)}`
      );
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
      body: {
        ok: false,
        error: {
          code: "bad-request",
          message: `not a usable session id: ${String(sessionId)}`
        }
      }
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
          message: `no log directory for session ${sessionId} (it may already be deleted)`,
          params: { sessionId },
          value: { sessionRoots: roots }
        }
      }
    };
  }

  const warnings = [];

  // "Running" is decided by the activity waterfall — the question `archive` asks
  // — and NOT by a live Agent, which is also present for a Session that is merely
  // open and idle. Anything genuinely running is asked to stop through the same
  // fan-out `archive` uses for `stopActivity`; only work that refuses to settle
  // after that is refused, because `session-stop` promises no more than "every
  // stop request was issued".
  const running = await sessionActivity(ctx, sessionId);
  if (running === null) {
    warn(
      warnings,
      "activity-unavailable",
      {},
      "could not ask whether the session is still running (the workspace/session-activity waterfall is unavailable), so that check was skipped"
    );
  }
  const busy = Array.isArray(running) && running.length > 0;
  if (busy) {
    await stopSessionActivity(ctx, sessionId, warnings);
    const remaining = await waitForActivityToSettle(ctx, sessionId);
    if (remaining.length > 0) {
      const waited = (ACTIVITY_SETTLE_ROUNDS * ACTIVITY_SETTLE_DELAY_MS) / 1000;
      const work = describeActivity(remaining);
      return {
        status: 409,
        body: {
          ok: false,
          error: {
            code: "session-active",
            message: `the session still has unfinished work (${work}) that did not settle within ${waited}s of asking it to stop, so the deletion was cancelled`,
            params: { work, seconds: waited }
          }
        }
      };
    }
  }

  // A Session that is loaded but idle is not refused: the browser half leaves it
  // first, and this stop retires whatever the drop left behind.
  const loaded = liveSession(ctx, sessionId) !== undefined;
  if (loaded && !busy) await stopSessionActivity(ctx, sessionId, warnings);

  const removed = [];
  const failed = [];

  /**
   * Remove every target directory, then report the ones the filesystem still
   * shows, so a writer that puts one back is noticed.
   * @returns the surviving targets.
   */
  const sweep = async () => {
    const surviving = [];
    for (const { root, dir } of targets) {
      if (!isInside(root, dir)) {
        if (!failed.some((entry) => entry.dir === dir)) {
          failed.push({
            dir,
            code: "path-outside-root",
            params: {},
            message: "the path is not inside the session root, so it was left alone"
          });
        }
        continue;
      }
      try {
        await fsp.rm(dir, { recursive: true, force: true });
      } catch (error) {
        failed.push({ dir, code: "remove-failed", params: { reason: message(error) }, message: message(error) });
      }
      if (await exists(dir)) surviving.push({ root, dir });
    }
    return surviving;
  };

  let surviving = await sweep();
  if (loaded) {
    // A Session that was still resident can flush its header back to disk a
    // moment after the removal, so a second look is mandatory whenever one
    // existed — not only when the first sweep happened to catch it.
    for (let round = 0; round < RESURRECTION_ROUNDS; round += 1) {
      if (round > 0 && surviving.length === 0) break;
      await delay(RESURRECTION_DELAY_MS);
      surviving = await sweep();
    }
  }

  const survivingDirs = new Set(surviving.map((entry) => entry.dir));
  const failedDirs = new Set(failed.map((entry) => entry.dir));
  for (const { dir } of targets) {
    if (!survivingDirs.has(dir) && !failedDirs.has(dir)) removed.push(dir);
  }

  if (failed.length > 0) {
    const reasons = failed.map((entry) => entry.message).join("; ");
    return {
      status: 500,
      body: {
        ok: false,
        error: {
          code: "delete-failed",
          message: `some session files could not be removed: ${reasons}`,
          params: { reason: reasons }
        },
        value: { sessionId, removedDirectories: removed, failed, warnings }
      }
    };
  }

  if (surviving.length > 0) {
    const dirs = surviving.map((entry) => entry.dir);
    warn(
      warnings,
      "directory-rewritten",
      { dirs: dirs.join(", ") },
      `these directories were written back after the removal, so an in-memory session still holds them: ${dirs.join(", ")}. Restart DSH and delete again to clear them for good.`
    );
    return {
      status: 500,
      body: {
        ok: false,
        error: {
          code: "delete-resurrected",
          message: `the session directory was written back, so the deletion did not take effect: ${dirs.join(", ")}`,
          params: { dirs: dirs.join(", ") }
        },
        value: { sessionId, removedDirectories: removed, failed, warnings }
      }
    };
  }

  // Detaching runs only once the files are really gone: a failure above must
  // leave the Workspace links alone instead of orphaning the Session.
  await detachFromWorkspaces(ctx, sessionId, warnings);

  await removeProjectionCaches(sessionId, roots, warnings);

  // The files are gone, but the row is rendered from a live-preferred corpus that
  // also lists in-memory sessions. Say so instead of reporting a clean success and
  // letting the user find a zombie entry under Ungrouped.
  const held = corpusNotes(ctx, sessionId);
  if (held.length > 0) {
    warnings.push(...held);
  }

  try {
    ctx.emit("api-session/removed", sessionId);
  } catch (error) {
    warn(
      warnings,
      "emit-failed",
      { reason: message(error) },
      `could not broadcast the removal: ${message(error)}`
    );
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
          // `?sessionId=…` also asks the liveness question for that one Session,
          // so "why was my delete refused?" can be answered without guessing.
          let requested = null;
          try {
            requested = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("sessionId");
          } catch {
            requested = null;
          }
          let activity = null;
          if (typeof requested === "string" && isSafeSessionId(requested)) {
            const reported = await sessionActivity(ctx, requested);
            activity =
              reported === null
                ? { asked: false }
                : { asked: true, summary: describeActivity(reported), entries: reported };
          }
          writeJson(res, 200, {
            ok: true,
            value: {
              sessionRoots: roots,
              // `false` here means the service did not resolve, which is what
              // silently disabled the "resident, so verify the removal twice"
              // policy before this probe reported it separately from "nothing is
              // loaded".
              services: {
                sessions: service(ctx, "sessions") !== undefined,
                workspaceRegistry: service(ctx, "workspaceRegistry") !== undefined,
                sessionPersistence: service(ctx, "sessionPersistence") !== undefined
              },
              // Without this the liveness question cannot be asked at all and
              // "running" degrades to "never running". `agents` is deliberately
              // absent: see the note on `inject`.
              activityWaterfall: typeof ctx.waterfall === "function",
              liveSessionIds: liveIds(ctx, "sessions"),
              activity,
              // Ask the same question the sidebar's row depends on: which source
              // would keep this Session listed now that its files are gone.
              corpus:
                typeof requested === "string" && isSafeSessionId(requested)
                  ? await corpusDiagnosis(ctx, requested)
                  : null
            }
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
