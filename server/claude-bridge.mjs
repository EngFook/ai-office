import { readdir, readFile, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

// This bridge only reads the installation catalog and the hook's metadata inbox.
// It never opens transcripts, runs agents, or accepts event writes over HTTP.
const EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'Stop', 'StopFailure', 'SessionEnd', 'SubagentStart', 'SubagentStop']);
const WAITING = new Set(['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input']);
const REQUIRED_HOOKS = [...EVENTS];
const MAX_JSON_BYTES = 64 * 1024;

function defaultClaudeHome() {
  return process.env.CLAUDE_CONFIG_DIR ? path.resolve(process.env.CLAUDE_CONFIG_DIR) : path.join(homedir(), '.claude');
}

function cleanString(value, max = 200) {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) return '';
  return value.trim().slice(0, max);
}

function identifier(value) {
  const text = cleanString(value, 180);
  return /^[a-zA-Z0-9_.:@-]+$/.test(text) ? text : '';
}

function cleanCwd(value) {
  const text = cleanString(value, 2048);
  return text && path.isAbsolute(text) ? path.normalize(text) : '';
}

async function safeRead(file, limit = MAX_JSON_BYTES) {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) return null;
    return await readFile(file, 'utf8');
  } catch { return null; }
}

async function readJson(file) {
  try { return JSON.parse(await safeRead(file)); } catch { return null; }
}

function frontmatterValue(text, key) {
  const header = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!header) return '';
  const lines = header[1].split(/\r?\n/);
  const index = lines.findIndex(line => line.startsWith(`${key}:`));
  if (index < 0) return '';
  let value = lines[index].slice(key.length + 1).trim();
  if (/^[>|][+-]?$/.test(value)) {
    const continuation = [];
    for (const line of lines.slice(index + 1)) {
      if (line && !/^\s/.test(line)) break;
      continuation.push(line.trim());
    }
    value = continuation.join(' ');
  }
  return cleanString(value.replace(/^(['"])([\s\S]*)\1$/, '$2'), 1800);
}

async function skillFiles(directory, depth = 0) {
  if (depth > 6) return [];
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const found = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await skillFiles(file, depth + 1));
    else if (entry.name === 'SKILL.md') found.push(file);
  }
  return found;
}

export async function discoverSkills(claudeHome = defaultClaudeHome()) {
  const manifest = await readJson(path.join(claudeHome, 'plugins', 'installed_plugins.json'));
  const catalog = new Map();
  for (const [source, versions] of Object.entries(manifest?.plugins || {})) {
    if (!source.endsWith('@awesome-gamedev-agent-skills')) continue;
    const pluginName = identifier(source.split('@')[0]);
    if (!pluginName || !Array.isArray(versions)) continue;
    // Stable IDs do not include the version hash. Prefer the latest install.
    const installations = [...versions].sort((a, b) => String(b.lastUpdated || b.installedAt || '').localeCompare(String(a.lastUpdated || a.installedAt || '')));
    for (const installation of installations) {
      const installPath = cleanCwd(installation.installPath);
      if (!installPath) continue;
      const root = path.join(installPath, 'skills');
      for (const file of [...await skillFiles(root), path.join(installPath, 'router', 'SKILL.md')]) {
        const text = await safeRead(file, 512 * 1024);
        if (!text) continue;
        const name = identifier(frontmatterValue(text, 'name') || path.basename(path.dirname(file)));
        if (!name) continue;
        const id = `${pluginName}:${name}`;
        if (catalog.has(id)) continue;
        const relative = path.relative(root, file).split(path.sep);
        const category = file === path.join(installPath, 'router', 'SKILL.md') ? 'router' : relative.length > 2 ? relative[0] : 'general';
        catalog.set(id, { id, name, description: frontmatterValue(text, 'description'), category, source, invocation: id });
      }
      if (catalog.size) break;
    }
  }
  return [...catalog.values()].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

export function sanitizeEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const event = raw.event || raw.hook_event_name;
  const sessionId = identifier(raw.sessionId || raw.session_id);
  const timestamp = typeof raw.timestamp === 'number' ? raw.timestamp : Date.parse(raw.timestamp);
  if (!EVENTS.has(event) || !sessionId || !Number.isFinite(timestamp) || timestamp <= 0 || timestamp > 8640000000000000) return null;
  const tool = identifier(raw.tool || raw.tool_name);
  const pid = Number(raw.pid);
  return {
    event, sessionId, timestamp,
    agentId: identifier(raw.agentId || raw.agent_id),
    agentType: identifier(raw.agentType || raw.agent_type),
    cwd: cleanCwd(raw.cwd), tool,
    skill: tool === 'Skill' ? identifier(raw.skill || raw.tool_input?.skill) : '',
    notificationType: identifier(raw.notificationType || raw.notification_type),
    pid: Number.isSafeInteger(pid) && pid > 1 ? pid : null,
  };
}

function resolveSkill(value, skills) {
  if (!value) return null;
  return skills.find(skill => skill.id === value || skill.name === value || `ai-office-${skill.name}` === value || (skill.category === 'router' && value === 'ai-office-gamedev-router'))?.id || null;
}

export function reconstructAgents(input, skills = [], { isProcessAlive } = {}) {
  const events = input.map(sanitizeEvent).filter(Boolean).sort((a, b) => a.timestamp - b.timestamp);
  const agents = new Map();
  const mainAgentIds = new Map();
  const endedSessions = new Set();
  const stoppedAgents = new Set();
  for (const event of events) {
    const mainId = `${event.sessionId}:main`;
    // SessionStart describes the session's primary agent, including --agent
    // sessions. Remember its ID if a Claude host supplies one in common fields.
    if (event.event === 'SessionStart') mainAgentIds.set(event.sessionId, event.agentId);
    const mainLifecycle = ['SessionStart', 'Stop', 'StopFailure'].includes(event.event);
    const isSubagent = !mainLifecycle && Boolean(event.agentId) && event.agentId !== mainAgentIds.get(event.sessionId);
    const id = isSubagent ? `${event.sessionId}:${event.agentId}` : mainId;
    if (event.event === 'SessionEnd') {
      endedSessions.add(event.sessionId);
      if (!agents.has(mainId)) agents.set(mainId, { id: mainId, sessionId: event.sessionId, agentType: 'main', name: 'Claude Code', isSubagent: false, cwd: event.cwd, lastTool: null, lastToolAt: null, lastToolOutcome: null, pid: event.pid });
      for (const agent of agents.values()) {
        if (agent.sessionId === event.sessionId) Object.assign(agent, { status: 'offline', tool: null, skillId: null, updatedAt: new Date(event.timestamp).toISOString(), lastEvent: event.event });
      }
      continue;
    }
    // An explicit session end outranks late child/tool notifications. Only a
    // new SessionStart may revive that session; metadata discovery must not.
    if (event.event === 'SessionStart') endedSessions.delete(event.sessionId);
    else if (endedSessions.has(event.sessionId)) continue;
    // A completed child's delayed tool/notification hook is not a new task.
    // Claude emits SubagentStart when that same child is explicitly resumed.
    if (isSubagent && event.event === 'SubagentStart') stoppedAgents.delete(id);
    else if (isSubagent && stoppedAgents.has(id)) continue;
    // A resumed session is a new lifecycle; old subagents cannot remain active.
    if (event.event === 'SessionStart') {
      for (const agent of agents.values()) {
        if (agent.sessionId === event.sessionId && agent.isSubagent) {
          Object.assign(agent, { status: 'offline', tool: null, skillId: null, updatedAt: new Date(event.timestamp).toISOString() });
          stoppedAgents.add(agent.id);
        }
      }
    }
    let agent = agents.get(id);
    if (!agent) {
      agent = { id, sessionId: event.sessionId, agentType: event.agentType || (isSubagent ? 'subagent' : 'main'), name: event.agentType || (isSubagent ? 'Claude subagent' : 'Claude Code'), status: 'idle', cwd: '', tool: null, lastTool: null, lastToolAt: null, lastToolOutcome: null, skillId: null, updatedAt: null, isSubagent, pid: null };
      agents.set(id, agent);
    }
    if (event.cwd) agent.cwd = event.cwd;
    if (event.agentType) agent.agentType = agent.name = event.agentType;
    if (event.pid) agent.pid = event.pid;
    agent.updatedAt = new Date(event.timestamp).toISOString();
    agent.lastEvent = event.event;
    if (event.tool && ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(event.event)) {
      agent.lastTool = event.tool;
      agent.lastToolAt = agent.updatedAt;
      agent.lastToolOutcome = { PreToolUse: 'running', PostToolUse: 'succeeded', PostToolUseFailure: 'failed' }[event.event];
    }
    if (event.event === 'SessionStart') {
      Object.assign(agent, { status: 'idle', tool: null, skillId: null });
    } else if (['UserPromptSubmit', 'SubagentStart', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(event.event)) {
      agent.status = 'working';
      agent.tool = event.event === 'PreToolUse' ? event.tool || null : null;
      if (event.event === 'UserPromptSubmit') agent.skillId = null;
      if (event.skill) agent.skillId = resolveSkill(event.skill, skills);
      if (!agent.skillId) agent.skillId = resolveSkill(agent.agentType, skills);
    } else if (event.event === 'Notification') {
      if (WAITING.has(event.notificationType)) agent.status = 'waiting';
      else if (event.notificationType === 'idle_prompt') Object.assign(agent, { status: 'idle', tool: null, skillId: null });
      else if (event.notificationType === 'elicitation_complete' || event.notificationType === 'elicitation_response') agent.status = 'working';
    } else if (event.event === 'StopFailure') {
      Object.assign(agent, { status: 'waiting', tool: null, skillId: null });
    } else if (event.event === 'Stop' || event.event === 'SubagentStop') {
      Object.assign(agent, { status: 'idle', tool: null, skillId: null });
      if (event.event === 'SubagentStop') stoppedAgents.add(id);
    }
  }
  for (const agent of agents.values()) {
    if (agent.pid && isProcessAlive && !isProcessAlive(agent.pid)) Object.assign(agent, { status: 'offline', tool: null, skillId: null });
    // pid is internal liveness evidence, not part of the browser payload.
    delete agent.pid;
  }
  return [...agents.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

async function hookInstalled(claudeHome) {
  const settings = await readJson(path.join(claudeHome, 'settings.json'));
  if (!settings || settings.disableAllHooks === true) return false;
  const script = await lstat(path.join(claudeHome, 'ai-office', 'hook.mjs')).catch(() => null);
  if (!script?.isFile()) return false;
  return REQUIRED_HOOKS.every(event => (settings.hooks?.[event] || []).some(group => (group.hooks || []).some(hook => hook.type === 'command' && typeof hook.command === 'string' && /ai-office[\/\\]/.test(hook.command))));
}

async function discoverSessions(claudeHome, isProcessAlive) {
  const directory = path.join(claudeHome, 'sessions');
  const files = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const sessions = new Map();
  for (const file of files) {
    if (!file.isFile() || file.isSymbolicLink() || !/^[a-zA-Z0-9_.-]+\.json$/.test(file.name)) continue;
    const metadata = await readJson(path.join(directory, file.name));
    const sessionId = identifier(metadata?.sessionId);
    const pid = Number(metadata?.pid);
    if (!sessionId || !Number.isSafeInteger(pid) || pid < 2) continue;
    const alive = isProcessAlive(pid);
    // Retain dead-PID evidence for recorded events even though dead metadata
    // alone does not add a historical agent to the visible roster.
    if (sessions.get(sessionId)?.alive && !alive) continue;
    const started = typeof metadata.startedAt === 'number' ? metadata.startedAt : Date.parse(metadata.startedAt);
    sessions.set(sessionId, { pid, alive, agent: { id: `${sessionId}:main`, sessionId, agentType: 'main', name: 'Claude Code', status: 'idle', cwd: cleanCwd(metadata.cwd), tool: null, lastTool: null, lastToolAt: null, lastToolOutcome: null, skillId: null, updatedAt: Number.isFinite(started) && started > 0 && started < 8640000000000000 ? new Date(started).toISOString() : null, isSubagent: false, lastEvent: 'Discovered', observed: false } });
  }
  return sessions;
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

export async function readClaudeStatus({ claudeHome = defaultClaudeHome(), isProcessAlive = processAlive } = {}) {
  const inbox = path.join(claudeHome, 'ai-office', 'events');
  const [skills, installed, files, discovered] = await Promise.all([discoverSkills(claudeHome), hookInstalled(claudeHome), readdir(inbox, { withFileTypes: true }).catch(() => []), discoverSessions(claudeHome, isProcessAlive)]);
  const events = [];
  for (const file of files) {
    if (!file.isFile() || file.isSymbolicLink() || !/^[a-zA-Z0-9_.-]+\.json$/.test(file.name)) continue;
    const event = sanitizeEvent(await readJson(path.join(inbox, file.name)));
    if (event) events.push(event);
  }
  const enriched = events.map(event => event.pid || !discovered.has(event.sessionId) ? event : { ...event, pid: discovered.get(event.sessionId).pid });
  const agents = reconstructAgents(enriched, skills, { isProcessAlive });
  for (const agent of agents) agent.observed = true;
  for (const { agent, alive } of discovered.values()) if (alive && !agents.some(recorded => recorded.id === agent.id)) agents.push(agent);
  const updatedAt = events.length ? new Date(events.reduce((latest, event) => Math.max(latest, event.timestamp), 0)).toISOString() : null;
  const liveAgentCount = agents.filter(agent => agent.status !== 'offline').length;
  return { connected: liveAgentCount > 0, hookInstalled: installed, updatedAt, lastEventAt: updatedAt, liveAgentCount, topicSkillCount: skills.filter(skill => skill.category !== 'router').length, skills, agents, eventCount: events.length, source: 'Claude Code local lifecycle hooks', privacy: 'Lifecycle metadata only; no prompts, transcripts, tool arguments, or outputs are read.' };
}

function isLoopback(address = '') {
  return address === '127.0.0.1' || address === '::1' || address.startsWith('::ffff:127.');
}

function allowRequest(request) {
  if (!isLoopback(request.socket?.remoteAddress)) return false;
  try {
    const host = new URL(`http://${request.headers.host}`);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname)) return false;
    const origin = request.headers.origin;
    if (origin && new URL(origin).origin !== host.origin) return false;
    if (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site'])) return false;
    return true;
  } catch { return false; }
}

export function claudeBridge(options = {}) {
  let cached = null;
  let refreshedAt = 0;
  let pending = null;
  const middleware = async (request, response, next) => {
    const url = request.url?.split('?')[0];
    if (url !== '/api/claude/status') return next();
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (!allowRequest(request)) { response.statusCode = 403; response.end('{"error":"Local same-origin access only"}'); return; }
    if (request.method !== 'GET') { response.statusCode = 405; response.setHeader('Allow', 'GET'); response.end('{"error":"Read-only endpoint"}'); return; }
    try {
      if (!cached || Date.now() - refreshedAt > 1000) {
        pending ||= readClaudeStatus(options).then(result => { cached = result; refreshedAt = Date.now(); return result; }).finally(() => { pending = null; });
        await pending;
      }
      response.end(JSON.stringify(cached));
    } catch {
      response.statusCode = 500;
      response.end('{"error":"Claude activity is temporarily unavailable"}');
    }
  };
  return { name: 'ai-office-claude-bridge', configureServer(server) { server.middlewares.use(middleware); }, configurePreviewServer(server) { server.middlewares.use(middleware); } };
}
