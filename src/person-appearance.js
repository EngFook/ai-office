// Per-person visual variety (V2): deterministic skin/hair colours, a shirt kept
// in the team colour (shade-jittered only, so provider identity stays readable),
// and a ±8% height factor. All derived from the figure id, so a person keeps the
// same look across frames, walks and re-renders.
export const SKINS = ['#e1b59a', '#c68d70', '#a9694d', '#e5c1a3', '#875a48', '#d6a080', '#f0d5b8', '#6e4a3a']
export const HAIR = ['#312822', '#483329', '#231f20', '#75503b', '#51443b', '#8a8178', '#a56a3b']
export const TROUSERS = ['#26232a', '#33302c', '#3a3f4a', '#262d26']
export const HEIGHT_JITTER = 0.08

export const hashIndex = id => [...String(id)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)

// Multiply a #rrggbb colour by `factor`, clamped per channel.
export function shadeColor(hex, factor) {
  const channels = [1, 3, 5].map(i => Math.min(255, Math.round(parseInt(hex.slice(i, i + 2), 16) * factor)))
  return `#${channels.map(c => c.toString(16).padStart(2, '0')).join('')}`
}

export function personAppearance(id, teamColor = '#808080') {
  const h = hashIndex(id)
  const trousers = TROUSERS[(h >>> 11) % TROUSERS.length]
  return {
    skin: SKINS[h % SKINS.length],
    hair: HAIR[(h >>> 3) % HAIR.length],
    // 0.88..1.12 shade of the team colour: still clearly the team shirt.
    shirt: shadeColor(teamColor, 0.88 + ((h >>> 7) % 9) / 8 * 0.24),
    trousers,
    height: 1 + ((h >>> 13) % 33 / 32 * 2 - 1) * HEIGHT_JITTER,
  }
}

// Where the soft blob shadow sits for each spot kind: just above the platform a
// figure is standing or sitting on (desk pods and room rugs are raised), so the
// quad neither z-fights nor sinks below the surface.
export const SHADOW_FLOOR_Y = 0.055
export const SHADOW_SPOT_Y = { desk: 0.13, meeting: 0.12, report: 0.12, lounge: 0.105 }
export const shadowHeightFor = figure =>
  figure.walking ? SHADOW_FLOOR_Y : (SHADOW_SPOT_Y[figure.spot?.kind] ?? SHADOW_FLOOR_Y)
