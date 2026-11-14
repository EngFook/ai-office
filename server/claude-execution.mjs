import { readdir, lstat, realpath, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

export const CLAUDE_ACTIVITY_LEASE_MS = 120000;
const WINDOW = 256 * 1024;
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]+$/.test(value);
const terminalReasons = new Set(['end_turn', 'stop_sequence']);

// This parser retains lifecycle fields only. Content, tool arguments/results,
// request blobs and reasoning never enter the cache or the status response.
export function parseClaudeExecutionRecords(text, agent) {
  let latest = null;
  for (const line of text.split('\n')) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || row.sessionId !== agent.sessionId || (agent.isSubagent ? row.agentId !== agent.agentId : row.agentId && row.agentId !== agent.agentId)) continue;
    if (!['assistant', 'user', 'api-request'].includes(row.type)) continue;
    const timestamp = Date.parse(row.timestamp);
    if (!Number.isFinite(timestamp) || latest && timestamp < latest.timestamp) continue;
    // API request records represent an actual provider attempt; request blobs
    // and shape/debug copies are deliberately excluded above.
    let phase = row.type === 'api-request' ? 'generating' : null;
    const message = row.message;
    if (row.type === 'assistant' && message?.role === 'assistant') {
      phase = terminalReasons.has(message.stop_reason) ? 'finished' : message.stop_reason === 'tool_use' ? 'tool-pending' : 'generating';
    } else if (row.type === 'user' && message?.role === 'user' && Array.isArray(message.content) && message.content.some(block => block?.type === 'tool_result')) {
      phase = 'between-tools';
    }
    if (phase) latest = { timestamp, phase };
  }
  return latest;
}

async function directories(directory) {
  return (await readdir(directory, { withFileTypes: true }).catch(() => []))
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).map(entry => path.join(directory, entry.name));
}
async function safeFile(root, file) {
  if (!file.startsWith(root + path.sep)) return null;
  let current = root;
  for (const part of path.relative(root, file).split(path.sep)) {
    current = path.join(current, part);
    const stat = await lstat(current).catch(() => null);
    if (!stat || stat.isSymbolicLink()) return null;
  }
  const stat = await lstat(file);
  return stat.isFile() && await realpath(file) === file ? stat : null;
}

export function createClaudeExecutionReader({ claudeHome }) {
  const paths = new Map(), cache = new Map();
  return async agents => {
    const root = path.join(await realpath(claudeHome).catch(() => path.resolve(claudeHome)), 'projects');
    const rootStat = await lstat(root).catch(() => null);
    if (!rootStat?.isDirectory() || rootStat.isSymbolicLink() || await realpath(root) !== root) return new Map();
    const projects = await directories(root), output = new Map();
    const ids = new Set(agents.map(agent => agent.id));
    for (const stored of [paths, cache]) for (const id of stored.keys()) if (!ids.has(id)) stored.delete(id);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(8, agents.length) }, async () => {
      while (cursor < agents.length) {
        const agent = agents[cursor++];
        if (!validId(agent.sessionId) || agent.isSubagent && !validId(agent.agentId)) continue;
        let handle;
        try {
          let file = paths.get(agent.id)?.file;
          if (!file || Date.now() - paths.get(agent.id).at > 10000) {
            const matches = [];
            for (const project of projects) {
              const sub = path.join(project, agent.sessionId, 'subagents');
              const candidates = agent.isSubagent ? [path.join(sub, `agent-${agent.agentId}.jsonl`)] : [path.join(project, `${agent.sessionId}.jsonl`)];
              const workflowRoot = path.join(sub, 'workflows');
              if (agent.isSubagent && await realpath(workflowRoot).catch(() => null) === workflowRoot) for (const workflow of await directories(workflowRoot)) candidates.push(path.join(workflow, `agent-${agent.agentId}.jsonl`));
              for (const candidate of candidates) {
                const stat = await safeFile(root, candidate);
                if (stat) matches.push({ file: candidate, time: stat.mtimeMs });
              }
            }
            file = matches.sort((a, b) => b.time - a.time)[0]?.file;
            paths.set(agent.id, { file, at: Date.now() });
          }
          if (!file) continue;
          const stat = await safeFile(root, file);
          if (!stat) continue;
          const signature = `${file}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
          if (cache.get(agent.id)?.signature === signature) { output.set(agent.id, cache.get(agent.id).metadata); continue; }
          handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
          const opened = await handle.stat();
          if (opened.ino !== stat.ino || !opened.isFile()) continue;
          const offset = Math.max(0, stat.size - WINDOW), buffer = Buffer.alloc(Math.min(WINDOW, stat.size));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
          let text = buffer.subarray(0, bytesRead).toString('utf8');
          if (offset) text = text.slice(text.indexOf('\n') + 1);
          text = text.slice(0, text.lastIndexOf('\n') + 1);
          const metadata = parseClaudeExecutionRecords(text, agent);
          cache.set(agent.id, { signature, metadata });
          output.set(agent.id, metadata);
        } catch { /* Missing/partial metadata cannot establish execution. */ }
        finally { await handle?.close(); }
      }
    }));
    return output;
  };
}

export function reconcileClaudeExecution(agents, sessions, events, transcriptMetadata, { now = Date.now(), leaseMs = CLAUDE_ACTIVITY_LEASE_MS } = {}) {
  const latestPids = new Map();
  for (const event of events) {
    const previous = latestPids.get(`${event.sessionId}:${event.agentId || 'main'}`);
    if (!previous || event.timestamp >= previous.timestamp) latestPids.set(`${event.sessionId}:${event.agentId || 'main'}`, event);
  }
  for (const agent of agents) {
    if (agent.status !== 'working' || !agent.observed) continue;
    const hookAt = Date.parse(agent.lastEventAt), transcript = transcriptMetadata.get(agent.id);
    if (transcript?.phase === 'finished' && transcript.timestamp >= hookAt && transcript.timestamp <= now) {
      Object.assign(agent, { status: 'idle', executionState: 'idle', tool: null, skillId: null, activityPhase: 'finished', observationSource: 'claude-transcript-terminal', executionObservedAt: new Date(transcript.timestamp).toISOString() });
      continue;
    }
    const session = sessions.get(agent.sessionId);
    const event = latestPids.get(`${agent.sessionId}:${agent.agentId || 'main'}`);
    // A live PID alone is not evidence for any child. Its own activity must
    // belong to this process generation and have a bounded, recent timestamp.
    if (!session?.alive || !Number.isFinite(session.startedAt) || !event || event.pid && event.pid !== session.pid || hookAt < session.startedAt) continue;
    const transcriptAt = transcript?.phase !== 'finished' && transcript?.timestamp >= hookAt && transcript.timestamp <= now ? transcript.timestamp : 0;
    const activeAt = Math.max(hookAt || 0, transcriptAt);
    if (activeAt > now || now - activeAt > leaseMs || activeAt < session.startedAt) continue;
    Object.assign(agent, { executionState: 'working', observationSource: transcriptAt >= hookAt ? 'claude-live-transcript' : 'claude-live-lifecycle', executionObservedAt: new Date(activeAt).toISOString(), evidenceExpiresAt: new Date(activeAt + leaseMs).toISOString() });
    if (transcriptAt >= hookAt) agent.activityPhase = transcript.phase;
  }
  return agents;
}
