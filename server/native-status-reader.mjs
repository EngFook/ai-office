const MAX_STATUS_BYTES = 2 * 1024 * 1024;

// Use a separately hosted current native-status bridge when the board backend
// is older. This is a read-only loopback source; failures never fall back to
// legacy state with weaker execution evidence.
export function createNativeStatusReader({ baseUrl, provider, fetchImpl = fetch } = {}) {
  let origin;
  try {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
    origin = url.origin;
  } catch { throw new Error('Native status URL must be a credential-free loopback HTTP(S) origin.'); }
  if (!['claude', 'codex'].includes(provider)) throw new Error('Native status provider must be claude or codex.');
  return async function readNativeStatus() {
    let reader;
    try {
      const signal = AbortSignal.timeout(2000);
      const response = await fetchImpl(`${origin}/api/${provider}/status?view=agents`, {
        method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store', headers: { Accept: 'application/json' }, signal,
      });
      if (!response.ok || Number(response.headers?.get('content-length')) > MAX_STATUS_BYTES) {
        await response.body?.cancel();
        throw new Error();
      }
      reader = response.body?.getReader();
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
    } catch { throw new Error(`Current ${provider} status source is unavailable.`); }
    finally { if (reader) await reader.cancel().catch(() => {}); }
  };
}
