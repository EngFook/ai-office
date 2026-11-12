import { readdir, lstat, realpath, open, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { setImmediate as yieldIO } from 'node:timers/promises';
import { redactWorkspaceText as clean } from './claude-workspace.mjs';

const idOK = value => typeof value === 'string' && /^[\w-]+$/.test(value);
const terminal = new Set(['completed', 'failed', 'stopped']);
const recordedStates = new Set(['running', 'stalled', ...terminal]);
const normalize = value => ({ killed: 'stopped', done: 'completed', succeeded: 'completed' }[value] || value);
const stamp = value => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const textBlocks = value => typeof value === 'string' ? value : Array.isArray(value) ? value.filter(b => b?.type === 'text').map(b => b.text || '').join('\n') : '';
const kindFor = name => ({ Bash: 'command', Monitor: 'monitor', Workflow: 'workflow', Agent: 'agent', local_bash: 'command', local_agent: 'agent', local_workflow: 'workflow' }[name] || 'unknown');
const capture = (text, tag) => text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1] || '';

// This reducer consumes known record schemas, not arbitrary text search over logs.
// Only visible tool inputs and structured lifecycle fields leave the index.
export function createBackgroundReducer(sessionId) {
  const tasks = new Map();
  function update(taskId, patch) {
    if (!idOK(taskId)) return;
    const previous = tasks.get(taskId) || { id: `${sessionId}:${taskId}`, taskId, sessionId, kind: 'unknown', status: 'unknown', description: '', command: '', agentId: null };
    const resumed = patch.startedAt && previous.updatedAt && patch.startedAt > previous.updatedAt && patch.toolUseId && patch.toolUseId !== previous.toolUseId;
    if (patch.status && terminal.has(patch.status) && patch.toolUseId && previous.toolUseId && patch.toolUseId !== previous.toolUseId) return;
    const next = { ...previous };
    if (resumed) { next.startedAt = patch.startedAt; delete next.summary; }
    for (const key of ['description', 'command', 'agentId', 'outputFile', 'toolUseId']) if (patch[key]) next[key] = patch[key];
    if (patch.kind && patch.kind !== 'unknown') next.kind = patch.kind;
    if (patch.startedAt && (!next.startedAt || patch.startedAt < next.startedAt)) next.startedAt = patch.startedAt;
    // Terminal notifications can be replayed in several transcripts. They do not
    // become new runs, and a delayed launch cannot resurrect a completed task.
    if (patch.status && (resumed || !terminal.has(previous.status) || terminal.has(patch.status)) && (!previous.updatedAt || !patch.updatedAt || patch.updatedAt >= previous.updatedAt || terminal.has(patch.status) && !terminal.has(previous.status))) {
      next.status = patch.status; next.updatedAt = patch.updatedAt || previous.updatedAt;
      if (patch.summary) next.summary = patch.summary;
    }
    tasks.set(taskId, next);
  }
  function consume(row, calls = new Map()) {
    if (!row || row.sessionId !== sessionId) return;
    if (!stamp(row.timestamp)) return;
    const time = stamp(row.timestamp), agentId = idOK(row.agentId) ? row.agentId : null;
    const content = row.message?.content;
    if (row.type === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (block?.type !== 'tool_use' || !['Bash', 'Monitor', 'Workflow', 'Agent', 'TaskStop', 'TaskOutput'].includes(block.name)) continue;
        const input = block.input || {};
        calls.set(block.id, { name: block.name, command: clean(input.command, 16000), description: clean(input.description || input.name, 2000), taskId: input.task_id || input.shell_id, agentId, time });
      }
    }
    if (row.type === 'user' && Array.isArray(content)) for (const block of content) {
      if (block?.type !== 'tool_result') continue;
      const call = calls.get(block.tool_use_id);
      if (!call) continue;
      const result = row.toolUseResult && typeof row.toolUseResult === 'object' ? row.toolUseResult : {};
      const text = textBlocks(block.content);
      let taskId = result.backgroundTaskId;
      if (call.name === 'Bash' && !taskId) {
        const match = text.match(/^Command (?:running in background with ID: ([\w-]+)\.|did not complete within[^\n]*?background \(ID: ([\w-]+)\))/);
        taskId = match?.[1] || match?.[2];
      }
      if (call.name === 'Monitor') taskId ||= text.match(/^Monitor started \(task ([\w-]+),/)?.[1];
      if (['Workflow', 'Monitor', 'Agent'].includes(call.name)) taskId ||= result.taskId || result.agentId || text.match(/^(?:Async agent launched successfully\.|Agent launched)[\s\S]*?agentId: ([\w-]+)/)?.[1];
      if (idOK(taskId) && !block.is_error) update(taskId, { kind: kindFor(call.name), status: 'running', startedAt: call.time || time, updatedAt: time, command: call.command, description: call.description || clean(result.workflowName, 2000), agentId: call.agentId, toolUseId: block.tool_use_id, outputFile: typeof result.outputFile === 'string' ? result.outputFile : text.match(/Output is being written to: ([^\n]+)/)?.[1]?.trim() });
      if (call.name === 'TaskStop' && !block.is_error && (result.task_id || /^\s*\{[^]*"task_id"/.test(text))) {
        let parsed = result; try { parsed = JSON.parse(text); } catch {}
        if (parsed.task_id === call.taskId) update(call.taskId, { status: 'stopped', updatedAt: time, summary: 'Stopped by Claude TaskStop' });
      }
      // TaskOutput is an explicit status observation, including tasks that have
      // not yet delivered their asynchronous completion notification.
      if (call.name === 'TaskOutput' && !block.is_error) {
        const status = normalize(result.task?.status || capture(text, 'status'));
        if (recordedStates.has(status)) update(call.taskId, { status, updatedAt: time });
      }
      calls.delete(block.tool_use_id);
    }
    if (row.type === 'attachment' && row.attachment?.type === 'task_status') {
      const a = row.attachment, status = normalize(a.status);
      if (recordedStates.has(status)) update(a.taskId, { kind: kindFor(a.taskType), status, updatedAt: time, command: clean(a.shell?.command, 16000), description: clean(a.description, 2000), outputFile: a.outputFilePath, toolUseId: a.shell?.toolUseId });
    }
    const texts = [];
    if (row.type === 'user') texts.push(textBlocks(content));
    if (row.type === 'queue-operation' && ['enqueue', 'remove', 'dequeue'].includes(row.operation)) texts.push(textBlocks(row.content));
    if (row.type === 'attachment' && row.attachment?.type === 'queued_command') texts.push(textBlocks(row.attachment.prompt));
    for (const text of texts.filter(text => text.trimStart().startsWith('<task-notification>'))) for (const match of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
      const body = match[1];
      const monitorExpired = /^Monitor event:/.test(capture(body, 'summary')) && /^\[Monitor expired after /.test(capture(body, 'event'));
      const status = monitorExpired ? 'stopped' : normalize(capture(body, 'status'));
      if (!terminal.has(status) && status !== 'stalled') continue;
      const summary = clean(monitorExpired ? capture(body, 'event') : capture(body, 'summary'), 2000);
      const kind = monitorExpired ? 'monitor' : /^Background command /.test(summary) ? 'command' : /^Dynamic workflow |^Workflow /.test(summary) ? 'workflow' : /^Agent /.test(summary) ? 'agent' : 'unknown';
      for (const [, taskId] of body.matchAll(/<task-id>([\w-]+)<\/task-id>/g)) update(taskId, { status, kind, updatedAt: time, summary, toolUseId: capture(body, 'tool-use-id'), outputFile: capture(body, 'output-file') });
    }
  }
  return { tasks, consume };
}

async function children(dir) {
  return (await readdir(dir, { withFileTypes: true }).catch(() => [])).filter(e => !e.isSymbolicLink());
}
async function safe(root, file) {
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

export function createClaudeBackgroundReader({ claudeHome }) {
  const sessions = new Map();
  let currentAgents = [], sessionStarts = new Map();
  let pending = null, lastScanAt = null, error = null, progress = { filesRead: 0, filesTotal: 0 }, scanCount = 0;
  async function scan(status) {
    const root = path.join(await realpath(claudeHome), 'projects');
    if (await realpath(root) !== root) throw Error('Unsafe project root');
    currentAgents = status.agents || [];
    sessionStarts = new Map();
    for (const entry of await children(path.join(claudeHome, 'sessions'))) {
      if (!entry.isFile() || !/^[\w.-]+\.json$/.test(entry.name)) continue;
      try { const metadata = JSON.parse(await readFile(path.join(claudeHome, 'sessions', entry.name), 'utf8'));
        const start = typeof metadata.startedAt === 'number' ? new Date(metadata.startedAt).toISOString() : stamp(metadata.startedAt);
        if (idOK(metadata.sessionId) && start && (!sessionStarts.has(metadata.sessionId) || start > sessionStarts.get(metadata.sessionId))) sessionStarts.set(metadata.sessionId, start);
      } catch {}
    }
    const ids = new Set((status.agents || []).filter(a => a.status !== 'offline').map(a => a.sessionId).filter(idOK));
    for (const id of sessions.keys()) if (!ids.has(id)) sessions.delete(id);
    const projects = (await children(root)).filter(e => e.isDirectory()).map(e => path.join(root, e.name));
    const files = [];
    for (const id of ids) {
      let session = sessions.get(id);
      if (!session) { session = { ...createBackgroundReducer(id), files: new Map(), missing: 0, skipped: 0 }; sessions.set(id, session); }
      const candidates = [];
      for (const project of projects) {
        candidates.push(path.join(project, `${id}.jsonl`));
        const sub = path.join(project, id, 'subagents');
        for (const e of await children(sub)) if (e.isFile() && /^agent-[\w-]+\.jsonl$/.test(e.name)) candidates.push(path.join(sub, e.name));
        const workflows = path.join(sub, 'workflows');
        for (const w of await children(workflows)) if (w.isDirectory()) for (const e of await children(path.join(workflows, w.name))) if (e.isFile() && /^agent-[\w-]+\.jsonl$/.test(e.name)) candidates.push(path.join(workflows, w.name, e.name));
      }
      let reset = false;
      const found = new Set();
      for (const file of candidates) {
        const stat = await safe(root, file);
        if (!stat) continue;
        found.add(file);
        const old = session.files.get(file);
        if (old && (old.ino !== stat.ino || stat.size < old.offset || stat.size === old.offset && old.mtime !== stat.mtimeMs)) reset = true;
        files.push({ file, stat, session, root });
      }
      session.missing = found.size === 0 ? 1 : 0;
      if ([...session.files.keys()].some(file => !found.has(file))) reset = true;
      if (reset) { const reducer = createBackgroundReducer(id); session.tasks = reducer.tasks; session.consume = reducer.consume; session.files.clear(); session.skipped = 0; }
    }
    files.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    progress = { filesRead: 0, filesTotal: files.length };
    for (const { file, stat, session, root } of files) {
      let entry = session.files.get(file);
      if (!entry) { entry = { offset: 0, ino: stat.ino, mtime: stat.mtimeMs, rest: Buffer.alloc(0), dropping: false, calls: new Map() }; session.files.set(file, entry); }
      if (entry.offset < stat.size) {
        if (!await safe(root, file)) throw Error('Source changed');
        const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          if ((await handle.stat()).ino !== stat.ino) throw Error('Source changed');
          const buffer = Buffer.alloc(256 * 1024);
          while (entry.offset < stat.size) {
            const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - entry.offset), entry.offset);
            if (!bytesRead) break;
            entry.offset += bytesRead;
            const chunk = Buffer.concat([entry.rest, buffer.subarray(0, bytesRead)]);
            let start = 0, end;
            while ((end = chunk.indexOf(10, start)) !== -1) {
              if (!entry.dropping) {
                try { session.consume(JSON.parse(chunk.subarray(start, end).toString('utf8')), entry.calls); } catch { session.skipped++; }
              }
              entry.dropping = false; start = end + 1;
            }
            entry.rest = Buffer.from(chunk.subarray(start));
            // Huge API request blobs are not task events. Bound memory without
            // interpreting a partial record or exposing its contents.
            if (entry.rest.length > 8 * 1024 * 1024) { entry.rest = Buffer.alloc(0); entry.dropping = true; session.skipped++; }
            await yieldIO();
          }
          entry.mtime = stat.mtimeMs;
        } finally { await handle.close(); }
      }
      progress.filesRead++;
    }
    lastScanAt = new Date().toISOString(); scanCount++;
  }
  function refresh(status) {
    if (!pending) pending = scan(status).then(() => { error = null; }).catch(() => { error = 'Background task sources could not be fully read'; }).finally(() => { pending = null; });
    return pending;
  }
  function snapshot({ sessionId, kind, status, scope = 'current', search = '', offset = 0, limit = 60 } = {}) {
    let tasks = [...sessions.values()].flatMap(s => [...s.tasks.values()]).map(task => {
      const owner = currentAgents.find(a => a.sessionId === task.sessionId && (task.agentId ? a.agentId === task.agentId : !a.isSubagent));
      const previousProcess = sessionStarts.has(task.sessionId) && (task.updatedAt || task.startedAt || '') < sessionStarts.get(task.sessionId);
      const endedOwner = task.agentId && (!owner || !['working', 'waiting'].includes(owner.status));
      if (['running', 'stalled'].includes(task.status) && (previousProcess || endedOwner)) return { ...task, status: 'unknown', lastRecordedStatus: task.status, uncertainty: previousProcess ? 'No terminal event before session restart' : 'Owner no longer active; command completion not recorded' };
      return task;
    });
    // A long Bash call is visible in Claude before its background task ID is
    // returned. Expose the actual pending tool call separately until that return.
    const pendingTools = new Map();
    for (const [sid, session] of sessions) for (const file of session.files.values()) for (const [toolUseId, call] of file.calls) {
      if (call.name !== 'Bash' || !call.time || sessionStarts.has(sid) && call.time < sessionStarts.get(sid)) continue;
      const actor = currentAgents.find(a => a.sessionId === sid && (call.agentId ? a.agentId === call.agentId : !a.isSubagent));
      if (!actor || actor.status !== 'working' || actor.tool !== 'Bash') continue;
      const key = `${sid}:${call.agentId || 'main'}`;
      if (!pendingTools.has(key) || call.time > pendingTools.get(key).startedAt) pendingTools.set(key, { id: `${sid}:${toolUseId}`, taskId: toolUseId, sessionId: sid, agentId: call.agentId, kind: 'foreground', status: 'running', command: call.command, description: call.description, startedAt: call.time, updatedAt: call.time, toolUseId });
    }
    tasks.push(...pendingTools.values());
    if (sessionId) tasks = tasks.filter(t => t.sessionId === sessionId);
    if (scope !== 'history') tasks = tasks.filter(t => !sessionStarts.has(t.sessionId) || (t.startedAt || t.updatedAt || '') >= sessionStarts.get(t.sessionId));
    tasks = tasks.map(task => ({ ...task, lastRecordedStatus: task.lastRecordedStatus || task.status,
      executionState: ['running', 'unknown'].includes(task.status) ? 'unconfirmed' : task.status,
      lastEventAt: task.updatedAt || task.startedAt || null,
      observationSource: task.kind === 'foreground' ? 'claude-pending-tool-record' : 'claude-transcript-task-lifecycle',
    }));
    const counts = {}, byKind = {}, executionCounts = {};
    for (const t of tasks) { counts[t.status] = (counts[t.status] || 0) + 1; (byKind[t.kind] ||= {})[t.status] = (byKind[t.kind][t.status] || 0) + 1; executionCounts[t.executionState] = (executionCounts[t.executionState] || 0) + 1; }
    if (kind && kind !== 'all') tasks = tasks.filter(t => t.kind === kind);
    if (status && status !== 'all') tasks = tasks.filter(t => t.status === status);
    const query = search.toLowerCase().slice(0, 200);
    if (query) tasks = tasks.filter(t => `${t.taskId} ${t.description} ${t.command} ${t.summary}`.toLowerCase().includes(query));
    tasks.sort((a, b) => (b.startedAt || b.updatedAt || '').localeCompare(a.startedAt || a.updatedAt || '') || a.id.localeCompare(b.id));
    offset = Math.max(0, Number(offset) || 0); limit = Math.min(200, Math.max(1, Number(limit) || 60));
    return { tasks: tasks.slice(offset, offset + limit).map(({ outputFile, ...task }) => task), total: tasks.length, counts, byKind, executionCounts, observedAt: lastScanAt, observationSource: 'claude-transcript-task-lifecycle', countsBasis: 'last-recorded', sessionId: sessionId || '', sessions: [...sessions.keys()], indexing: Boolean(pending), initialScanComplete: scanCount > 0, progress: { ...progress }, lastScanAt, error: error || ([...sessions.values()].some(s => s.missing) ? 'One or more session transcript sources are unavailable' : null), skippedRecords: [...sessions.values()].reduce((n, s) => n + s.skipped, 0), source: 'Claude local transcript task lifecycle', scope: scope === 'history' ? 'history' : 'current', sessionStarts: Object.fromEntries(sessionStarts), coverage: 'Last-recorded task lifecycle plus pending Bash tool calls; running records do not confirm live execution. No access to Claude in-memory task registry or live workflow progress.' };
  }
  return { refresh, snapshot };
}
