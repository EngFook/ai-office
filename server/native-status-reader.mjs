const MAX_STATUS_BYTES = 2 * 1024 * 1024;

// Use a separately hosted current native-status bridge when the board backend
// is older. This is a read-only loopback source; failures never fall back to
// legacy state with weaker execution evidence.
export function createNativeStatusReader({ baseUrl, provider, fetchImpl = fetch, timeoutMs = 2000 } = {}) {
  let origin;
  try {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
    origin = url.origin;
  } catch { throw new Error('Native status URL must be a credential-free loopback HTTP(S) origin.'); }
  if (!['claude', 'codex'].includes(provider)) throw new Error('Native status provider must be claude or codex.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2000) throw new Error('Native status deadline must be between 1 and 2000 milliseconds.');
  let pending = null;
  async function readStatus() {
    const controller = new AbortController(), signal = controller.signal;
    let reader, body, cancelled = false, rejectTimeout;
    const timeout = new Promise((_, reject) => { rejectTimeout = reject; });
    const timer = setTimeout(() => { controller.abort(); rejectTimeout(new Error('Native status deadline exceeded')); }, timeoutMs);
    timer.unref?.();
    const cancel = () => {
      if (!body || cancelled) return;
      cancelled = true;
      // A source's stalled cancellation must not keep a timed-out poll alive.
      try { Promise.resolve(reader ? reader.cancel() : body.cancel()).catch(() => {}); } catch {}
    };
    const reading = (async () => { try {
      const response = await fetchImpl(`${origin}/api/${provider}/status?view=agents`, {
        method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store', headers: { Accept: 'application/json' }, signal,
      });
      body = response.body;
      signal.throwIfAborted();
      if (!response.ok || Number(response.headers?.get('content-length')) > MAX_STATUS_BYTES) {
        throw new Error();
      }
      reader = body?.getReader();
      if (!reader) throw new Error();
      const chunks = []; let bytes = 0;
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_STATUS_BYTES) throw new Error();
        chunks.push(Buffer.from(value));
      }
      signal.throwIfAborted();
      const status = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!status || typeof status !== 'object' || Array.isArray(status) || !Array.isArray(status.agents)
        || status.agents.some(agent => !agent || typeof agent !== 'object' || Array.isArray(agent))) throw new Error();
      return status;
    } finally { cancel(); } })();
    try { return await Promise.race([reading, timeout]); }
    catch { throw new Error(`Current ${provider} status source is unavailable.`); }
    finally { clearTimeout(timer); controller.abort(); cancel(); }
  }
  return async function readNativeStatus() {
    // Share only an active observation, never a completed or failed snapshot.
    pending ||= readStatus().finally(() => { pending = null; });
    return structuredClone(await pending);
  };
}
