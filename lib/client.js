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
      "dialog.note": "工作区关联与投影缓存会一并清理。若该会话正在运行，需要先切换到其他会话。",
      "dialog.sessionId": "会话 ID",
      "dialog.confirm": "彻底删除",
      "dialog.pending": "正在删除…",
      "dialog.cancel": "取消",
      "dialog.close": "关闭",
      "dialog.failed": "删除失败"
    };

    const en = {
      "menu.deleteSession": "Delete session permanently",
      "dialog.title": "Delete this session permanently?",
      "dialog.desc": "Every log of “{title}” will be removed from disk. This cannot be undone.",
      "dialog.descUntitled": "Every log of this session will be removed from disk. This cannot be undone.",
      "dialog.note":
        "Workspace links and the projection cache are cleaned up as well. A session that is still running must be left first.",
      "dialog.sessionId": "Session ID",
      "dialog.confirm": "Delete permanently",
      "dialog.pending": "Deleting…",
      "dialog.cancel": "Cancel",
      "dialog.close": "Close",
      "dialog.failed": "Delete failed"
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
     * The `shell.overlay` entry: nothing while no confirmation is pending,
     * otherwise one dialog per request (keyed by the Session), so in-flight and
     * error state die with it.
     * @param props - the request hook, its settlement, and the locale seat.
     * @returns the open dialog, or null.
     */
    function DeleteSessionDialog({ useDeleteRequest: useRequest, settleDeleteRequest, deleteSession, t }) {
      const request = useRequest((pending) => pending);
      if (request === null) return null;
      return jsx(
        DeleteConfirmForm,
        { request, onSettle: settleDeleteRequest, deleteSession, t },
        request.sessionId
      );
    }

    /**
     * One request's dialog: confirm, or cancel and leave the Session alone. A
     * failed deletion keeps the dialog open and reports the host's message.
     * @param props - the request, its settlement, the host call, and the locale seat.
     * @returns the dialog.
     */
    function DeleteConfirmForm({ request, onSettle, deleteSession, t }) {
      const [busy, setBusy] = react.useState(false);
      const [error, setError] = react.useState(null);
      const close = () => {
        if (busy) return;
        onSettle();
      };
      const confirm = () => {
        setBusy(true);
        setError(null);
        deleteSession(request.sessionId)
          .then(() => {
            setBusy(false);
            onSettle();
          })
          .catch((reason) => {
            setBusy(false);
            setError(reason instanceof Error ? reason.message : String(reason));
          });
      };
      const titled = typeof request.displayTitle === "string" && request.displayTitle.trim() !== "";
      return jsx(primitives.Modal, {
        open: true,
        onClose: close,
        closeLabel: t("dialog.close"),
        title: t("dialog.title"),
        description: t(titled ? "dialog.desc" : "dialog.descUntitled", { title: request.displayTitle }),
        footer: jsxs(Fragment, {
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
              children: t(busy ? "dialog.pending" : "dialog.confirm")
            })
          ]
        }),
        children: jsxs(Fragment, {
          children: [
            jsx("p", { className: "dsh-session-delete-note", children: t("dialog.note") }),
            jsxs("p", {
              className: "dsh-session-delete-meta",
              children: [
                t("dialog.sessionId"),
                ": ",
                jsx("span", { className: "dsh-session-delete-code", children: request.sessionId })
              ]
            }),
            error !== null &&
              jsx("p", { className: "dsh-session-delete-error", children: `${t("dialog.failed")}: ${error}` })
          ]
        })
      });
    }
    //#endregion

    //#region wiring
    /**
     * The injected behavior: delete on the host, then pull a fresh Session
     * baseline so the row leaves the sidebar even if the removal event is missed.
     * @param ctx - client root context (sessions service).
     * @returns the row's delete action.
     */
    function createDeleteSession(ctx) {
      return async (sessionId) => {
        const value = await postJson(API_DELETE, { sessionId });
        try {
          await ctx.sessions?.refresh?.();
        } catch (error) {
          console.warn("[dsh-session-delete] Session baseline refresh failed:", error);
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
              deleteSession: createDeleteSession(ctx)
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
