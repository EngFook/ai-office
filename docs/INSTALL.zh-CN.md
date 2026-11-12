# 安装你自己的 AI Office

这是需要 Node.js 24+ 与终端的源码安装版，目前实机验收以 macOS 为主；尚不是所有人下载后双击即用的桌面安装包。应用提供中英文三步上手指南，账号、模型与工作目录由每位使用者自行选择。代码采用 MIT，第三方素材保留各自许可（见 LICENSE 与 NOTICE）。


## 子代理逐个显示

Claude 的每个子代理由本机生命周期 hooks 识别；运行 `npm run connect:claude` 后，新会话会报告开始、工具活动和结束事件。Codex 通过本机活动线程及生命周期元数据识别。每个运行中的子代理都有独立人物，可点击查看自己的 ID、父代理、会话和运行状态；空闲代理进入折叠列表，已结束/失去连接的代理不再作为工作中人物显示。

Gemini、Grok、Qwen 及其他已接入运行器的活动人物同样保留独立身份。外部框架如果未提供可读取的子代理事件，需要在其真实生命周期回调里调用下面的本机上报入口；办公室不能凭安装了模型或技能推断子代理在工作。

```bash
printf '%s\n' '{"provider":"gemini","id":"research-child-1","sessionId":"research-session-1","parentAgentId":"research-root","isSubagent":true,"name":"Research helper","status":"working"}' | node scripts/office-board.mjs agent-heartbeat
```

`provider` 支持 claude、codex、gemini、local-qwen、grok-bot；必须已在办公室配置中启用，执行模式为 enabled。每个子代理使用提供方内唯一且稳定的 id，不得让兄弟代理共用 id。每 30 秒更新一次；开始使用 working，等待输入使用 waiting，空闲使用 idle，结束使用 offline。超过 60 秒未更新视为断线，十分钟后清理记录。只上报身份和状态，不上报提示词、回复或密钥；这不会领取任务或批准任何操作。

自定义端口时用 `AI_OFFICE_URL=http://127.0.0.1:实际端口`。原生 Claude/Codex 已被观察到的代理不需要再重复上报；接入外部框架前先核对现有活动列表。手机网关不开放代理上报接口。画面按实际人物数量扩容，已验证 300 个测试代理的独立位置与点击详情；测试数量不代表同时运行了 300 个真实 AI。

AI Office 是本机运行的办公室与任务板。每个使用者配置自己的工作目录、AI 登录与模型；发行源码不包含原安装者的账号、任务或 Git 历史。

## 准备与首次启动

准备 Node.js 24 或更新版本、npm、支持 WebGL 的浏览器。开发验证环境为 macOS；不宣称 Windows/Linux 的全部集成均已通过实机验证。Claude、Codex 等 CLI 需要你另行安装并登录。Ollama、Gemini、Grok Bot 均为可选，未安装不影响打开办公室。当前 Gemini 适配器需要 Antigravity 兼容的 `agy` 接口，不能把其他 `gemini` 命令直接当作兼容替代。

在解压或复制后的源码目录运行：

```bash
npm ci
npm start
```

`npm start` 会打开浏览器，默认地址为 `http://127.0.0.1:5173`。首次可以直接浏览，随后按页面的三步指南运行 `npm run setup`、登录自己的 AI、重启并添加第一项任务。终端服务需要保持运行，Ctrl+C 停止。修改已有配置用 `npm run setup -- --overwrite`，旧配置自动备份。

启动或接单有问题先运行 `npm run doctor`。它只读检查 Node、依赖、目录权限、CLI 是否存在及审查配置，不调用 AI、不读密钥、不代为登录。命令存在不代表已登录，以任务板的实际就绪状态为准。指定端口用 `npm start -- --port 5174`；无自动打开浏览器用 `--no-open`。生产构建仍可用 `npm run build` 后 `npm run preview`（默认 4173）。不能只把 dist 上传到静态网站，就期待本机任务板与 AI 执行功能继续可用。

设置向导会让你选择办公室名称、时区、默认工作目录、数据目录、启用的 AI、CLI 命令、模型、并发数及独立审查员。CLI command 是可执行文件路径或 PATH 中的命令名，不是含参数的 shell 命令。

新安装默认 `disabled`，AI 全关闭，自动接单关闭。`disabled` / `read-only` 都不会启动任务或向 AI 服务发出请求；只用于查看已有/空任务板。确认本机设置后，选择 `enabled`、启用所需提供方、完成其登录，再按需要打开任务板的自动接单。设置向导本身不启动 AI。

Claude Code 和 Codex 使用你自己的 CLI 订阅登录，不强制提供 API key。设置向导只写本机设置，不安装 CLI/模型、不登录账号、不开通 API 服务，也不创建 webhook。订阅权限、CLI 兼容性与额度仍影响可用性。

独立代码审查目前只支持 Claude 与 Codex，审查员必须与作者不同。`reviewerFor` 默认 Claude 交 Codex、Codex 交 Claude；审查员未启用、未登录或额度不可用时，任务等待，不改由作者自审。Gemini 的只读研究、Qwen 的本机辅助和 Grok 的协调身份不等于独立代码审查能力。

当前每个 Claude/Codex/Gemini 提供方可配置 1–8 个任务板工作位；Local Qwen 与 Grok Bot 的配置并发数为 1。Grok Bot 由外部 Bot 自己领取任务，办公室不创建其本机进程池。办公室能显示 100 人，不代表调度器会同时启动 100 个执行者；实际能力还受本机资源、额度及项目写入隔离限制。

## 配置与私人数据

默认配置：`~/.ai-office/config.json`，权限 0600。默认数据目录：`~/.ai-office`。配置只保存路径和非密钥设置；不要把账号、token、密码或 webhook 密钥放入 config JSON、项目仓库或聊天。

- `AI_OFFICE_CONFIG`：配置文件路径。
- `AI_OFFICE_HOME`：运行时私人数据目录，优先于 config 的 dataDir。
- `AI_OFFICE_WORKSPACE`：覆盖默认工作目录。
- `AI_OFFICE_MODE`：明确覆盖 disabled / read-only / enabled。
- `CLAUDE_CONFIG_DIR`、`CODEX_HOME`：对应 CLI 的本机安装/状态目录。

修改已有设置可再次运行 `npm run setup -- --overwrite`；旧配置会另存备份。运行 `npm run setup -- --help` 查看全部参数。修改后重启办公室。无交互的安全初始化示例：

```bash
npm run setup -- --yes --workspace /path/to/your/project
```

本机 Qwen 使用已有的 Ollama 服务及模型。先自行安装适合内存的模型，再在向导填写服务地址与模型名称；办公室不会自动下载模型。Gemini 需要兼容的本机命令，Grok Bot 通过队列、显式本机命令与可选 webhook 连接；配置启用不等于外部服务已登录。

配置完成后，在「任务」打开 **Qwen 本地助手**：可查看实际模型、忙闲和三项后台职责；展开八类文字辅助，选择类型、粘贴原文，再提交。它能整理日志、标签、文案、变更记录、拆分建议、交接、阻塞和验收清单；没有文件或终端操作能力，也不能代替独立代码审查。单路推理、32K上下文和两分钟空闲保留用于控制资源；过长资料会在提交或推理前明确提示缩短。

**Gemini 研究助手**提供六类只读研究草稿。它会核对CLI登录及可用模型；只有明确要求登录时才显示本机登录命令。网络不可用会单独提示，不会冒充退出登录。先完成本人登录，再刷新连接状态；不要把账号密码或API密钥放进任务。

**Claude 工作室**通过本机事件更新代理、指令和后台任务。看到「事件实时同步」表示来源通道已连接；来源监视失败或连接中断时显示轮询补偿并自动恢复。代理自己的运行状态仍以生命周期证据判断，历史记录和未落盘状态会保留待确认。


### 开发与协调分工

高级分工字段保存在本机配置 JSON，可在无密钥 JSON 文件中准备后用 `npm run setup -- --from 文件路径 --overwrite` 导入，或先停止服务再编辑现有配置。保留其他配置字段，不要用以下片段直接覆盖完整设置：

```json
{
  "routing": { "workProviders": ["claude", "codex"], "balanceProvider": null },
  "reviewerFor": { "claude": "codex", "codex": "claude" },
  "pausedTaskIds": []
}
```

`workProviders` 是未指定执行者的编码任务候选列表，只能包含 Claude/Codex，默认两者都可参与。`balanceProvider` 可填 `claude` 或 `codex`，将协调/辅助类任务定向给该提供方；`null` 使用普通候选列表。提供方仍须启用、登录、有额度与空余工作位。已明确分配的任务不会因为候选列表变化而悄悄换人；研究、外部 Bot、Qwen 辅助与独立审查仍走各自规则。

## 从已有办公室迁移

先停止原办公室服务，再备份私人数据目录。运行 `npm run migrate -- --help` 查看本版本的迁移参数。迁移与首次设置分开；安装不会自动导入旧任务、打开自动接单或覆盖已有数据。先保持 disabled，核对待答问题、拒绝/暂停状态、任务与执行设置，再决定启用。不要把私人备份装进发行源码包。

先预览，再明确复制到一个新的空目录：

```bash
npm run migrate -- --from /path/to/old-data --to /path/to/new-data
npm run migrate -- --from /path/to/old-data --to /path/to/new-data --apply
```

可选 `--legacy-project /path/to/old-source` 导入旧项目内白名单中的报告。迁移复制任务库与允许的数据，保留原任务、问题绑定、拒绝/暂停和接单设置；不迁移 config、登录、密钥、手机配对身份或 webhook 投递身份。用 setup 为新数据目录单独建立配置，先保持 `disabled` / `read-only`。旧接单设置即使为开启，关闭的执行模式也不会启动它。

如果旧部署曾在代码中保存“用户暂停”的任务 ID，这些规则不是数据库状态，迁移程序不会猜测或自动搬运。启用前，使用者必须核对旧规则和真实暂停清单，将需要继续保留的完整任务 ID 明确写入新配置的 `pausedTaskIds`；可将旧配置作为 setup 的 `--from` 输入，但不要顺带导入凭据。保留完整 ID，避免短前缀误匹配。只有确认原先暂停/拒绝的任务仍保持阻止执行后，才启用新实例。未核对清楚时保持禁用，不自动解除旧限制。

## 手机：显式开启同一 Wi-Fi 入口

手机的 `127.0.0.1` 指向手机自己。默认办公室只监听运行它的电脑，不向局域网公开。手机访问需要你额外启动网关：

```bash
npm run build
# 保持主服务运行；开发服务默认为 5173
npm run dev
# 另开一个终端
npm run mobile
npm run mobile:link
```

手机与电脑连接可信的同一 Wi-Fi，用 `mobile:link` 输出的完整私人配对链接。不要公开分享链接。网关默认监听电脑的私有 IPv4、5174 端口，并转发到本机 5173；如主服务使用其他端口，设置 `AI_OFFICE_URL=http://127.0.0.1:实际端口`；`AI_OFFICE_MOBILE_PORT` 可覆盖网关端口。存取码保存在私人数据目录，权限 0600；手机不能访问源码、代理领取接口或本机凭据配置接口。

只想查看手机入口地址、不要显示配对密钥时，运行 `npm run mobile:link -- --address-only`；这个地址需要在手机输入存取码。主服务使用 5186 的例子：在另一个终端运行 `AI_OFFICE_URL=http://127.0.0.1:5186 npm run mobile`，再读取配对链接。网关启动前会检查手机构建是否存在；地址改变或离线时，链接命令会要求重新启动网关，避免继续给出旧地址。入口地址存在不代表上游办公室仍在运行；手机提示服务未回应时，检查主服务终端。

HTTP 局域网入口不提供公网访问。电脑休眠、换网或服务停止会断开，换网后重新读取链接。可选 `npm run mobile:install` 安装 macOS 启动项 `local.ai-office.mobile`，不适用于 Windows/Linux。已有旧版启动项需先由使用者停止，安装器不会擅自修改旧服务。更新 UI 后需重新构建。

## 分享源码与验证范围

```bash
npm run package:source -- --output /path/to/new/ai-office-source
```

命令输出一个全新源码目录，只复制明确白名单内、已由 Git 跟踪的普通文件，包含通用 `.gitignore`、中文 `CHANGELOG.md`、本指南与资源归属说明。未跟踪的新代码不会进入包；先加入版本跟踪再打包。不会复制 `.git`、旧提交、reports、worktree、依赖、构建、配置、登录或任务数据，也不附带本机个人 AGENTS 指令。隐藏目录、备份、数据库、日志、会话记录及本机凭据 JSON 即使误加入版本跟踪也会被排除。

敏感值/个人标识扫描失败时会停止并报告文件名与问题类型，不打印敏感值，不静默删改功能。`SOURCE-MANIFEST.json` 记录来源提交、工作区快照性质及每个文件的 SHA-256，供核对；扫描不能替代人工隐私与许可证审查。代码采用根目录 LICENSE 的 MIT 许可；保留 NOTICE 和第三方素材原有许可证与来源说明。

运行 `npm test` 与 `npm run build` 检查当前源码。纯净 HOME 测试不等于全部真实服务已登录；实际使用前仍需核对本机登录、额度、项目目录与独立审查能力。


## macOS Dock 应用入口

在已经安装依赖的项目目录运行 `npm run app:install`，会在 `~/Applications/AI Office.app` 创建本机快捷入口，可拖进 Dock。入口连接已有办公室；没有服务时才启动当前项目的办公室，新安装仍保留向导设置的执行模式。Node.js 24+ 与项目目录必须保留，应用不包含账号或密钥。

默认使用 `http://127.0.0.1:5173/`，其他端口可用 `npm run app:install -- --url http://127.0.0.1:5186/`。如果该入口是由已登记的 LaunchAgent 管理的连接视图，再指定 `--launch-agent 你的服务名称`，只复用这个服务，绝不会另开独立执行器。已存在的 `.app` 不会被覆盖；更新前先保留旧应用备份。

若手机或电脑无法初始化 3D，办公室会显示重试、打开任务板、查看代理列表入口。任务、Qwen 与调度不依赖 3D 画面。
