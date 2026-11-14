# Grok Bot 真实对话缓存同步

调度台顶部的「你 ↔ Grok Bot」直接读取 Grok Bot 本机保存的 transcript replica。它与下面的办公室指令队列分开：任务摘要不会伪装成原聊天。只读，不发送聊天，不触发 webhook，不使用账号凭据或私有网络 API。

默认来源为 macOS 的 `~/Library/Application Support/Grok Bot/sand-client-persistence`，仅打开名称解码后匹配 `transcript.replicas.<Bot UUID>` 的 schemaVersion 1 JSON blob，以及用于 Bot 名称和默认选择的 `roster.last-roster`、`selection.last-agent`。不会读取 cookies、secrets、MCP 配置等其他文件。用户切换 Bot 时只能选择实际发现的来源 ID。

每 15 秒重新读取；手动刷新立即读取。界面分别显示「源缓存更新」和「办公室读取」时间。Grok Bot 必须先把新消息保存到本机，办公室才能读到。应用未刷新或没有落盘时，办公室的刷新不能强制云端同步。

原缓存可能仅保存最近 200 条源记录。`precedingTimestampMs` 存在时明确标示更早历史缺失；不存在也不会宣称云端完整。分页可以读取当前缓存全部可展示记录；缓存改变后旧游标失效，防止把不同快照拼成一段完整历史。消息稳定 ID 去重，冲突或来源读取失败时清空面板并报错。

用户/助手文字、只读问题选项、已缓存的语音文字显示在面板。附件、凭据请求和其他应用事件显示占位说明；不读取附件内容、语音工具结果、模型推理或隐藏字段。常见密钥、Authorization 和 webhook URL 遮盖。文本以 React 纯文本方式显示，不能执行 HTML。

`GET /api/office/grok/conversation` 仅在本机同源 relay 或办公室服务上开放；仅允许 `botId`、`cursor` 查询参数，不接受路径，也没有任何写入操作。手机网关不转发此私密对话接口。需要在部署时维持 loopback 与同源限制。

实际覆盖边界：能够同步该机器上原应用已保存的可展示聊天缓存；不能承诺所有云端历史、附件内容、未落盘的新消息或 100% 无延迟同步。完整回补需要原应用提供的正式导出或读取接口，不能拿办公室任务卡填充缺失对话。

验证：`node --test test/grok-conversation.test.mjs test/grok-conversation-ui.test.mjs test/office-relay.test.mjs`。测试使用合成消息，不向真实 Grok 发送任何内容。
