import { TaskBoardError } from './task-store.mjs';

const names = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini', 'local-qwen': 'Local Qwen', 'grok-bot': 'Grok' };
const identity = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:@/-]{0,511}$/.test(value) ? value : null;
const text = (value, max = 200) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, max) : '';

// Optional adapters publish lifecycle metadata only. Presence is not a task
// claim, an approval, or evidence that a task has been completed.
export function createAgentPresence({ now = Date.now, leaseMs = 60000, retentionMs = 600000, limit = 4096 } = {}) {
  const records = new Map();
  const prune = () => { for (const [key, value] of records) if (now() - value.lastSeen >= retentionMs) records.delete(key); };
  function heartbeat(input = {}) {
    const provider = input.provider === 'grok' ? 'grok-bot' : input.provider;
    const id = identity(input.id), sessionId = identity(input.sessionId);
    const parentAgentId = input.parentAgentId == null ? null : identity(input.parentAgentId);
    if (!names[provider] || !id || !sessionId || !['working', 'idle', 'waiting', 'offline'].includes(input.status) || typeof input.isSubagent !== 'boolean' || (input.isSubagent && (!parentAgentId || parentAgentId === id))) {
      throw new TaskBoardError('Provide provider, unique id, sessionId, status, isSubagent and a distinct parentAgentId for each child.', 'INVALID_AGENT', 400);
    }
    prune();
    const key = `${provider}:${id}`, previous = records.get(key);
    if (previous && (previous.sessionId !== sessionId || previous.parentAgentId !== parentAgentId || previous.isSubagent !== input.isSubagent)) throw new TaskBoardError('Agent identity changed; use a new id for a different agent.', 'AGENT_CONFLICT', 409);
    if (!previous && records.size >= limit) throw new TaskBoardError('Agent presence capacity reached; expired entries are removed automatically.', 'AGENT_LIMIT', 409);
    const lastSeen = now();
    const agent = { id, sessionId, parentAgentId, parentSessionId: identity(input.parentSessionId), isSubagent: input.isSubagent,
      provider: names[provider], providerKey: provider, name: text(input.name) || names[provider], agentType: text(input.agentType) || (input.isSubagent ? 'subagent' : 'main'),
      role: text(input.role) || 'Helper', status: input.status, executionState: input.status, observed: true, source: 'local-agent-heartbeat', observationSource: 'local-agent-heartbeat',
      tool: text(input.tool) || null, cwd: text(input.cwd, 2048), updatedAt: new Date(lastSeen).toISOString(), lastSeen };
    records.set(key, agent);
    return { id, provider, status: agent.status, expiresAt: new Date(lastSeen + leaseMs).toISOString() };
  }
  function agents() {
    prune();
    return [...records.values()].map(({ lastSeen, ...agent }) => now() - lastSeen >= leaseMs ? { ...agent, status: 'offline', executionState: 'offline', tool: null } : agent);
  }
  return { heartbeat, agents };
}
