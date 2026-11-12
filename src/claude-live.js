const SOURCES = new Set(['lifecycle', 'sessions', 'transcripts']);

// Share one local invalidation channel. Its connection state is not agent status.
export function createClaudeEventHub({ EventSourceImpl = globalThis.EventSource, url = '/api/claude/events', debounceMs = 100, heartbeatTimeoutMs = 45000, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const listeners = new Set();
  let source = null, timer = null, watchdog = null, reconnect = null;
  let state = { transport: 'connecting', revision: null, observedAt: null, lastHeartbeatAt: null, fallbackSources: [], reason: null };
  const emit = kind => { for (const listener of listeners) { try { listener({ kind, state: { ...state } }); } catch {} } };
  function start() {
    if (source) return;
    if (typeof EventSourceImpl !== 'function') { state = { ...state, transport: 'fallback', reason: 'unsupported' }; emit('state'); return; }
    let current;
    try { current = new EventSourceImpl(url); }
    catch { state = { ...state, transport: 'fallback', reason: 'connection-error' }; emit('state'); return; }
    source = current;
    const alive = () => {
      clearTimer(watchdog);
      watchdog = setTimer(() => {
        if (source !== current) return;
        current.close(); source = null;
        state = { ...state, transport: 'fallback', reason: 'heartbeat-timeout' }; emit('state');
        reconnect = setTimer(() => { reconnect = null; if (listeners.size) start(); }, 1000);
      }, heartbeatTimeoutMs);
    };
    alive();
    const receive = (event, initial, heartbeat = false) => {
      if (source !== current) return;
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      if (!Number.isSafeInteger(data?.revision) || data.revision < 0 || typeof data.observedAt !== 'string' || !Number.isFinite(Date.parse(data.observedAt)) || !Array.isArray(data.sources) || data.sources.some(value => !SOURCES.has(value))) return;
      if (data.fallbackSources !== undefined && (!Array.isArray(data.fallbackSources) || data.fallbackSources.some(value => !SOURCES.has(value)))) return;
      alive();
      state = { ...state, transport: 'live', lastHeartbeatAt: now(), fallbackSources: data.fallbackSources || [], reason: null };
      if (heartbeat) { emit('state'); return; }
      if (!initial && state.revision !== null && data.revision <= state.revision) { emit('state'); return; }
      // A new backend process starts its own revision sequence.
      state = { ...state, revision: data.revision, observedAt: data.observedAt }; emit('state');
      clearTimer(timer);
      timer = setTimer(() => { timer = null; emit('invalidate'); }, debounceMs);
    };
    current.addEventListener('snapshot', event => receive(event, true));
    current.addEventListener('change', event => receive(event, false));
    current.addEventListener('heartbeat', event => receive(event, false, true));
    current.addEventListener('error', () => {
      if (source !== current) return;
      state = { ...state, transport: 'fallback', reason: 'connection-error' }; emit('state');
      // Native EventSource reconnects; readers poll while it recovers.
    });
  }
  return {
    subscribe(listener) {
      listeners.add(listener); listener({ kind: 'state', state: { ...state } });
      if (listeners.size === 1) start();
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          clearTimer(timer); clearTimer(watchdog); clearTimer(reconnect); timer = null; watchdog = null; reconnect = null; source?.close(); source = null;
          state = { transport: 'connecting', revision: null, observedAt: null, lastHeartbeatAt: null, fallbackSources: [], reason: null };
        }
      };
    },
  };
}
export const claudeEvents = createClaudeEventHub();

// Only one request per view. Changes during a read queue one fresh follow-up.
export function createClaudeLiveFeed({ url, validate = () => true, onSnapshot, onError = () => {}, onSync = () => {}, events = claudeEvents, fetchImpl = globalThis.fetch, pollMs = 4000, verifyMs = 30000, timeoutMs = 15000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let stopped = true, pending = null, dirty = false, controller = null, timer = null, unsubscribe;
  let transport = 'connecting';
  function schedule() {
    clearTimer(timer);
    if (!stopped && !pending) timer = setTimer(() => { timer = null; void refresh(); }, transport === 'live' ? verifyMs : pollMs);
  }
  async function read() {
    while (dirty && !stopped) {
      dirty = false;
      const request = new AbortController(); controller = request;
      const timeout = setTimer(() => request.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, { signal: request.signal, cache: 'no-store' });
        if (!response.ok) throw new Error('Claude snapshot unavailable.');
        const data = await response.json();
        if (!validate(data)) throw new Error('Invalid Claude snapshot.');
        if (!stopped) onSnapshot(data);
      } catch (error) { if (!stopped) onError(error); }
      finally { clearTimer(timeout); if (controller === request) controller = null; }
    }
  }
  function refresh() {
    if (stopped) return Promise.resolve();
    dirty = true; clearTimer(timer); timer = null;
    if (!pending) pending = read().finally(() => { pending = null; schedule(); });
    return pending;
  }
  return {
    start() {
      if (!stopped) return pending || Promise.resolve();
      stopped = false;
      unsubscribe = events.subscribe(event => {
        if (stopped) return;
        const changedTransport = transport !== event.state.transport;
        transport = event.state.transport; onSync(event.state);
        if (event.kind === 'invalidate') void refresh(); else if (changedTransport) schedule();
      });
      return refresh();
    },
    refresh,
    stop() { stopped = true; dirty = false; clearTimer(timer); timer = null; unsubscribe?.(); unsubscribe = null; controller?.abort(); return pending || Promise.resolve(); },
  };
}
