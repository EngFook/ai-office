// Grow GPU buffers in chunks, retaining every observed actor, including people
// walking out and permanent representatives. Never cap the roster at 160.
export function crowdCapacity(count, current = 160) {
  if (!Number.isSafeInteger(count) || count < 0) return current;
  return Math.max(current, Math.ceil(count / 128) * 128);
}
