// V6 desk props: Kenney CC0 low-poly monitors, keyboards, cups and small
// plants (see assets/kenney/README.md), pre-baked by convert-desk-props.mjs
// into indexed geometries whose vertices point into one shared colour
// palette. Every prop type is one InstancedMesh and all four share a single
// material + 1xN palette texture, so the whole pass costs 4 draw calls with
// static matrices (plus 1 for the coffee steam on the top quality tier).
// Placement is a pure function of the layout, deterministic per desk hash,
// and never moves furniture: props only sit on existing surfaces.
import * as THREE from 'three'
import { PROP_MODELS, PROP_PALETTE } from './desk-prop-data.js'
import { hashIndex } from './person-appearance.js'

// World-size targets per prop (model units are normalised, feet at y=0).
export const PROP_WORLD = {
  keyboard: { width: 0.85 }, // replaces the old flat keyboard box on the desk pad
  monitor: { height: 0.6 }, // smaller side display next to the main screen
  cup: { height: 0.2 },
  plant: { height: 0.5 },
}

export function propScale(name) {
  const model = PROP_MODELS[name], target = PROP_WORLD[name]
  return target.width ? target.width / model.size[0] : target.height / model.size[1]
}

// Desk-local surfaces (desk top .97+.06, keyboard pad top 1.05+.0125).
const DESK_TOP = 1.03, PAD_TOP = 1.0625
const local = (seat, lx, y, lz, yaw, scale, name) => ({
  seat, name, y, yaw: (seat.angle || 0) + yaw, scale,
  x: seat.x + lx * Math.cos(seat.angle || 0) + lz * Math.sin(seat.angle || 0),
  z: seat.z - lx * Math.sin(seat.angle || 0) + lz * Math.cos(seat.angle || 0),
})
const loose = (name, x, y, z, yaw, scale) => ({ seat: null, name, x, y, z, yaw, scale })

// Every desk gets a keyboard; side monitors, cups and plants appear on
// hash-chosen subsets with jittered positions so the floor never looks
// copy-pasted. All offsets keep clear of the desk pad, tray, lamp and the
// main monitor (desk is 4.5 x 1.9, centred on the seat origin).
export function propPlacements(layout) {
  const keyboards = [], monitors = [], cups = [], plants = []
  const scales = Object.fromEntries(Object.keys(PROP_WORLD).map(name => [name, propScale(name)]))
  for (const seat of layout.desks) {
    const h = hashIndex(seat.id)
    keyboards.push(local(seat, 0, PAD_TOP, -0.33, (h % 9 - 4) * 0.012, scales.keyboard, 'keyboard'))
    // Side display on the right, turned toward the sitter. The Kenney model's
    // screen faces -z, so the facing yaw carries an extra half turn.
    if (h % 2 === 1) monitors.push(local(seat, 1.25, DESK_TOP, 0.6, Math.PI - 2.63 + (h % 5 - 2) * 0.04, scales.monitor, 'monitor'))
    if (h % 3 !== 0) cups.push(local(seat, -1.0 - ((h >>> 3) % 3) * 0.08, DESK_TOP, 0.05 + ((h >>> 5) % 4) * 0.07, h % 7, scales.cup, 'cup'))
    if ((h >>> 2) % 3 !== 1) plants.push(local(seat, 2.0, DESK_TOP, 0.55, (h >>> 4) % 7, scales.plant * (0.9 + ((h >>> 7) % 5) * 0.05), 'plant'))
  }
  // Cups also live where people rest and meet: lounge tables (top .45+.05),
  // the coffee counter (top 1.42+.06) and the meeting table (top 1.07+.08).
  for (const table of layout.lounge.tables) {
    cups.push(loose('cup', table.x + 0.6, 0.5, table.z - 0.35, 1.1, scales.cup))
    cups.push(loose('cup', table.x + 0.1, 0.5, table.z + 0.4, 3.7, scales.cup))
  }
  const coffee = layout.commons.reception
  cups.push(loose('cup', coffee.x + 2.6, 1.48, coffee.z + 0.2, 0.6, scales.cup))
  cups.push(loose('cup', coffee.x + 2.2, 1.48, coffee.z - 0.35, 2.4, scales.cup))
  cups.push(loose('cup', coffee.x - 0.6, 1.48, coffee.z + 0.3, 4.9, scales.cup))
  const meeting = layout.commons.meeting.table
  cups.push(loose('cup', meeting.x - 2.6, 1.15, meeting.z - 1.2, 0.9, scales.cup))
  cups.push(loose('cup', meeting.x + 2.9, 1.15, meeting.z + 1.1, 2.2, scales.cup))
  cups.push(loose('cup', meeting.x - 5.0, 1.15, meeting.z + 1.0, 3.9, scales.cup))
  cups.push(loose('cup', meeting.x + 5.3, 1.15, meeting.z - 1.0, 5.3, scales.cup))
  // Steam rises from the espresso machine on the coffee counter (top ~2.3).
  const steam = { x: coffee.x - 1.8, y: 2.34, z: coffee.z }
  return { keyboards, monitors, cups, plants, steam }
}

// Click handler for one prop batch: a prop on a desk selects its seat just
// like the desk does, but loose props (lounge/coffee-bar/meeting cups,
// seat:null) must let the click fall through to the surface beneath them so
// the existing room-focus handlers still run — propagation stops only when
// a valid seat is actually picked.
export function propPickHandler(items, onPick) {
  return event => {
    const seat = items[event.instanceId]?.seat
    if (!seat) return
    event.stopPropagation()
    onPick(seat)
  }
}

// Palette-cell UV for colour index i of n: cell centres on a 1xN strip.
export function paletteU(index, count = PROP_PALETTE.length) {
  return (index + 0.5) / count
}

// Builds the shared-palette BufferGeometry for one prop model.
export function buildPropGeometry(name) {
  const model = PROP_MODELS[name]
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(model.positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(model.normals, 3))
  const uv = new Float32Array(model.colors.length * 2)
  model.colors.forEach((colorIndex, i) => { uv[i * 2] = paletteU(colorIndex); uv[i * 2 + 1] = 0.5 })
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  geometry.setIndex(model.index)
  return geometry
}

// --- Monitor "code" scroll (V6): one tiny shared canvas, stepped at CODE_HZ
// (the meeting approved 2-4Hz), multiplied by the per-screen instance colour
// so working screens glow in the provider tint and idle screens stay dark.
export const CODE_HZ = 3
export const CODE_W = 128, CODE_H = 64, CODE_LINE = 8
export const CODE_BG = '#c2cac2'
const CODE_SHADES = ['#e6ece4', '#95a497', '#d5ddd3', '#aab8ac']

export function shouldStepCode(nowMs, lastMs, hz = CODE_HZ) {
  return nowMs - lastMs >= 1000 / hz
}

// Draws one line of fake code: an indent, then a few dashes in alternating
// shades, all inside [0, width). `rand` is injectable for tests.
export function drawCodeLine(ctx, width, y, height, rand = Math.random) {
  let x = 4 + Math.floor(rand() * 4) * 7
  const dashes = 2 + Math.floor(rand() * 3)
  for (let i = 0; i < dashes && x < width - 8; i++) {
    const dash = 6 + Math.floor(rand() * 15)
    ctx.fillStyle = CODE_SHADES[Math.floor(rand() * CODE_SHADES.length)]
    ctx.fillRect(x, y + 1, Math.min(dash, width - 4 - x), height - 2)
    x += dash + 4 + Math.floor(rand() * 7)
  }
}

// --- Coffee steam (V6): a short loop of billboarded puffs over the espresso
// machine; pure (time, index) so the demand frameloop can render any frame.
// Gated to the `steam` quality-tier flag, so phones never pay for it.
export const STEAM_COUNT = 7
export const STEAM_PERIOD = 3.2 // s for one puff to rise and vanish
export const STEAM_RISE = 1.15 // world units of rise over a puff's life

export function steamParticle(t, index) {
  const phase = (t / STEAM_PERIOD + index / STEAM_COUNT) % 1
  return {
    phase,
    y: phase * STEAM_RISE,
    drift: Math.sin(t * 0.8 + index * 2.1) * 0.08 * phase,
    sway: Math.cos(t * 0.6 + index * 1.7) * 0.05 * phase,
    scale: 0.16 + phase * 0.42,
    // Born invisible, peaks mid-rise, fully gone before the loop wraps.
    fade: Math.sin(Math.PI * Math.min(1, phase * 1.15)),
  }
}
