// Keep the central island between the team desks and the northern rooms.
// The west entrance and x=16 circulation lane remain open.
export const CENTRAL_SOCIAL = {
  planter: { x: 5, z: -17, width: 7, depth: 3.6 },
  board: { x: 5, z: -23, width: 4.8, depth: 1.5 },
  stops: [
    { x: 3.5, z: -12, angle: Math.PI / 2 },
    { x: 6.5, z: -12, angle: -Math.PI / 2 },
  ],
}
