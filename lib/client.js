/**
 * dsh-session-delete — browser half.
 *
 * Contributes one row to `sidebar.workspaces.session.menu.item`, the rows of a
 * Session's "..." menu, after the shipped pin(100)/rename(200)/fork(300)/
 * archive(400). Order 500 plus `separatorBefore` starts a plugin group.
 *
 * The row raises a request in a module-scoped store; a second `shell.overlay`
 * entry renders exactly one confirmation dialog per request. That dialog is the
 * ui-primitives `Modal` the shipped archive confirmation uses, so it carries the
 * host's mask, card, elevation and focus trap instead of a native `window.confirm`
 * (whose chrome is the Electron window title and cannot be themed or localized).
 *
 * Route URLs are DOCUMENT-RELATIVE on purpose (no leading slash): the harness
 * serves the GUI with `<base href="./">`, so a sub-path deployment keeps the
 * request inside the plugin's mount.
 */
window.__ModuleLoader__.load({
  id: "dsh-session-delete",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const jsxRuntime = require("react/jsx-runtime");
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    const { jsx, jsxs, Fragment } = jsxRuntime;

    /** Locale namespace this plugin owns (its own `zh`/`en` dictionaries). */
    const NS = "dsh-session-delete";
    /** Cell key of the contributed row in sidebar.workspaces.session.menu.item. */
    const ROW_ID = "dsh-session-delete.session.delete";
    /** Row order: after the shipped archive row (400). */
    const ROW_ORDER = 500;
    /** Cell key of the contributed confirmation dialog in shell.overlay. */
    const DIALOG_ID = "dsh-session-delete.session-delete-confirm";
    /** Host route (mirrors the host half's ROUTES.remove). */
    const API_DELETE = "api/dsh-session-delete/delete";

    //#region styles
    /** Plugin stylesheet: the host design tokens, tagged so it is injected once. */
    const CSS = [
      ".dsh-session-delete-action{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}",
      ".dsh-session-delete-action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}",
      ".dsh-session-delete-action:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-alias-state-error-primary);outline-offset:2px}",
      ".dsh-session-delete-note{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}",
      ".dsh-session-delete-meta{margin:12px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);word-break:break-all}",
      ".dsh-session-delete-warnings{margin:8px 0 0;padding-left:18px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);word-break:break-all}",
      ".dsh-session-delete-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}",
      ".dsh-session-delete-error{margin:12px 0 0;font-size:13px;line-height:20px;color:var(--dsw-alias-state-error-primary)}"
    ].join("");

    const CSS_TAG_ID = "dsh-session-delete/client.css";
    if (
      typeof document !== "undefined" &&
      document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG_ID) + "]") === null
    ) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-session-delete";
      tag.dataset.pluginCss = CSS_TAG_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }
    //#endregion

    /** Dictionaries. `register(ns, locale, dict)`; keys are flat and `{name}` interpolates. */
    const zh = {
      "menu.deleteSession": "彻底删除会话",
      "dialog.title": "彻底删除此会话？",
      "dialog.desc": "“{title}”的全部日志将从磁盘上删除，且无法恢复。",
      "dialog.descUntitled": "该会话的全部日志将从磁盘上删除，且无法恢复。",
      "dialog.note": "工作区关联与投影缓存会一并清理；若该会话仍在运行，会先请宿主停止它。此操作无法撤销。",
      "dialog.noteOpen":
        "该会话正打开在当前窗口：确认后会先切换到其他会话，等它从内存中释放再删除，否则它会被重新写回磁盘、重启后又冒出来。",
      "dialog.noteHeld": "该会话仍被当前窗口占用：确认后会先尝试离开它，再执行删除。",
      "dialog.sessionId": "会话 ID",
      "dialog.confirm": "彻底删除",
      "dialog.pending": "正在删除…",
      "dialog.switching": "正在切换会话…",
      "dialog.stillOpen": "该会话一直没从当前窗口释放，已取消删除以免它复活。请手动切换到其他会话后再来删除。",
      "dialog.noTarget": "找不到可切换的其他会话，已取消删除。请先新建或打开另一个会话，再来删除。",
      "dialog.blockedRunning":
        "该会话仍有未结束的工作（{work}），请求停止后等待 {seconds} 秒仍未结束，删除已取消。请稍后重试。",
      "dialog.warnings": "已从磁盘删除，但有以下告警：",
      "dialog.blockedResurrected":
        "该会话的日志在被删除后又被重新写回了磁盘，说明仍有内存中的会话持有它。请重启 DSH 后再删除。（{dirs}）",
      "dialog.notFound": "没有找到该会话的日志目录，可能已经被删除了。",
      "dialog.badRequest": "请求被拒绝：会话 ID 不合法。",
      "dialog.forbidden": "请求被拒绝：该操作只允许来自本机。",
      "dialog.deleteFailed": "部分文件删除失败：{reason}",
      "dialog.cancel": "取消",
      "dialog.close": "关闭",
      "dialog.failed": "删除失败",
      "warning.corpus-held-live":
        "宿主进程里仍有一个活着的 Session 实例持有它——它若再次落盘，重启 DSH 后这个会话会重新出现。",
      "warning.corpus-held-pending":
        "持久化层仍把它记作「已创建但尚未落盘」——这条记录只活在本次进程内，重启即消失。",
      "warning.activity-stop-failed": "请求宿主停止该会话的活动失败：{reason}",
      "warning.workspace-registry-missing": "工作区注册表不可用，已跳过工作区解绑。",
      "warning.workspace-list-failed": "读取工作区列表失败：{reason}",
      "warning.workspace-detach-failed": "从工作区「{workspace}」解绑失败：{reason}",
      "warning.unpin-failed": "取消置顶失败：{reason}",
      "warning.projection-cache-failed": "投影缓存清理失败（{file}）：{reason}",
      "warning.activity-unavailable":
        "无法询问该会话是否仍在运行（workspace/session-activity 不可用），已跳过这项检查。",
      "warning.directory-rewritten":
        "以下目录在删除后被重新写入，说明仍有内存中的会话持有它：{dirs}",
      "warning.emit-failed": "广播会话移除事件失败：{reason}"
    };

    const en = {
      "menu.deleteSession": "Delete session permanently",
      "dialog.title": "Delete this session permanently?",
      "dialog.desc": "Every log of “{title}” will be removed from disk. This cannot be undone.",
      "dialog.descUntitled": "Every log of this session will be removed from disk. This cannot be undone.",
      "dialog.note": "Workspace links and the projection cache are cleaned up as well; if the session is still running, the host is asked to stop it first. This cannot be undone.",
      "dialog.noteOpen":
        "This session is open in this window: it is left first, and deleted only once it has been released, so it cannot be written back to disk and reappear after a restart.",
      "dialog.noteHeld": "This session is still held by this window: it is left first, then deleted.",
      "dialog.sessionId": "Session ID",
      "dialog.confirm": "Delete permanently",
      "dialog.pending": "Deleting…",
      "dialog.switching": "Leaving the session…",
      "dialog.stillOpen":
        "The session was never released by this window, so the deletion was cancelled instead of letting it come back. Switch to another conversation first.",
      "dialog.noTarget":
        "There is no other conversation to switch to, so the deletion was cancelled. Open or start another conversation first.",
      "dialog.blockedRunning":
        "The session still has unfinished work ({work}) that did not settle within {seconds}s of asking it to stop, so the deletion was cancelled. Try again in a moment.",
      "dialog.warnings": "Removed from disk, with these warnings:",
      "dialog.blockedResurrected":
        "The session's log was written back to disk after the removal, so an in-memory session still holds it. Restart DSH, then delete it again. ({dirs})",
      "dialog.notFound": "No log directory was found for this session; it may already be deleted.",
      "dialog.badRequest": "The request was rejected: that is not a usable session id.",
      "dialog.forbidden": "The request was rejected: this operation is only allowed from this machine.",
      "dialog.deleteFailed": "Some files could not be removed: {reason}",
      "dialog.cancel": "Cancel",
      "dialog.close": "Close",
      "dialog.failed": "Delete failed",
      "warning.corpus-held-live":
        "The host still holds a live Session instance for it, so the log can be flushed back to disk and the conversation can be listed again after a restart.",
      "warning.corpus-held-pending":
        "The persistence layer still lists it as created but never materialized; that record lives only inside this process and goes away with a restart.",
      "warning.activity-stop-failed": "Could not ask the host to stop this session's work: {reason}",
      "warning.workspace-registry-missing":
        "The workspace registry is unavailable, so workspace links were left alone.",
      "warning.workspace-list-failed": "Could not read the workspace list: {reason}",
      "warning.workspace-detach-failed": "Could not detach from workspace “{workspace}”: {reason}",
      "warning.unpin-failed": "Could not unpin the session: {reason}",
      "warning.projection-cache-failed": "Could not remove the projection cache record ({file}): {reason}",
      "warning.activity-unavailable":
        "Could not ask whether this session is still running (the workspace/session-activity waterfall is unavailable), so that check was skipped.",
      "warning.directory-rewritten":
        "These directories were written back after the removal, so an in-memory session still holds them: {dirs}",
      "warning.emit-failed": "Could not broadcast the removal: {reason}"
    };

    //#region pending-request store
    /** The one confirmation currently open, or null. */
    let pendingRequest = null;
    /** Subscribers re-read on every change (useSyncExternalStore). */
    const pendingListeners = new Set();

    /**
     * Replace the pending request and wake every subscriber.
     * @param next - the request to show, or null to close the dialog.
     */
    function setPendingRequest(next) {
      pendingRequest = next;
      for (const listener of [...pendingListeners]) listener();
    }

    /**
     * Subscribe to pending-request changes.
     * @param listener - React's invalidation callback.
     * @returns the unsubscribe function.
     */
    function subscribePending(listener) {
      pendingListeners.add(listener);
      return () => {
        pendingListeners.delete(listener);
      };
    }

    /** @returns the current pending request (a stable reference between changes). */
    function readPending() {
      return pendingRequest;
    }

    /**
     * Read the pending request as a hook, the shape a slot inject face exposes.
     * @param select - projection over the store value.
     * @returns the selected value.
     */
    function useDeleteRequest(select) {
      return select(react.useSyncExternalStore(subscribePending, readPending, readPending));
    }
    //#endregion

    //#region host transport
    /**
     * POST one JSON payload to a host route and unwrap the {ok, value} envelope.
     * @param url - document-relative route URL.
     * @param payload - JSON-serializable body.
     * @returns the route's `value`.
     */
    async function postJson(url, payload) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(payload)
      });
      let data;
      try {
        data = await response.json();
      } catch {
        data = undefined;
      }
      if (!response.ok || data?.ok === false || data?.error !== undefined) {
        const error = new Error(data?.error?.message ?? data?.message ?? `HTTP ${response.status}`);
        error.code = data?.error?.code;
        error.params = data?.error?.params;
        error.details = data?.value;
        throw error;
      }
      return data?.value;
    }

    /**
     * The row label's own title text, falling back to the Session id.
     * @param displayTitle - owner-supplied title.
     * @param sessionId - the Session id.
     * @returns a non-empty label.
     */
    function labelOf(displayTitle, sessionId) {
      return typeof displayTitle === "string" && displayTitle.trim() !== "" ? displayTitle : sessionId;
    }
    //#endregion

    //#region session retention
    /**
     * Retain source of the Session the Main view is showing. `dsh-client-ui-session`
     * and `dsh-client-ui-workspace` read the same key to decide which Session is
     * current, and ui-workspace's `replaceMain()` releases it on every navigation.
     */
    const MAIN_VIEW_SOURCE = "mainView";
    /** How long a navigation away may take before the deletion is cancelled. */
    const RELEASE_TIMEOUT_MS = 5000;
    /** Polling interval while waiting for that release. */
    const RELEASE_POLL_MS = 150;
    /** Grace period for the release to reach the host before it is asked to delete. */
    const RELEASE_SETTLE_MS = 250;

    /**
     * Resolve one client service: the injected property when it is declared,
     * otherwise the registry lookup, so no hard dependency is added for a service
     * that may be absent on another build.
     * @param ctx - client root context.
     * @param name - service key.
     * @returns the service, or undefined when it is not mounted.
     */
    function serviceOf(ctx, name) {
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
     * The observable retention face of one Session, or null when the store cannot
     * answer. `retainInfo` observes reference counts without retaining, creating a
     * scope or opening history, and reports zero when no generation is live.
     * @param ctx - client root context.
     * @param sessionId - the Session id.
     * @returns the snapshot source, or null.
     */
    function retainFace(ctx, sessionId) {
      const sessions = serviceOf(ctx, "sessions");
      if (typeof sessions?.retainInfo !== "function") return null;
      try {
        const source = sessions.retainInfo(sessionId);
        if (source === null || typeof source.getSnapshot !== "function" || typeof source.subscribe !== "function") {
          return null;
        }
        return source;
      } catch (error) {
        console.warn("[dsh-session-delete] retainInfo failed:", error);
        return null;
      }
    }

    /**
     * One Session's local reference counts.
     * @param ctx - client root context.
     * @param sessionId - the Session id.
     * @returns `known` false when the store cannot answer, plus the two counts.
     */
    function retentionOf(ctx, sessionId) {
      const source = retainFace(ctx, sessionId);
      if (source === null) return { known: false, mainView: 0, referenceCount: 0 };
      try {
        const info = source.getSnapshot();
        const mainView = info?.retainedBy?.[MAIN_VIEW_SOURCE];
        return {
          known: true,
          mainView: typeof mainView === "number" ? mainView : 0,
          referenceCount: typeof info?.referenceCount === "number" ? info.referenceCount : 0
        };
      } catch {
        return { known: false, mainView: 0, referenceCount: 0 };
      }
    }

    /**
     * Subscribe one component to a Session's local retention. The snapshot is
     * cached by value because `useSyncExternalStore` compares by identity.
     * @param ctx - client root context.
     * @param sessionId - the Session id.
     * @returns the retention record.
     */
    function useRetainInfo(ctx, sessionId) {
      const cache = react.useRef({ known: false, mainView: 0, referenceCount: 0 });
      const read = react.useCallback(() => {
        const next = retentionOf(ctx, sessionId);
        const previous = cache.current;
        if (
          previous.known !== next.known ||
          previous.mainView !== next.mainView ||
          previous.referenceCount !== next.referenceCount
        ) {
          cache.current = next;
        }
        return cache.current;
      }, [ctx, sessionId]);
      const subscribe = react.useCallback(
        (listener) => {
          const source = retainFace(ctx, sessionId);
          if (source === null) return () => {};
          try {
            return source.subscribe(listener);
          } catch {
            return () => {};
          }
        },
        [ctx, sessionId]
      );
      return react.useSyncExternalStore(subscribe, read, read);
    }

    /**
     * Another Session to land on, preferring one that is not already the Main view
     * so the navigation does not bounce straight back.
     * @param ctx - client root context.
     * @param sessionId - the Session being left.
     * @returns an id, or undefined when the list holds no other row.
     */
    function anotherSessionId(ctx, sessionId) {
      let byId;
      try {
        byId = serviceOf(ctx, "sessions")?.list?.getSnapshot?.()?.byId;
      } catch {
        return undefined;
      }
      if (byId === null || typeof byId !== "object") return undefined;
      const ids = Object.keys(byId).filter((id) => id !== sessionId);
      return ids.find((id) => (byId[id]?.retainedBy?.[MAIN_VIEW_SOURCE] ?? 0) === 0) ?? ids[0];
    }

    /**
     * Wait for the Main view's reference on a Session to drop.
     * @param ctx - client root context.
     * @param sessionId - the Session id.
     * @param timeoutMs - how long to wait.
     * @returns whether the reference is gone.
     */
    async function waitForRelease(ctx, sessionId, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (retentionOf(ctx, sessionId).mainView === 0) return true;
        if (Date.now() >= deadline) return false;
        await new Promise((resolve) => {
          setTimeout(resolve, RELEASE_POLL_MS);
        });
      }
    }

    /**
     * Leave the target Session before it is deleted. A Session still retained by
     * the Main view keeps a live in-memory generation, and that generation flushes
     * the header back to disk after the removal — which is how a deleted
     * conversation reappeared on the next start.
     * @param ctx - client root context.
     * @param sessionId - the Session to leave.
     * @returns whether leaving was needed, whether it happened, and why it did not.
     */
    async function leaveSession(ctx, sessionId) {
      if (retentionOf(ctx, sessionId).mainView === 0) return { needed: false, left: true, reason: null };
      const ui = serviceOf(ctx, "uiWorkspace");
      const next = anotherSessionId(ctx, sessionId);
      try {
        if (next !== undefined && typeof ui?.openSession === "function") ui.openSession(next);
        else if (typeof ui?.startSession === "function") ui.startSession();
        else return { needed: true, left: false, reason: "no-target" };
      } catch (error) {
        console.warn("[dsh-session-delete] navigation away failed:", error);
        return { needed: true, left: false, reason: "no-target" };
      }
      if (!(await waitForRelease(ctx, sessionId, RELEASE_TIMEOUT_MS))) {
        return { needed: true, left: false, reason: "timeout" };
      }
      // The release retires the client scope; give that round trip time to reach
      // the host before the host is asked to remove the log.
      await new Promise((resolve) => {
        setTimeout(resolve, RELEASE_SETTLE_MS);
      });
      return { needed: true, left: true, reason: null };
    }
    //#endregion

    //#region menu row
    /**
     * Menu row (order 500): raise the confirmation. The deletion itself belongs
     * to the dialog, so the menu closes immediately either way.
     * @param props - owner share (sessionId/displayTitle), the menu's
     * `useMenuOpenState`, and the plugin's locale `t`.
     * @returns the row.
     */
    function DeleteSessionMenuItem(props) {
      const { sessionId, displayTitle, useMenuOpenState, t } = props;
      const [, setMenuOpen] = useMenuOpenState();
      return jsx(primitives.MenuItemButton, {
        separatorBefore: true,
        danger: true,
        icon: jsx(primitives.IconTrashOutlineRegular, {}),
        onSelect: () => {
          setMenuOpen(false);
          setPendingRequest({ sessionId, displayTitle });
        },
        children: t("menu.deleteSession")
      });
    }
    //#endregion

    //#region confirmation dialog
    /**
     * The dictionary key of the note matching a Session's local retention, so the
     * dialog can say up front whether the conversation is about to be switched
     * away from.
     * @param retention - the retention record.
     * @returns the dictionary key.
     */
    function retentionNoteKey(retention) {
      if (retention.mainView > 0) return "dialog.noteOpen";
      if (retention.referenceCount > 0) return "dialog.noteHeld";
      return "dialog.note";
    }

    /**
     * Render one host warning. The host has no idea which language this window is
     * in, so it sends a stable code plus parameters; `warning.message` is the
     * host's own English sentence, used when this build of the browser half does
     * not know the code yet — a newer host must never produce a blank line.
     * @param t - the plugin's locale function.
     * @param warning - one entry from the host's `warnings` array.
     * @returns the text to show.
     */
    function warningText(t, warning) {
      if (warning === null || typeof warning !== "object") return String(warning);
      const code = typeof warning.code === "string" ? warning.code : null;
      if (code !== null) {
        const key = `warning.${code}`;
        const translated = t(key, warning.params ?? {});
        if (typeof translated === "string" && translated !== "" && translated !== key) return translated;
      }
      if (typeof warning.message === "string" && warning.message !== "") return warning.message;
      return code ?? String(warning);
    }

    /**
     * Turn a failed request into a sentence. Known codes are localized (and may
     * name what is still running); anything else falls back to the host's own
     * text rather than hiding it behind a generic message.
     * @param t - the plugin's locale function.
     * @param reason - the thrown error from `postJson`.
     * @returns the text to show.
     */
    function failureText(t, reason) {
      const params = reason?.params ?? {};
      switch (reason?.code) {
        case "session-active":
        case "session-running":
          return t("dialog.blockedRunning", params);
        case "delete-resurrected":
          return t("dialog.blockedResurrected", params);
        case "delete-failed":
          return t("dialog.deleteFailed", params);
        case "not-found":
          return t("dialog.notFound");
        case "bad-request":
          return t("dialog.badRequest");
        case "forbidden":
          return t("dialog.forbidden");
        default:
          return reason instanceof Error ? reason.message : String(reason);
      }
    }

    /**
     * The `shell.overlay` entry: nothing while no confirmation is pending,
     * otherwise one dialog per request (keyed by the Session), so in-flight and
     * error state die with it.
     * @param props - the request hook, its settlement, the retention hook, the
     * leave step, the host call, and the locale seat.
     * @returns the open dialog, or null.
     */
    function DeleteSessionDialog({
      useDeleteRequest: useRequest,
      settleDeleteRequest,
      deleteSession,
      useRetainInfo: useRetain,
      leaveSession: leave,
      t
    }) {
      const request = useRequest((pending) => pending);
      if (request === null) return null;
      return jsx(
        DeleteConfirmForm,
        { request, onSettle: settleDeleteRequest, deleteSession, useRetain, leave, t },
        request.sessionId
      );
    }

    /**
     * One request's dialog: leave the Session if this window still holds it, then
     * delete it. A refusal, a failed release or a host warning keeps the dialog
     * open and says what happened, instead of closing on a false success.
     * @param props - the request, its settlement, the retention hook, the leave
     * step, the host call, and the locale seat.
     * @returns the dialog.
     */
    function DeleteConfirmForm({ request, onSettle, deleteSession, useRetain, leave, t }) {
      // Unconditional: this component only mounts for a non-null request, and a
      // hook may not be called conditionally in the parent.
      const retention = useRetain(request.sessionId);
      const [busy, setBusy] = react.useState(false);
      const [phase, setPhase] = react.useState("idle");
      const [error, setError] = react.useState(null);
      const [warnings, setWarnings] = react.useState(null);
      const close = () => {
        if (busy) return;
        onSettle();
      };
      const confirm = () => {
        setBusy(true);
        setError(null);
        const run = async () => {
          if (retention.mainView > 0) setPhase("switching");
          const outcome = await leave(request.sessionId);
          if (outcome.needed && !outcome.left) {
            setBusy(false);
            setPhase("idle");
            setError(t(outcome.reason === "timeout" ? "dialog.stillOpen" : "dialog.noTarget"));
            return;
          }
          setPhase("deleting");
          const result = await deleteSession(request.sessionId);
          setBusy(false);
          setPhase("idle");
          const reported = Array.isArray(result?.warnings) ? result.warnings : [];
          if (reported.length > 0) {
            setWarnings(reported);
            return;
          }
          onSettle();
        };
        run().catch((reason) => {
          setBusy(false);
          setPhase("idle");
          setError(failureText(t, reason));
          // A refusal can still carry warnings (a directory that was written
          // back, a workspace that would not detach). Showing the sentence and
          // dropping them would hide the part that says what to do next.
          const reported = Array.isArray(reason?.details?.warnings) ? reason.details.warnings : [];
          if (reported.length > 0) setWarnings(reported);
        });
      };
      const titled = typeof request.displayTitle === "string" && request.displayTitle.trim() !== "";
      const done = warnings !== null && error === null;
      const confirmLabel = phase === "switching" ? "dialog.switching" : busy ? "dialog.pending" : "dialog.confirm";
      return jsx(primitives.Modal, {
        open: true,
        onClose: close,
        closeLabel: t("dialog.close"),
        title: t("dialog.title"),
        description: t(titled ? "dialog.desc" : "dialog.descUntitled", { title: request.displayTitle }),
        footer: done
          ? jsx(primitives.Button, {
              variant: "outline",
              onClick: close,
              children: t("dialog.close")
            })
          : jsxs(Fragment, {
              children: [
                jsx(primitives.Button, {
                  variant: "outline",
                  disabled: busy,
                  onClick: close,
                  children: t("dialog.cancel")
                }),
                jsx(primitives.Button, {
                  variant: "outline",
                  className: "dsh-session-delete-action",
                  disabled: busy,
                  onClick: confirm,
                  children: t(confirmLabel)
                })
              ]
            }),
        children: jsxs(Fragment, {
          children: [
            jsx("p", { className: "dsh-session-delete-note", children: t(retentionNoteKey(retention)) }),
            jsxs("p", {
              className: "dsh-session-delete-meta",
              children: [
                t("dialog.sessionId"),
                ": ",
                jsx("span", { className: "dsh-session-delete-code", children: request.sessionId })
              ]
            }),
            error !== null &&
              jsx("p", { className: "dsh-session-delete-error", children: `${t("dialog.failed")}: ${error}` }),
            warnings !== null &&
              jsxs(Fragment, {
                children: [
                  done &&
                    jsx("p", { className: "dsh-session-delete-note", children: t("dialog.warnings") }),
                  jsx("ul", {
                    className: "dsh-session-delete-warnings",
                    children: warnings.map((entry, index) =>
                      jsx("li", { children: warningText(t, entry) }, `warning-${index}`)
                    )
                  })
                ]
              })
          ]
        })
      });
    }
    //#endregion

    //#region wiring
    /**
     * The injected behavior: delete on the host, then make the row leave this
     * window's Session list.
     *
     * Applying the removal locally is the primary step and refreshing the baseline
     * is only the fallback, because the two are not equivalent: `refreshList()`
     * merges against the host's answer with "identities absent from the baseline
     * are removed" — so a Session the host still lists (one its in-memory store or
     * the persistence layer's pending set is holding) is *inserted back*, which
     * leaves the row stranded under Ungrouped until the next restart.
     * @param ctx - client root context (sessions service).
     * @returns the row's delete action.
     */
    function createDeleteSession(ctx) {
      return async (sessionId) => {
        const value = await postJson(API_DELETE, { sessionId });
        const sessions = serviceOf(ctx, "sessions");
        try {
          if (typeof sessions?.handleSessionRemoved === "function") {
            // This is the same entry point the `api-session/removed` relay calls;
            // calling it directly covers the case where that relay arrives late or
            // not at all.
            sessions.handleSessionRemoved(sessionId);
          } else {
            await sessions?.refresh?.();
          }
        } catch (error) {
          console.warn("[dsh-session-delete] applying the removal locally failed:", error);
        }
        return value;
      };
    }

    /** Required services (fiber inject waiting). */
    const inject = ["slots", "locale"];

    /**
     * Mount the confirmation row, its dialog, and its dictionaries.
     * @param ctx - client root context (services: slots, locale).
     */
    function apply(ctx) {
      ctx.effect(() => {
        const offZh = ctx.locale.register(NS, "zh", zh);
        const offEn = ctx.locale.register(NS, "en", en);
        return () => {
          offZh?.();
          offEn?.();
        };
      }, "dsh-session-delete: dictionaries");

      const disposers = [];
      const mount = (name, register) => {
        try {
          disposers.push(ctx.slots.inject(name, register));
        } catch (error) {
          console.warn(`[dsh-session-delete] ${name} registration failed:`, error);
        }
      };

      mount("sidebar.workspaces.session.menu.item", () =>
        ctx.slots.register(
          {
            name: "sidebar.workspaces.session.menu.item",
            id: ROW_ID,
            order: ROW_ORDER,
            locale: NS
          },
          DeleteSessionMenuItem
        )
      );

      mount("shell.overlay", () =>
        ctx.slots.register(
          {
            name: "shell.overlay",
            id: DIALOG_ID,
            locale: NS,
            inject: () => ({
              useDeleteRequest,
              settleDeleteRequest: () => setPendingRequest(null),
              deleteSession: createDeleteSession(ctx),
              useRetainInfo: (sessionId) => useRetainInfo(ctx, sessionId),
              leaveSession: (sessionId) => leaveSession(ctx, sessionId)
            })
          },
          DeleteSessionDialog
        )
      );

      ctx.effect(
        () => () => {
          setPendingRequest(null);
          for (const dispose of disposers.splice(0)) dispose();
        },
        "dsh-session-delete: ui mounts"
      );
    }
    //#endregion

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
