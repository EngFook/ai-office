import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, lstatSync, readFileSync, writeFileSync, renameSync, unlinkSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const DAY = 86400000, SOURCE_BYTES = 18000, MAX_PENDING = 90;
const iso = value => new Date(value).toISOString();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const idText = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:@/-]{0,239}$/.test(value);
// Redact complete values before clipping. Neither raw task descriptions nor
// native transcript/tool output are included in this external report channel.
const clean = (value, limit) => (typeof value === 'string' ? value : '')
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
const fail = (message, status = 400) => { const error = new Error(message); error.status = status; throw error; };
const validConfig = value => {
  if (!value || typeof value !== 'object' || typeof value.enabled !== 'boolean' || typeof value.timeZone !== 'string'
    || !Number.isInteger(value.hour) || value.hour < 0 || value.hour > 23) throw new Error('日报配置无效。');
  try { new Intl.DateTimeFormat('en-CA', { timeZone: value.timeZone }).format(); } catch { throw new Error('日报时区无效。'); }
  return { enabled: value.enabled, timeZone: value.timeZone, hour: value.hour };
};
function readPrivate(file) {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new Error('Invalid report storage');
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return null; throw new Error('日报存储不可读；保留原文件，等待修复。'); }
}
function writePrivate(file, value) {
  const directory = path.dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('日报目录必须是本机普通目录。');
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    renameSync(temp, file); chmodSync(file, 0o600);
  } finally { try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
function calendarParts(ms, timeZone) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
}
function localDate(ms, timeZone) {
  const p = calendarParts(ms, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}
// Resolve the local calendar boundary explicitly; never inherit the host zone.
function nextBoundary(after, config) {
  const day = calendarParts(after, config.timeZone);
  for (let offset = 0; offset < 4; offset++) {
    const date = new Date(Date.UTC(day.year, day.month - 1, day.day + offset));
    const desired = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), config.hour);
    let result = desired;
    for (let attempt = 0; attempt < 4; attempt++) {
      const p = calendarParts(result, config.timeZone);
      const delta = desired - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
      if (!delta) break;
      result += delta;
    }
    if (result > after) return result;
  }
  throw new Error('无法计算下一次日报时间。');
}
function projectScope(input) {
  const values = typeof input === 'function' ? input() : input;
  if (!Array.isArray(values)) throw new Error('日报项目范围不可用。');
  const result = new Map();
  for (const item of values) {
    const folders = typeof item === 'string' ? [item] : item && typeof item === 'object' ? [item.path, ...(Array.isArray(item.folders) ? item.folders : [])] : [];
    for (const folder of folders) if (typeof folder === 'string' && path.isAbsolute(folder) && !/[\x00-\x1f]/.test(folder)) {
      const normalized = path.normalize(folder);
      result.set(normalized, clean(typeof item === 'object' ? item.name : path.basename(normalized), 100) || path.basename(normalized));
    }
  }
  return result;
}
function taskSource(task, project) {
  return { id: task.id, project, provider: clean(task.assignee?.provider || task.provider || 'unknown', 40), title: clean(task.title, 180),
    status: task.status, updatedAt: stamp(task.updatedAt) ? task.updatedAt : null,
    result: clean(task.result, 750), blocker: clean(task.error, 400), completionSource: clean(task.completionSource || 'unknown', 60) };
}
function capture(store, allowedProjects, period, capturedAt) {
  const board = store.snapshot({ recoverLeases: false });
  if (!board || !Array.isArray(board.tasks)) throw new Error('日报任务来源不可用。');
  const scope = projectScope(allowedProjects), tasks = [], outside = [];
  for (const task of board.tasks) {
    if (!task || !idText(task.id) || task.status === 'deleted') continue;
    const folder = typeof task.projectPath === 'string' && path.isAbsolute(task.projectPath) ? path.normalize(task.projectPath) : null;
    if (folder && scope.has(folder)) tasks.push({ task, folder }); else outside.push(task);
  }
  const from = Date.parse(period.startAt), to = Date.parse(period.endAt);
  const inPeriod = task => stamp(task.updatedAt) && Date.parse(task.updatedAt) >= from && Date.parse(task.updatedAt) < to;
  const changed = tasks.filter(({ task }) => inPeriod(task));
  const completed = changed.filter(({ task }) => task.status === 'done');
  const blockers = tasks.filter(({ task }) => task.status === 'blocked');
  const scopedIds = new Set(tasks.map(({ task }) => task.id));
  const questions = (Array.isArray(board.humanRequests) ? board.humanRequests : []).filter(question => question && scopedIds.has(question.taskId) && ['pending', 'delivered'].includes(question.state));
  const doneByProvider = {};
  for (const { task } of completed) { const provider = clean(task.assignee?.provider || task.provider || 'unknown', 40); doneByProvider[provider] = (doneByProvider[provider] || 0) + 1; }
  const coverage = '依据任务板当前保存的状态和更新时间汇总；任务完成由任务板记录，不等于独立验收。原生日志只有有限采样，本报告不声称覆盖所有终端、子代理或被删除的历史活动。受阻和待答数量是生成资料时的快照。';
  const source = { period, capturedAt, coverage, counts: { completed: completed.length, changed: changed.length, blocked: blockers.length,
    pending: tasks.filter(({ task }) => task.status === 'pending').length, running: tasks.filter(({ task }) => task.status === 'running').length,
    needsUser: questions.length, outOfScope: outside.length, omitted: 0, doneByProvider }, tasks: [], questions: [] };
  const ordered = [...completed, ...blockers, ...changed].sort((a, b) => String(b.task.updatedAt).localeCompare(String(a.task.updatedAt)));
  const seen = new Set(), usedFolders = new Set();
  for (const { task, folder } of ordered) {
    if (seen.has(task.id)) continue; seen.add(task.id);
    const row = taskSource(task, scope.get(folder));
    source.tasks.push(row);
    if (Buffer.byteLength(JSON.stringify(source), 'utf8') > SOURCE_BYTES) { source.tasks.pop(); source.counts.omitted++; }
    else usedFolders.add(folder);
  }
  for (const question of questions) {
    source.questions.push({ id: clean(question.id, 240), taskId: question.taskId, kind: ['info', 'approval'].includes(question.kind) ? question.kind : 'unknown', question: clean(question.question, 500), state: question.state });
    if (Buffer.byteLength(JSON.stringify(source), 'utf8') > SOURCE_BYTES) { source.questions.pop(); source.counts.omitted++; }
    else usedFolders.add(tasks.find(({ task }) => task.id === question.taskId).folder);
  }
  // Count-only aggregates also belong to the configured scope, even when all
  // records were too large to include in the model prompt.
  for (const { folder } of tasks) usedFolders.add(folder);
  return { source, usedFolders: [...usedFolders].sort() };
}
function publicReport(record) {
  const { sourceSnapshot, usedFolders, attempts, nextAttemptAt, ...report } = record;
  return structuredClone(report);
}
function validState(value) {
  if (!value || value.version !== 1 || !stamp(value.nextDueAt) || !Array.isArray(value.reports) || value.reports.length > 180) throw new Error('日报存储格式无效；保留原记录。');
  for (const report of value.reports) {
    if (!report || !/^qwen-daily:\d{4}-\d{2}-\d{2}$/.test(report.id) || !['generating', 'retrying', 'withheld', 'pending', 'delivered'].includes(report.status)
      || !stamp(report.period?.startAt) || !stamp(report.period?.endAt) || !Array.isArray(report.usedFolders)) throw new Error('日报记录无效；保留原记录。');
    if (['pending', 'delivered'].includes(report.status) && (!/^[a-f0-9]{64}$/.test(report.reportHash || '') || typeof report.text !== 'string' || !report.text.trim())) throw new Error('日报正文无效；保留原记录。');
  }
  return value;
}

// SQLite serializes stale-lock recovery as well as creation. A plain read / unlink
// sequence would let two restarts remove each other's newly acquired wx lock.
function reportLock(home) {
  const file = path.join(home, 'qwen-daily-report.lock'), token = randomUUID();
  const dbFile = path.join(home, 'qwen-daily-report-lock.sqlite');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (!lstatSync(home).isDirectory() || lstatSync(home).isSymbolicLink()) throw new Error('Invalid report home');
  const transact = callback => {
    const db = new DatabaseSync(dbFile);
    try {
      chmodSync(dbFile, 0o600); db.exec('PRAGMA busy_timeout=3000; BEGIN IMMEDIATE');
      try { const result = callback(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    } finally { db.close(); }
  };
  const owns = () => { try { const value = readPrivate(file); return value?.pid === process.pid && value.token === token; } catch { return false; } };
  transact(() => {
    const previous = readPrivate(file);
    if (previous) {
      if (!Number.isSafeInteger(previous.pid) || previous.pid < 1 || typeof previous.token !== 'string') throw new Error('日报锁记录无效。');
      let alive = true;
      try { process.kill(previous.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
      if (alive) throw new Error('另一个日报服务已经运行。');
      unlinkSync(file);
    }
    writeFileSync(file, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 });
  });
  return { owns, release() { transact(() => { if (owns()) unlinkSync(file); }); } };
}

export function createQwenDailyReport(options = {}) {
  const { store, qwenClient, now = Date.now, allowedProjects = [], notify = async () => {}, intervalMs = 60000, retryMs = 300000 } = options;
  const home = options.home || process.env.AI_OFFICE_HOME || path.join(homedir(), '.ai-office');
  const configFile = path.join(home, 'qwen-daily-report-config.json'), stateFile = path.join(home, 'qwen-daily-report.json');
  let config = { enabled: false, timeZone: 'Asia/Singapore', hour: 8 }, state = null, storageError = null;
  let stopped = true, timer = null, flight = null, controller = null, lock = null, phase = 'disabled', lastCheckedAt = null, deliveryError = null;
  const explicit = options.config || Object.fromEntries(['enabled', 'timeZone', 'hour'].filter(key => Object.hasOwn(options, key)).map(key => [key, options[key]]));
  try {
    config = validConfig({ ...config, ...(readPrivate(configFile) || {}), ...explicit });
    const saved = readPrivate(stateFile);
    if (saved) state = validState(saved);
  } catch { storageError = '日报配置或存储不可读；保留原记录，等待修复。'; }
  if (!Number.isFinite(intervalMs) || intervalMs < 1 || !Number.isFinite(retryMs) || retryMs < 1) throw new Error('Invalid daily report interval.');
  const persist = () => writePrivate(stateFile, state);
  const inScope = record => { const current = projectScope(allowedProjects); return record.usedFolders.every(folder => current.has(folder)); };
  const pending = () => {
    if (!config.enabled || storageError) return [];
    try { return (state?.reports || []).filter(record => record.status === 'pending' && inScope(record)).map(publicReport); }
    catch { return []; }
  };
  const status = () => {
    const reports = state?.reports || [];
    let withheldCount = 0;
    try { withheldCount = reports.filter(record => record.status === 'withheld' || record.status === 'pending' && !inScope(record)).length; }
    catch { withheldCount = reports.filter(record => record.status === 'pending').length; }
    return { enabled: config.enabled, started: !stopped, phase: storageError ? 'unavailable' : !config.enabled ? 'disabled' : stopped ? 'stopped' : phase,
      timeZone: config.timeZone, hour: config.hour, nextDueAt: state?.nextDueAt || null, lastCheckedAt,
      pendingCount: pending().length, withheldCount, error: storageError || deliveryError || (withheldCount ? '日报项目范围已变化，暂停转交旧范围内容。' : null),
      latest: reports.length ? publicReport(reports.at(-1)) : null };
  };
  async function notifyPending() {
    const reports = pending();
    if (reports.length && !stopped) {
      try { await notify(reports); }
      catch { deliveryError = '日报已保存，等待 Grok 通知通道恢复；尚未确认转告。'; }
    }
    return status();
  }
  async function scan() {
    if (stopped || !config.enabled || storageError || !lock?.owns()) return status();
    lastCheckedAt = iso(now()); phase = 'waiting';
    if (!state) { state = { version: 1, createdAt: iso(now()), nextDueAt: iso(nextBoundary(now(), config)), reports: [] }; persist(); }
    const unfinished = state.reports.find(record => ['generating', 'retrying'].includes(record.status) || record.status === 'withheld' && inScope(record));
    let record = unfinished;
    if (!record && now() >= Date.parse(state.nextDueAt)) {
      if (state.reports.filter(item => item.status !== 'delivered').length >= MAX_PENDING) { deliveryError = '待转告日报积压，先由 Grok 转告现有报告。'; return notifyPending(); }
      const end = Date.parse(state.nextDueAt), period = { startAt: iso(end - DAY), endAt: iso(end), timeZone: config.timeZone };
      const captured = capture(store, allowedProjects, period, iso(now()));
      record = { id: `qwen-daily:${localDate(end, config.timeZone)}`, status: 'retrying', state: 'retrying', period, createdAt: iso(now()), sourceSnapshot: captured.source, usedFolders: captured.usedFolders, attempts: 0, nextAttemptAt: iso(now()) };
      state.reports.push(record); persist();
    }
    if (record && now() >= Date.parse(record.nextAttemptAt || 0)) {
      if (!inScope(record)) {
        record.status = record.state = 'withheld';
        state.nextDueAt = iso(Math.max(Date.parse(state.nextDueAt), nextBoundary(Date.parse(record.period.endAt), config)));
        persist(); deliveryError = '日报项目范围已变化，暂停生成旧范围内容；后续日期继续按当前范围汇总。';
        return notifyPending();
      }
      if (qwenClient?.runtimeState?.().busy === true) phase = 'waiting-model';
      else {
        phase = 'generating'; record.status = record.state = 'generating'; record.attempts++; record.nextAttemptAt = iso(now() + retryMs); persist();
        controller = new AbortController();
        try {
          if (typeof qwenClient?.summarizeDailyReport !== 'function') throw new Error('日报模型未连接。');
          const result = await qwenClient.summarizeDailyReport(JSON.stringify(record.sourceSnapshot), { signal: controller.signal });
          if (stopped || controller.signal.aborted) return status();
          const summary = clean(result?.summary, 3000);
          if (!summary || !Array.isArray(result?.highlights) || result.highlights.some(item => typeof item !== 'string')) throw new Error('日报生成不完整。');
          const highlights = result.highlights.map(item => clean(item, 500)).filter(Boolean).slice(0, 12);
          const facts = record.sourceSnapshot;
          const text = [`Qwen 工作日报 · ${localDate(Date.parse(record.period.endAt), config.timeZone)}`,
            `统计窗口：${new Intl.DateTimeFormat('sv-SE', { timeZone: config.timeZone, dateStyle: 'short', timeStyle: 'short' }).format(new Date(record.period.startAt))} 至 ${new Intl.DateTimeFormat('sv-SE', { timeZone: config.timeZone, dateStyle: 'short', timeStyle: 'short' }).format(new Date(record.period.endAt))}（${config.timeZone}，24 小时）`, summary,
            ...highlights.map(item => `• ${item}`), `任务板：期间完成 ${facts.counts.completed} 项，期间更新 ${facts.counts.changed} 项；资料快照时受阻 ${facts.counts.blocked} 项、待补充或批准 ${facts.counts.needsUser} 项。`,
            `覆盖说明：${facts.coverage} 范围外记录 ${facts.counts.outOfScope} 项；因篇幅省略 ${facts.counts.omitted} 条。`].join('\n\n');
          const generated = { ...record, status: 'pending', state: 'pending', generatedAt: iso(now()), model: clean(qwenClient.model || 'local-qwen', 200), source: 'local-qwen', summary, highlights, text, coverage: facts.coverage, counts: facts.counts };
          generated.reportHash = hash([generated.id, generated.period, generated.generatedAt, generated.model, text, generated.counts]);
          const next = { ...state, nextDueAt: iso(Math.max(Date.parse(state.nextDueAt), nextBoundary(Date.parse(record.period.endAt), config))), reports: state.reports.map(item => item.id === record.id ? generated : item) };
          const delivered = next.reports.filter(item => item.status === 'delivered').slice(-30);
          next.reports = next.reports.filter(item => item.status !== 'delivered' || delivered.includes(item));
          writePrivate(stateFile, next); state = next; phase = 'waiting'; deliveryError = null;
        } catch {
          if (!stopped) { record.status = record.state = 'retrying'; persist(); phase = 'retrying'; deliveryError = 'Qwen 日报尚未生成成功，保留资料稍后重试。'; }
        } finally { controller = null; }
      }
    } else if (record) phase = 'retrying';
    return notifyPending();
  }
  function tick() {
    if (!flight) flight = scan().catch(() => { phase = 'unavailable'; deliveryError = '日报来源或存储暂不可用；保留原记录，下次巡检重试。'; return status(); }).finally(() => { flight = null; });
    return flight;
  }
  function acknowledge(id, input = {}) {
    if (storageError || stopped || !config.enabled || !lock?.owns()) fail('日报服务未启用或不持有运行锁。', 503);
    const record = state?.reports.find(item => item.id === id);
    if (!record) fail('日报不存在。', 404);
    if (input.source !== 'grok-bot') fail('Only Grok Bot can acknowledge actual report delivery.');
    if (input.reportHash !== record.reportHash) fail('Report binding does not match.', 409);
    if (!idText(input.messageId)) fail('A real delivered Bot message ID is required.');
    if (!['pending', 'delivered'].includes(record.status)) fail('日报尚未生成完成。', 409);
    if (!inScope(record)) fail('日报范围已变化，不能确认旧范围转告。', 409);
    if (record.status === 'delivered') {
      if (record.delivery?.messageId !== input.messageId) fail('该日报已绑定另一个送达消息。', 409);
      return publicReport(record);
    }
    if (state.reports.some(item => item.id !== id && item.delivery?.messageId === input.messageId)) fail('送达消息已用于另一份日报。', 409);
    const updated = { ...record, status: 'delivered', state: 'delivered', delivery: { source: 'grok-bot', messageId: input.messageId, deliveredAt: iso(now()) } };
    const next = { ...state, reports: state.reports.map(item => item.id === id ? updated : item) };
    writePrivate(stateFile, next); state = next; deliveryError = null;
    return publicReport(updated);
  }
  return { status, pending, acknowledge, tick,
    start() {
      if (!stopped) return tick();
      if (config.enabled && !storageError) {
        try {
          lock = reportLock(home);
          const saved = readPrivate(stateFile);
          state = saved ? validState(saved) : null;
          if (Object.keys(explicit).length) writePrivate(configFile, config);
        } catch {
          lock?.release(); lock = null; phase = 'unavailable';
          deliveryError = '日报运行锁或存储不可用；已有服务保持运行，本实例不生成或转告。';
          return Promise.resolve(status());
        }
      }
      stopped = false;
      if (config.enabled && !storageError) { timer = setInterval(() => { void tick(); }, intervalMs); timer.unref?.(); }
      return tick();
    },
    async stop() { stopped = true; clearInterval(timer); timer = null; controller?.abort(); await flight; lock?.release(); lock = null; phase = 'stopped'; },
  };
}
