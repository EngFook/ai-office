import { lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { redactWorkspaceText } from './claude-workspace.mjs';

const WINDOW = 512 * 1024;
const textBlocks = content => (Array.isArray(content) ? content : [])
  .filter(block => block && ['input_text', 'output_text', 'text'].includes(block.type) && typeof block.text === 'string')
  .map(block => block.text).join('\n');
const visiblePhase = payload => payload.channel !== 'analysis' && (['commentary', 'final'].includes(payload.channel) || ['commentary', 'final_answer'].includes(payload.phase));
const promptText = text => text.replace(/<(?:environment_context|in-app-browser-context|permissions instructions|skills_instructions)\b[^>]*>[\s\S]*?<\/(?:environment_context|in-app-browser-context|permissions instructions|skills_instructions)>/g, '').trim();

// This is a separate, on-demand projection. The floor status API stays metadata-only.
// System/developer messages, reasoning, encrypted content, arguments and results
// never become workspace events. Inherited parent history is not a child's task.
export function parseCodexWorkspaceRecords(text, agent) {
  let instruction = '', instructionState = 'unavailable', ownHistory = !agent.isSubagent;
  const events = [], seen = new Set();
  for (const line of text.split('\n')) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || row.type !== 'response_item' || !row.payload || typeof row.payload !== 'object') continue;
    const payload = row.payload;
    const timestamp = Number.isFinite(Date.parse(row.timestamp)) ? new Date(row.timestamp).toISOString() : null;
    const id = payload.id || `${timestamp}:${events.length}`;
    if (payload.id && seen.has(payload.id)) continue;
    if (payload.id) seen.add(payload.id);
    if (payload.type === 'agent_message' && agent.isSubagent && agent.agentPath && payload.recipient === agent.agentPath) {
      const visible = textBlocks(payload.content);
      if (/^Message Type: NEW_TASK\b/.test(visible)) {
        ownHistory = true;
        events.length = 0;
        const assignment = visible.match(/(?:^|\n)Payload:\s*\n?([\s\S]*)$/)?.[1] || '';
        instruction = redactWorkspaceText(assignment.trim(), 16000);
        instructionState = instruction ? 'available' : payload.content?.some(block => block?.type === 'encrypted_content') ? 'encrypted' : 'unavailable';
      }
      continue;
    }
    if (!ownHistory) continue;
    if (payload.type === 'message' && payload.role === 'user') {
      const visible = redactWorkspaceText(promptText(textBlocks(payload.content)), 16000);
      if (visible) { instruction = visible; instructionState = 'available'; }
      continue;
    }
    if (payload.type === 'message' && payload.role === 'assistant' && visiblePhase(payload)) {
      const visible = redactWorkspaceText(textBlocks(payload.content), 4000);
      if (visible) events.push({ id, timestamp, kind: 'message', tool: '', text: visible });
    } else if (['function_call', 'custom_tool_call'].includes(payload.type)) {
      const tool = typeof payload.name === 'string' && /^[a-zA-Z0-9_.:/-]{1,200}$/.test(payload.name) ? payload.name : '';
      if (tool) events.push({ id: payload.call_id || id, timestamp, kind: 'tool', tool, text: tool });
    }
  }
  return { instruction, instructionState, events: events.slice(-32), truncated: events.length > 32 };
}

async function safeFile(home, file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return null;
  const relative = path.relative(home, file);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !['sessions', 'archived_sessions'].includes(relative.split(path.sep)[0])) return null;
  let current = home;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    const info = await lstat(current).catch(() => null);
    if (!info || info.isSymbolicLink()) return null;
  }
  const stat = await lstat(file);
  return stat.isFile() && await realpath(file) === file ? stat : null;
}

export function createCodexWorkspaceReader({ codexHome }) {
  const cache = new Map();
  return async (status, rows) => {
    const root = await realpath(codexHome).catch(() => path.resolve(codexHome));
    const agents = (status.agents || []).filter(agent => agent.status !== 'offline');
    const ids = new Set(agents.map(agent => agent.id));
    for (const id of cache.keys()) if (!ids.has(id)) cache.delete(id);
    const files = new Map(rows.map(row => [row.id, row.rollout_path]));
    const result = new Array(agents.length);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(8, agents.length) }, async () => {
      while (cursor < agents.length) {
        const index = cursor++, agent = agents[index];
        const base = { ...agent, instruction: '', instructionState: 'unavailable', events: [], sourceAvailable: false, truncated: false };
        result[index] = base;
        let handle;
        try {
          const original = files.get(agent.id);
          const relative = typeof original === 'string' ? path.relative(path.resolve(codexHome), original) : '..';
          const file = !relative.startsWith('..') && !path.isAbsolute(relative) ? path.join(root, relative) : null;
          const stat = await safeFile(root, file);
          if (!stat) continue;
          const signature = `${file}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
          const previous = cache.get(agent.id);
          if (previous?.signature === signature) { result[index] = { ...base, ...previous.data }; continue; }
          handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
          const opened = await handle.stat();
          if (!opened.isFile() || opened.ino !== stat.ino) continue;
          const head = Buffer.alloc(Math.min(WINDOW, stat.size));
          const first = await handle.read(head, 0, head.length, 0);
          let text = head.subarray(0, first.bytesRead).toString('utf8');
          // JSONL rows must be complete, including when a writer is appending.
          text = text.slice(0, text.lastIndexOf('\n') + 1);
          const truncated = stat.size > WINDOW;
          let tailText = '';
          if (truncated) {
            const tailOffset = Math.max(WINDOW, stat.size - WINDOW);
            // Include the preceding byte so an exact row boundary does not
            // discard a complete first row. Partial boundary rows are skipped.
            const tail = Buffer.alloc(stat.size - tailOffset + 1);
            const last = await handle.read(tail, 0, tail.length, tailOffset - 1);
            const boundary = tail[0] === 10;
            let ending = tail.subarray(1, last.bytesRead).toString('utf8');
            ending = ending.slice(boundary ? 0 : ending.indexOf('\n') + 1, ending.lastIndexOf('\n') + 1);
            tailText = ending;
            text += ending;
          }
          const parsed = parseCodexWorkspaceRecords(text, agent);
          if (truncated && !agent.isSubagent) {
            // A first-page prompt can belong to a much older turn. Without a
            // recent readable user message, do not present it as today's task.
            const recent = parseCodexWorkspaceRecords(tailText, agent);
            parsed.instruction = recent.instruction;
            parsed.instructionState = recent.instruction ? recent.instructionState : 'outside-window';
          }
          const data = { ...parsed, sourceAvailable: true, truncated: truncated || parsed.truncated };
          cache.set(agent.id, { signature, data });
          result[index] = { ...base, ...data };
        } catch { /* Missing files preserve the observed agent without fabricated content. */ }
        finally { await handle?.close(); }
      }
    }));
    return { enabled: true, agents: result, metadataAvailable: status.metadataAvailable, sourceHealth: status.sourceHealth, observedAt: status.observedAt, coverage: status.coverage, updatedAt: new Date().toISOString(), privacy: 'On-demand visible instructions and public activity. No reasoning, system instructions, tool arguments/results or encrypted content. Common credentials masked.' };
  };
}
