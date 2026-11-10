// Standing hosts stay clear of desks and the main walking aisles. They are
// provider-level presence, never task workers or recyclable lounge figures.
export const RESIDENT_SPOTS = Object.freeze({
  claude: { x: -30, z: 11.2, angle: 0 },
  codex: { x: 2.5, z: 11.2, angle: 0 },
  grok: { x: 33, z: 10, angle: 0 },
  gemini: { x: 35, z: -13.5, angle: 0 },
  'local-qwen': { x: 22, z: -18.5, angle: 0 },
})

export function residentFigures(residents = []) {
  return residents.filter(resident => RESIDENT_SPOTS[resident.key]).map(resident => ({
    id: resident.id, provider: resident.key, resident, agent: null,
    ...RESIDENT_SPOTS[resident.key],
    walking: false, sitting: false, queue: [], spot: { kind: 'resident' },
  }))
}
