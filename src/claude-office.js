export const CLAUDE_DEPARTMENTS = ['Engines', 'Game Systems', 'Design & Production', 'Claude Runtime'];

const ENGINE_CATEGORIES = new Set(['godot', 'unity', 'unreal', 'ebitengine', 'web-engines', 'other-engines']);
const words = {godot:'Godot', unity:'Unity', unreal:'Unreal', threejs:'Three.js', gltf:'glTF', gdscript:'GDScript', csharp:'C#', cpp:'C++', ui:'UI', ux:'UX', ai:'AI', ecs:'ECS', fps:'FPS', rpg:'RPG', pixijs:'PixiJS', love2d:'LÖVE', pygame:'pygame', roblox:'Roblox', luau:'Luau', navmesh:'NavMesh', scriptableobjects:'ScriptableObjects', '2d':'2D', '3d':'3D'};
export const skillTitle = skill => skill.category === 'router' ? 'Game Development Router' : (skill.name || skill.id.split(':').pop()).split('-').map(word => words[word] || word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
const departmentIndex = skill => ENGINE_CATEGORIES.has(skill.category) ? 0 : skill.category === 'disciplines' ? 1 : 2;
const statusRank = {working:3, waiting:2, idle:1, offline:0};

export function claudeAgentStatus(agent) {
  return {working:{id:'running',label:'Running'},idle:{id:'idle',label:'Idle'},waiting:{id:'waiting',label:'Waiting'},offline:{id:'offline',label:'Offline'}}[agent?.liveStatus] || {id:'offline',label:'Offline'};
}

export function claudeWorkerGroups(roster) {
  const groups = {running:[],idle:[],waiting:[],offline:[]};
  for (const agent of roster) {
    if (agent.runtimeAgents?.length) groups[claudeAgentStatus(agent).id].push(agent);
  }
  for (const group of Object.values(groups)) group.sort((a,b)=>a.index-b.index);
  return groups;
}

export function claudeWorkerIdentity(worker) {
  const actor = String(worker.id || '').split(':').pop();
  const shortId = (actor === 'main' ? worker.sessionId || worker.id : actor).slice(-6);
  const label = worker.agentType === 'main' ? worker.provider || 'Claude Code' : worker.name || worker.agentType || 'Claude agent';
  const project = worker.cwd?.split(/[\\/]/).filter(Boolean).pop() || 'Local project';
  return {label, shortId, project};
}

export function runningClaudeAgents(roster) {
  return roster.filter(agent=>agent.runtimeAgents?.length && agent.liveStatus==='working')
    .sort((a,b)=>(statusRank[b.liveStatus] || 0)-(statusRank[a.liveStatus] || 0) || a.index-b.index);
}

// Follow the actual worker if it starts using a skill and moves to a specialist
// seat. Never switch an open profile to a different worker reusing that seat.
export function resolveClaudeSelection(roster, selected) {
  if (!selected) return null;
  const workerId = selected.runtimeAgents?.[0]?.id;
  const found = workerId ? roster.find(agent=>agent.runtimeAgents?.some(worker=>worker.id===workerId)) : roster.find(agent=>agent.id===selected.id);
  return found || {...selected, liveStatus:'offline', runtimeAgents:(selected.runtimeAgents || []).map(worker=>({...worker,status:'offline',tool:null}))};
}

// Each live Claude worker occupies exactly one seat. Skill specialists keep a
// permanent home; additional workers and general sessions use runtime seats.
export function buildClaudeRoster(skills = [], runtimeAgents = [], available = true, seats = new Map()) {
  const offsets = [0, 50, 100];
  const roster = [...skills].sort((a,b) => a.id.localeCompare(b.id)).map(skill => {
    const group = departmentIndex(skill);
    return {id:`claude-skill-${skill.id}`, index:offsets[group]++, name:skillTitle(skill), description:skill.description, department:CLAUDE_DEPARTMENTS[group], floor:2, kind:'specialist', skillId:skill.id, skill, skills:[skill.id], liveStatus:'idle', runtimeAgents:[]};
  });
  const bySkill = new Map(roster.map(agent => [agent.skillId, agent]));
  const byType = new Map(roster.map(agent => [agent.skill.category === 'router' ? 'ai-office-gamedev-router' : `ai-office-${agent.skill.name}`, agent]));
  const sorted = [...runtimeAgents].filter(agent => agent.status !== 'offline').sort((a,b) => (statusRank[b.status] || 0) - (statusRank[a.status] || 0) || a.id.localeCompare(b.id));
  // A seat belongs to a worker for its whole lifecycle, including when it
  // temporarily uses a specialist's workstation. Reuse seats after session end.
  const liveIds = new Set(sorted.map(agent=>agent.id));
  for (const id of seats.keys()) if (!liveIds.has(id)) seats.delete(id);
  const occupied = new Set(seats.values());
  for (const agent of [...sorted].sort((a,b)=>a.id.localeCompare(b.id))) {
    if (seats.has(agent.id)) continue;
    let index = 150;
    while (occupied.has(index)) index++;
    seats.set(agent.id,index);
    occupied.add(index);
  }
  for (const runtime of sorted) {
    const specialist = bySkill.get(runtime.skillId) || byType.get(runtime.agentType);
    const liveStatus = available ? runtime.status : 'offline';
    if (specialist && specialist.runtimeAgents.length === 0) {
      specialist.runtimeAgents = [runtime];
      specialist.liveStatus = liveStatus;
    } else {
      roster.push({id:`claude-live-${runtime.id}`, index:seats.get(runtime.id), name:runtime.name || runtime.agentType || 'Claude Code session', department:CLAUDE_DEPARTMENTS[3], floor:2, kind:'live', description:runtime.isSubagent ? 'A Claude Code subagent reporting its actual activity.' : 'A Claude Code session reporting its actual activity.', skillId:runtime.skillId, skills:runtime.skillId ? [runtime.skillId] : [], liveStatus, runtimeAgents:[runtime]});
    }
  }
  return roster;
}
