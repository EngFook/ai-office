import { CENTRAL_SOCIAL } from './central-social.js'
export const SHARED_DEPARTMENTS = ['Claude Build Studio', 'Codex Review & Balance', 'Grok Dispatch', 'Gemini Research', 'Qwen Local Assistance']
export const OFFICE_PROVIDERS = {
  'local-qwen': { name: 'Local Qwen', department: SHARED_DEPARTMENTS[4], color: '#c4b06d', marker: '#e2cf91' },
  claude: { name: 'Claude Code', department: SHARED_DEPARTMENTS[0], color: '#d9a27f', marker: '#e7b393' },
  codex: { name: 'Codex', department: SHARED_DEPARTMENTS[1], color: '#80ad98', marker: '#a8dec0' },
  grok: { name: 'Grok', department: SHARED_DEPARTMENTS[2], color: '#a598c1', marker: '#c4b3e2' },
  gemini: { name: 'Gemini', department: SHARED_DEPARTMENTS[3], color: '#8fa9d6', marker: '#b3c8ee' },
}
export const REVIEWER_ROLES = ['Playtester', 'UX/UI Reviewer', 'Performance Engineer', 'Code Reviewer']
export const WORKSTATION_COUNTS = { claude: 20, codex: 6, reviewers: 4, grok: 1, gemini: 4, 'local-qwen': 2 }

// The owner's permanent workstation counts never change with board history.
// Only real excess workers add pods, in the extension behind the work floor.
export const WORKSTATION_GRID = {
  'local-qwen': { columns: [19.5, 24.5], startZ: -22, rowStep: -8 },
  claude: { columns: [-31, -26, -21, -16, -11], startZ: 8, rowStep: -8 },
  codex: { columns: [0, 5, 10], startZ: 8, rowStep: -8 },
  grok: { columns: [37], startZ: -3, rowStep: -8 },
  reviewers: { columns: [20, 25], startZ: 8, rowStep: -8 },
  // Gemini Research room behind Grok Dispatch: 4 read-only Gemini desks.
  gemini: { columns: [32, 40], startZ: -17, rowStep: -8 },
  overflow: { columns: [-31, -26, -21, -16, -11, 0, 5, 10, 20], startZ: -48, rowStep: -8 },
}
export const WORKSTATION_GEOMETRY = {
  angle: 0, width: 4.5, depth: 1.9,
  podWidth: 4.6, podDepth: 5.8, podOffsetZ: -.5,
  chairOffsetZ: -1.65, monitorZ: .55, screenZ: .51,
}
// Four five-person circles form two rows in the Claude studio.
export const CLAUDE_TABLES = [[-27.5, 4], [-14.5, 4], [-27.5, -13], [-14.5, -13]].map(([x, z], index) => ({
  id: `claude:table:${index}`, x, z, radius: 4, seats: 5, seatRadius: 3,
}))
const ZONES = [
  { id: 'claude', left: -34, right: -8, back: -20, front: 12 },
  { id: 'codex', left: -3, right: 13, back: -4, front: 12 },
  { id: 'grok', left: 30, right: 44, back: -8, front: 12,
    meeting: { x: 37, z: 6, width: 6, depth: 6, tableWidth: 3.6, tableDepth: 1.8, seats: 2 } },
  { id: 'reviewers', left: 17, right: 28, back: -4, front: 12 },
  { id: 'gemini', left: 29, right: 43, back: -29, front: -12 },
  { id: 'local-qwen', left: 17, right: 27, back: -27, front: -17 },
]
// Two sofa circles give the compact studio a social heart, with a clear central path.
export const LOUNGE = { id: 'lounge', x: -17, z: -31, width: 20, depth: 18, left: -27, right: -7, back: -40, front: -22,
  sofas: [
    { x: -22, z: -26, angle: Math.PI, width: 5 }, { x: -22, z: -36, angle: 0, width: 5 },
    { x: -12, z: -26, angle: Math.PI, width: 5 }, { x: -12, z: -36, angle: 0, width: 5 },
  ],
  tables: [{ x: -22, z: -31, radius: 1.7 }, { x: -12, z: -31, radius: 1.7 }],
  plants: [[-26, -23], [-8, -23], [-26, -39], [-8, -39]],
  route: { midX: -17, rowZ: -21, exitX: -6 },
}
const OVERFLOW_COLUMNS = { claude: [0, 1, 2, 3, 4], codex: [5, 6, 7], grok: [8], gemini: [8], 'local-qwen': [8] }
const text = value => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
const roleKey = value => text(value).toLowerCase()
const providerKey = value => ({ 'Claude Code': 'claude', Codex: 'codex', Grok: 'grok', Gemini: 'gemini', 'Local Qwen': 'local-qwen' })[value] || (OFFICE_PROVIDERS[value] ? value : null)
const providerFor = agent => providerKey(agent.provider) || providerKey(agent.officeZone) || 'claude'
const rolesFor = agent => [agent.role, ...(agent.runtimeAgents || []).map(worker => worker.agentRole)].map(roleKey)
// Design reviews share the UX station; the role itself stays available.
const reviewerFor = agent => REVIEWER_ROLES.find(role => rolesFor(agent).includes(roleKey(role))) || (rolesFor(agent).includes('game designer') ? 'UX/UI Reviewer' : undefined)
const isWorking = agent => agent?.liveStatus === 'working' && agent.runtimeAgents?.some(worker => worker.status === 'working' && worker.observed !== false)
const validSlot = slot => Number.isSafeInteger(slot) && slot >= 0
const seatKey = ({ zone, slot }) => `${zone}:${slot}`

function requiredPods() {
  return [
    ...['claude', 'codex', 'gemini', 'local-qwen'].flatMap(zone => Array.from({ length: WORKSTATION_COUNTS[zone] }, (_, slot) => ({
      id: `${zone}:workstation:${slot}`, zone, provider: zone, slot, kind: 'workstation', role: null,
      label: `${OFFICE_PROVIDERS[zone].name} ${String(slot + 1).padStart(2, '0')}`,
    }))),
    { id: 'grok:provider', zone: 'grok', provider: 'grok', slot: 0, kind: 'provider', role: 'Manager', label: 'Grok Dispatch Lead' },
    ...REVIEWER_ROLES.map((role, slot) => ({ id: `reviewers:role:${roleKey(role)}`, zone: 'reviewers', provider: 'grok', slot, kind: 'role', role, label: role })),
  ]
}

function podPosition(zone, slot) {
  if (zone === 'claude') {
    const table = CLAUDE_TABLES[Math.floor(slot / 5)], theta = (slot % 5) * Math.PI * 2 / 5
    return [table.x + Math.sin(theta) * table.seatRadius, table.z + Math.cos(theta) * table.seatRadius, theta + Math.PI]
  }
  const { columns, startZ, rowStep } = WORKSTATION_GRID[zone]
  return [columns[slot % columns.length], startZ + Math.floor(slot / columns.length) * rowStep, WORKSTATION_GEOMETRY.angle]
}

function workstation(definition, resident) {
  const [x, z, angle] = podPosition(definition.zone, definition.slot)
  const geometry = WORKSTATION_GEOMETRY
  const sin = Math.sin(angle), cos = Math.cos(angle)
  const roundTable = definition.zone === 'claude' ? CLAUDE_TABLES[Math.floor(definition.slot / 5)] : null
  return {
    ...definition, ...(roundTable ? { roundTable } : {}), x, z, angle, width: geometry.width, depth: geometry.depth, dx: sin, dz: cos,
    provider: resident ? providerFor(resident) : definition.provider,
    // Team support roles use the existing fixed desks instead of adding furniture.
    role: definition.role || resident?.role || null,
    chairX: x + sin * geometry.chairOffsetZ, chairZ: z + cos * geometry.chairOffsetZ,
    // Round-table seats reserve personal chair space; the shared surface is a circle.
    podX: x + sin * (roundTable ? geometry.chairOffsetZ : geometry.podOffsetZ),
    podZ: z + cos * (roundTable ? geometry.chairOffsetZ : geometry.podOffsetZ),
    podWidth: roundTable ? 2 : Math.abs(cos) * geometry.podWidth + Math.abs(sin) * geometry.podDepth,
    podDepth: roundTable ? 2 : Math.abs(cos) * geometry.podDepth + Math.abs(sin) * geometry.podWidth,
    reservedFor: resident?.id || null, occupant: resident || null,
  }
}

export function createSharedLayout(input = [], allocations = new Map(), board = {}) {
  const agents = [...new Map(input.filter(agent => agent?.id && isWorking(agent)).map(agent => [agent.id, agent])).values()]
  const aliveKeys = new Set(agents.map(agent => `agent:${agent.id}`))
  for (const key of allocations.keys()) if (!aliveKeys.has(key)) allocations.delete(key)
  const definitions = new Map(requiredPods().map(pod => [seatKey(pod), pod]))
  const occupied = new Map(), placements = new Map()
  const canKeep = (agent, seat) => {
    if (!seat || !validSlot(seat.slot)) return false
    const provider = providerFor(agent)
    if (seat.zone === 'overflow') return OVERFLOW_COLUMNS[provider].includes(seat.slot % WORKSTATION_GRID.overflow.columns.length)
    const pod = definitions.get(seatKey(seat))
    if (!pod) return false
    if (pod.zone === 'reviewers') return roleKey(pod.role) === roleKey(reviewerFor(agent))
    if (pod.zone === 'grok') return provider === 'grok' && rolesFor(agent).includes('manager') && !reviewerFor(agent)
    return pod.zone === provider
  }
  const assign = (agent, seat) => {
    const key = seatKey(seat)
    allocations.set(`agent:${agent.id}`, { zone: seat.zone, slot: seat.slot })
    occupied.set(key, agent)
    if (!definitions.has(key)) definitions.set(key, {
      id: `agent:${agent.id}`, ...seat, provider: providerFor(agent), kind: 'agent',
      label: agent.name || OFFICE_PROVIDERS[providerFor(agent)].name, role: agent.role || null,
    })
  }
  const waiting = []
  // Retain all continuing placements before assigning newcomers, independent of
  // poll order, role definitions on the board, or historical roster indices.
  for (const agent of [...agents].sort((a, b) => a.id.localeCompare(b.id))) {
    const seat = allocations.get(`agent:${agent.id}`)
    if (canKeep(agent, seat) && !occupied.has(seatKey(seat))) assign(agent, seat)
    else waiting.push(agent)
  }
  for (const agent of waiting) {
    const provider = providerFor(agent), reviewer = reviewerFor(agent)
    const available = [...definitions.values()].filter(pod => !occupied.has(seatKey(pod)))
    let seat = reviewer && available.find(pod => pod.zone === 'reviewers' && pod.role === reviewer)
    if (!seat) seat = available.find(pod => pod.zone === provider && (provider !== 'grok' || rolesFor(agent).includes('manager') && !reviewer))
    if (!seat) {
      const columns = WORKSTATION_GRID.overflow.columns.length, lanes = OVERFLOW_COLUMNS[provider]
      let row = 0, slot
      while (slot === undefined) {
        slot = lanes.map(column => row * columns + column).find(candidate => !occupied.has(`overflow:${candidate}`))
        row++
      }
      seat = { zone: 'overflow', slot }
    }
    assign(agent, seat)
  }
  const desks = [...definitions.values()].map(definition => {
    const resident = occupied.get(seatKey(definition)), desk = workstation(definition, resident)
    if (resident) placements.set(resident.id, desk)
    return desk
  })
  const overflow = desks.filter(desk => desk.zone === 'overflow')
  const bases = [...ZONES]
  if (overflow.length) bases.push({ id: 'overflow', left: -34, right: 23, front: -44, back: Math.min(...overflow.map(pod => pod.podZ - pod.podDepth / 2 - 1)) })
  const zones = bases.map(base => {
    const pods = desks.filter(desk => desk.zone === base.id)
    const style = OFFICE_PROVIDERS[base.id] || { ...OFFICE_PROVIDERS.grok, name: base.id === 'reviewers' ? 'Specialist Reviewers' : 'Main Area', department: base.id === 'reviewers' ? 'Specialist Reviewers' : 'Main Area' }
    return { ...base, ...style, x: (base.left + base.right) / 2, z: (base.back + base.front) / 2,
      width: base.right - base.left, depth: base.front - base.back, deskCount: pods.length, workingCount: pods.filter(pod => pod.occupant).length }
  })
  const left = -36, right = 46, back = Math.min(LOUNGE.back, ...zones.map(zone => zone.back)) - 2, front = 39
  const bounds = { x: (left + right) / 2, z: (back + front) / 2, width: right - left, depth: front - back }
  // Compact perimeter rooms retain full-size furniture and accessible entrances.
  const room = (x, width) => ({
    x, z: 26, width, depth: 16, angle: 0, room: true, wallHeight: 3.8,
    left: x - width / 2, right: x + width / 2, back: 18, front: 34,
    doorway: { x: x - width / 2 + 4, z: 18, width: 3.2, depth: 2 },
    approach: { x: x - width / 2 + 4, z: 18.5, width: 3.2, depth: 5 },
  })
  const commons = {
    reception: { x: -31.5, z: -31, width: 7.25, depth: 2, angle: 0 },
    meeting: { ...room(-23, 20), table: { x: -23, z: 27, width: 12, depth: 4.4 } },
    tasks: { ...room(8, 20), standing: { x: 8, z: 27, width: 14, depth: 8 } },
    reports: room(32, 22),
  }
  const shared = Object.fromEntries(Object.entries(commons).map(([id, area]) => [id, [area.x, area.z]]))
  return {
    centralSocial: CENTRAL_SOCIAL,
    agents, zones, desks, roundTables: CLAUDE_TABLES, benches: sharedBenches(desks), placements, bounds, shared, commons, lounge: LOUNGE,
    aisles: {
      entrance: { x: -5.5, z: bounds.z, width: 5, depth: bounds.depth },
      cross: { x: bounds.x, z: 14, width: bounds.width, depth: 4 },
    },
  }
}

export function sharedSeatForAgent(agent, layout) {
  return layout.placements.get(agent.id)
}

export function sharedFocusArea(focus, layout) {
  const [type, value] = String(focus || 'overview').split('-'), index = Number(value)
  if (type === 'agent') {
    const agent = layout.agents.find(person => person.index === index)
    const seat = agent && sharedSeatForAgent(agent, layout)
    if (seat) return { x: seat.chairX, z: seat.chairZ, width: 11, depth: 10, type: 'agent' }
  }
  if (type === 'department' && layout.zones[index]) return { ...layout.zones[index], width: layout.zones[index].width + 3, depth: layout.zones[index].depth + 3, type: 'department' }
  if (focus === 'lounge' || focus === 'reception') {
    const left = layout.commons.reception.x - layout.commons.reception.width / 2
    return { x: (left + LOUNGE.right) / 2, z: LOUNGE.z, width: LOUNGE.right - left + 3, depth: LOUNGE.depth + 3, type: focus }
  }
  const shared = layout.commons[focus]
  if (shared) return { x: shared.x, z: shared.z, width: shared.width + 3, depth: shared.depth + 3, type: focus }
  return { ...layout.bounds, width: layout.bounds.width + 4, depth: layout.bounds.depth + 4, type: 'overview' }
}

function sharedBenches(desks) {
  const groups = new Map()
  for (const desk of desks) {
    if (desk.roundTable) continue
    const key = `${desk.zone}:${desk.provider}:${desk.z}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(desk)
  }
  return [...groups.entries()].map(([id, seats]) => {
    const left = Math.min(...seats.map(seat => seat.x - seat.width / 2))
    const right = Math.max(...seats.map(seat => seat.x + seat.width / 2))
    return { id, x: (left + right) / 2, z: seats[0].z, width: right - left, depth: 2.3, seats }
  })
}
