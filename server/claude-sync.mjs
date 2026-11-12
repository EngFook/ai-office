import { watch, lstatSync } from 'node:fs';
import path from 'node:path';

const SOURCES = ['lifecycle', 'sessions', 'transcripts'];
const validName = value => typeof value === 'string' && /^[a-zA-Z0-9_.-]+\.json$/.test(value);

// Three native directory watches, independent of connected browser count. Only
// invalidation metadata leaves this module; paths and record contents never do.
export function createClaudeSync({ claudeHome, onInvalidate = () => {}, watchImpl = watch, now = Date.now,
  debounceMs = 150, heartbeatMs = 15000, recoveryMs = 30000, maxClients = 32 } = {}) {
  const clients = new Set(), watchers = new Map(), changed = new Set();
  const directories = { lifecycle: path.join(claudeHome, 'ai-office', 'events'), sessions: path.join(claudeHome, 'sessions'), transcripts: path.join(claudeHome, 'projects') };
  let revision = 0, timer, heartbeat, recovery, stopped = false, started = false;
  const metadata = sources => ({ revision, observedAt: new Date(now()).toISOString(), sources, watchedSources: SOURCES.filter(source => watchers.has(source)), fallbackSources: SOURCES.filter(source => !watchers.has(source)) });
  function send(response, type, value) {
    try {
      // A slow or abandoned browser must not accumulate an unbounded SSE queue.
      if (response.destroyed || response.writableEnded || response.writableLength > 64 * 1024) { disconnect(response); response.end(); return; }
      response.write(type ? `event: ${type}\ndata: ${JSON.stringify(value)}\n\n` : ': heartbeat\n\n');
    } catch { disconnect(response); }
  }
  function disconnect(response) { clients.delete(response); }
  function flush() {
    timer = null;
    if (stopped || !changed.size) return;
    revision++;
    const payload = metadata([...changed]); changed.clear();
    for (const client of clients) send(client, 'change', payload);
  }
  function invalidate(source, name = null) {
    if (stopped || !SOURCES.includes(source)) return;
    onInvalidate(source, name);
    changed.add(source);
    if (!timer) { timer = setTimeout(flush, debounceMs); timer.unref?.(); }
  }
  function install(source) {
    if (stopped) return;
    const directory = directories[source];
    const remove = () => { const previous = watchers.get(source); if (previous) { watchers.delete(source); previous.watcher.close(); } };
    try {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) { remove(); return; }
      const previous = watchers.get(source);
      if (previous?.ino === stat.ino) return;
      if (previous) { previous.watcher.close(); watchers.delete(source); }
      const watcher = watchImpl(directory, { recursive: source === 'transcripts', persistent: false }, (event, filename) => {
        const name = filename == null ? null : String(filename);
        if (source === 'lifecycle' && name && !validName(name)) return;
        if (source === 'sessions' && name && !validName(name)) return;
        if (source === 'transcripts' && name && !name.endsWith('.jsonl') && event !== 'rename') return;
        invalidate(source, name);
      });
      watchers.set(source, { watcher, ino: stat.ino });
      watcher.on('error', () => { watcher.close(); if (watchers.get(source)?.watcher === watcher) { watchers.delete(source); invalidate(source); } });
    } catch { remove(); /* Missing/unsupported watches are covered by periodic reconciliation. */ }
  }
  function start() {
    if (started || stopped) return;
    started = true;
    for (const source of SOURCES) install(source);
    heartbeat = setInterval(() => { for (const client of clients) send(client, 'heartbeat', metadata([])); }, heartbeatMs); heartbeat.unref?.();
    recovery = setInterval(() => {
      // Also catches missed/coalesced OS events, directory replacement, and
      // lifecycle changes such as a process exiting without a final hook.
      for (const source of SOURCES) { install(source); invalidate(source); }
    }, recoveryMs); recovery.unref?.();
  }
  function attach(request, response) {
    if (stopped || clients.size >= maxClients) { response.statusCode = 503; response.setHeader('Retry-After', '5'); response.end('{"error":"Claude event stream is temporarily unavailable"}'); return; }
    start();
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders?.(); response.write('retry: 1500\n\n');
    clients.add(response);
    response.once('close', () => disconnect(response));
    send(response, 'snapshot', metadata(SOURCES));
  }
  function close() {
    stopped = true;
    clearTimeout(timer); clearInterval(heartbeat); clearInterval(recovery);
    for (const { watcher } of watchers.values()) watcher.close(); watchers.clear();
    for (const client of clients) { try { client.end(); } catch {} } clients.clear();
  }
  return { start, attach, close };
}

// Hook files are atomic, append-mostly records. The bridge performs one initial
// scan, then checks named changes. Full reconciliation is bounded by time or a
// lost watcher event; it is never repeated for each tool event.
export function createClaudeLifecycleIndex({ inbox, readEvents, now = Date.now, reconcileMs = 30000, maxDirty = 4096 }) {
  const cache = new Map(), dirty = new Set();
  let initialized = false, fullRequired = true, lastFullAt = 0, pending = null;
  function invalidate(name) {
    if (!validName(name) || dirty.size >= maxDirty) { fullRequired = true; dirty.clear(); }
    else dirty.add(name);
  }
  async function read(health = {}) {
    if (pending) await pending;
    const full = !initialized || fullRequired || now() - lastFullAt >= reconcileMs;
    const names = full ? undefined : [...dirty]; dirty.clear(); fullRequired = false;
    const localHealth = {};
    pending = readEvents(inbox, cache, localHealth, { changedFiles: names });
    try {
      const result = await pending;
      initialized = true;
      if (full) lastFullAt = now();
      if (!localHealth.available) fullRequired = true;
      Object.assign(health, localHealth);
      return result;
    } catch (error) { fullRequired = true; throw error; }
    finally { pending = null; }
  }
  return { invalidate, read };
}
