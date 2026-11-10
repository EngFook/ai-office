import { CENTRAL_SOCIAL } from './central-social.js'
// General walking system: every figure walks along aisles between "spots"
// (desk, review desk, Gemini room, meeting room, report area, lounge sofa).
// Each spot carries a path from the spot out to the main cross aisle (z = 14),
// so any route is: spot -> its path -> along the cross aisle -> target path reversed -> target.
export const AISLE_Z = 14
export const WALK_SPEED = 6 // world units per second
export const REPORT_DWELL_MS = 4000

// Shared benches are exited at their ends, never through a neighbour's desk.
const gapX = desk => desk.zone === 'local-qwen' ? 28 : desk.zone === 'gemini' ? 28 : desk.zone === 'reviewers' ? 28 : desk.zone === 'grok' ? 32 : desk.zone === 'claude' || (desk.zone === 'overflow' && desk.x < -8) ? -6 : desk.zone === 'codex' || (desk.zone === 'overflow' && desk.x < 17) ? 16 : 28

// Exit radially, then follow the outside of the chair ring to the row passage.
function roundTablePath(desk) {
  const table = desk.roundTable, radius = 6.1
  let theta = Math.atan2(desk.chairX - table.x, desk.chairZ - table.z)
  const steps = Math.max(1, Math.ceil(Math.abs(theta) / (Math.PI / 12)))
  return [...Array.from({ length: steps + 1 }, (_, i) => {
    const angle = theta * (1 - i / steps)
    return [table.x + Math.sin(angle) * radius, table.z + Math.cos(angle) * radius]
  }), [-6, table.z + radius], [-6, AISLE_Z]]
}

export function deskSpot(desk) {
  const x = desk.chairX, z = desk.chairZ, gx = gapX(desk)
  const path = desk.roundTable ? roundTablePath(desk) : desk.zone === 'grok' ? [[gx, z], [gx, AISLE_Z]] : [[x, z - 3], [gx, z - 3], [gx, AISLE_Z]]
  const kind = desk.zone === 'reviewers' ? 'review' : desk.zone === 'gemini' ? 'research' : 'desk'
  return { id: `desk:${desk.id}`, kind, x, z, angle: desk.angle || 0, sit: true, path }
}

export function meetingSpot(index, commons) {
  const room = commons.meeting, table = room.table, door = room.doorway.x
  const x = table.x + [-4.5, -1.5, 1.5, 4.5][index % 4], z = table.z - 3.8
  return { id: `meeting:${index}`, kind: 'meeting', x, z, angle: 0, sit: true, path: [[x, 22], [door, 22], [door, AISLE_Z]] }
}

// The delegates stand south of the board. Approach through the clear x=16
// lane and z=-20 corridor, never through the planter or other work zones.
export function huddleSpot(index) {
  const slot = index % 5, x = CENTRAL_SOCIAL.board.x - 3 + slot * 1.5, z = CENTRAL_SOCIAL.board.z + [2, 3, 3.3, 3, 2][slot]
  return { id: `huddle:${index}`, kind: 'huddle', x, z, angle: Math.atan2(CENTRAL_SOCIAL.board.x-x, CENTRAL_SOCIAL.board.z-z), sit: false,
    path: [[x, -20], [16, -20], [16, AISLE_Z]] }
}

export function reportSpot(index, commons) {
  const room = commons.reports, door = room.doorway.x
  const x = room.x - 3 + (index % 5) * 1.5, z = room.back + 3.2
  return { id: `report:${index}`, kind: 'report', x, z, angle: Math.PI, sit: false, path: [[x, 22], [door, 22], [door, AISLE_Z]] }
}

export function loungeSpots(lounge) {
  const spots = []
  const { midX: LOUNGE_MID_X, rowZ: LOUNGE_ROW_Z, exitX: LOUNGE_EXIT_X } = lounge.route
  for (const sofa of lounge.sofas.filter(s => Math.abs(Math.sin(s.angle)) < .01)) {
    const fx = Math.sin(sofa.angle), fz = Math.cos(sofa.angle)
    for (const dx of [-1.5, 0, 1.5]) {
      const x = sofa.x + dx * Math.cos(sofa.angle), z = sofa.z + fz * .15
      const standZ = sofa.z + fz * 1.6
      spots.push({ id: `lounge:${spots.length}`, kind: 'lounge', x, z, angle: sofa.angle, sit: true, sofa: true,
        path: [[x + fx * 1.6, standZ], [LOUNGE_MID_X, standZ], [LOUNGE_MID_X, LOUNGE_ROW_Z], [LOUNGE_EXIT_X, LOUNGE_ROW_Z], [LOUNGE_EXIT_X, AISLE_Z]] })
    }
  }
  return spots
}

const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6
export function route(from, to) {
  if (from.id === to.id) return [[to.x, to.z]]
  const points = [[from.x, from.z], ...from.path, ...[...to.path].reverse(), [to.x, to.z]]
  return points.filter((p, i) => i === 0 || !same(p, points[i - 1]))
}
export const routeLength = points => points.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[0] - points[i][0], p[1] - points[i][1]), 0)

// Position/heading after walking `distance` along the route.
export function pointAlong(points, distance) {
  let left = Math.max(0, distance)
  for (let i = 1; i < points.length; i++) {
    const [ax, az] = points[i - 1], [bx, bz] = points[i], len = Math.hypot(bx - ax, bz - az)
    if (left <= len && len > 0) { const t = left / len; return { x: ax + (bx - ax) * t, z: az + (bz - az) * t, angle: Math.atan2(bx - ax, bz - az), done: false } }
    left -= len
  }
  const last = points[points.length - 1], prev = points[points.length - 2] || last
  return { x: last[0], z: last[1], angle: Math.atan2(last[0] - prev[0], last[1] - prev[1]), done: true }
}

// Ambient figures are decoration, never extra agents or reported work.
export const MAX_AMBIENT_WALKERS = 2
export const MAX_IDLE_FIGURES = 5
export function ambientSpots(commons) {
  const aisleStops = [commons.tasks.doorway.x, commons.reports.doorway.x, -6].map((x, index) => ({
    id: `ambient:${index}`, kind: 'ambient', x, z: AISLE_Z, angle: index % 2 ? Math.PI : 0,
    sit: false, path: [[x, AISLE_Z]],
  }))
  return [...aisleStops, ...CENTRAL_SOCIAL.stops.map((stop, i) => ({
    ...stop, id: `ambient:central:${i}`, kind: 'ambient', sit: false,
    path: [[stop.x, -7], [16, -7], [16, AISLE_Z]],
  }))]
}
const seed = id => [...id].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 0)

// Interrupt from the actual position. Follow the existing safe route to its
// nearest reachable cross-aisle waypoint; never cut across furniture or walls.
function transitSpot(fig, now) {
  const { points, start, speed } = fig.walk
  const distance = Math.max(0, now - start) / 1000 * speed
  const p = pointAlong(points, distance)
  let covered = 0, end = points.length - 1
  for (let i = 1; i < points.length; i++) {
    covered += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1])
    if (covered >= distance) { end = i; break }
  }
  let exit = []
  if (Math.abs(p.z - AISLE_Z) > 1e-6) {
    const forward = points.slice(end), ahead = forward.findIndex(point => point[1] === AISLE_Z)
    if (ahead >= 0) exit = forward.slice(0, ahead + 1)
    else {
      const backward = points.slice(0, end).reverse(), behind = backward.findIndex(point => point[1] === AISLE_Z)
      exit = behind >= 0 ? backward.slice(0, behind + 1) : fig.walk.to.path
    }
  }
  return { id: `transit:${fig.id}:${now}`, kind: 'transit', x: p.x, z: p.z, angle: p.angle, sit: false, path: exit }
}

export function createMovement({ lounge, commons, ambient = true }) {
  const seats = loungeSpots(lounge), strolls = ambientSpots(commons)
  const figures = new Map()
  let ambientEnabled = ambient, serial = 0, ambientSerial = 0
  const busySeat = () => new Set([...figures.values()].map(f => f.queue.at(-1)?.id || f.walk?.to?.id || f.spot?.id))
  const freeSeat = () => { const used = busySeat(); return seats.find(s => !used.has(s.id)) || seats[figures.size % seats.length] }
  const place = (fig, spot, now = 0) => { fig.spot = spot; fig.walk = null; fig.queue = []; fig.arrivedAt = now; Object.assign(fig, { x: spot.x, z: spot.z, angle: spot.angle }) }
  const init = (fig, now) => { fig.seed ??= seed(fig.id); fig.speed ??= WALK_SPEED * (.86 + fig.seed % 25 / 100); fig.nextAmbientAt ??= now + 1200 + (fig.idle ? serial++ : 0) * 2600; fig.trip ??= 0; return fig }
  const goTo = (fig, now, ...spots) => {
    const finalId = spots.at(-1).id
    if ((fig.queue.at(-1) || fig.walk?.to || fig.spot)?.id === finalId) return
    if (fig.walk) place(fig, transitSpot(fig, now), now)
    fig.queue = spots
  }
  const priority = fig => { fig.ambientTrip = false; fig.ambientPaused = false }
  function sync({ working = [], meeting = null, huddle = null, now = Date.now(), initial = false, ambient: override }) {
    if (typeof override === 'boolean') ambientEnabled = override
    if (!ambientEnabled) for (const fig of figures.values()) if (fig.ambientTrip) {
      if (fig.walk) place(fig, transitSpot(fig, now), now)
      fig.queue = []; fig.ambientTrip = false; fig.ambientPaused = true
    }
    const live = new Set(working.map(w => w.id))
    for (const w of working) {
      let fig = figures.get(w.id)
      if (!fig) {
        const idle = [...figures.values()].find(f => f.idle && f.provider === w.provider && !f.rep)
        if (idle) { figures.delete(idle.id); fig = { ...idle, id: w.id } }
        else { fig = { id: w.id, provider: w.provider, queue: [] }; place(fig, initial ? deskSpot(w.desk) : freeSeat(), now) }
        figures.set(w.id, fig)
      }
      init(fig, now); priority(fig)
      Object.assign(fig, { agent: w.agent || null, idle: false, rep: false })
      goTo(fig, now, deskSpot(w.desk))
    }
    for (const fig of figures.values()) if (!fig.idle && !fig.rep && !live.has(fig.id)) {
      priority(fig); fig.idle = true; fig.agent = null
      if (initial) place(fig, freeSeat(), now); else goTo(fig, now, reportSpot(figures.size, commons), freeSeat())
      fig.nextAmbientAt = now + 18000
    }
    for (const provider of ['claude', 'codex', 'gemini', 'grok']) {
      if (![...figures.values()].some(f => f.provider === provider)) {
        const fig = init({ id: `idle:${provider}`, provider, idle: true, agent: null, queue: [] }, now)
        place(fig, freeSeat(), now); figures.set(fig.id, fig)
      }
    }
    // Keep a tiny decorative pool even when every provider has real work.
    // These never carry an agent identity and do not scale with worker count.
    if (!meeting?.active) while ([...figures.values()].filter(f => f.idle && !f.rep).length < MAX_AMBIENT_WALKERS) {
      const index = ambientSerial++, provider = ['claude', 'codex'][index % 2]
      const fig = init({ id: `ambient:${index}`, provider, idle: true, agent: null, queue: [] }, now)
      place(fig, freeSeat(), now); figures.set(fig.id, fig)
    }
    const manualMeeting = meeting?.active === true
    const attendees = manualMeeting ? (meeting.attendees || []) : [...new Set(huddle?.active ? (huddle.attendees || []) : [])].filter(provider => ['claude', 'codex', 'grok', 'gemini', 'local-qwen'].includes(provider)).slice(0, 5)
    attendees.forEach((provider, index) => {
      let fig = [...figures.values()].find(f => f.rep === provider)
      if (!fig) fig = [...figures.values()].find(f => f.idle && f.provider === provider)
      if (!fig) {
        fig = init({ id: `rep:${provider}`, provider, agent: null, queue: [] }, now)
        place(fig, freeSeat(), now); figures.set(fig.id, fig)
      }
      priority(fig); fig.rep = provider; fig.idle = true
      goTo(fig, now, manualMeeting ? meetingSpot(index, commons) : huddleSpot(index))
    })
    for (const fig of figures.values()) if (fig.rep && !attendees.includes(fig.rep)) {
      priority(fig); fig.rep = false; fig.nextAmbientAt = now + 12000; goTo(fig, now, freeSeat())
    }
    const idle = [...figures.values()].filter(f => f.idle && !f.rep)
    for (const fig of idle.slice(0, Math.max(0, idle.length - Math.min(MAX_IDLE_FIGURES, seats.length)))) figures.delete(fig.id)
    return step(now)
  }
  function step(now) {
    for (const fig of figures.values()) {
      if (fig.walk) {
        const p = pointAlong(fig.walk.points, (now - fig.walk.start) / 1000 * fig.walk.speed)
        Object.assign(fig, { x: p.x, z: p.z, angle: p.angle })
        if (p.done) {
          fig.spot = fig.walk.to; fig.walk = null; fig.arrivedAt = now
          if (fig.ambientTrip && fig.spot.kind === 'lounge' && !fig.queue.length) {
            fig.ambientTrip = false; fig.nextAmbientAt = now + 8000 + fig.seed % 9000
          }
        }
      }
      if (!fig.walk && fig.queue.length) {
        const dwell = fig.spot?.kind === 'report' && fig.idle && !fig.rep ? REPORT_DWELL_MS : fig.spot?.kind === 'ambient' && fig.ambientTrip ? 3500 + fig.seed % 4000 : 0
        if (now - fig.arrivedAt >= dwell) {
          const to = fig.queue.shift(); fig.walk = { to, points: route(fig.spot, to), start: now, speed: fig.speed }
        }
      }
      if (!fig.walk) Object.assign(fig, { x: fig.spot.x, z: fig.spot.z, angle: fig.spot.angle })
    }
    if (ambientEnabled) {
      let active = [...figures.values()].filter(f => f.ambientTrip).length
      const candidates = [...figures.values()].filter(f => f.idle && !f.rep && !f.agent && !f.walk && !f.queue.length && !f.ambientTrip && (f.spot.kind === 'lounge' || f.ambientPaused)).sort((a, b) => a.nextAmbientAt - b.nextAmbientAt)
      for (const fig of candidates) {
        if (active >= MAX_AMBIENT_WALKERS) break
        if (now < fig.nextAmbientAt) continue
        fig.ambientTrip = true; active++
        const home = freeSeat()
        const targets = fig.ambientPaused ? [home] : [strolls[(fig.seed + fig.trip++) % strolls.length], home]
        fig.ambientPaused = false
        const to = targets.shift(); fig.queue = targets
        fig.walk = { to, points: route(fig.spot, to), start: now, speed: fig.speed }
      }
    }
    for (const fig of figures.values()) { fig.walking = !!fig.walk; fig.sitting = !fig.walk && !!fig.spot.sit }
    return [...figures.values()]
  }
  return { sync, step, figures, seats }
}
