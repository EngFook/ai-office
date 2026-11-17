import { requestJson } from './json-request.js';

export const EMPTY_BOARD = { tasks: [], roles: [], instructions: [], settings: { autoPickup: false }, runtime: { providers: {}, running: [] }, grok: { configured: false, connected: false }, csrfToken: '' };
function normalizeBoard(data) {
  if (!data || !Array.isArray(data.tasks) || !Array.isArray(data.roles) || !Array.isArray(data.instructions)) throw new Error('The local studio service returned an invalid task board.');
  return { ...EMPTY_BOARD, ...data, settings: { ...EMPTY_BOARD.settings, ...data.settings }, runtime: { ...EMPTY_BOARD.runtime, ...data.runtime }, grok: { ...EMPTY_BOARD.grok, ...data.grok } };
}

// Reads are shared; a completed mutation invalidates any earlier read before
// obtaining its confirmation snapshot. Writes are never retried automatically.
export function createTaskBoardClient({ fetchImpl = globalThis.fetch, setTimer = setTimeout, clearTimer = clearTimeout, onSnapshot = () => {}, onRefreshError = () => {}, onLoading = () => {}, onPending = () => {}, onMutationError = () => {}, onMutationSuccess = () => {} } = {}) {
  let state = EMPTY_BOARD, active = true, generation = 0, read = null, mutationSequence = 0, pending = 0;
  const mutations = new Set();
  const current = epoch => active && epoch === generation;
  function cancelRead() { const previous = read; read = null; previous?.controller.abort(); }
  async function refresh(options = {}) {
    if (!active) return null;
    if (options.fresh) cancelRead();
    if (!options.quiet) onLoading(true);
    if (!read) {
      const flight = { controller: new AbortController(), promise: null }, epoch = generation;
      read = flight;
      flight.promise = requestJson('/api/office/board', { fetchImpl, controller: flight.controller, timeoutMs: 15000, setTimer, clearTimer, headers: { Accept: 'application/json' } })
        .then(normalizeBoard)
        .then(next => {
          if (!current(epoch) || read !== flight) return { next: null };
          state = next; onSnapshot(next); return { next };
        })
        .catch(error => {
          const failure = flight.controller.signal.aborted ? new Error('The local studio service did not respond. Refresh and try again.') : error;
          if (current(epoch) && read === flight) onRefreshError(failure);
          return { error: failure };
        })
        .finally(() => { if (current(epoch) && read === flight) { read = null; onLoading(false); } });
    }
    const result = await read.promise;
    if (result.error && options.throwOnError) throw result.error;
    return result.next || null;
  }
  async function mutate(url, method, payload) {
    if (!active) throw new Error('The studio view has closed. Reopen it before making changes.');
    const epoch = generation, id = ++mutationSequence, controller = new AbortController();
    mutations.add(controller); onPending(++pending);
    let sent = false;
    try {
      if (!state.csrfToken) await refresh({ quiet: true, throwOnError: true });
      if (!current(epoch)) throw new Error('The studio view has closed.');
      if (!state.csrfToken) throw new Error('The local studio service is not ready. Refresh and try again.');
      sent = true;
      const result = await requestJson(url, { fetchImpl, controller, timeoutMs: 45000, setTimer, clearTimer, method,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Office-Token': state.csrfToken }, body: JSON.stringify(payload || {}) });
      if (current(epoch)) {
        if (id === mutationSequence) onMutationSuccess();
        await refresh({ quiet: true, fresh: true });
      }
      return result;
    } catch (error) {
      const unconfirmed = sent && (controller.signal.aborted || !Number.isInteger(error.status) || error.status >= 500);
      const failure = unconfirmed ? new Error('The studio did not confirm the change. Refresh the board to check whether it was saved before retrying.') : error;
      if (current(epoch) && id === mutationSequence) onMutationError(failure);
      // A rejected CSRF token/version needs a fresh board, never an automatic
      // replay of the user's write. Preserve its failure while refreshing.
      if (current(epoch) && [403, 409].includes(error.status)) await refresh({ quiet: true, fresh: true });
      throw failure;
    } finally {
      mutations.delete(controller);
      if (current(epoch)) onPending(pending = Math.max(0, pending - 1));
    }
  }
  return {
    refresh, mutate,
    busy: () => Boolean(read) || pending > 0,
    start() { active = true; },
    stop() {
      active = false; generation++; cancelRead();
      for (const controller of mutations) controller.abort();
      mutations.clear(); pending = 0;
    },
  };
}
