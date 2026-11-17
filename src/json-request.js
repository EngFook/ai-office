// The deadline covers both the connection and reading/parsing its response.
// Cancellation is also bounded when an underlying fetch ignores AbortSignal.
export async function requestJson(url, { fetchImpl = globalThis.fetch, controller = new AbortController(), timeoutMs = 15000, setTimer = setTimeout, clearTimer = clearTimeout, ...options } = {}) {
  let timer, cancel;
  const aborted = new Promise((_, reject) => {
    cancel = () => reject(controller.signal.reason || new Error('Request cancelled.'));
    controller.signal.addEventListener('abort', cancel, { once: true });
    if (controller.signal.aborted) cancel();
    timer = setTimer(() => controller.abort(new Error('Request timed out.')), timeoutMs);
  });
  try {
    return await Promise.race([aborted, (async () => {
      if (controller.signal.aborted) throw controller.signal.reason;
      const response = await fetchImpl(url, { cache: 'no-store', credentials: 'same-origin', ...options, signal: controller.signal });
      const source = await response.text();
      let data;
      try { data = source ? JSON.parse(source) : {}; } catch { throw new Error('The local studio service returned an unreadable response.'); }
      if (!response.ok) {
        const error = new Error(typeof data?.error === 'string' ? data.error : data?.error?.message || data?.message || `The studio service returned ${response.status}.`);
        error.status = response.status;
        throw error;
      }
      return data;
    })()]);
  } finally {
    clearTimer(timer);
    controller.signal.removeEventListener('abort', cancel);
  }
}
