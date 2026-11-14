# AI Office

A local task board and visual workplace for your own AI tools. See real running agents, assign work, inspect blocked tasks, and answer requests for information or approval. Claude Code, Codex, Gemini, local Ollama models and Grok Bot have different connection requirements; you can use only the providers you need.

**Status:** source installation for users comfortable with a terminal. Developed and smoke-tested on macOS; Linux/Windows are not yet certified end to end. This is not a hosted service or a one-click desktop installer. A browser and Node.js **24+** are required; provider accounts and subscriptions are separate.

## Try it first

Download this version's source ZIP and extract it (or clone the repository), then open a terminal in that folder:

```bash
npm ci
npm start
```

The browser opens at **http://127.0.0.1:5173/**. Keep the terminal open; Ctrl+C stops the office. No build step is needed for this local start. New installations let you explore without executing AI work. An empty room is normal until a real connected agent reports activity; installed skills do not create fake workers.

If the browser does not open, copy the printed URL. If startup fails, run `npm run doctor`. It checks the runtime, dependencies, configuration, writable folders, provider commands and missing reviewers without running AI or reading login credentials. It reports what to do next; a command being installed does not prove it is signed in.

## Connect your AI and finish a first task

1. Run `npm run setup -- --lang en` (Chinese: `npm run setup`). Choose an existing project folder, your preferred AI providers and the `enabled` mode. The app shows the same three-step guide in English and Chinese. To edit an existing setup, use `npm run setup -- --overwrite --lang en`; a backup is retained.
2. Sign into the provider CLI you selected. Claude/Codex can use their CLI subscription login. For Claude activity figures, also run `npm run connect:claude`, then restart Claude sessions. For a local model, start Ollama and choose a model already shown by `ollama list`. Gemini currently requires the Antigravity-compatible `agy` interface; a different `gemini` CLI is not interchangeable. Grok Bot instructions are under Dispatch. Restart the office with `npm start` after setup changes.
3. Open Tasks, add a small request such as checking README typos, choose its folder/provider, and enable **Auto pickup**. Read the card's wait reason if it does not start. Code work requires an independent enabled and signed-in Claude/Codex reviewer; an author cannot approve its own review.

The guide stays available above the office. Running agents and each reported subagent can be clicked to see their identity, parent, status and project. Idle agents are grouped. External frameworks must report lifecycle events to show their children; merely enabling a provider does not establish a live connection.

**Common problems:**

- **Cannot connect / black page:** keep the server running, check its printed URL and run `npm run doctor`. A static `dist` upload cannot provide the local task board or AI connections.
- **Task stays pending:** inspect its wait reason, Auto pickup, provider login, quota, project folder and reviewer. Resolve the cause before retrying a blocked card.
- **Phone cannot connect:** `127.0.0.1` on the phone is the phone itself. Use the paired mobile gateway in the installation guide; do not expose the local server directly to the internet.
- **Port occupied:** stop the previous office or start a separate installation/data directory with `npm start -- --port 5174`. Use the printed port for external Bot commands (`AI_OFFICE_URL`).
- **Nothing happens after changing settings:** restart the office. Setup saves settings; it does not install models, sign in, or turn on Auto pickup.

[完整中文安装、迁移与手机使用指南](docs/INSTALL.zh-CN.md)

## Configuration and privacy

Local settings live in `~/.ai-office/config.json`, outside Git. `AI_OFFICE_CONFIG` selects another settings file; `AI_OFFICE_HOME` selects private runtime data; `AI_OFFICE_WORKSPACE` selects a workspace. The default is `disabled` with providers and automatic pickup off. `disabled` and `read-only` do not start AI tasks or contact AI services. Credentials stay in provider login stores or supported environment variables, never in configuration JSON or Git.

Board scheduling supports 1–8 workers each for Claude/Codex/Gemini, and 1 for Local Qwen/Grok Bot. An office that displays hundreds of external agents does not promise that many simultaneous scheduled workers. Independent coding jobs need separate worktrees. Supported routing and migration details are in the installation guide; preserve user-held task IDs before enabling migrated data.

For a production build use `npm run build` then `npm run preview` (normally port 4173). Run `npm test` for automated checks. `npm start -- --no-open` keeps browser opening manual.

## License and source distribution

AI Office code is licensed under [MIT](LICENSE). Third-party assets and npm dependencies retain their original licenses; see [NOTICE](NOTICE) and the asset attribution files.

```bash
npm run package:source -- --output /path/to/new/ai-office-source
```

This creates a source directory from individually tracked allowlisted files, including LICENSE and NOTICE. It excludes Git history, private reports, local data, credentials, dependencies and builds. Heuristic checks reject obvious private paths and credentials. Review the contents before sharing; scanning is not a complete privacy guarantee. `SOURCE-MANIFEST.json` records the source revision and file hashes. New files must be tracked before packaging. The recipient installs dependencies and uses their own accounts; no runtime data or account transfers.

## Codex activity

When the Codex provider is enabled in an enabled office, activity observation is automatic and read-only. It uses the local Codex state database and held writer locks to identify sessions, then projects only lifecycle and tool-name metadata from bounded activity-file tails. No model call, API key, hook installation or permission change is needed. `CODEX_HOME` is supported for another local Codex configuration.

Shared-office roles use explicit role/path and tool metadata. Root coordinators are Facilitators; operations and administration map to Admin; review and quality work map to Tester; other contributors are Helpers. This is an office classification and does not change agent permissions or runtime instructions. Workers keep stable identities and seats as other workers arrive or their status changes.

The status response never includes messages, prompts, reasoning, tool arguments/results or credentials. Runtime formats can change; missing lifecycle evidence is handled conservatively rather than inventing running work.

## Claude Code activity

```bash
npm run connect:claude
```

Optional: if you have installed and enabled `gamedev@awesome-gamedev-agent-skills`, this connection command uses your installation. This plugin is not bundled or required for the general office. It creates one user-level Claude subagent per installed skill (the count depends on the installed plugin), plus `ai-office-gamedev-router`, with the corresponding plugin skill preloaded. Existing Claude settings and unrelated agents are preserved; changed files are backed up under `~/.claude/ai-office/backups/`. Rerun after updating the skill plugin. Installation is idempotent.

Restart existing Claude Code sessions once to load newly installed agents and hooks. For example, ask Claude Code to use `ai-office-gamedev-router` to choose specialists, or `ai-office-threejs-scene-setup` to work on a scene. Claude’s normal permissions and model settings still apply. All actual working sessions and subagents appear in the shared Claude studio, including those working on other local projects. A skill installation alone never creates a person in the office.

The status endpoint reads installation metadata, live session metadata and sanitized lifecycle events under `~/.claude/ai-office/events/`; its payload remains metadata-only. Click the Claude room or its resident to open **Claude workspace**: each observed online agent has an independent, scrollable task-instruction and activity panel. Running/waiting agents appear by default; choose All online to include idle agents, or search by agent, project or instruction. Scrolling up pauses following; Follow latest resumes it.

Claude activity uses a shared local event connection: saved lifecycle changes, new instructions and background-task updates refresh the views together. The workspace shows whether event sync is connected or a source is using polling. A lost connection reconnects automatically with 2/4-second polling while it recovers; healthy connections still reconcile every 30 seconds. The connection indicator describes synchronization, not proof that every agent is currently executing.

The workspace also shares **Dispatch conversation** with Grok Dispatch: the same persisted instructions, planning replies and linked task results appear in both places. Submit a new instruction from either view; unsent drafts survive navigation between them. Requests refresh every four seconds, and repeated submissions with the same request ID do not create duplicate instructions. Read-only installations can view history but cannot submit or retry. Grok Bot reads the office queue and writes plans back through the existing command interface; this does not mirror private Grok chats or send keystrokes to active Claude terminals.

An explicitly connected local preview can grant the narrower `dispatchInstructions` capability through `officeRelay`: only instruction submission/retry is forwarded to an existing loopback office, with its own same-origin/CSRF checks. Other writes remain disabled. A durable request journal protects legacy upstreams from repeated submissions, and uncertain results require checking history before retrying. A configured webhook is shown separately from a live Bot heartbeat; a saved instruction is not an execution acknowledgement.

An owner can explicitly opt into `officeRelay({ userActions: true })` to also expose task cards, batch card actions, question responses/re-requests, roles and the automatic-pickup toggle. The view advertises each capability separately and still runs no worker service. Both loopback offices enforce their own tokens; worker claim/finish, Bot impersonation, credential configuration and maintenance endpoints remain blocked. A failed write with an uncertain result is never automatically retried. This lets a newer local UI operate an existing office without starting a second runner or replacing its active work.

Dispatch synchronizes the office instruction queue and actual `apply-plan` replies, not private Grok chat history. When an API planner is not connected, the configured Bot webhook receives an `office.instructions.pending` event with instruction IDs/revisions, the local command interface and office URL. The Bot must use that URL (`AI_OFFICE_URL`, or the matching `--port`) to read `pending-instructions`, report its real `bot-heartbeat` and write the plan back with `apply-plan INSTRUCTION_ID`. It must still be able to execute commands on the office computer; accepting a webhook alone does not provide that access. Notification acceptance is persisted separately from human-question notifications, deduplicated per instruction revision, and retried on failure at five-minute intervals up to three attempts. The UI shows the latest queue read, manual refresh and notification status without treating acceptance as receipt, approval or execution. Relays reuse a newer upstream's delivery state instead of notifying twice.

The Codex workspace similarly shows observed main agents and subagents, with separate status filters, bounded readable instructions and public activity. `/api/codex/workspace` is read-only and loopback-only; it excludes internal reasoning, tool results and system content. Some Codex subagent assignments are encrypted in local logs and are explicitly marked unreadable instead of displaying inherited parent instructions. Missing status metadata is shown as unconfirmed. Neither Claude nor Codex private workspace endpoints are exposed through the phone gateway.

To group worktrees under an owner-approved project list, place `project-catalog.json` in the private office data directory. It is an array of `{ "id": "my-project", "name": "My project", "path": "/path/to/main", "folders": ["/path/to/worktree"] }` entries. Only listed projects become project cards; explicit folder aliases and their descendants are grouped for display and filtering. Task execution paths and historical records remain unchanged. Without a catalog, folder-based project discovery remains available.

Only while the workspace is open, `/api/claude/workspace` reads bounded head/tail windows of matching local session/subagent JSONL files (including nested workflow agents). It displays initial subagent assignment text, visible assistant messages, and selected tool-input fields such as command/path; up to 32 recent events per agent. Missing records and interrupted connections are labeled explicitly. Internal reasoning, attachments, system records and tool results are excluded. Common credential patterns are masked, but task text and paths remain private information: this is a local-only view, not a public sharing endpoint. Both APIs are read-only, no-store and same-origin loopback only; the mobile gateway does not expose the workspace. `CLAUDE_CONFIG_DIR` is supported for alternate installations. No agent is launched by viewing these panels.

The workspace also indexes **Background commands & workflows** through `/api/claude/background-tasks`: commands, monitors, workflows and pending Bash tool calls, with owner/task IDs, instructions and recorded terminal status. Choose the current process or full retained history, filter by session/type/status, search, and page through all matches. Initial indexing displays progress; subsequent reads follow appended records on source-change events, with polling as a fallback. Reading does not execute commands or inject messages. The endpoint is loopback-only, same-origin and GET-only, and is not exposed by the mobile gateway. It consumes structured task fields, not raw tool outputs or reasoning; common credentials are masked.

This is a persisted-event view, **not Claude's in-memory task registry**. A chat-message background-command summary, the native task panel, and full retained history have different scopes. Old launches without completion evidence become unconfirmed after a restart or owner termination. Missing/malformed source records and read failures are surfaced; the app does not claim complete historical reconstruction or zero-delay synchronization.


The observer runs on 11 lifecycle events, including `StopFailure`, and completes its local write before the next event. It exits successfully on errors and has a one-second timeout so a dashboard failure cannot stop Claude work. For a graceful disconnect, remove only hook entries ending in `--ai-office-managed` from Claude settings. Generated `ai-office-*.md` agents can be removed independently.

## Using the shared office

- Drag to rotate, scroll to zoom, or switch to the top-down seat map. Room controls and labels focus the Claude studio, Codex support area, Grok management suite and shared spaces.
- Open the directory to search runtime agents by provider, role, name or project. Filter by Running, Idle or Waiting. Only working agents can be located on the floor.
- Save manual project assignments, repository links, work briefs and progress. Add reports linked to projects and individual agents. These actions do not launch an AI agent or access a repository.
- Existing assignments and reports from all three floors migrate into Floor 03 without losing their original fields or IDs. The original v1 browser-storage entries remain intact; the shared office writes v2 entries. Old agent links are preserved rather than reassigned to a different worker by seat number.

Characters represent observed runtime agents. Legacy manual assignments and reports remain in browser storage. The executable task board is stored separately on this Mac.


## Task board and worker pickup

Open **Task board** in the sidebar or click its board in the 3D office. Add a request, details, and an absolute project folder. Choose Any, Claude Code, or Codex, a support role, and a priority. Requests without a folder remain pending. The board shows Pending, Working, Blocked, and Done, with each worker's result in the task details.

Automatic pickup is disabled for a new board. Enable it explicitly only after setup and provider login; it can be paused with its switch. Only installed, authenticated local CLIs can pick up requests. Claude Desktop activity does not establish that the standalone Claude CLI is signed in; check the readiness indicators. Provider concurrency is configured per installation; coding workers still cannot write to the same project folder concurrently. Use separate worktrees for independent coding tasks. The visual office still accommodates 100 Claude workers and 24 Codex workers from all sessions.

Workers retain normal CLI permissions. Codex uses workspace-write sandboxing; Claude denies unanswered permission prompts. Completion requires a successful CLI result and an explicit structured completion report. Interrupted, expired, failed, or timed-out work becomes Blocked and requires an explicit retry. A server restart never silently reruns interrupted work. Tasks and management requests persist in `~/.ai-office/board.sqlite` (`AI_OFFICE_HOME` can select another directory). Request text is intentionally saved and sent to the selected provider; full CLI logs and tool outputs are not exposed in the board.

## Grok Bot 聊天由使用者控制

Codex、Claude、Gemini、Qwen 及所有 AI、子代理和脚本均不得通过用户账号、本机 Grok Bot 应用或浏览器向 Grok Bot 聊天输入、粘贴或发送消息，进度同步、配置说明和测试消息也不例外。不得通过 UI 自动化、AppleScript 或其他代理代发。

与 Grok Bot 的通信只走办公室 `pending-questions` 队列及已配置的 webhook 唤醒。接口不可用时报告受阻，不回退到聊天。下方本机连接步骤由用户自行操作；Grok Bot 转告问题使用自己的 Bot 身份，不能冒充用户。webhook 接收成功不代表问题已送达或用户已批准。这项通信边界也适用于新的安装。

## Grok Bot management without an API key

[Grok Bot](https://docs.x.ai/grok-bot/overview) runs on a cloud computer, but its app can also execute local commands when that capability is enabled under the user's existing approval policy. Its cloud browser cannot directly open this Mac's localhost. Use **Grok Management → Grok Bot local connection** to copy setup instructions containing this installation's command path. The office does not change Grok Bot permissions or expose the local server publicly.

An assistant on this Mac can use:

```bash
node scripts/office-board.mjs status
node scripts/office-board.mjs pending-instructions
node scripts/office-board.mjs add-role < role.json
node scripts/office-board.mjs add-task < task.json
node scripts/office-board.mjs apply-plan INSTRUCTION_ID < plan.json
node scripts/office-board.mjs bot-heartbeat < presence.json
```

Mutations accept a JSON object on stdin. A role has `name` and `description`. A task has `title`, `description`, `projectPath`, `provider` (`any`, `codex`, `claude`), `role` (`any`, `Facilitator`, `Admin`, `Helper`, `Tester`), and `priority` (`low`, `normal`, `high`). A plan has `summary`, `roles`, and `tasks`; applying one uses the original instruction's project folder, atomically creates its roles/tasks, and is idempotent. Plan creation is recorded separately from task execution.

Bot presence has `id`, `name`, `role`, and `status` (`idle` or `working`), plus optional `activity` and `instructionId`. Send a heartbeat about every 30 seconds while actually working and send idle when finished. Working presence expires after 60 seconds; the live connection expires after 10 minutes without contact. Presence is session metadata, not a claim that all of Grok Bot's activity is monitored. Server restarts require a fresh heartbeat.

Give Grok Bot your management instructions in its app, or save them here and ask the Bot to read pending instructions. The local bridge does not automatically send chat messages to Grok Bot or install a scheduled polling routine. The CLI fetches the local request token itself; keys/tokens do not belong in command arguments or chat. It supports `--port` or a loopback-only `AI_OFFICE_URL` for another local port.

## Grok Bot 的独立任务栏

在任务板的执行者筛选或“添加请求”中选择 **Grok Bot**（`grok-bot`）。这是 Bot 自己的待办，例如看守、整理报告或用户交办的本机工作；原有 **Grok Dispatch** 仍用于给管理团队下达规划指示。办公室不会启动模型或替 Grok Bot 自动执行这栏任务，也不会自动把任务发送到 Bot 聊天。

Bot 在用户允许的本机命令环境里先读 `status`，再明确领取自己的任务。`worker.json` 需要稳定的 `id`、`name`、`provider: "grok-bot"`、`role: "Helper"` 和实际存在的绝对 `projectPath`；`projectPaths` 也可声明多个允许的项目目录。仅声明 `grok-bot`，不混入其他 provider。Bot 不会领取 `any` 或 Claude/Codex 的卡，普通 worker 也不能代领 Bot 的卡。

```bash
node scripts/office-board.mjs add-task < bot-task.json
node scripts/office-board.mjs claim TASK_ID < worker.json > claim.json
# 或领取自己队列的下一张符合条件的卡：
node scripts/office-board.mjs claim-next < worker.json > claim.json
node scripts/office-board.mjs heartbeat TASK_ID < heartbeat.json
node scripts/office-board.mjs finish TASK_ID < completion.json
```

`bot-task.json` 与普通卡相同，但 `provider` 为 `grok-bot`。领取返回 `{task, claimToken}`，没有可领取任务时返回 `null`。将返回的 token 保留在本机受保护文件中；不要放入命令行参数或聊天。工作期间每 20–30 秒发送 `heartbeat.json`：`{"claimToken":"领取返回的值"}`。任务结束时 `completion.json` 使用同一 token，并填写 `status`（`done` 或 `blocked`）、真实 `result` 和必要的 `error`。这套任务心跳与办公室人物显示用的 `bot-heartbeat` 是两回事；长任务两者都应按实际状态更新。

Grok Bot 的任务锁独立于编码任务，因此能与同项目的开发工作同时进行；同一项目内的 Bot 任务仍串行。服务器正常重载不会取消有效的 Bot 领取，但超过 60 秒未续约会受阻，需明确重试。领取任务不扩大执行权限；具体的发送、删除、合并、发布等操作仍须遵守任务范围和原有授权。

## Grok connection availability

Configured installations use Grok Bot's local command interface and pending-question relay. They do not currently offer direct xAI API-key setup; that legacy route is hidden because the configured server does not accept it. No API key is required to explore the office.

## 按需多 Agent 与 Grok 用户问询

任务板会显示本机配置及运行时可用的并行能力；各提供方并发数由使用者配置。普通 Codex 任务明确启用最多 2 个原生子代理；Claude 可用内置 Agent，任务提示将每名执行者的子代理限制为 2 个。独立编码必须用不同 worktree；研究笔记按完整任务 ID 的哈希分文件。多个 agent 共用订阅额度，不能用来绕过额度。只读排障不允许继续派生子代理。

Qwen 继续每 5 分钟召集、核对分工及额度；本机 Qwen 推理并发受本机实现及配置限制以控制内存，但可协调多个远端执行者。Grok 的多个持久 Bot 由 Grok Bot 自己管理，办公室只记录真实心跳与领取，不声称能直接启动外部 Bot。

明确需要用户补资料或批准时，Qwen 为原任务保存一条绑定版本的问题。Grok 在自己的聊天中实际转达后，才确认送达；收到用户原话后写回同一个任务。没有用户回复、用户拒绝、任务内容已改变时，其他 agent 不得代答或自动放行。资料与批准分开处理；收到有效回复后仍须重新检查登录、项目目录、额度、并行空位。

```bash
node scripts/office-board.mjs pending-questions
node scripts/office-board.mjs acknowledge-question REQUEST_ID < delivery.json
node scripts/office-board.mjs answer-question REQUEST_ID < reply.json
```

`delivery.json`：`{"source":"grok-bot","questionHash":"问题返回的哈希","messageId":"真实已发送消息的编号"}`。

`reply.json`：`{"source":"grok-bot","replyAuthor":"user","questionHash":"同一问题哈希","userMessageId":"真实用户回复编号","userReply":"逐字原话","decision":"provide_info 或 approve 或 deny"}`。问题 ID 由 `pending-questions` 获取。含糊问题不能推定批准；同一用户消息只能绑定一个问题。重复相同回复幂等，过期回复拒绝。仅当原项目目录不可用，资料回复可附 `projectPath`：该绝对路径必须逐字出现在用户原话里且确实存在；有效原目录和批准回复不能借此换项目。目录仍不可用时保留问题等待补充。工具自身的权限弹窗仍需按原流程处理。桥接使用现有本机同源与 CSRF 校验；用户来源由 Grok 附原话及消息编号确认，不宣称能独立验证外部聊天作者。

即时通知是可选配置：在任务板的 **需要你回复 · Grok 转告 → 即时转告：本机设置** 填入现有 Grok routine 的 webhook URL 和 Webhook key；只接受 `https://api2.cursor.sh`。密钥存于 `~/.ai-office/grok-wake.json`，权限 `0600`，不会返回浏览器或写入 Git。通知发送问题编号、原任务编号、类型及问题原文，Grok 转告前再读本机队列核对；HTTP 成功只表示唤醒被接收，不表示问题已送达用户。失败最多尝试 3 次，间隔至少 5 分钟；已接受的问题持久去重。未配置时不会发送通知；如使用者已经另行设置巡板例程，可由该例程读取队列。此代码不会自行创建或改变 Grok 的例程。


事件通知也支持 `GROK_BOT_WEBHOOK_URL` 和 `GROK_BOT_WEBHOOK_AUTH`（值为 `Bearer <token>`）。本机持久配置可放在 `~/.ai-office/grok-webhook.env`，仅当前用户可读写（`0600`），格式为两行单引号包裹的 `export NAME='value'`；程序只解析这两个变量，不执行 shell。加载优先级为进程环境变量、私有环境文件、原有 UI JSON 配置。高优先级配置缺失字段或无效时显示错误，不回退到旧密钥；由环境管理时，页面不覆盖配置。办公室的工作代理、登录检查和额度查询进程不会继承这些凭据。


### Grok：先核实处理，解决不了再转告

Qwen 要求负责人复盘失败、调整方案、实际修复并重新验证。诊断结果中的修复步骤必须回到原任务执行，不能把一份排查报告当成任务完成。

Grok 运行 `node scripts/office-board.mjs pending-questions` 取得当前绑定，先查原任务和已有资料。核实解决信息缺项后运行 `node scripts/office-board.mjs triage-question REQUEST_ID`，从 stdin 输入：

```json
{"source":"grok-bot","questionHash":"当前值","outcome":"resolved_info","summary":"找到的资料及具体下一步","evidence":"核对的文件、提交、检查结果"}
```

这只把信息问题交回原负责人重新执行，不构成用户答复或批准，不更换原项目目录；执行前仍检查额度和工作位。需要批准或确实解决不了时，使用同一命令并将 outcome 改为 `needs_user`，说明已查过什么和仍缺什么，再以 Bot 自己的身份转告；实际送达后才 `acknowledge-question`，拿到真实用户答复后才 `answer-question`。已经转告的问题不得重复催问；资料核实记录不得伪造 userReply 或批准。旧的已转告信息问题可以核实一次并解决，无须重新向用户发问。


### 直接回复受阻问题

任务板顶部“需要你处理”区显示全部当前问询。打开对话框可填写资料、批准当前请求并附条件、拒绝，或确认条件恢复。原项目失效时，可展开目录栏提供已有目录，路径必须同时写入回复。接口 `POST /api/office/human-requests/:id/respond` 记录 `office-ui` 来源，仍要求当前 questionHash、独立操作编号和同源 CSRF；不伪造 Grok 消息编号或送达。

“重新请求”调用同源 `POST /api/office/human-requests/:id/rerequest`，提交 questionHash 与 operationId。它只恢复问询为 pending 并唤醒 Grok，任务仍 blocked；保留旧送达/回复历史并更新 questionHash，旧回复不能批准新一轮问题。同一 operationId 幂等，每分钟最多一次，同一问题最多五次。拒绝后的重新请求继续要求本人回复，不能由 Grok 核实资料直接放行。每一轮用户明确重请核查独立去重，不等于取消拒绝后自动放行任务。

办公室对话框提交独立的 `userAction`（approve / deny / provide_info / restored）与用户亲自输入的 `userReply`。按钮选择不伪装成逐字发言，附加限制保留原文；Grok `/answer` 只接受 grok-bot 来源，继续要求已送达和真实用户原话。


### 手机入口（同一个 Wi-Fi）

手机上的 `127.0.0.1` 是手机自己，不能指向这台 Mac。保持 Mac 上的办公室服务运行，先 `npm run build`，再 `npm run mobile`。独立入口监听 Mac 当前的私有区网 IPv4、端口 5174；原有 5173 和模型服务继续只监听本机。

入口需要存取码或带配对片段的完整链接。存取码生成在 `~/.ai-office/mobile-access.json`（0600，不进 Git）；配对后使用 HttpOnly、SameSite=Strict 的七天会话。入口只提供构建后的页面与经过验证的办公室 API，保留后台 CSRF 检查，只转发用户界面需要的路由，代理领取/完成、Grok Bot 转告回写与凭据配置仍仅供本机使用；不提供源码、任意代理或公网隧道。HTTP 区网入口仅用于可信的同一 Wi-Fi；流量或外网不能直接访问。Mac 休眠、断网或办公室服务停止时不可用。重新部署界面时需要更新构建。

使用 `npm run mobile:install` 安装本机启动项 `local.ai-office.mobile`，使用 `npm run mobile:link` 显示可直接在手机打开的私有配对链接（不要公开分享）。启动项管理手机入口；区网地址变化后会重启并更新上述本机配置。换网后使用新的地址；任务数据始终来自同一台 Mac。


## macOS Dock shortcut

After installing the project dependencies, run `npm run app:install` to create `~/Applications/AI Office.app`. Drag it to the Dock. The shortcut reuses a running office or starts this local project using its existing configuration; keep Node.js 24+ and the project installed. It contains no account or credential transfer.

Use `npm run app:install -- --url http://127.0.0.1:5186/` for another local port. If a registered LaunchAgent manages that view, add `--launch-agent your.service.label`: this only wakes the existing service and never falls back to starting another runner. Existing app bundles are not overwritten; retain a backup before replacing one.

A renderer or 3D asset failure is confined to the scene. Task board, Qwen and Dispatch remain usable, with direct task-list and agent-list actions plus a Retry 3D button.

## Actual Grok conversation mirror

Dispatch can show messages that the Grok Bot macOS app has saved locally, with Bot selection, pagination and separate source/read timestamps. This is a read-only local cache: older cloud history and unsaved new messages may be missing. It is separate from office instructions and is unavailable through the mobile gateway. See [cache coverage and privacy](docs/grok-conversation.md).


## Grok 十分钟受阻巡查

可通过已有 webhook 每十分钟让 Grok 读取当前受阻卡、核对条件并安排恢复或排查，办公室显示实际回写状态。默认关闭；启用配置、Bot 命令及例程补充见 [巡查说明](docs/grok-blocked-patrol.md)。


## Gemini 与 Qwen 剧情接力

任意已配置的写作项目可启用 Gemini 研究、创意和审稿，Qwen 写作与修订的持续候选流程。项目、正典来源和创作重点全部来自本机配置，代码不内置任何项目；默认关闭，保留原项目与正式内容。见 [剧情工坊说明](docs/story-studio.md)。

### 安装专属设置

项目名、路径和任务 ID 不写在代码里。项目列表放在数据目录（`AI_OFFICE_HOME`，默认 `~/.ai-office`）的 `project-catalog.json`；Qwen 看守和日报若需要先等某些任务完成，可在同一目录的 `qwen-prerequisites.json` 写 `{"watch":["<任务ID>"],"workReports":["<任务ID>"]}`，或设置逗号分隔的环境变量 `AI_OFFICE_QWEN_WATCH_PREREQUISITES`、`AI_OFFICE_WORK_REPORT_PREREQUISITES`（环境变量优先）。默认没有前置任务；配置无效时会记录警告（不输出配置值）并按无前置任务处理。
