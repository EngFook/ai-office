// Stop animation wake-ups when the tab is hidden or the canvas is offscreen.
// The R3F demand loop still accepts occasional data/camera invalidations, so
// pausing does not reset its clock, workers, camera or GPU assets.
export function startVisibleSceneLoop(invalidate, {
  target, intervalMs, document: doc = globalThis.document,
  Observer = globalThis.IntersectionObserver,
  schedule = (callback, delay) => globalThis.setInterval(callback, delay),
  cancel = timer => globalThis.clearInterval(timer),
} = {}) {
  let inView = true, timer = null, disposed = false
  const tick = () => { if (!disposed && !doc?.hidden && inView) invalidate() }
  const update = () => {
    if (disposed) return
    const active = !doc?.hidden && inView
    if (!active && timer !== null) { cancel(timer); timer = null }
    if (active && timer === null) { tick(); timer = schedule(tick, intervalMs) }
  }
  const observer = target && typeof Observer === 'function' ? new Observer(entries => {
    const entry = entries.find(item => item.target === target)
    if (entry) { inView = entry.isIntersecting; update() }
  }) : null
  observer?.observe(target)
  doc?.addEventListener('visibilitychange', update)
  update()
  return () => {
    disposed = true
    if (timer !== null) cancel(timer)
    doc?.removeEventListener('visibilitychange', update)
    observer?.disconnect()
  }
}
