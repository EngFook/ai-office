import { requestJson } from './json-request.js';

// One request per shared resource, only while a visible consumer needs it.
// A cancelled generation can never publish into a later subscription.
export function createPollingResource({ url, initialData = null, validate = () => true, errorMessage = 'Data temporarily unavailable. Reconnecting automatically.', pollMs = 30000, timeoutMs = 12000, fetchImpl = globalThis.fetch, visibilityTarget = globalThis.document, focusTarget = globalThis.window, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const listeners = new Set();
  let state = { data: initialData, error: null, loading: true, receivedAt: null };
  let request = null, timer = null;
  const visible = () => visibilityTarget?.visibilityState !== 'hidden';
  const publish = value => { state = value; for (const listener of listeners) listener(state); };
  function cancel() { clearTimer(timer); timer = null; const previous = request; request = null; previous?.controller.abort(); }
  function schedule() {
    clearTimer(timer);
    if (listeners.size && visible()) timer = setTimer(() => { timer = null; void refresh(); }, pollMs);
  }
  function refresh() {
    if (!listeners.size || !visible()) return Promise.resolve(state);
    if (request) return request.promise;
    clearTimer(timer); timer = null;
    const current = { controller: new AbortController(), promise: null }; request = current;
    // Refreshing an already observed provider must not turn Connected back
    // into Connecting on every poll; the last confirmed data remains visible.
    publish({ ...state, loading: state.receivedAt === null });
    current.promise = requestJson(url, { fetchImpl, controller: current.controller, timeoutMs, setTimer, clearTimer })
      .then(data => {
        if (!validate(data)) throw new Error('Invalid response.');
        if (request === current) publish({ data, error: null, loading: false, receivedAt: now() });
      })
      .catch(() => { if (request === current) publish({ ...state, error: errorMessage, loading: false }); })
      .finally(() => { if (request === current) { request = null; schedule(); } });
    return current.promise;
  }
  const wake = () => { if (visible()) void refresh(); else cancel(); };
  return {
    getSnapshot: () => state,
    refresh,
    subscribe(listener) {
      listeners.add(listener); listener(state);
      if (listeners.size === 1) {
        visibilityTarget?.addEventListener('visibilitychange', wake);
        focusTarget?.addEventListener('focus', wake);
        void refresh();
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          cancel();
          visibilityTarget?.removeEventListener('visibilitychange', wake);
          focusTarget?.removeEventListener('focus', wake);
        }
      };
    },
  };
}
