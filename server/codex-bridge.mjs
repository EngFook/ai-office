import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { open, readdir, readFile, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { workerEnvironment } from './worker-environment.mjs';

const execute = promisify(execFile);
const TAIL_BYTES = 4 * 1024 * 1024;
const START = new Set(['task_started', 'turn_started']);
const STOP = new Set(['task_complete', 'turn_complete', 'turn_completed', 'turn_aborted', 'turn_cancelled', 'task_interrupted']);
const WAIT = new Set(['exec_approval_request', 'apply_patch_approval_request', 'request_user_input', 'mcp_elicitation_request']);
const COLUMNS = ['id', 'rollout_path', 'cwd', 'source', 'agent_nickname', 'agent_role', 'agent_path', 'updated_at', 'updated_at_ms', 'archived'];
const defaultHome = () => process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(homedir(), '.codex');
const clean = (value, max = 200) => typeof value === 'string' && !/[\x00-\x1f\x7f]/.test(value) ? value.trim().slice(0, max) : '';
const identifier = value => /^[a-zA-Z0-9_.:@/-]+$/.test(clean(value)) ? clean(value) : '';
const cwd = value => { const text = clean(value, 2048); return text && path.isAbsolute(text) ? path.normalize(text) : ''; };
const iso = value => Number.isFinite(value) && value > 0 && value <= 8640000000000000 ? new Date(value).toISOString() : null;

async function smallFile(file, max = 512 * 1024) {
  try {
    const stat = await lstat(file);
    return stat.isFile() && !stat.isSymbolicLink() && stat.size <= max ? await readFile(file, 'utf8') : null;
  } catch { return null; }
}

export function parseLockOwners(text, directory) {
  const owners = new Map();
  let pid = null;
  for (const line of String(text || '').split('\n')) {
    if (/^p\d+$/.test(line)) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid > 1) {
      const file = line.slice(1);
      if (path.dirname(file) !== directory) continue;
      const id = path.basename(file).match(/^([a-zA-Z0-9-]+)\.lock$/)?.[1];
      if (id) owners.set(id, pid);
    }
  }
  return owners;
}

async function lockOwners(codexHome) {
  const directory = path.join(codexHome, 'thread-writer-locks');
  const stat = await lstat(directory).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return { owners: new Map(), available: false };
  for (const program of ['/usr/sbin/lsof', '/usr/bin/lsof']) {
    try {
      const { stdout } = await execute(program, ['-Fpn', '+D', directory], { env: workerEnvironment(), timeout: 4000, maxBuffer: 1024 * 1024 });
      return { owners: parseLockOwners(stdout, directory), available: true };
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      if (typeof error.code === 'number' && error.code === 1) return { owners: parseLockOwners(error.stdout, directory), available: true };
      return { owners: new Map(), available: false };
    }
  }
  return { owners: new Map(), available: false };
}

export function readThreadMetadata(codexHome, loadedIds = []) {
  let database;
  try {
    database = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'), { readOnly: true });
    const columns = new Set(database.prepare('PRAGMA table_info(threads)').all().map(row => row.name));
    if (!columns.has('id')) return [];
    // Deliberately exclude title, preview, first_user_message, policies, and auth.
    const selection = COLUMNS.map(column => columns.has(column) ? column : `NULL AS ${column}`).join(', ');
    const rows = database.prepare(`SELECT ${selection} FROM threads ORDER BY ${columns.has('updated_at') ? 'updated_at' : 'id'} DESC LIMIT 128`).all();
    for (const id of loadedIds.slice(0, 256)) {
      if (!rows.some(row => row.id === id)) {
        const row = database.prepare(`SELECT ${selection} FROM threads WHERE id = ?`).get(id);
        if (row) rows.push(row);
      }
    }
    return rows;
  } catch { return []; }
  finally { database?.close(); }
}

// Projection is the privacy boundary. Returned objects contain no message,
// prompt, reasoning, command, arguments, tool input, or tool result fields.
export function sanitizeCodexRecord(record) {
  if (!record || typeof record !== 'object') return null;
  const timestamp = typeof record.timestamp === 'number' ? record.timestamp : Date.parse(record.timestamp);
  if (!iso(timestamp)) return null;
  const payload = record.payload;
  if (!payload || typeof payload !== 'object') return null;
  if (record.type === 'event_msg') {
    const type = payload.type;
    if (START.has(type) || STOP.has(type) || WAIT.has(type)) return { type, timestamp };
    if (type === 'item_completed') {
      const item = payload.item;
      const names = { CommandExecution: 'Shell', FileChange: 'File edit', McpToolCall: 'MCP tool', DynamicToolCall: 'Tool call' };
      if (!item || !names[item.type]) return null;
      return { type: 'tool_completed', timestamp, tool: names[item.type], outcome: item.status === 'failed' ? 'failed' : 'succeeded' };
    }
    return null;
  }
  if (record.type !== 'response_item') return null;
  if (['function_call', 'custom_tool_call'].includes(payload.type)) {
    const tool = identifier(payload.name);
    if (!tool) return null;
    const namespace = identifier(payload.namespace);
    return { type: 'tool_started', timestamp, tool: namespace ? `${namespace}.${tool}` : tool, callId: identifier(payload.call_id) };
  }
  if (['function_call_output', 'custom_tool_call_output'].includes(payload.type)) return { type: 'tool_finished', timestamp, callId: identifier(payload.call_id) };
  return null;
}

export function reduceCodexEvents(events, previous) {
  const state = previous ? { ...previous, calls: new Map(previous.calls) } : { status: 'idle', tool: null, lastTool: null, lastToolAt: null, lastToolOutcome: null, updatedAt: null, lastEvent: 'Discovered', observed: false, activeTurn: null, calls: new Map() };
  for (const event of events) {
    if (!event) continue;
    if (START.has(event.type)) {
      state.status = 'working'; state.activeTurn = true; state.tool = null; state.calls.clear();
    } else if (STOP.has(event.type)) {
      state.status = 'idle'; state.activeTurn = false; state.tool = null; state.calls.clear();
    } else if (WAIT.has(event.type)) {
      if (state.activeTurn === false) continue;
      state.status = 'waiting';
    } else if (['tool_started', 'tool_finished', 'tool_completed'].includes(event.type)) {
      if (state.activeTurn === false) continue;
      state.status = 'working';
      let tool = event.tool;
      if (event.type === 'tool_started') {
        state.tool = tool;
        if (/(?:^|[._])request_user_input(?:_async)?$/.test(tool)) state.status = 'waiting';
        if (event.callId) state.calls.set(event.callId, tool);
      } else if (event.type === 'tool_finished') {
        tool = state.calls.get(event.callId);
        state.calls.delete(event.callId);
        state.tool = [...state.calls.values()].at(-1) || null;
      } else state.tool = null;
      if (tool) {
        state.lastTool = tool;
        state.lastToolAt = iso(event.timestamp);
        state.lastToolOutcome = event.type === 'tool_started' ? 'running' : event.outcome || 'succeeded';
      }
    } else continue;
    state.lastEvent = event.type;
    state.updatedAt = iso(event.timestamp);
    state.observed = true;
  }
  return state;
}

async function rolloutState(file, codexHome, cache) {
  const safePath = cwd(file);
  const relative = path.relative(codexHome, safePath);
  if (!safePath || relative.startsWith('..') || path.isAbsolute(relative) || !['sessions', 'archived_sessions'].includes(relative.split(path.sep)[0])) return reduceCodexEvents([]);
  let handle;
  try {
    const actual = await realpath(safePath);
    const actualHome = await realpath(codexHome);
    const actualRelative = path.relative(actualHome, actual);
    if (actualRelative.startsWith('..') || path.isAbsolute(actualRelative) || !['sessions', 'archived_sessions'].includes(actualRelative.split(path.sep)[0])) return reduceCodexEvents([]);
    handle = await open(safePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    if (!stat.isFile()) return reduceCodexEvents([]);
    const old = cache.get(safePath);
    if (old?.size === stat.size && old.mtime === stat.mtimeMs) return old.state;
    const append = old && stat.size >= old.size && stat.size - old.offset <= TAIL_BYTES;
    const offset = append ? old.offset : Math.max(0, stat.size - TAIL_BYTES);
    const buffer = Buffer.alloc(Math.min(TAIL_BYTES, stat.size - offset));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    const first = !append && offset > 0 ? text.indexOf('\n') + 1 : 0;
    const last = text.lastIndexOf('\n');
    const events = [];
    if (last >= first) for (const line of text.slice(first, last).split('\n')) {
      // Skip unrelated content without parsing it. Field order is native
      // rollout timestamp/type/payload; only allowlisted projections survive.
      if (!/"type"\s*:\s*"(?:event_msg|response_item)"/.test(line.slice(0, 240))) continue;
      try { const event = sanitizeCodexRecord(JSON.parse(line)); if (event) events.push(event); } catch { /* partial/unrecognized record */ }
    }
    const state = reduceCodexEvents(events, append ? old.state : undefined);
    // Cache only sanitized state and byte offsets, never raw rollout lines.
    cache.set(safePath, { state, size: stat.size, mtime: stat.mtimeMs, offset: last >= 0 ? offset + Buffer.byteLength(text.slice(0, last + 1)) : offset });
    return state;
  } catch { return reduceCodexEvents([]); }
  finally { await handle?.close(); }
}

function frontmatter(text) {
  const header = text?.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] || '';
  const fields = {};
  const lines = header.split(/\r?\n/);
  for (const key of ['name', 'description']) {
    const index = lines.findIndex(line => line.startsWith(`${key}:`));
    if (index < 0) continue;
    let value = lines[index].slice(key.length + 1).trim();
    if (/^[>|][+-]?$/.test(value)) {
      const more = [];
      for (const line of lines.slice(index + 1)) { if (line && !/^\s/.test(line)) break; more.push(line.trim()); }
      value = more.join(' ');
    }
    fields[key] = clean(value.replace(/^(['"])([\s\S]*)\1$/, '$2'), key === 'name' ? 180 : 1800);
  }
  return fields;
}

async function findSkills(directory, depth = 0) {
  if (depth > 3) return [];
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (entry.isSymbolicLink()) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await findSkills(file, depth + 1));
    else if (entry.name === 'SKILL.md') files.push(file);
  }
  return files;
}

export async function discoverCodexSkills({ codexHome = defaultHome(), agentsHome = path.join(homedir(), '.agents') } = {}) {
  const roots = [{ directory: path.join(agentsHome, 'skills'), source: 'Local agent skills' }, { directory: path.join(codexHome, 'skills'), source: 'Codex skills' }];
  // Read only plugin section names and explicit enabled booleans from config.
  const config = await smallFile(path.join(codexHome, 'config.toml')) || '';
  const enabled = new Set();
  let section = null;
  for (const line of config.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) section = line.match(/^\s*\[plugins\."([a-zA-Z0-9_.@-]+)"\]\s*$/)?.[1] || null;
    else if (section && /^\s*enabled\s*=\s*true(?:\s*#.*)?\s*$/.test(line)) enabled.add(section);
  }
  for (const plugin of enabled) {
    const [name, market] = plugin.split('@');
    if (!name || !market) continue;
    const base = path.join(codexHome, 'plugins', 'cache', market, name);
    const versions = (await readdir(base, { withFileTypes: true }).catch(() => [])).filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).map(entry => entry.name).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    if (versions[0]) roots.push({ directory: path.join(base, versions[0], 'skills'), source: plugin });
  }
  const catalog = new Map();
  for (const { directory, source } of roots) for (const file of await findSkills(directory)) {
    const fields = frontmatter(await smallFile(file));
    const slug = path.basename(path.dirname(file));
    if (!identifier(slug) || !fields.name) continue;
    const id = `codex:${source.includes('@') ? source.split('@')[0] + ':' : ''}${slug}`;
    if (!catalog.has(id)) catalog.set(id, { id, name: fields.name, description: fields.description || '', category: 'available', source });
  }
  return [...catalog.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function readCodexStatus({ codexHome = defaultHome(), agentsHome, owners, cache = new Map() } = {}) {
  const lockState = owners ? { owners, available: true } : await lockOwners(codexHome);
  const [skills, rows] = await Promise.all([discoverCodexSkills({ codexHome, agentsHome }), Promise.resolve(readThreadMetadata(codexHome, [...lockState.owners.keys()]))]);
  const agents = [];
  for (const row of rows) {
    const id = identifier(row.id);
    if (!id) continue;
    const loaded = lockState.owners.has(id) && !row.archived;
    // Inactive history stays out of the floor; expose a small recent ended
    // roster only if it was previously observed by this bridge instance.
    if (!loaded && !cache.has(`agent:${id}`)) continue;
    let spawn = null;
    try { spawn = JSON.parse(row.source)?.subagent?.thread_spawn; } catch { /* source may be 'vscode'/'exec' */ }
    const agentPath = clean(row.agent_path || spawn?.agent_path, 200);
    const agentRole = clean(row.agent_role || spawn?.agent_role, 100);
    const isSubagent = Boolean(spawn || agentPath && agentPath !== '/root');
    const agentType = agentRole || clean(agentPath.split('/').pop()) || 'main';
    const name = clean(row.agent_nickname || spawn?.agent_nickname) || (isSubagent ? `Codex ${agentType}` : 'Codex coordinator');
    const state = loaded ? await rolloutState(row.rollout_path, codexHome, cache) : cache.get(`agent:${id}`)?.state || reduceCodexEvents([]);
    const { calls, activeTurn, ...activity } = state;
    const updatedAt = state.updatedAt || iso(row.updated_at_ms || row.updated_at * 1000);
    agents.push({ id, sessionId: id, agentType, agentRole: agentRole || null, agentPath: agentPath || null, name, ...activity, status: loaded ? state.status : 'offline', tool: loaded ? state.tool : null, cwd: cwd(row.cwd), updatedAt, isSubagent, parentSessionId: identifier(spawn?.parent_thread_id) || null });
    cache.set(`agent:${id}`, { state });
  }
  const updatedAt = agents.map(agent => agent.updatedAt).filter(Boolean).sort().at(-1) || null;
  return { connected: agents.some(agent => agent.status !== 'offline'), source: 'Codex local writer locks and lifecycle metadata', metadataAvailable: lockState.available, updatedAt, lastEventAt: updatedAt, liveAgentCount: agents.filter(agent => agent.status !== 'offline').length, agents, skills, privacy: 'Only thread identity, writer-lock liveness, lifecycle types and tool names are exposed. Prompts, messages, reasoning, arguments, results and authentication are excluded.' };
}

function allowed(request) {
  const address = request.socket?.remoteAddress || '';
  if (!['127.0.0.1', '::1'].includes(address) && !address.startsWith('::ffff:127.')) return false;
  try {
    const host = new URL(`http://${request.headers.host}`);
    return ['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname) && (!request.headers.origin || new URL(request.headers.origin).origin === host.origin) && (!request.headers['sec-fetch-site'] || ['same-origin', 'none'].includes(request.headers['sec-fetch-site']));
  } catch { return false; }
}

export function codexBridge(options = {}) {
  const cache = new Map();
  let last = null, refreshedAt = 0, pending = null;
  const middleware = async (request, response, next) => {
    if (request.url?.split('?')[0] !== '/api/codex/status') return next();
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (!allowed(request)) { response.statusCode = 403; response.end('{"error":"Local same-origin access only"}'); return; }
    if (request.method !== 'GET') { response.statusCode = 405; response.setHeader('Allow', 'GET'); response.end('{"error":"Read-only endpoint"}'); return; }
    try {
      if (!last || Date.now() - refreshedAt > 1000) {
        pending ||= readCodexStatus({ ...options, cache }).then(value => { last = value; refreshedAt = Date.now(); }).finally(() => { pending = null; });
        await pending;
      }
      response.end(JSON.stringify(last));
    } catch { response.statusCode = 500; response.end('{"error":"Codex activity is temporarily unavailable"}'); }
  };
  return { name: 'ai-office-codex-bridge', configureServer(server) { server.middlewares.use(middleware); }, configurePreviewServer(server) { server.middlewares.use(middleware); } };
}
