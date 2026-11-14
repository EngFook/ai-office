# Grok 十分钟受阻巡查

办公室每十分钟扫描当前受阻卡，通过已有 webhook 唤醒 Grok Bot。只有确有受阻卡时才通知。任务没有变化时不向用户反复发消息；重要进展、失败或需要资料/决定时才转告。

## 启用

在本机办公室数据目录放入权限 0600 的 `grok-blocked-patrol-config.json`：

```json
{"version":1,"enabled":true,"intervalMs":600000}
```

重启实际承载任务执行器的办公室服务。默认未启用；无效配置会停止巡查并显示错误。复用原有 webhook 配置，不把 URL 或密钥写入仓库。

Grok 例程也必须接收此工作流程；只有 webhook HTTP 2xx 时界面仍显示等待 Grok 实际回写，不代表已经处理。配置文本见 [例程补充](grok-blocked-patrol-routine.txt)。由用户自行发送例程配置，不使用用户的私人聊天代发。

## Bot 本机命令

沿用已登记的本机脚本路径 S、Node 与办公室端口：

```sh
AI_OFFICE_URL=http://127.0.0.1:5173 node "$S" blocked-tasks
AI_OFFICE_URL=http://127.0.0.1:5173 node "$S" handle-blocked-task TASK_ID < decision.json
```

读取返回 `cycleId`、当前任务 `version`、`fingerprint`、`allowedActions`、候选负责人及原因。`decision.json` 格式：

```json
{"source":"grok-bot","cycleId":"读取的当前轮次","version":1,"fingerprint":"读取的指纹","action":"wait","reason":"本轮发现的具体阻塞","evidence":"真实核对的资料、日志或检查结果"}
```

可用动作：`wait` 记录排查结论；`retry` 重新排队；`investigate` 创建关联排查任务。后两者必须附当前最合适候选的 `provider`。每轮最多派两项恢复工作，同一卡不重复操作，过期轮次或版本返回 409 后需重新读取。保留跨重启状态及进程锁。不得把假证据、HTTP接受、候选建议写成真实处理。

原任务范围、用户暂停/拒绝/批准、独立审查、登录、额度、项目占用及重试预算仍然有效。需要用户资料或批准时走原 `pending-questions` → `triage-question` → 真实转告/答复流程。不能删除、标记完成或虚构批准来清空受阻。无受阻卡时只更新下次检查时间。

## 查看状态

`status` 的 `grokPatrol` 和 Grok 解阻协作区展示下次巡检、上次实际回写、唤醒失败等信息。`lastRequestedAt` 是办公室请求时间，`lastReadAt` 是队列读取时间，`lastHandledAt` 仅在有效回写后更新；本机来源标记不是对外部 Bot 身份的独立认证。没有新用户消息也应处理已有授权任务；不需要每十分钟报告一次“没有变化”。
