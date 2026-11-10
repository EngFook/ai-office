// Verified 2026-11-04 against Codex CLI 0.163.0-alpha.11 and:
// https://learn.chatgpt.com/docs/agent-configuration/subagents
// Claude Agent is a built-in tool; no experimental agent-team flag is required.
// https://code.claude.com/docs/en/sub-agents
export function codexSubagentArgs(task) {
  return task.kind === 'resolution'
    ? ['-c', 'agents.enabled=false']
    : ['-c', 'agents.enabled=true', '-c', 'agents.max_concurrent_threads_per_session=2'];
}

export function parallelCapabilities({ providers = {}, limits = {} } = {}) {
  const ready = key => Boolean(providers[key]?.available && providers[key]?.authenticated);
  return {
    claude: { ready: ready('claude'), taskSlots: limits.claude ?? 3, nativeSubagents: 'available', nativeLimit: null, recommendedNativeLimit: 2, delegation: 'native-and-board', note: 'Claude Agent 可按需并行；共用 Claude 额度，写入需独立 worktree；只读排障禁用子代理。' },
    codex: { ready: ready('codex'), taskSlots: limits.codex ?? 2, nativeSubagents: 'enabled', nativeLimit: 2, delegation: 'native-and-board', note: '每个普通任务启用最多 2 个原生子代理，共用 Codex 额度；只读排障禁用子代理。' },
    gemini: { ready: ready('gemini'), taskSlots: limits.gemini ?? 2, nativeSubagents: 'unverified', nativeLimit: null, delegation: 'board-research', note: '最多 2 个独立只读研究任务同时运行；未验证原生子代理，不声称支持。' },
    'local-qwen': { ready: ready('local-qwen'), taskSlots: 1, nativeSubagents: 'none', nativeLimit: 0, delegation: 'board-coordinator', note: 'Qwen 召集并委派多个 AI；36GB 本机只运行 1 路本地推理，避免抢占开发内存。' },
    'grok-bot': { ready: null, taskSlots: null, nativeSubagents: 'unverified', nativeLimit: null, delegation: 'external-bots', note: 'Grok 已确认可使用多个持久 Bot 分工，共用订阅额度；各自登记心跳，实际启动和并行由 Grok Bot 控制。' },
  };
}
