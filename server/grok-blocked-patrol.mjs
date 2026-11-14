import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, lstatSync, readFileSync, writeFileSync, renameSync, unlinkSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { assessBlockedTask } from './qwen-huddle.mjs';
import { reviewWorkHold } from './review-policy.mjs';
import { humanRequestHold } from './human-relay-policy.mjs';
import { resolutionPaused } from './resolution-policy.mjs';
import { watchFingerprint } from './watch-task-policy.mjs';

const iso = value => new Date(value).toISOString();
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const identity = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:@/-]{0,239}$/.test(value);
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status, statusCode: status }); };
const STORAGE_ERROR = 'Grok 受阻巡查存储或运行锁不可用；保留原记录，停止自动处理。';
// Redact full values before clipping; no raw secrets enter patrol responses or journals.
function redactSecrets(value, limit = 4000) {
  return (typeof value === 'string' ? value : '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]')
    .replace(/\b(?:sk-|xai-|crsr_|ghp_|github_pat_)[a-zA-Z0-9_-]{12,}/g, '[REDACTED]')
    .replace(/\b(Bearer|Basic)\s+[^\s"'`,;]+/gi, '$1 [REDACTED]')
    .replace(/(?<![\w-])((?:[\w-]*(?:token|secret|password|api[_-]?key|authorization)[\w-]*)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/([?&](?:access[_-]?token|refresh[_-]?token|api[_-]?key|key|token|auth|authorization|signature|sig|password|passwd|pwd)=)[^\s&#"'<>]+/gi, '$1[REDACTED]')
    .replace(/https?:\/\/[^\s"'<>]+\/automations\/webhook\/[^\s"'<>]+/gi, '[REDACTED WEBHOOK]')
    .slice(0, limit).trim();
}
function readPrivate(file) {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new Error('Invalid patrol storage');
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function writePrivate(file, value) {
  const home = path.dirname(file);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const directory = lstatSync(home);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Invalid patrol directory');
  const temp = `${file}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); renameSync(temp, file); chmodSync(file, 0o600); }
  finally { try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
// Serialize both stale-lock recovery and acquisition, including same-process instances.
function acquireLock(home) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (!lstatSync(home).isDirectory() || lstatSync(home).isSymbolicLink()) throw new Error('Invalid patrol directory');
  const file = path.join(home, 'grok-blocked-patrol.lock'), dbFile = path.join(home, 'grok-blocked-patrol-lock.sqlite'), token = randomUUID();
  try { if (!lstatSync(dbFile).isFile() || lstatSync(dbFile).isSymbolicLink()) throw new Error('Invalid patrol lock database'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const transaction = action => {
    const db = new DatabaseSync(dbFile);
    try {
      chmodSync(dbFile, 0o600); db.exec('PRAGMA busy_timeout=3000; BEGIN IMMEDIATE');
      try { const result = action(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    } finally { db.close(); }
  };
  const owns = () => { try { const value = readPrivate(file); return value?.pid === process.pid && value.token === token; } catch { return false; } };
  transaction(() => {
    const previous = readPrivate(file);
    if (previous) {
      if (!Number.isSafeInteger(previous.pid) || previous.pid < 1 || typeof previous.token !== 'string') throw new Error('Invalid patrol lock');
      let alive = true;
      try { process.kill(previous.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
      if (alive) throw new Error('Patrol already running');
      unlinkSync(file);
    }
    writeFileSync(file, JSON.stringify({ pid: process.pid, token }), { mode: 0o600, flag: 'wx' });
  });
  return { owns, release() { transaction(() => { if (owns()) unlinkSync(file); }); } };
}
function validState(value) {
  if (!value || value.version !== 1 || !timestamp(value.nextCheckAt) || !Number.isSafeInteger(value.blockedCount) || value.blockedCount < 0) throw new Error('Invalid patrol state');
  const cycle = value.cycle;
  if (cycle != null) {
    if (!identity(cycle.id) || !timestamp(cycle.createdAt) || !Number.isSafeInteger(cycle.dispatched) || cycle.dispatched < 0 || cycle.dispatched > 2
      || !cycle.readBindings || typeof cycle.readBindings !== 'object' || Array.isArray(cycle.readBindings)
      || !cycle.handled || typeof cycle.handled !== 'object' || Array.isArray(cycle.handled)) throw new Error('Invalid patrol cycle');
    for (const [id, binding] of Object.entries(cycle.readBindings)) if (!identity(id) || !Number.isSafeInteger(binding.version) || !/^[a-f0-9]{64}$/.test(binding.fingerprint || '')) throw new Error('Invalid patrol binding');
    for (const [id, entry] of Object.entries(cycle.handled)) if (!identity(id) || !['reserved', 'handled', 'failed'].includes(entry.state) || !['wait', 'retry', 'investigate'].includes(entry.action) || !timestamp(entry.at)) throw new Error('Invalid patrol receipt');
  }
  return value;
}

export function createGrokBlockedPatrol({ store, home = process.env.AI_OFFICE_HOME || path.join(homedir(), '.ai-office'), enabled = false,
  intervalMs = 600000, now = Date.now, runtimeReader = () => ({}), quotaReader = () => null, configuration = {}, providerConcurrency,
  notify = async () => {}, onDispatch = async () => {} } = {}) {
  if (!store || typeof store.snapshot !== 'function') throw new Error('A task store is required.');
  if (!Number.isFinite(intervalMs) || intervalMs < 1) throw new Error('Invalid patrol interval.');
  const stateFile = path.join(home, 'grok-blocked-patrol.json');
  let state = null, stopped = true, lock = null, timer = null, flight = null, storageError = null, error = null, phase = enabled ? 'stopped' : 'disabled';
  try { const saved = readPrivate(stateFile); if (saved) state = validState(saved); } catch { storageError = STORAGE_ERROR; }
  const status = () => ({ enabled: enabled === true, started: !stopped, intervalMs, nextCheckAt: state?.nextCheckAt || null,
    lastRequestedAt: state?.lastRequestedAt || null, lastReadAt: state?.lastReadAt || null, lastHandledAt: state?.lastHandledAt || null,
    lastResult: state?.lastResult || null, phase: storageError ? 'unavailable' : !enabled ? 'disabled' : stopped ? (error ? 'unavailable' : 'stopped') : phase,
    error: storageError || error, blockedCount: state?.blockedCount || 0 });
  const persist = () => { try { state.phase = phase; state.error = error; writePrivate(stateFile, state); } catch { storageError = STORAGE_ERROR; throw new Error(STORAGE_ERROR); } };
  const available = () => {
    if (!enabled || stopped || storageError || !lock?.owns()) fail('Grok 受阻巡查未启用或不持有运行锁。', 503);
  };
  const facts = () => {
    store.syncHumanRequests?.();
    return { board: store.snapshot({ recoverLeases: false }), runtime: runtimeReader(), quota: quotaReader() };
  };
  function assessment(task, current) {
    if (current.board.maintenance?.active) return { mode: 'follow_up', candidates: [], reason: '办公室正在维护，保留原卡，暂不自动恢复。' };
    if (resolutionPaused(task)) return { mode: 'follow_up', candidates: [], reason: '用户暂停或已停用，不能自动恢复。' };
    return assessBlockedTask(task, current.board, current.runtime, current.quota, now(), providerConcurrency, configuration);
  }
  function pending() {
    available();
    if (!state?.cycle || now() >= Date.parse(state.nextCheckAt)) return { cycleId: null, nextCheckAt: state?.nextCheckAt || null, tasks: [] };
    const current = facts(), tasks = current.board.tasks.filter(task => task.status === 'blocked').map(task => {
      const assessed = assessment(task, current), fingerprint = watchFingerprint(task);
      const human = current.board.humanRequests?.find(item => item.id === task.humanGate?.requestId && ['pending', 'delivered'].includes(item.state));
      state.cycle.readBindings[task.id] = { version: task.version, fingerprint };
      const candidates = (assessed.candidates || []).map(item => ({ ...item, reason: redactSecrets(item.reason, 1000) }));
      return { id: task.id, version: task.version, fingerprint, title: redactSecrets(task.title, 240), description: redactSecrets(task.description, 6000),
        error: redactSecrets(task.error, 2000), result: redactSecrets(task.result, 4000), role: redactSecrets(task.role, 100), provider: task.provider,
        projectPath: redactSecrets(task.projectPath, 4000), mode: assessed.mode, reason: redactSecrets(assessed.reason, 2000), candidates,
        allowedActions: ['wait', ...(candidates.length && assessed.mode === 'investigate' ? ['investigate'] : candidates.length && assessed.mode === 'dispatch' ? ['retry'] : [])],
        humanRequestId: human?.id || null, handled: !!state.cycle.handled[task.id] };
    });
    state.blockedCount = tasks.length; state.lastReadAt = iso(now()); persist();
    return { cycleId: state.cycle.id, createdAt: state.cycle.createdAt, nextCheckAt: state.nextCheckAt, tasks };
  }
  async function handle(id, input = {}) {
    available();
    if (!input || typeof input !== 'object' || Array.isArray(input) || input.source !== 'grok-bot') fail('Only Grok Bot can record its blocked-task handling.');
    if (Object.keys(input).some(key => !['source', 'cycleId', 'version', 'fingerprint', 'action', 'provider', 'reason', 'evidence'].includes(key))) fail('Patrol handling cannot approve, complete, delete, or edit task scope.');
    if (!identity(id) || !['wait', 'retry', 'investigate'].includes(input.action)) fail('Invalid blocked-task action.');
    if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 2000 || typeof input.evidence !== 'string' || !input.evidence.trim() || input.evidence.length > 4000) fail('Concrete reason and verification evidence are required.');
    const cycle = state?.cycle;
    if (!cycle || input.cycleId !== cycle.id || now() >= Date.parse(state.nextCheckAt)) fail('巡查轮次已改变，请读取当前受阻任务。', 409);
    if (Object.hasOwn(cycle.handled, id)) fail('本轮已经处理或尝试过此任务，不重复派单。', 409);
    const binding = cycle.readBindings[id];
    if (!binding || input.version !== binding.version || input.fingerprint !== binding.fingerprint) fail('请先读取本轮任务并使用当前版本和指纹。', 409);
    const current = facts(), task = current.board.tasks.find(item => item.id === id);
    if (!task || task.status !== 'blocked' || task.version !== input.version || watchFingerprint(task) !== input.fingerprint) fail('任务已经改变，请重新读取并核对。', 409);
    const assessed = assessment(task, current);
    let selected;
    if (input.action !== 'wait') {
      if (current.board.maintenance?.active || current.board.settings?.autoPickup === false || resolutionPaused(task) || humanRequestHold(task) || reviewWorkHold(task)) fail('此任务仍有暂停、人工确认、审查或维护门禁。', 409);
      const mode = input.action === 'retry' ? 'dispatch' : 'investigate';
      const bestFit = assessed.candidates?.[0]?.fit;
      selected = assessed.candidates?.find(item => item.provider === input.provider && item.fit === bestFit);
      if (assessed.mode !== mode || !selected) fail('分派条件已改变，所选代理或动作不符合当前分工、额度或工作位。', 409);
      if (cycle.dispatched >= 2) fail('本轮已安排两项恢复工作，其余留到下一轮。', 409);
    }
    const at = iso(now()), reason = redactSecrets(input.reason, 2000), evidence = redactSecrets(input.evidence, 4000);
    const record = { action: input.action, state: 'reserved', at, version: task.version, fingerprint: input.fingerprint, provider: selected?.provider || task.provider, reason, evidence };
    // Reserve durably before mutating the task. A crash cannot repeat a dispatch
    // or reset its per-cycle budget, even if receipt persistence then fails.
    cycle.handled[id] = record;
    if (input.action !== 'wait') cycle.dispatched++;
    persist();
    let applied = false, investigationTaskId = null;
    try {
      if (input.action === 'retry') { store.retryBlockedTask(id, { version: task.version, provider: selected.provider, reason: reason.slice(0, 1000) }); applied = true; }
      if (input.action === 'investigate') { const result = store.investigateBlockedTask(id, { version: task.version, provider: selected.provider, reason }); applied = result.created; investigationTaskId = result.task.id; }
      record.state = 'handled'; record.applied = applied; if (investigationTaskId) record.investigationTaskId = investigationTaskId;
      state.lastHandledAt = at; state.lastResult = { taskId: id, action: input.action, applied, reason, evidence, at, ...(investigationTaskId ? { investigationTaskId } : {}) };
      phase = 'watching'; error = null; persist();
    } catch (cause) {
      record.state = 'failed'; record.applied = false;
      if (!storageError) persist();
      throw cause;
    }
    if (applied) {
      try { await onDispatch(); }
      catch { error = '恢复任务已入队，但执行器唤醒失败；保留任务，等待执行器恢复。'; phase = 'unavailable'; persist(); }
    }
    return { taskId: id, cycleId: cycle.id, action: input.action, applied, ...(investigationTaskId ? { investigationTaskId } : {}), status: status() };
  }
  async function scan() {
    if (!enabled || stopped || storageError) return status();
    available();
    if (!state) { state = { version: 1, nextCheckAt: iso(now()), blockedCount: 0, cycle: null }; persist(); }
    if (now() < Date.parse(state.nextCheckAt)) return status();
    const current = facts();
    const blocked = current.board.tasks.filter(task => task.status === 'blocked');
    state.nextCheckAt = iso(now() + intervalMs); state.blockedCount = blocked.length; error = null;
    if (current.board.maintenance?.active) {
      state.cycle = null; phase = 'paused'; persist(); return status();
    }
    if (!blocked.length) { state.cycle = null; phase = 'watching'; persist(); return status(); }
    const createdAt = iso(now());
    state.cycle = { id: `grok-blocked:${randomUUID()}`, createdAt, dispatched: 0, readBindings: {}, handled: {} };
    state.lastRequestedAt = createdAt; phase = 'notifying'; persist();
    try {
      const result = await notify([{ id: state.cycle.id, state: 'pending', createdAt }]);
      if (result?.configured === false || result?.error || result?.sent !== true) throw new Error('Wake acceptance unconfirmed');
      if (!stopped) { if (phase === 'notifying') phase = 'awaiting_bot'; persist(); }
    } catch { if (!stopped) { phase = 'unavailable'; error = 'Grok 巡查唤醒未成功；任务保持受阻，下一轮重试。'; persist(); } }
    return status();
  }
  function tick() {
    if (!flight) flight = scan().catch(() => { phase = 'unavailable'; error = 'Grok 巡查来源或存储暂不可用，本轮未完成。'; return status(); }).finally(() => { flight = null; });
    return flight;
  }
  function schedule() {
    clearTimeout(timer);
    if (stopped || !enabled || storageError) return;
    const due = Date.parse(state?.nextCheckAt), delay = Number.isFinite(due) ? Math.max(1000, due - now()) : intervalMs;
    timer = setTimeout(async () => { await tick(); schedule(); }, delay); timer.unref?.();
  }
  return { status, pending, handle, tick,
    async start() {
      if (!stopped) return tick();
      if (!enabled || storageError) return status();
      try { lock = acquireLock(home); const saved = readPrivate(stateFile); state = saved ? validState(saved) : null; }
      catch { try { lock?.release(); } catch {} lock = null; error = STORAGE_ERROR; phase = 'unavailable'; return status(); }
      stopped = false; error = typeof state?.error === 'string' ? state.error : null;
      phase = ['awaiting_bot', 'watching', 'paused', 'unavailable'].includes(state?.phase) ? state.phase : state?.cycle ? 'unavailable' : 'watching';
      if (state?.cycle && state.phase === 'notifying') error = '上次 Grok 唤醒未确认完成，保留本轮，等待下一次巡查。';
      await tick(); schedule(); return status();
    },
    async stop() { stopped = true; clearTimeout(timer); timer = null; await flight; try { lock?.release(); } catch { storageError = STORAGE_ERROR; } lock = null; },
  };
}
