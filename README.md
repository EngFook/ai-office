# The AI Office

A local, interactive office dashboard for a Mac. Claude Code, Codex and Grok share **Floor 03**. Claude has the largest open work studio with 100 seats; Codex has 24 nearby support desks for **Facilitator**, **Admin**, **Helper** and **Tester** roles; Grok has a dedicated six-seat management suite with a meeting area. The first and second floors are no longer part of the interface.

Only runtime agents whose reported state is **working** appear as people in the office. Idle agents stay in a collapsed **Idle agents** list; agents waiting for input have a separate collapsed list. Installed skills are capabilities, not extra people. Click a figure or its compact provider-colored ID marker to inspect its provider, role, project, status and current/last tool. Agents leave the floor automatically when they stop working. Above 24 working agents, IDs appear only on hover or selection to keep the overview clear. All figures remain clickable; the status list and directory identify every worker. Furniture uses instanced rendering for a full 130-person office.

Claude and Codex have live local activity connections. Grok Bot connects through approved local commands; xAI API planning is an optional second route. A management role alone never creates a working figure.

## Start the office

Requires Node.js 24 or newer.

```bash
npm install
npm run dev
```

Open the local address printed in Terminal (normally http://127.0.0.1:5173). Keep Terminal open while using the app. On this Mac, you can also double-click `Start AI Office.command`. Use `npm run build` for a production build and `npm test` for bridge, roster, migration and hook checks. `npm run dev` or `npm run preview` is required for local activity monitoring; a static-only deployment cannot connect to your Mac.

## Codex activity

The Codex connection is automatic and read-only. It uses the local Codex state database and held writer locks to identify sessions, then projects only lifecycle and tool-name metadata from bounded activity-file tails. No model call, API key, hook installation or permission change is needed. `CODEX_HOME` is supported for another local Codex configuration.

Shared-office roles use explicit role/path and tool metadata. Root coordinators are Facilitators; operations and administration map to Admin; review and quality work map to Tester; other contributors are Helpers. This is an office classification and does not change agent permissions or runtime instructions. Workers keep stable identities and seats as other workers arrive or their status changes.

The status response never includes messages, prompts, reasoning, tool arguments/results or credentials. Runtime formats can change; missing lifecycle evidence is handled conservatively rather than inventing running work.

## Claude Code activity

```bash
npm run connect:claude
```

The connection command uses your enabled `gamedev@awesome-gamedev-agent-skills` installation. It creates one user-level Claude subagent per installed skill (currently 76), plus `ai-office-gamedev-router`, with the corresponding plugin skill preloaded. Existing Claude settings and unrelated agents are preserved; changed files are backed up under `~/.claude/ai-office/backups/`. Rerun after updating the skill plugin. Installation is idempotent.

Restart existing Claude Code sessions once to load newly installed agents and hooks. For example, ask Claude Code to use `ai-office-gamedev-router` to choose specialists, or `ai-office-threejs-scene-setup` to work on a scene. Claude’s normal permissions and model settings still apply. All actual working sessions and subagents appear in the shared Claude studio, including those working on other local projects. A skill installation alone never creates a person in the office.

The local bridge reads installation metadata, live session metadata and sanitized lifecycle events under `~/.claude/ai-office/events/`. It does not read prompts, transcripts, tool arguments/results, model output or credentials. Events stay on this Mac. The read-only API accepts same-origin loopback requests. `CLAUDE_CONFIG_DIR` is supported for alternate installations.

The observer runs on 11 lifecycle events, including `StopFailure`, and completes its local write before the next event. It exits successfully on errors and has a one-second timeout so a dashboard failure cannot stop Claude work. For a graceful disconnect, remove only hook entries ending in `--ai-office-managed` from Claude settings. Generated `ai-office-*.md` agents can be removed independently.

## Using the shared office

- Drag to rotate, scroll to zoom, or switch to the top-down seat map. Room controls and labels focus the Claude studio, Codex support area, Grok management suite and shared spaces.
- Open the directory to search runtime agents by provider, role, name or project. Filter by Running, Idle or Waiting. Only working agents can be located on the floor.
- Save manual project assignments, repository links, work briefs and progress. Add reports linked to projects and individual agents. These actions do not launch an AI agent or access a repository.
- Existing assignments and reports from all three floors migrate into Floor 03 without losing their original fields or IDs. The original v1 browser-storage entries remain intact; the shared office writes v2 entries. Old agent links are preserved rather than reassigned to a different worker by seat number.

Characters represent observed runtime agents. Legacy manual assignments and reports remain in browser storage. The executable task board is stored separately on this Mac.


## Task board and worker pickup

Open **Task board** in the sidebar or click its board in the 3D office. Add a request, details, and an absolute project folder. Choose Any, Claude Code, or Codex, a support role, and a priority. Requests without a folder remain pending. The board shows Pending, Working, Blocked, and Done, with each worker's result in the task details.

Automatic pickup is enabled for a new board and can be paused with its switch. Only installed, authenticated local CLIs can pick up requests. Claude Desktop activity does not establish that the standalone Claude CLI is signed in; check the readiness indicators. Each provider runs one board task at a time, and a project folder cannot have two simultaneous board workers. The visual office still accommodates 100 Claude workers and 24 Codex workers from all sessions.

Workers retain normal CLI permissions. Codex uses workspace-write sandboxing; Claude denies unanswered permission prompts. Completion requires a successful CLI result and an explicit structured completion report. Interrupted, expired, failed, or timed-out work becomes Blocked and requires an explicit retry. A server restart never silently reruns interrupted work. Tasks and management requests persist in `~/.ai-office/board.sqlite` (`AI_OFFICE_HOME` can select another directory). Request text is intentionally saved and sent to the selected provider; full CLI logs and tool outputs are not exposed in the board.

## Grok Bot 聊天只由用户控制

用户要求：「让codex 不要帮我发了 这边只有我自己控制」。Codex、Claude、Gemini、Qwen 及所有 AI、子代理和脚本均不得通过用户账号、本机 Grok Bot 应用或浏览器向 Grok Bot 聊天输入、粘贴或发送消息，进度同步、配置说明和测试消息也不例外。不得通过 UI 自动化、AppleScript 或其他代理代发。

与 Grok Bot 的通信只走办公室 `pending-questions` 队列及已配置的 webhook 唤醒。接口不可用时报告受阻，不回退到聊天。下方本机连接步骤由用户自行操作；Grok Bot 转告问题使用自己的 Bot 身份，不能冒充用户。webhook 接收成功不代表问题已送达或用户已批准。持久规则见 `AGENTS.md`。

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

## Optional xAI API planning

The collapsed **Connect xAI API** panel supports direct planning from office instructions. Enter a key from your own [xAI console](https://console.x.ai/) in that local field. Keys are validated against available models and saved outside the repository in `~/.ai-office/grok-credentials.json` with owner-only permissions. `XAI_API_KEY` (or `GROK_API_KEY`) and optional `GROK_MODEL` are also supported. No key is returned to the browser, sent to worker processes, or logged. See [xAI's API quickstart](https://docs.x.ai/developers/quickstart).

When connected through the API, pending instructions are planned automatically using structured output. Grok can add management roles and pending Claude/Codex tasks, but cannot claim that implementation is finished. The API receives the management instruction, selected project path, and role descriptions, with response storage disabled. Without this optional connection, instructions stay queued for Grok Bot's local interface.

All board endpoints require loopback and same-origin access. Mutations additionally require JSON and a per-server request token. This service is designed for a local Mac, not unauthenticated public hosting.

## 按需多 Agent 与 Grok 用户问询

任务板会显示运行时的真实并行能力：Claude 3 个独立工作位，Codex 2 个，Gemini 2 个只读研究工作位。普通 Codex 任务明确启用最多 2 个原生子代理；Claude 可用内置 Agent，任务提示将每名执行者的子代理限制为 2 个。独立编码必须用不同 worktree；研究笔记按完整任务 ID 的哈希分文件。多个 agent 共用订阅额度，不能用来绕过额度。只读排障不允许继续派生子代理。

Qwen 继续每 5 分钟召集、核对分工及额度；本机同时仅保留 1 路 Qwen 推理以控制内存，但可协调多个远端执行者。Grok 的多个持久 Bot 由 Grok Bot 自己管理，办公室只记录真实心跳与领取，不声称能直接启动外部 Bot。

明确需要用户补资料或批准时，Qwen 为原任务保存一条绑定版本的问题。Grok 在自己的聊天中实际转达后，才确认送达；收到用户原话后写回同一个任务。没有用户回复、用户拒绝、任务内容已改变时，其他 agent 不得代答或自动放行。资料与批准分开处理；收到有效回复后仍须重新检查登录、项目目录、额度、并行空位。

```bash
node scripts/office-board.mjs pending-questions
node scripts/office-board.mjs acknowledge-question REQUEST_ID < delivery.json
node scripts/office-board.mjs answer-question REQUEST_ID < reply.json
```

`delivery.json`：`{"source":"grok-bot","questionHash":"问题返回的哈希","messageId":"真实已发送消息的编号"}`。

`reply.json`：`{"source":"grok-bot","replyAuthor":"user","questionHash":"同一问题哈希","userMessageId":"真实用户回复编号","userReply":"逐字原话","decision":"provide_info 或 approve 或 deny"}`。问题 ID 由 `pending-questions` 获取。含糊问题不能推定批准；同一用户消息只能绑定一个问题。重复相同回复幂等，过期回复拒绝。仅当原项目目录不可用，资料回复可附 `projectPath`：该绝对路径必须逐字出现在用户原话里且确实存在；有效原目录和批准回复不能借此换项目。目录仍不可用时保留问题等待补充。工具自身的权限弹窗仍需按原流程处理。桥接使用现有本机同源与 CSRF 校验；用户来源由 Grok 附原话及消息编号确认，不宣称能独立验证外部聊天作者。

即时通知是可选配置：在任务板的 **需要你回复 · Grok 转告 → 即时转告：本机设置** 填入现有 Grok routine 的 webhook URL 和 Webhook key；只接受 `https://api2.cursor.sh`。密钥存于 `~/.ai-office/grok-wake.json`，权限 `0600`，不会返回浏览器或写入 Git。通知发送问题编号、原任务编号、类型及问题原文，Grok 转告前再读本机队列核对；HTTP 成功只表示唤醒被接收，不表示问题已送达用户。失败最多尝试 3 次，间隔至少 5 分钟；已接受的问题持久去重。未配置时使用 Grok 原有每两小时巡板补漏，不增加高频 Grok 调用。此代码不会自行创建或改变 Grok 的例程。


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

使用 `npm run mobile:install` 安装本机启动项 `com.allant.ai-office-mobile`，使用 `npm run mobile:link` 显示可直接在手机打开的私有配对链接（不要公开分享）。启动项管理手机入口；区网地址变化后会重启并更新上述本机配置。换网后使用新的地址；任务数据始终来自同一台 Mac。

## 净化候选的运行限制

此候选只用于本机源码净化、安装、构建和测试验证，尚未获得推送、合并或部署批准。不要在 Mac mini 或第二个 checkout 运行 `npm run dev` / `npm run preview`。这两个命令都会启动任务 runner、Grok 管理、队列 webhook、Qwen 看守和 huddle；当前没有环境级只读或禁用开关，第二实例可能争抢同一任务板。该限制须在后续通用化任务中解决后再验证 Mini，本候选没有启动 Mini 或真实服务。

公开源码不包含本机 reports、会议记录、运行数据、备份或私人截图。`docs/office-preview.png` 是公开基线自带的静态办公室示意图。美术资源来自仓库中注明来源和许可的 Kenney、Quaternius 资源与生成式场景资产。
