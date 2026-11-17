import test from 'node:test'
import assert from 'node:assert/strict'
import { startVisibleSceneLoop } from '../src/scene-activity.js'

function fixture({ hidden = false, observer = true } = {}) {
  const listeners = new Map(), timers = new Map(), target = {}, events = []
  let id = 0, observerCallback, disconnected = false
  const document = { hidden, addEventListener: (type, cb) => listeners.set(type, cb), removeEventListener: (type, cb) => { if (listeners.get(type) === cb) listeners.delete(type) } }
  const stop = startVisibleSceneLoop(() => events.push('frame'), {
    target, document, intervalMs: 1000 / 30,
    Observer: observer ? class { constructor(callback) { observerCallback = callback } observe(value) { assert.equal(value, target) } disconnect() { disconnected = true } } : null,
    schedule: (callback, delay) => { assert.equal(delay, 1000 / 30); timers.set(++id, callback); return id },
    cancel: id => timers.delete(id),
  })
  return { stop, timers, events, listeners, get disconnected() { return disconnected }, hidden(value) { document.hidden = value; listeners.get('visibilitychange')?.() }, intersect(value) { observerCallback?.([{ target, isIntersecting: value }]) } }
}

test('hidden tabs cancel animation wake-ups; visibility restores one loop and an immediate frame', () => {
  const f = fixture()
  assert.equal(f.timers.size, 1); assert.equal(f.events.length, 1)
  const queued = [...f.timers.values()][0]
  f.hidden(true); assert.equal(f.timers.size, 0)
  queued(); assert.equal(f.events.length, 1, 'an already queued callback cannot render a hidden page')
  f.hidden(false); assert.equal(f.timers.size, 1); assert.equal(f.events.length, 2)
  f.hidden(false); assert.equal(f.timers.size, 1); assert.equal(f.events.length, 2, 'duplicate visibility events do not multiply loops')
  f.stop(); assert.equal(f.timers.size, 0); assert.equal(f.listeners.size, 0); assert.equal(f.disconnected, true)
  queued(); assert.equal(f.events.length, 2, 'unmounted canvases cannot be invalidated')
})

test('offscreen canvases remain paused until both the canvas and the page become visible', () => {
  const f = fixture()
  f.intersect(false); assert.equal(f.timers.size, 0)
  f.hidden(true); f.intersect(true); assert.equal(f.timers.size, 0)
  f.intersect(false); f.hidden(false); assert.equal(f.timers.size, 0)
  f.intersect(true); assert.equal(f.timers.size, 1); assert.equal(f.events.length, 2)
  f.stop(); f.intersect(true); f.hidden(false); assert.equal(f.timers.size, 0)
})

test('initially hidden tabs do not start a timer, including browsers without IntersectionObserver', () => {
  const f = fixture({ hidden: true, observer: false })
  assert.equal(f.timers.size, 0); assert.equal(f.events.length, 0)
  f.hidden(false); assert.equal(f.timers.size, 1); assert.equal(f.events.length, 1)
  f.stop()
})
