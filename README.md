# Session Delete for DSH

**Permanently delete a session** — the one thing DeepSeek Harness cannot do.

[English](#english) · [中文](#中文)

---

## English

Adds a **Delete session permanently** row to the sidebar session **“⋯” menu**. After a
confirmation dialog it erases the session for good: its log directory on disk, its projection
cache, and its links to every workspace — and every open window drops the row immediately.

### Why this plugin exists

DSH ships `archiveSession` and nothing else. Two behaviours leave sessions that can never be
removed from the interface:

- **Deleting a workspace only ungroups its sessions.** The confirmation says it verbatim:
  *"This removes “…” from the workspace list. The folder and session logs will be kept. Its
  sessions will appear under Ungrouped."* So the sessions fall into **Ungrouped**, and deleting
  the folder afterwards changes nothing — the logs still live under `$DSH_HOME/sessions`.
- **The persistence seam has no deletion API.** Its own documentation states:
  *"Nothing deletes session files — logs accumulate under `root` until removed externally; the
  seam has no deletion API."*

This plugin closes that gap. It is the difference from the other session-menu plugins: it does
not stop at a UI action, it removes the **on-disk session record** and cleans up everything that
pointed at it.

### What it does

| Step | Action |
|---|---|
| 1 | Validates `sessionId` (one path segment, no `..`) |
| 2 | Scans `<sessionsRoot>/<projectKey>/<sessionId>` (the project key is a lossy encoding of the cwd, so it is scanned, never inverted) |
| 3 | `404` when there is nothing to delete · `409` while the session is live in memory (switch away first) |
| 4 | Detaches the session from every workspace through the registry entity API and unpins it |
| 5 | `fs.rm(dir, { recursive: true, force: true })` — the real deletion |
| 6 | Removes `storages/session_projcache/sessions/<id>.json` |
| 7 | Emits `api-session/removed`, so every open client drops the row |

The client then calls `ctx.sessions.refresh()` to make sure the row is gone.

### Install

From the market (once listed):

```
dsh plugin --profile web add github:spidu-lee/dsh-session-delete
```

Or add it to a profile patch by hand:

```yaml
# cordis.patch.yml
- insert:
    - id: session-delete
      name: 'dsh-session-delete'
```

The package declares both `dsh.bundle.patch` and `dsh.client` (`platform: web`), so it installs
as a normal bundle. **Restart DSH after installing**: the host half mounts its route family at
startup.

> `"private": true` is intentional. An unrelated npm package already owns the name
> `dsh-session-delete`, so this plugin is distributed from GitHub only.

### The menu row and the dialog

| | |
|---|---|
| Slot | `sidebar.workspaces.session.menu.item` |
| Row id | `dsh-session-delete.session.delete` |
| Order | `500` (after the shipped pin 100 / rename 200 / fork 300 / archive 400) |
| Style | ui-primitives `MenuItemButton` with `danger` + `separatorBefore`, icon `IconTrashOutlineRegular` |

The confirmation is **not** `window.confirm` — that is a native Electron dialog whose chrome is
the window title, and it can be neither themed nor localized. This plugin reuses the ui-primitives
`Modal` that the shipped archive confirmation uses, so the mask, card, radius, elevation and
focus trap are the host's own.

| | |
|---|---|
| Slot | `shell.overlay` |
| Entry id | `dsh-session-delete.session-delete-confirm` |

- The row and the dialog are decoupled by a module-scoped pending-request store
  (`useSyncExternalStore`): the row only files a request, `shell.overlay` renders exactly one
  dialog for the current request, so in-flight and error state cannot leak.
- The danger button is themed: text and border `--dsw-alias-state-error-primary`, hover background
  `--dsw-alias-interactive-bg-hover-danger`. The stylesheet is injected once
  (`<style data-plugin-css="dsh-session-delete/client.css">`) and removed when the plugin unloads.
- On failure the dialog **stays open** and shows the host's own error text (for example the 409
  "the session is running, switch away first").

### Localization

- **UI strings** use `ctx.locale.register(ns, locale, dict)` in the namespace
  `dsh-session-delete`; the slot registration carries `locale: NS` to receive an injected `t`, so
  switching the interface language takes effect immediately. Keys: `menu.deleteSession`,
  `dialog.title`, `dialog.desc`, `dialog.note`, `dialog.confirm`, `dialog.cancel` (zh + en).
- **Package metadata** (the name and description shown on the plugin card) follows DSH's official
  convention: `locale/en.json` and `locale/zh.json` next to `package.json`, each shaped
  `{"meta": {"title": …, "description": …}}`, with `"./locale/*.json"` exported. The host's
  `readPluginMeta()` picks the language up on its own.

### Security

- The route family sits behind the shared **loopback trust fence**: the peer socket address must
  be 127/8 or `::1`, `Host` must be a loopback authority, `sec-fetch-site: cross-site` is
  rejected outright, and a present `Origin` must match `Host`. `X-Forwarded-For` is never trusted.
- Only `<sessionsRoot>/<projectKey>/<sessionId>` is ever removed, and the target is re-asserted
  inside the root with `path.relative` immediately before removal.
- Request bodies are capped at 64 KiB and only `POST` is accepted.
- Deletion is **irreversible**, so the confirmation is mandatory. There is deliberately no trash
  can.
- `POST api/dsh-session-delete/info` reports the active session roots and the live session ids,
  which is what you want when a deletion is refused.

### Offline self-test

`test/dry-run.mjs` drives both route handlers with a temporary directory and a fake cordis context,
covering invalid ids, unknown ids, a non-loopback `Host`, a live session, and a concurrent second
delete:

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
& 'D:\Program Files\DeepSeek Harness\DeepSeek Harness.exe' 'D:\DSHWorkSpace\dsh-session-delete\test\dry-run.mjs'
```

### Compatibility and known limits

- Built against DSH `0.2.0-rc.2` (desktop runtime). The host half imports nothing but `node:os`,
  `node:path` and `node:fs`; the browser half requires `react`, `react/jsx-runtime` and
  `@deepseek-ai/dsh-client-ui-primitives` through the harness module loader.
- If the session is open in another window it stays in memory, so deletion is refused with 409
  rather than corrupting a live writer.
- Removing the log directory is the deletion; there is no recycle bin and no undo.

### License

MIT

---

## 中文

在左侧会话行的 **「⋯」菜单**里加一行 **「彻底删除会话」**。确认之后它会把会话真正抹掉：
磁盘上的日志目录、投影缓存、以及它在每个工作区里的关联，并且所有已打开的窗口立刻移除该行。

### 为什么需要它

DSH 内置只有 `archiveSession`，没有删除。有两种行为会留下**永远删不掉**的会话：

- **删除工作区只是把会话「解组」。** 确认框原文写着：*「这会把『…』从工作区列表里移除。
  文件夹和会话日志会保留。它的会话将出现在未分组下。」* 于是会话掉进**「未分组」**，
  之后再去删文件夹也没用——日志仍然躺在 `$DSH_HOME/sessions` 里。
- **持久化层没有删除 API。** 它自己的文档写得很直白：*「没有任何东西会删除会话文件——
  日志在 `root` 下不断堆积，直到被外部删除；这个接缝没有删除 API。」*

本插件补上这个缺口。这也是它和其他会话菜单插件的区别：它不停留在界面动作，
而是真正删掉**磁盘上的会话记录**，并清理所有指向它的东西。

### 它做了什么

| 步骤 | 动作 |
|---|---|
| 1 | 校验 `sessionId`（单段路径名，禁止 `..`） |
| 2 | 扫描 `<sessionsRoot>/<projectKey>/<sessionId>`（projectKey 是 cwd 的有损编码，只能扫，不能反推） |
| 3 | 没找到 → `404`；会话仍在内存里（正在打开/运行）→ `409`，提示先切换会话 |
| 4 | 通过 registry 实体 API 把会话从所有工作区解绑，并取消置顶 |
| 5 | `fs.rm(dir, { recursive: true, force: true })` —— 真正的删除 |
| 6 | 删除 `storages/session_projcache/sessions/<id>.json` |
| 7 | 广播 `api-session/removed`，所有已打开的客户端据此移除该行 |

随后客户端会调用 `ctx.sessions.refresh()` 重新拉一次基线，确保行一定消失。

### 安装

上架之后可以在市场里直接装：

```
dsh plugin --profile web add github:spidu-lee/dsh-session-delete
```

或者手动写进 profile patch：

```yaml
# cordis.patch.yml
- insert:
    - id: session-delete
      name: 'dsh-session-delete'
```

包同时声明了 `dsh.bundle.patch` 与 `dsh.client`（`platform: web`），可以作为一个普通 bundle 安装。
**装完请重启 DSH**：宿主半边在启动时挂载路由。

> `"private": true` 是刻意的。npm 上的 `dsh-session-delete` 已经被一个不相关的包占用，
> 所以本插件只从 GitHub 分发。

### 菜单行与确认框

| | |
|---|---|
| 座位（slot） | `sidebar.workspaces.session.menu.item` |
| 行 id | `dsh-session-delete.session.delete` |
| order | `500`（内置 pin 100 / rename 200 / fork 300 / archive 400 之后） |
| 样式 | ui-primitives `MenuItemButton` 的 `danger` + `separatorBefore`，图标 `IconTrashOutlineRegular` |

确认框**不是** `window.confirm`——那是 Electron 原生对话框，标题栏就是窗口标题，
既无法改样式也无法本地化。本插件复用内置归档确认框所用的 ui-primitives `Modal`：
遮罩、卡片、圆角、层级阴影、焦点陷阱都由组件自带，外观与 DSH 一致。

| | |
|---|---|
| 座位（slot） | `shell.overlay` |
| 条目 id | `dsh-session-delete.session-delete-confirm` |

- 菜单行与对话框通过模块内的 pending-request store（`useSyncExternalStore`）解耦：
  菜单行只登记请求，`shell.overlay` 只渲染**当前这一个**确认框，取消/关闭即清空，
  因此在途与错误状态不会残留。
- 危险按钮用主题变量上色：文字与描边 `--dsw-alias-state-error-primary`，hover 底色
  `--dsw-alias-interactive-bg-hover-danger`。样式表只注入一次
  （`<style data-plugin-css="dsh-session-delete/client.css">`），随插件卸载一并移除。
- 删除失败时对话框**不关闭**，把宿主返回的错误原文显示在框内（例如 409「会话正在运行，请先切换」）。

### 本地化

- **界面文案**由 `ctx.locale.register(ns, locale, dict)` 提供，命名空间 `dsh-session-delete`；
  槽注册时带 `locale: NS` 以取得注入的 `t`，切换界面语言即时生效。键：`menu.deleteSession`、
  `dialog.title`、`dialog.desc`、`dialog.note`、`dialog.confirm`、`dialog.cancel`（中文 + 英文）。
- **包元信息**（插件卡片上的名称与介绍）遵循 DSH 官方约定：`package.json` 旁边放
  `locale/en.json` 与 `locale/zh.json`，结构为 `{"meta": {"title": …, "description": …}}`，
  并在 `exports` 里暴露 `"./locale/*.json"`。宿主的 `readPluginMeta()` 会自行取用。

### 安全

- 路由走共享的 **loopback 信任栅栏**：对端 socket 地址必须是 127/8 或 `::1`，`Host` 必须是
  loopback 权威，`sec-fetch-site: cross-site` 直接拒绝，带 `Origin` 时其 host 必须与 `Host`
  相同。`X-Forwarded-For` 永不采信。
- 只删 `<sessionsRoot>/<projectKey>/<sessionId>`，且删除前再次用 `path.relative` 断言目标在根目录之内。
- 请求体上限 64 KiB；只接受 `POST`。
- 删除**不可恢复**，所以确认框是强制的，且刻意不做「回收站」。
- `POST api/dsh-session-delete/info` 返回当前会话根目录与内存中活跃的会话 id，
  删除被拒绝时用它排查最直接。

### 离线自测

`test/dry-run.mjs` 用临时目录 + 伪造的 cordis 上下文直接驱动两个路由处理器，
覆盖非法 id、未知 id、非 loopback Host、活跃会话、并发二次删除等分支：

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
& 'D:\Program Files\DeepSeek Harness\DeepSeek Harness.exe' 'D:\DSHWorkSpace\dsh-session-delete\test\dry-run.mjs'
```

### 兼容性与已知限制

- 针对 DSH `0.2.0-rc.2`（桌面运行时）开发。宿主半边只 import `node:os`、`node:path`、`node:fs`；
  浏览器半边通过 harness 模块加载器 require `react`、`react/jsx-runtime`、
  `@deepseek-ai/dsh-client-ui-primitives`。
- 会话若在其它窗口打开，仍在内存中，此时会返回 409 拒绝删除，而不是破坏正在写入的进程。
- 删掉日志目录就是删除本身：没有回收站，没有撤销。

### 许可证

MIT
