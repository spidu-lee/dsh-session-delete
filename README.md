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
| 3 | `404` when there is nothing to delete |
| 4 | Asks the `workspace/session-activity` waterfall what still runs — the same question `archive` asks — and, if anything does, dispatches `workspace/session-stop` (the fan-out `archive` uses for `stopActivity`) and re-polls until it settles |
| 5 | `409` only when that work *refuses to settle*; the message names what is still running. The waterfall reports it entry by entry, which is the only honest busy signal: a live **Agent** exists for any session a window has open, working or not |
| 6 | Dispatches `workspace/session-stop` for a session that is merely **loaded** in memory, so it cannot flush its header back to disk after the removal |
| 7 | `fs.rm(dir, { recursive: true, force: true })` — the real deletion |
| 8 | Stats the directory again, up to 4 rounds 350 ms apart, and answers `delete-resurrected` instead of success if a writer puts it back |
| 9 | Detaches the session from every workspace through the registry entity API and unpins it — only *after* the files are gone, so a failure cannot orphan a workspace link |
| 10 | Removes `storages/session_projcache/sessions/<id>.json` (best effort, reported as a warning) |
| 11 | Asks whether the session is *still listed* — live in the host's store, or held by the persistence layer as created-but-unmaterialized — and says so as a warning rather than claiming a clean success |
| 12 | Emits `api-session/removed`, so every open client drops the row |

The client then applies that removal to its own list locally, which is not the same thing as
refreshing: see [below](#the-menu-row-and-the-dialog).

**Why steps 4–6 and 8 exist.** A session that is still resident in the host can flush its header back
to disk a fraction of a second after the removal — which is how a deleted conversation used to
reappear in the sidebar after a restart. The browser half now leaves the session first
(see [below](#the-menu-row-and-the-dialog)) and the host verifies that nothing came back.

**Why step 11 exists.** Deleting the files does not make the host forget the session. The list the
sidebar renders is *live-preferred*: it merges the in-memory store with the persisted corpus, and the
persistence layer also lists sessions this process created but never materialized. The row is removed
in the window that asked for the deletion (see below), but the two holders stay, and they do **not**
carry the same risk:

- a **resident Session** in the host's store can flush its header back to disk, so that log may
  reappear and the conversation may be listed again after a restart;
- a **pending entry** in the persistence layer only lives inside this process and disappears with it.

Neither can be cleared by a plugin — there is no removal API on `sessions`, and the tracker's
`pending` map is internal (only `hasPendingSession(id)` is public) — so the deletion reports which one
it found instead of claiming the operation was completely clean.

**Why the liveness question is a waterfall and not `agents.get`.** An earlier revision refused the
deletion whenever the Agent registry held the session. That is not a busy signal: DSH keeps an Agent
alive for any session a window has open, so a perfectly idle conversation was refused with "it is
still running". `workspace/session-activity` is what `archiveSession` itself consults, and its
providers are the ones that actually know — the Agent registry reports *the running turn*, alongside
owned jobs, subagent descendants and active schedules.

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
- The dialog reads the session's **local retention** through `ctx.get("sessions").retainInfo(id)`
  and says up front which case it is looking at: `dialog.noteOpen` ("opened in this window"),
  `dialog.noteHeld` ("held here"), or `dialog.note`.
- **Deleting the conversation you are looking at is handled, not refused.** If the row you clicked
  is the one in the Main view, the dialog first navigates to another session
  (`uiWorkspace.openSession`, or `startSession()` when the workspace has no other row), waits for
  the `mainView` reference count to drop, lets the release reach the host, and only then deletes.
  If that release does not happen within 5 s the deletion is **cancelled** with
  `dialog.stillOpen` — a clear refusal beats a resurrection.
- The danger button is themed: text and border `--dsw-alias-state-error-primary`, hover background
  `--dsw-alias-interactive-bg-hover-danger`. The stylesheet is injected once
  (`<style data-plugin-css="dsh-session-delete/client.css">`) and removed when the plugin unloads.
- On failure the dialog **stays open** and shows the host's own error text, with the known
  refusals mapped to their own messages (`dialog.blockedRunning` when work would not settle,
  `dialog.blockedResurrected` when the log came back). A warning that accompanies a refusal is
  listed too — that is where the instruction for what to do next lives.
- After a successful delete the row is removed by calling `sessions.handleSessionRemoved(id)` —
  the same entry point the `api-session/removed` relay uses — rather than by refreshing the
  baseline. The two are not equivalent: a refresh merges against the host's answer with
  "identities absent from the baseline are removed", so a session the host still lists is
  *inserted back*, leaving the row stranded under Ungrouped. A refresh is only the fallback for a
  client that does not expose the removal entry point.
- If the host reports non-fatal `warnings` (a projection-cache miss, a workspace that could not be
  unpinned), the dialog switches to a read-only **done** state that lists them instead of closing
  on a false success.

### Localization

- **UI strings** use `ctx.locale.register(ns, locale, dict)` in the namespace
  `dsh-session-delete`; the slot registration carries `locale: NS` to receive an injected `t`, so
  switching the interface language takes effect immediately. Keys: `menu.deleteSession`,
  `dialog.title`, `dialog.desc`, `dialog.descUntitled`, `dialog.note`, `dialog.noteOpen`,
  `dialog.noteHeld`, `dialog.sessionId`, `dialog.confirm`, `dialog.switching`, `dialog.pending`,
  `dialog.cancel`, `dialog.close`, `dialog.failed`, `dialog.stillOpen`, `dialog.noTarget`,
  `dialog.blockedRunning`, `dialog.blockedResurrected`, `dialog.notFound`, `dialog.badRequest`,
  `dialog.forbidden`, `dialog.deleteFailed`, `dialog.warnings`, plus one `warning.*` key per
  warning code (zh + en).
- **The host never sends prose.** It has no idea which language the requesting window is in, so a
  warning crosses the wire as `{ code, params, message }` and an error as
  `{ code, message, params }`. The dialog renders `warning.<code>` / `dialog.<code>` through the
  injected `t`, interpolating `params`; `message` is the host's English sentence, used only as the
  fallback when the browser half does not know the code (an older client against a newer host must
  not render a blank line). The codes today are `corpus-held-live`, `corpus-held-pending`,
  `activity-stop-failed`, `activity-unavailable`, `workspace-registry-missing`,
  `workspace-list-failed`, `workspace-detach-failed`, `unpin-failed`, `projection-cache-failed`,
  `directory-rewritten` and `emit-failed`.
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
- `POST api/dsh-session-delete/info` reports the active session roots, **whether each service
  actually resolved** (`services.sessions` / `.workspaceRegistry` / `.sessionPersistence`) and
  whether the `workspace/session-activity` waterfall can be dispatched at all
  (`activityWaterfall`), plus the ids currently loaded. A `false` anywhere is the signature of a
  liveness check that has silently degraded to "nothing is running", which is exactly the bug that
  let a deleted session be written back — so check it first when a deletion is refused.
- Add `?sessionId=<id>` to that same request and it also answers the liveness question for that one
  session — `{"asked":true,"summary":"turn×1","entries":[…]}` — and a `corpus` block saying which
  source would still list that session now (`live`, `pending`, `listed`, `persisted`). "Why was my
  deletion refused, or why is the row still there?" is answered directly by it.

### Offline self-test

`test/dry-run.mjs` drives both route handlers with a temporary directory and a fake cordis context,
covering invalid ids, unknown ids, a non-loopback `Host`, work that stops when asked, work that
refuses to settle, a merely-loaded session, an idle session, the delayed verification pass, a
concurrent second delete, a session still resident in the host store, a session the persistence layer
still holds as pending, and the service/waterfall/corpus probes:

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
& 'D:\Program Files\DeepSeek Harness\DeepSeek Harness.exe' 'D:\DSHWorkSpace\dsh-session-delete\test\dry-run.mjs'
```

> A fake context cannot prove that the **real** host resolves `ctx.sessions` or dispatches
> `workspace/session-activity`. Always follow this up against a restarted DSH with `POST …/info` and
> read its `services` and `activityWaterfall` fields; the original silent-guard bug passed every
> offline check.

### Compatibility and known limits

- Built against DSH `0.2.0-rc.2` (desktop runtime). The host half imports nothing but `node:os`,
  `node:path` and `node:fs`; the browser half requires `react`, `react/jsx-runtime` and
  `@deepseek-ai/dsh-client-ui-primitives` through the harness module loader.
- The host half declares `inject = ["webServer", "sessions"]`. Declaring the session store is
  deliberate: an unresolved service must not look like "no session is loaded", because that is what
  silently disables the removal-verification policy. `agents` is deliberately **not** declared —
  see "Why the liveness question is a waterfall" above.
- A session open in **another window** keeps a live generation there. The host stops its activity
  and re-checks the directory, but a window that reopens the session afterwards can still rewrite
  the header; the plugin reports that as `delete-resurrected` rather than claiming success.
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
| 3 | 没找到 → `404` |
| 4 | 用 `workspace/session-activity` waterfall 询问该会话还有什么在跑——**与内置归档 `archiveSession` 问的是同一个问题**；若有，就派发 `workspace/session-stop`（归档 `stopActivity` 用的同一条扇出）并**轮询直到它真的停下来** |
| 5 | 只有在那份工作**停不下来**时才 `409`，且消息里点名还在跑的是什么。这个 waterfall 逐项报告，是唯一诚实的「忙」信号：Agent 注册表对任何被窗口打开过的会话都有一条记录，不管它在不在干活 |
| 6 | 会话只是**加载在内存里** → 也派发 `workspace/session-stop`，让它没法在删除之后把 header 再写回磁盘 |
| 7 | `fs.rm(dir, { recursive: true, force: true })` —— 真正的删除 |
| 8 | 再次 stat 该目录，最多 4 轮、每轮间隔 350 ms；若被重新写回，返回 `delete-resurrected` 而不是假装成功 |
| 9 | 通过 registry 实体 API 把会话从所有工作区解绑，并取消置顶——**只在文件确实删掉之后**才做，失败时不会留下「工作区里没了、磁盘上还在」的孤儿状态 |
| 10 | 删除 `storages/session_projcache/sessions/<id>.json`（尽力而为，失败记入告警） |
| 11 | 追问该会话**是否仍被列为存在**——在宿主内存里活着，或被持久化层记作「已创建但尚未落盘」——并把这些如实写成告警，而不是谎报干净成功 |
| 12 | 广播 `api-session/removed`，所有已打开的客户端据此移除该行 |

随后客户端会把这个移除**直接应用到自己的列表上**——这和「刷新基线」不是一回事，见下文。

**为什么需要第 11 步。** 删掉文件并不会让宿主忘记这个会话。侧边栏渲染的列表是**内存优先**的：
它把内存中的会话存储与磁盘语料合并，而持久化层还会额外列出「本进程已创建但尚未落盘」的会话。
行本身会在发起删除的那个窗口里被移除（见下文），但这两个来源会留下，而且它们的**风险并不相同**：

- 宿主存储里**活着的 Session** 能把 header 再次落盘，所以那份日志可能回来，重启后这个会话可能
  又被列出来；
- 持久化层里的 **pending 记录**只活在本次进程内，随进程结束一起消失。

插件清不掉任何一个——`sessions` 上没有任何移除 API，tracker 的 `pending` 表也是内部的
（公开的只有 `hasPendingSession(id)`）——所以删除会如实报告碰到的是哪一种，而不是声称完全干净。

**为什么需要第 4–6、8 步。** 仍然驻留在宿主内存里的会话，会在目录被删掉之后的一瞬间把 header
重新 flush 回磁盘——这正是「删掉的对话重启后又冒出来」的成因。现在浏览器半边会先离开该会话
（见下文），宿主再复查确认没有被写回。

**为什么「在不在运行」要问 waterfall，而不是 `agents.get`。** 早先的版本只要 Agent 注册表里有
这个会话就拒绝删除。那不是「忙」的信号：DSH 对任何被窗口打开过的会话都会保留一个 Agent，
于是一个完全空闲的会话会被回一句「该会话仍在运行」。`workspace/session-activity` 才是
`archiveSession` 自己会问的那个问题，它的提供方才真正知道答案——Agent 注册表报的是
**正在跑的回合**，另外还有所属任务、subagent 子孙和活跃提醒。

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
- 确认框会通过 `ctx.get("sessions").retainInfo(id)` 读取该会话在**本窗口的保留计数**，
  并据此在开头就说清是哪种情况：`dialog.noteOpen`（正打开在当前窗口）、
  `dialog.noteHeld`（被本窗口持有）、或 `dialog.note`。
- **删「正在看的这一条」是被处理的，不是被拒绝的。** 如果点的那一行正是主视图里的会话，
  确认框会先切到另一个会话（`uiWorkspace.openSession`；工作区里没有别的会话时用
  `startSession()`），等 `mainView` 引用计数归零、并给释放留出到宿主的时间，然后才真正删除。
  若 5 秒内释放不掉，删除会被**取消**并提示 `dialog.stillOpen`——宁可明确拒绝，也不要制造幽灵会话。
- 危险按钮用主题变量上色：文字与描边 `--dsw-alias-state-error-primary`，hover 底色
  `--dsw-alias-interactive-bg-hover-danger`。样式表只注入一次
  （`<style data-plugin-css="dsh-session-delete/client.css">`），随插件卸载一并移除。
- 删除失败时对话框**不关闭**，把宿主返回的错误原文显示在框内；已知的几种拒绝各有专属文案
  （`dialog.blockedRunning` = 有活儿停不下来，`dialog.blockedResurrected` = 日志被写回）。
  随同拒绝一起返回的告警也会列出来——「接下来该怎么做」通常就写在那里。
- 删除成功后，那一行是通过调用 `sessions.handleSessionRemoved(id)` 移除的——**就是
  `api-session/removed` 中继自己用的那个入口**——而不是刷新基线。两者不等价：刷新会拿宿主的
  回答做合并，规则是「基线里没有的 id 才删」，于是宿主仍在列出的会话会被**重新插回来**，
  那一行就卡在「未分组」里。只有客户端不提供该移除入口时才回退到刷新。
- 宿主返回非致命 `warnings`（投影缓存没删掉、某个工作区解绑失败等）时，对话框进入只读的
  **完成态**把它们列出来，而不是假成功直接关掉。

### 本地化

- **界面文案**由 `ctx.locale.register(ns, locale, dict)` 提供，命名空间 `dsh-session-delete`；
  槽注册时带 `locale: NS` 以取得注入的 `t`，切换界面语言即时生效。键：`menu.deleteSession`、
  `dialog.title`、`dialog.desc`、`dialog.descUntitled`、`dialog.note`、`dialog.noteOpen`、
  `dialog.noteHeld`、`dialog.sessionId`、`dialog.confirm`、`dialog.switching`、`dialog.pending`、
  `dialog.cancel`、`dialog.close`、`dialog.failed`、`dialog.stillOpen`、`dialog.noTarget`、
  `dialog.blockedRunning`、`dialog.blockedResurrected`、`dialog.notFound`、`dialog.badRequest`、
  `dialog.forbidden`、`dialog.deleteFailed`、`dialog.warnings`，外加**每个告警码一个
  `warning.*` 键**（中文 + 英文）。
- **宿主从不发送散文。** 它根本不知道发起请求的窗口是什么语言，所以告警以
  `{ code, params, message }` 过线，错误以 `{ code, message, params }` 过线。对话框用注入的 `t`
  渲染 `warning.<code>` / `dialog.<code>` 并把 `params` 插进去；`message` 是宿主那句英文，
  只在浏览器半边不认识这个码时兜底（旧客户端遇上新宿主**不能**渲染出空白行）。
  目前的告警码：`corpus-held-live`、`corpus-held-pending`、`activity-stop-failed`、
  `activity-unavailable`、`workspace-registry-missing`、`workspace-list-failed`、
  `workspace-detach-failed`、`unpin-failed`、`projection-cache-failed`、`directory-rewritten`、
  `emit-failed`。
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
- `POST api/dsh-session-delete/info` 返回当前会话根目录、**每个服务是否真的解析成功**
  （`services.sessions` / `.workspaceRegistry` / `.sessionPersistence`）、
  `workspace/session-activity` waterfall 能不能派发（`activityWaterfall`），
  以及当前加载在内存里的 id。任何一项为 `false` 就是「活性检查已静默退化成永远认为没有东西在跑」
  的特征——也就是当初让被删会话被写回磁盘的那个 bug，所以删除被拒绝时先看这一项。
- 同一个请求加上 `?sessionId=<id>`，它会顺带回答那一个会话的活性问题
  （`{"asked":true,"summary":"turn×1","entries":[…]}`），并给出一个 `corpus` 块说明**现在还有哪个
  来源会列出这个会话**（`live` / `pending` / `listed` / `persisted`）。「我的删除为什么被拒」和
  「行为什么还在」都能直接由它回答。

### 离线自测

`test/dry-run.mjs` 用临时目录 + 伪造的 cordis 上下文直接驱动两个路由处理器，
覆盖非法 id、未知 id、非 loopback Host、能停下来的运行中工作、停不下来的工作、仅仅是加载在
内存里的会话、空闲会话、仍驻留在宿主存储里的会话、被持久化层记作 pending 的会话、
延迟复查、并发二次删除，以及服务/waterfall/corpus 探针：

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
& 'D:\Program Files\DeepSeek Harness\DeepSeek Harness.exe' 'D:\DSHWorkSpace\dsh-session-delete\test\dry-run.mjs'
```

> 伪造的上下文**无法证明真实宿主能解析 `ctx.sessions`、也无法证明它能派发
> `workspace/session-activity`**。务必在重启过的 DSH 上用 `POST …/info` 复查它的 `services` 与
> `activityWaterfall` 字段——当初那个「守卫静默失效」的 bug 通过了全部离线检查。

### 兼容性与已知限制

- 针对 DSH `0.2.0-rc.2`（桌面运行时）开发。宿主半边只 import `node:os`、`node:path`、`node:fs`；
  浏览器半边通过 harness 模块加载器 require `react`、`react/jsx-runtime`、
  `@deepseek-ai/dsh-client-ui-primitives`。
- 宿主半边声明 `inject = ["webServer", "sessions"]`。声明会话存储是刻意的：服务没解析时绝不能
  看起来像「没有会话被加载」，那正是会让复查策略静默失效的情形。`agents` 则**刻意不声明**——
  原因见上文「为什么『在不在运行』要问 waterfall」。
- 会话若在**其它窗口**打开，那边会保留一个活着的 generation。宿主会停掉它的活动并复查目录，
  但如果那个窗口之后又把它打开，仍然可能把 header 写回去；此时插件报 `delete-resurrected`
  而不是声称成功。
- 删掉日志目录就是删除本身：没有回收站，没有撤销。

### 许可证

MIT
