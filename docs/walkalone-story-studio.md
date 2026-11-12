# 退界剧情工坊：Gemini 与 Qwen 接力

这是用户授权的退界 / Walkalone 剧情候选工作流，不新增项目，不直接覆盖游戏正式剧情。

- Gemini 负责公开资料研究、选题、人物冲突、伏笔与反转构思，以及关键审稿。
- Qwen 用同一个本地助手实例负责场景正文和定向修改，遇到用户手动任务让出计算位。
- 本机服务保存阶段、输入版本和候选稿，只有前一步实际完成且验收合格才启动下一步。排队和真实运行分别显示。

## 运行节奏

每六小时最多开启一轮；剧情调度器每24小时最多新建八张 Gemini 工作卡（现有卡的手动或解阻重试另受执行器额度约束）、同一创作链同时最多一张 Gemini 卡。研究→Qwen 草稿→Gemini 审稿→Qwen 一次定向修订→保存候选。每轮一个有边界的场景，轮换关注热血、团队代价、悬疑证据与反转，不无限续写。暂停、维护、额度不足、登录失效或失败时保留进度并冷却，不启动重复卡，也不自动开付费超额。

研究只读公开可访问的简介、试读、作者/出版社资料或评论等，记录来源与日期，提炼叙事方法；不下载或复制整本受版权保护小说。网络可达性检查只能确认来源能打开，不能证明模型解读准确。新点子必须贴合本轮已给定的退界设定，候选稿仍须核验和采纳。

## 本机配置

数据目录 `story-studio-config.json`（0600）默认未启用：

```json
{"version":1,"enabled":true,"projectId":"walkalone","sourceRoot":"/absolute/path/to/current/Walkalone","projectPath":"/absolute/path/to/current/Walkalone","goal":"强化退界剧情的热血、悬疑、伏笔和有因果的反转；保持人物动机与既定事实。"}
```

`sourceRoot` 必须指向最新剧情工作区，而不是较旧的另一份 checkout。读取固定剧情资料并保存来源哈希；候选稿保存在本机数据目录 `creative/walkalone/`，不写回 canon。

在 Gemini 或 Qwen 的办公室详情里查看当前阶段、下一次检查、最近候选和真实错误。候选预览不代表已通过作者采纳或游戏正式发布。

## CLI 完成验收

本机使用 Antigravity `agy`，支持非交互执行，但正常退出码本身不证明查证完成。执行器检查 `finished_reason`、必需工具的 `denied_actions` 及结构化产物；超时、必要权限缺失和模型声明无法完成均保留为阻塞。文学编辑不走代码独立审查流程，也不改变 Claude↔Codex 的代码审查职责。

官方参考：[Headless mode](https://antigravity.google/docs/cli/headless)、[Plans](https://antigravity.google/docs/plans)、[Changelog](https://antigravity.google/docs/changelog)。官方支持自动化调用，不等于无限额度、零故障或账号状态保证。
