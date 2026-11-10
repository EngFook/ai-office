export const CODEX_DEPARTMENTS = ['Engineering', 'Design & Content', 'Research & Planning', 'Quality & Delivery'];

const PROFILE_SEATS = 40;
const LIVE_SEATS = 50 - PROFILE_SEATS;
const LIVE_STATUSES = new Set(['working', 'idle', 'waiting']);
const genericRoles = new Set(['main', 'root', 'default', 'general', 'general purpose', 'coordinator', 'codex coordinator']);
const canonical = new Map([
  ...['engineering', 'engineer', 'coder', 'coding', 'developer', 'worker', 'executor', 'implementer', 'backend', 'frontend', 'software', 'sdk', 'build', 'debugger'].map(role => [role, 0]),
  ...['design & content', 'design and content', 'design', 'designer', 'creative', 'content', 'writer', 'author', 'artist', 'illustrator', 'ui', 'ux'].map(role => [role, 1]),
  ...['research & planning', 'research and planning', 'research', 'researcher', 'explore', 'explorer', 'planner', 'plan', 'analyst', 'analysis', 'scientist', 'data'].map(role => [role, 2]),
  ...['quality & delivery', 'quality and delivery', 'quality', 'delivery', 'reviewer', 'review', 'security', 'auditor', 'audit', 'tester', 'test', 'qa', 'ci', 'deploy', 'release', 'bugbot'].map(role => [role, 3]),
]);

function words(value) {
  return typeof value === 'string' ? value.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/[_:/.-]+/g, ' ').replace(/\s+/g, ' ').trim() : '';
}

function category(value) {
  const text = words(value);
  if (!text || genericRoles.has(text)) return null;
  if (canonical.has(text)) return canonical.get(text);
  if (/\b(review(?:er|ing)?|security|test(?:er|ing|s)?|qa|ci|cd|deploy(?:ment|ing)?|release|delivery|audit(?:or|ing)?|bugbot|validation|verification)\b/.test(text)) return 3;
  if (/\b(image(?:gen|s)?|imagegen|design(?:er|ing)?|documents?|documentation|docs?|presentations?|slides?|assets?|content|creative|illustration|illustrator|artists?|writer|writing|pdf|templates?|pets?|mascot|ui|ux|scene|layout|floor)\b/.test(text)) return 1;
  if (/\b(search|research(?:er|ing)?|planning|planner|plan|explore|explorer|analysis|analy[sz]e|analyst|data|spreadsheets?|csv|visualiz(?:e|ation)|canvas|locate)\b/.test(text)) return 2;
  if (/\b(engineering|engineer|coding|coder|code|developer|development|sdk|api|cli|build|backend|frontend|software|debugger|hooks?|sites?)\b/.test(text)) return 0;
  return null;
}

// Only public skill/actor metadata determines the department. Prompt, transcript,
// tool arguments and output are deliberately never inspected.
export function codexDepartment(item = {}) {
  for (const value of [item.category, item.agentRole]) {
    const found = category(value);
    if (found !== null) return CODEX_DEPARTMENTS[found];
  }
  for (const value of [item.agentType, item.agentPath, item.name]) {
    const found = category(value);
    if (found !== null) return CODEX_DEPARTMENTS[found];
  }
  // The generic coordinator belongs to Engineering; an incidental web or image
  // tool call does not turn the whole root session into a different specialist.
  const root = item.isSubagent === false || (item.isSubagent !== true && genericRoles.has(words(item.agentType))) || words(item.agentPath) === 'root';
  if (root) return CODEX_DEPARTMENTS[0];
  for (const value of [item.tool, item.lastTool, item.id]) {
    const found = category(value);
    if (found !== null) return CODEX_DEPARTMENTS[found];
  }
  return CODEX_DEPARTMENTS[0];
}

// Overflow repeats four department blocks, preserving each department rather
// than placing every extra Codex worker in the last room.
export function codexDepartmentForIndex(index) {
  return Math.floor(Math.max(0, index) / 50) % 4;
}

export function codexSeatForIndex(index) {
  return { department: codexDepartmentForIndex(index), local: Math.floor(Math.max(0, index) / 200) * 50 + Math.max(0, index) % 50 };
}

const titleWords = { ai: 'AI', api: 'API', cli: 'CLI', ci: 'CI', sdk: 'SDK', ui: 'UI', ux: 'UX', pdf: 'PDF', csv: 'CSV', html: 'HTML', json: 'JSON', latex: 'LaTeX', openai: 'OpenAI' };
function skillTitle(skill) {
  return String(skill.name || skill.id.split(':').pop()).split(/[-_:]/).filter(Boolean).map(word => titleWords[word.toLowerCase()] || word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

function timestamp(value) {
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function uniqueRecords(records) {
  const byId = new Map();
  for (const record of records) {
    if (!record || typeof record.id !== 'string' || !record.id.trim()) continue;
    const previous = byId.get(record.id);
    if (!previous || timestamp(record.updatedAt) >= timestamp(previous.updatedAt)) byId.set(record.id, record);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function codexWorkerIdentity(worker = {}) {
  const root = worker.agentType === 'main' || worker.isSubagent === false;
  const actorId = root ? worker.sessionId || worker.id : worker.id;
  const shortId = String(actorId || '').split(':').pop().slice(-6);
  const label = worker.name || (!genericRoles.has(words(worker.agentType)) && worker.agentType) || (root ? 'Codex coordinator' : 'Codex agent');
  const project = worker.cwd?.split(/[\\/]/).filter(Boolean).pop() || 'Local project';
  return { label, shortId, project };
}

// Skill profiles describe installed capabilities and remain idle. Each observed
// worker gets its own stable identity and seat, independent of any skill it uses.
// The first 40 places in each block are profiles, the last 10 are live workers;
// this keeps catalog changes from moving workers or colliding with their seats.
export function buildCodexRoster(skills = [], agents = [], available = true, seats = new Map()) {
  const workers = uniqueRecords(agents).filter(worker => worker.status !== 'offline' && worker.observed !== false);
  const liveIds = new Set(workers.map(worker => worker.id));
  for (const id of seats.keys()) if (!liveIds.has(id)) seats.delete(id);
  const occupied = new Set();
  for (const worker of workers) {
    const index = seats.get(worker.id);
    if (!Number.isSafeInteger(index) || index < 0 || index % 50 < PROFILE_SEATS || occupied.has(index)) seats.delete(worker.id);
    else occupied.add(index);
  }
  for (const worker of workers) {
    if (seats.has(worker.id)) continue;
    const department = CODEX_DEPARTMENTS.indexOf(codexDepartment(worker));
    let ordinal = 0, index;
    do {
      index = Math.floor(ordinal / LIVE_SEATS) * 200 + department * 50 + 49 - ordinal % LIVE_SEATS;
      ordinal++;
    } while (occupied.has(index));
    seats.set(worker.id, index);
    occupied.add(index);
  }
  const profileCounts = [0, 0, 0, 0];
  const roster = uniqueRecords(skills).map(skill => {
    const department = CODEX_DEPARTMENTS.indexOf(codexDepartment(skill));
    const ordinal = profileCounts[department]++;
    const index = Math.floor(ordinal / PROFILE_SEATS) * 200 + department * 50 + ordinal % PROFILE_SEATS;
    return {
      id: `codex-skill-${skill.id}`, index, name: skillTitle(skill), description: skill.description || '',
      department: CODEX_DEPARTMENTS[department], floor: 1, provider: 'Codex', kind: 'specialist',
      skillId: skill.id, skill, skills: [skill.id], runtimeAgents: [], liveStatus: 'idle',
    };
  });
  for (const original of workers) {
    const worker = { ...original, provider: 'Codex' };
    const index = seats.get(worker.id);
    const department = codexDepartmentForIndex(index);
    const identity = codexWorkerIdentity(worker);
    roster.push({
      id: `codex-live-${worker.id}`, index, name: identity.label,
      description: worker.isSubagent ? 'An observed Codex subagent.' : 'An observed Codex session.',
      department: CODEX_DEPARTMENTS[department], floor: 1, provider: 'Codex', kind: 'live',
      skillId: worker.skillId, skill: undefined, skills: worker.skillId ? [worker.skillId] : [],
      runtimeAgents: [worker], liveStatus: available ? (LIVE_STATUSES.has(worker.status) ? worker.status : 'idle') : 'offline',
    });
  }
  return roster;
}
