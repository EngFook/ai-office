// V6 asset pipeline: converts the committed Kenney CC0 OBJ/MTL sources in
// assets/kenney/ into src/desk-prop-data.js — one indexed, flat-shaded
// geometry per prop with a per-vertex index into one shared colour palette.
// Material colours come from the .mtl Kd values (Furniture Pack) or from
// sampling the pack's colormap.png at each vertex's UV (Food Kit), so the
// runtime needs no OBJ parsing and all props can share a single material.
// Run manually after changing the source assets: node scripts/convert-desk-props.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const PROPS = [
  { name: 'monitor', obj: 'assets/kenney/furniture-kit/computerScreen.obj' },
  { name: 'keyboard', obj: 'assets/kenney/furniture-kit/computerKeyboard.obj' },
  { name: 'plant', obj: 'assets/kenney/furniture-kit/plantSmall2.obj' },
  { name: 'cup', obj: 'assets/kenney/food-kit/cup-coffee.obj', texture: 'assets/kenney/food-kit/Textures/colormap.png' },
]

// --- Minimal PNG decoder (8-bit, colour type 2/3/6, no interlace) ---------
function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  let offset = 8, width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0
  let palette = null
  const idat = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4)
      bitDepth = data[8]; colorType = data[9]; interlace = data[12]
    } else if (type === 'PLTE') palette = data
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    offset += 12 + length
  }
  if (bitDepth !== 8 || interlace !== 0) throw new Error(`unsupported PNG (depth ${bitDepth}, interlace ${interlace})`)
  const channels = { 2: 3, 3: 1, 6: 4 }[colorType]
  if (!channels) throw new Error(`unsupported PNG colour type ${colorType}`)
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const pixels = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const out = pixels.subarray(y * stride, (y + 1) * stride)
    const prev = y ? pixels.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[x - channels] : 0
      const b = prev ? prev[x] : 0
      const c = prev && x >= channels ? prev[x - channels] : 0
      let value = line[x]
      if (filter === 1) value += a
      else if (filter === 2) value += b
      else if (filter === 3) value += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      out[x] = value & 0xff
    }
  }
  const sample = (u, v) => {
    const x = Math.min(width - 1, Math.max(0, Math.round(u * (width - 1))))
    const y = Math.min(height - 1, Math.max(0, Math.round((1 - v) * (height - 1))))
    const i = y * stride + x * channels
    if (colorType === 3) { const p = pixels[i] * 3; return [palette[p], palette[p + 1], palette[p + 2]] }
    return [pixels[i], pixels[i + 1], pixels[i + 2]]
  }
  return { width, height, sample }
}

// --- OBJ/MTL parsing -------------------------------------------------------
function parseMtl(text) {
  const materials = new Map()
  let current = null
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts[0] === 'newmtl') { current = parts[1]; materials.set(current, [255, 255, 255]) }
    else if (parts[0] === 'Kd' && current) materials.set(current, parts.slice(1, 4).map(v => Math.round(parseFloat(v) * 255)))
  }
  return materials
}

const hex = ([r, g, b]) => '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')

function convert(prop, palette) {
  const objPath = join(root, prop.obj)
  const objText = readFileSync(objPath, 'utf8')
  const mtlName = objText.match(/^mtllib\s+(.+?)\s*$/m)?.[1]
  const materials = mtlName ? parseMtl(readFileSync(join(dirname(objPath), mtlName), 'utf8')) : new Map()
  const png = prop.texture ? decodePng(readFileSync(join(root, prop.texture))) : null
  const v = [], vt = [], vn = []
  const positions = [], normals = [], colors = [], index = []
  const seen = new Map()
  let material = null
  const paletteIndex = color => {
    const key = hex(color)
    if (!palette.includes(key)) palette.push(key)
    return palette.indexOf(key)
  }
  for (const line of objText.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts[0] === 'v') v.push(parts.slice(1, 4).map(Number))
    else if (parts[0] === 'vt') vt.push(parts.slice(1, 3).map(Number))
    else if (parts[0] === 'vn') vn.push(parts.slice(1, 4).map(Number))
    else if (parts[0] === 'usemtl') material = parts[1]
    else if (parts[0] === 'f') {
      const corners = parts.slice(1).map(ref => {
        const [vi, ti, ni] = ref.split('/').map(n => parseInt(n, 10) - 1)
        const color = png ? png.sample(...vt[ti]) : materials.get(material) || [255, 255, 255]
        const colorIdx = paletteIndex(color)
        const key = `${vi}/${ni}/${colorIdx}`
        if (!seen.has(key)) {
          seen.set(key, positions.length / 3)
          positions.push(...v[vi]); normals.push(...vn[ni]); colors.push(colorIdx)
        }
        return seen.get(key)
      })
      for (let i = 2; i < corners.length; i++) index.push(corners[0], corners[i - 1], corners[i])
    }
  }
  // Normalise: XZ centred on the origin, feet on y=0, original units kept.
  const bounds = axis => {
    let min = Infinity, max = -Infinity
    for (let i = axis; i < positions.length; i += 3) { min = Math.min(min, positions[i]); max = Math.max(max, positions[i]) }
    return [min, max]
  }
  const [minX, maxX] = bounds(0), [minY, maxY] = bounds(1), [minZ, maxZ] = bounds(2)
  const shift = [(minX + maxX) / 2, minY, (minZ + maxZ) / 2]
  const round = (value, digits) => Number(value.toFixed(digits))
  for (let i = 0; i < positions.length; i += 3) for (let axis = 0; axis < 3; axis++) {
    positions[i + axis] = round(positions[i + axis] - shift[axis], 4)
    normals[i + axis] = round(normals[i + axis], 3)
  }
  return {
    size: [round(maxX - minX, 4), round(maxY - minY, 4), round(maxZ - minZ, 4)],
    tris: index.length / 3,
    positions, normals, colors, index,
  }
}

const palette = []
const models = {}
for (const prop of PROPS) {
  models[prop.name] = convert(prop, palette)
  const { size, tris, positions } = models[prop.name]
  console.log(`${prop.name}: ${tris} tris, ${positions.length / 3} verts, size ${size.join(' x ')}`)
}
console.log(`palette: ${palette.length} colours: ${palette.join(' ')}`)

const output = `// Generated by scripts/convert-desk-props.mjs from the CC0 Kenney sources in
// assets/kenney/ (see assets/kenney/README.md for provenance and licences).
// Do not edit by hand — rerun the script instead.
export const PROP_PALETTE = ${JSON.stringify(palette)}
export const PROP_MODELS = ${JSON.stringify(models)}
`
writeFileSync(join(root, 'src/desk-prop-data.js'), output)
console.log(`wrote src/desk-prop-data.js (${output.length} bytes)`)
