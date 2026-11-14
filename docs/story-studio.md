# 剧情工坊：Gemini 与 Qwen 接力

这是可选的剧情候选工作流，可用于任何在本机配置中登记的写作项目。代码不内置任何项目名、路径或正典格式；不新增项目，不直接覆盖项目正式内容。

- Gemini 负责公开资料研究、选题、人物冲突、伏笔与反转构思，以及关键审稿。
- Qwen 用同一个本地助手实例负责场景正文和定向修改，遇到用户手动任务让出计算位。
- 本机服务保存阶段、输入版本和候选稿，只有前一步实际完成且验收合格才启动下一步。排队和真实运行分别显示。

## 运行节奏

每六小时最多开启一轮；剧情调度器每24小时最多新建八张 Gemini 工作卡（现有卡的手动或解阻重试另受执行器额度约束）、同一创作链同时最多一张 Gemini 卡。研究→Qwen 草稿→Gemini 审稿→Qwen 一次定向修订→保存候选。每轮一个有边界的场景，按配置的创作重点（`focus`）轮换，不无限续写。暂停、维护、额度不足、登录失效或失败时保留进度并冷却，不启动重复卡，也不自动开付费超额。

研究只读公开可访问的简介、试读、作者/出版社资料或评论等，记录来源与日期，提炼叙事方法；不下载或复制整本受版权保护小说。网络可达性检查只能确认来源能打开，不能证明模型解读准确。新点子必须贴合本轮已给定的项目设定，候选稿仍须核验和采纳。

## 本机配置

数据目录（`AI_OFFICE_HOME`，默认 `~/.ai-office`）中的 `story-studio-config.json`（0600）默认未启用。启用时必须指定 `projectId`、相同的 `sourceRoot`/`projectPath`，以及正典来源 `canon.sources`：

```json
{
  "version": 1,
  "enabled": true,
  "projectId": "my-novel",
  "projectName": "My Novel",
  "sourceRoot": "/absolute/path/to/my-novel",
  "projectPath": "/absolute/path/to/my-novel",
  "goal": "为现有章节之后撰写可选的原创候选场景；保持人物动机与既定事实。",
  "focus": ["人物动机：选择与代价", "悬疑：可核对的线索"],
  "canon": {
    "preamble": "以下为正典逐字摘录；不是完整正典。",
    "sources": [
      { "path": "docs/story-bible.md", "mode": "lines", "patterns": ["^- \\*\\*"], "minMatches": 3 },
      { "path": "docs/outline.md", "mode": "section", "heading": "最新章节结尾（逐字摘录）：\n", "pattern": "## 最新章节\\s*([\\s\\S]*?)(?:\\n---|$)" },
      { "path": "src/story-version.txt", "mode": "none", "versionPattern": "story\\.v(\\d+)" }
    ]
  }
}
```

- `projectId`：字母、数字、`-`、`_`；候选稿保存在数据目录 `creative/<projectId>/`，不写回正典。`projectName` 只用于显示和提示词，缺省用 `project-catalog.json` 中同 ID 条目的 `name`，再缺省用 `projectId`。
- `canon.sources[].path` 是相对 `sourceRoot` 的文件路径（每个 ≤512KB，不能跳出项目、不能是链接）。`mode`：`full` 整个文件、`lines` 只保留匹配 `patterns` 的行（可用 `minMatches`/`exactMatches` 校验格式）、`section` 取 `pattern` 的第一个捕获组、`none` 只参与哈希与校验。可选 `heading`、`join`、`requireText`、`versionPattern`（第一个捕获组为版本标签，可配 `minVersion` 对第二个捕获组（没有时用第一个）做数值下限检查）。拼接后的正典超过 8000 字节会拒绝，不静默截断。
- `goal`、`focus`、`canon` 缺省时分别使用通用目标、通用创作重点；没有 `canon` 时不能启用。

也可以把项目定义集中写在数据目录的 `project-catalog.json`：在对应项目条目中加 `storyStudio` 块（可含 `projectName`、`goal`、`focus`、`canon`），`story-studio-config.json` 只保留 `version`、`enabled`、`projectId` 和路径；条目的 `name` 作为显示名。`story-studio-config.json` 中的同名键优先。两份文件都在本机数据目录，不进入仓库。

`sourceRoot` 必须指向最新剧情工作区，而不是较旧的另一份 checkout。每轮读取配置的正典来源并保存来源哈希；来源改变时保留候选稿并等待重新核对。

在 Gemini 或 Qwen 的办公室详情里查看当前阶段、下一次检查、最近候选和真实错误。候选预览不代表已通过作者采纳或正式发布。

## CLI 完成验收

本机使用 Antigravity `agy`，支持非交互执行，但正常退出码本身不证明查证完成。执行器检查 `finished_reason`、必需工具的 `denied_actions` 及结构化产物；超时、必要权限缺失和模型声明无法完成均保留为阻塞。文学编辑不走代码独立审查流程，也不改变 Claude↔Codex 的代码审查职责。

官方参考：[Headless mode](https://antigravity.google/docs/cli/headless)、[Plans](https://antigravity.google/docs/plans)、[Changelog](https://antigravity.google/docs/changelog)。官方支持自动化调用，不等于无限额度、零故障或账号状态保证。
