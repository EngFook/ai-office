import { readdir, lstat, realpath, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

const WINDOW = 128 * 1024;
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]+$/.test(value);

// Display only visible conversation text and a small tool-input allowlist.
// Never expose reasoning, tool results, attachments, or complete raw records.
export function redactWorkspaceText(value, limit = 12000) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]')
    .replace(/\b(?:sk-|xai-|crsr_|ghp_|github_pat_)[a-zA-Z0-9_-]{12,}/g, '[REDACTED]')
    .replace(/\b(Bearer|Basic)\s+[^\s"'`,;]+/gi, '$1 [REDACTED]')
    .replace(/(?<![\w-])((?:[\w-]*(?:token|secret|password|api[_-]?key|authorization)[\w-]*)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, '$1[REDACTED]')
    // Redact complete URL values before clipping the display window. Candidate
    // boundaries avoid quadratic retries in long command/output words.
    .replace(/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/([?&](?:access[_-]?token|refresh[_-]?token|api[_-]?key|key|token|auth|authorization|signature|sig|password|passwd|pwd)=)[^\s&#"'<>]+/gi, '$1[REDACTED]')
    .replace(/https?:\/\/[^\s"'<>]+\/automations\/webhook\/[^\s"'<>]+/gi, '[REDACTED WEBHOOK]')
    .slice(0, limit);
}

export function parseWorkspaceRecords(text, agent) {
  let instruction = '';
  let started = false;
  const seen = new Set();
  const events = [];
  for (const line of text.split('\n')) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    if (row.sessionId !== agent.sessionId || (agent.isSubagent ? row.agentId !== agent.agentId : row.agentId)) continue;
    const message = row.message;
    if (!message || !['user', 'assistant'].includes(row.type) || message.role !== row.type) continue;
    if (row.uuid && seen.has(row.uuid)) continue;
    if (row.uuid) seen.add(row.uuid);
    const blocks = (typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : Array.isArray(message.content) ? message.content : []).filter(block => block && typeof block === 'object');
    if (row.type === 'user') {
      const prompt = blocks.filter(block => block.type === 'text').map(block => redactWorkspaceText(block.text)).filter(Boolean).join('\n');
      if (/^<(?:task-notification|local-command-caveat|system-reminder)>/.test(prompt.trimStart())) continue;
      if (prompt && !agent.isSubagent) instruction = prompt.slice(0, 16000);
      else if (prompt && !started) instruction = [instruction, prompt].filter(Boolean).join('\n\n').slice(0, 32000);
      continue;
    }
    started = true;
    for (const [index, block] of blocks.entries()) {
      let content = '', kind = 'message', tool = '';
      if (block.type === 'text') content = redactWorkspaceText(block.text, 4000);
      if (block.type === 'tool_use') {
        kind = 'tool';
        tool = redactWorkspaceText(block.name, 100);
        const input = block.input || {};
        content = ['description', 'command', 'file_path', 'path', 'pattern', 'query', 'skill']
          .filter(key => typeof input[key] === 'string').map(key => `${key}: ${redactWorkspaceText(input[key], 3000)}`).join('\n');
        if (!content) content = 'Tool call';
      }
      if (!content) continue;
      const timestamp = Number.isFinite(Date.parse(row.timestamp)) ? new Date(row.timestamp).toISOString() : null;
      events.push({ id: `${row.uuid || timestamp || 'record'}:${index}`, timestamp, kind, tool, text: content });
    }
  }
  const unique = [...new Map(events.map(event => [event.id, event])).values()];
  return { instruction, events: unique.slice(-32), truncated: unique.length > 32 };
}

async function directories(directory) {
  return (await readdir(directory, { withFileTypes: true }).catch(() => []))
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).map(entry => path.join(directory, entry.name));
}

// Every component must be a real directory/file within the configured projects
// root. There are no HTTP-supplied paths, and symlinked transcripts are rejected.
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

export function createClaudeWorkspaceReader({ claudeHome }) {
  let root = path.resolve(claudeHome, 'projects');
  const paths = new Map(), contents = new Map();
  async function locate(agent, projects) {
    if (!validId(agent.sessionId) || (agent.isSubagent && !validId(agent.agentId))) return null;
    const previous = paths.get(agent.id);
    if (previous?.file && Date.now() - previous.at < 10000) return previous.file;
    const matches = [];
    for (const project of projects) {
      if (!agent.isSubagent) {
        const file = path.join(project, `${agent.sessionId}.jsonl`);
        const stat = await safeFile(root, file);
        if (stat) matches.push({ file, time: stat.mtimeMs });
      } else {
        const directory = path.join(project, agent.sessionId, 'subagents');
        const candidates = [path.join(directory, `agent-${agent.agentId}.jsonl`)];
        // Claude workflow agents live one level below subagents/workflows.
        const workflowRoot = path.join(directory, 'workflows');
        if (await realpath(workflowRoot).catch(() => null) === workflowRoot) {
          for (const workflow of await directories(workflowRoot)) candidates.push(path.join(workflow, `agent-${agent.agentId}.jsonl`));
        }
        for (const file of candidates) {
          const stat = await safeFile(root, file);
          if (stat) matches.push({ file, time: stat.mtimeMs });
        }
      }
    }
    const file = matches.sort((a, b) => b.time - a.time)[0]?.file || null;
    paths.set(agent.id, { file, at: Date.now() });
    return file;
  }
  async function readAgent(agent, projects) {
    const base = { ...agent, instruction: '', events: [], sourceAvailable: false, truncated: false };
    let handle;
    try {
      const file = await locate(agent, projects);
      if (!file) return base;
      const stat = await safeFile(root, file);
      if (!stat) return base;
      const signature = `${file}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      const cached = contents.get(agent.id);
      if (cached?.signature === signature) return { ...base, ...cached.data };
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await handle.stat();
      if (opened.ino !== stat.ino || !opened.isFile()) return base;
      const head = Buffer.alloc(Math.min(WINDOW, stat.size));
      const headRead = await handle.read(head, 0, head.length, 0);
      let text = head.subarray(0, headRead.bytesRead).toString('utf8');
      const truncated = stat.size > WINDOW;
      let tailText = '';
      if (truncated) {
        text = text.slice(0, text.lastIndexOf('\n') + 1);
        // Avoid overlapping head/tail windows, which would repeat initial
        // assignment blocks when the file is between one and two windows long.
        const tailOffset = Math.max(Buffer.byteLength(text), stat.size - WINDOW);
        const tail = Buffer.alloc(stat.size - tailOffset + 1);
        const tailRead = await handle.read(tail, 0, tail.length, tailOffset - 1);
        const boundary = tail[0] === 10;
        const ending = tail.subarray(1, tailRead.bytesRead).toString('utf8');
        tailText = ending.slice(boundary ? 0 : ending.indexOf('\n') + 1, ending.lastIndexOf('\n') + 1);
        text += tailText;
      }
      const parsed = parseWorkspaceRecords(text, agent);
      if (truncated && !agent.isSubagent) {
        // An old head prompt may be unrelated to the active turn. Only the
        // recent window can establish the main session's current instruction.
        const recent = parseWorkspaceRecords(tailText, agent);
        parsed.instruction = recent.instruction;
        parsed.instructionState = recent.instruction ? 'visible' : 'outside-window';
      }
      const data = { ...parsed, sourceAvailable: true, truncated: truncated || parsed.truncated };
      contents.set(agent.id, { signature, data });
      return { ...base, ...data };
    } catch { return base; } finally { await handle?.close(); }
  }
  return async status => {
    root = path.join(await realpath(claudeHome).catch(() => path.resolve(claudeHome)), 'projects');
    const agents = (status.agents || []).filter(agent => agent.observed && agent.status !== 'offline');
    const ids = new Set(agents.map(agent => agent.id));
    for (const cache of [paths, contents]) for (const id of cache.keys()) if (!ids.has(id)) cache.delete(id);
    const rootStat = await lstat(root).catch(() => null);
    const projects = rootStat?.isDirectory() && !rootStat.isSymbolicLink() && await realpath(root) === root ? await directories(root) : [];
    const output = new Array(agents.length);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(8, agents.length) }, async () => {
      while (cursor < agents.length) { const index = cursor++; output[index] = await readAgent(agents[index], projects); }
    }));
    output.sort((a, b) => a.id.localeCompare(b.id));
    return { enabled: true, agents: output, updatedAt: new Date().toISOString(), observedAt: status.observedAt, metadataAvailable: status.metadataAvailable, executionCounts: status.executionCounts, sourceErrors: status.sourceErrors, coverage: status.coverage, hookInstalled: status.hookInstalled, privacy: 'Local on-demand task instructions and visible activity; reasoning and tool results excluded. Common credential patterns masked.' };
  };
}
