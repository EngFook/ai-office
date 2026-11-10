import { sanitizeUsage, usageFact } from './qwen-usage-watch.mjs';
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

const LIMIT = 200;
const queues = new Map();
const providers = new Set(['any', 'claude', 'codex', 'gemini', 'grok', 'grok-bot', 'local-qwen', 'unknown']);
const phases = new Set(['stopped', 'waiting', 'checking', 'healthy', 'attention', 'unavailable']);
const counts = ['total', 'pending', 'running', 'done', 'blocked', 'failed', 'unknown'];
const details = Object.freeze({
  pending: '任务等待领取。', running: '任务已开始运行。', done: '任务已完成。',
  blocked: '任务受阻；请按任务 ID 查看原卡。', failed: '任务失败；请按任务 ID 查看原卡。',
  stale: '任务长时间没有进度更新。', 'runner-missing': '此前观测到的执行器已消失，需核对。',
  quota: '模型额度达到提醒线；请查看用量状态。',
  'usage-rise': '用量明显上升；请核对数值和观测间隔。',
  'usage-unavailable': '用量统计不可用；无法确认实际消耗。',
  'quota-exhausted': '额度已用完；仅通知 Grok，不自动重置或购买额度。',
  'quota-reset': '已观测到额度重置时间；请按该时间向用户报告。',
  'quota-reset-due': '预定重置时间已到，等待新观测；不能据此确认额度已恢复。',
  'quota-refreshed': '观测到用量下降或额度窗口变化；请核对最新数值。',
  'quota-unavailable': '模型额度状态暂不可用；请核对用量来源。',
  unknown: '收到未识别的结构化状态提醒；请核对办公室状态。',
});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = (value, max = 240) => typeof value === 'string' && value.length > 0 && value.length <= max && /^[a-zA-Z0-9][a-zA-Z0-9_.:@/-]*$/.test(value) ? value : null;
const iso = value => { const ms = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN; return Number.isFinite(ms) && !Number.isNaN(new Date(ms).valueOf()) ? new Date(ms).toISOString() : null; };
const eventKey = value => typeof value === 'string' && value.trim() && value.length <= 4096 ? /^sha256:[a-f0-9]{64}$/.test(value) ? value : `sha256:${createHash('sha256').update(value).digest('hex')}` : null;
function event(value, fallbackAt) {
  if (!object(value) || !eventKey(value.key) || typeof value.type !== 'string' || !value.type.trim()) return null;
  const type = Object.hasOwn(details, value.type) ? value.type : 'unknown';
  return { key: eventKey(value.key), type, taskId: identifier(value.taskId), provider: providers.has(value.provider) ? value.provider : 'unknown',
    severity: ['info', 'warning', 'error', 'critical'].includes(value.severity) ? value.severity : 'warning',
    // Never persist free-form model output, error text, titles or log snippets.
    detail: details[type], occurredAt: iso(value.occurredAt) || fallbackAt,
    ...(object(value.usage) ? { usage: usageFact(value.usage) } : {}) };
}
function progress(value) {
  if (!object(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => providers.has(key) && object(item)).map(([key, item]) => [key,
    Object.fromEntries(counts.filter(name => Number.isSafeInteger(item[name]) && item[name] >= 0).map(name => [name, item[name]])),
  ]));
}
function current(report, generatedAt) {
  const issues = Array.isArray(report.issues) ? report.issues : [];
  const issueCount = Number.isSafeInteger(report.issueCount) && report.issueCount >= issues.length ? report.issueCount : issues.length;
  return { checkedAt: iso(report.checkedAt), phase: phases.has(report.phase) ? report.phase : 'unavailable',
    issueCount, issuesTruncated: issueCount > LIMIT,
    issues: issues.slice(0, LIMIT).map(item => event(item, iso(report.checkedAt) || generatedAt)).filter(Boolean),
    progress: progress(report.progress),
    ...(object(report.usage) ? { usage: sanitizeUsage(report.usage) } : {}),
    observation: { available: object(report.observation) ? report.observation.available === true : typeof report.observation === 'string' && report.observation.trim().length > 0, verified: false },
    error: report.error ? '本地初筛暂不可用；请查看办公室状态。' : null };
}
async function checkEntry(filename, kind, missing = true) {
  try { const stat = await lstat(filename); if (stat.isSymbolicLink() || !(kind === 'directory' ? stat.isDirectory() : stat.isFile())) throw new Error('Qwen watch report path must use a regular directory and file.'); return stat; }
  catch (error) { if (missing && error.code === 'ENOENT') return null; throw error; }
}

// A single queue per destination serializes publishers, including separate
// instances in this process. Every write reloads retained history after restart.
export function createQwenWatchReport({ projectPath, now = Date.now } = {}) {
  if (typeof projectPath !== 'string' || !path.isAbsolute(projectPath)) throw new Error('Qwen watch report requires an absolute project path.');
  const directory = path.join(path.resolve(projectPath), 'reports');
  const filename = path.join(directory, 'qwen-watch.json');
  function serial(action) {
    const next = (queues.get(filename) || Promise.resolve()).catch(() => {}).then(action);
    queues.set(filename, next);
    void next.finally(() => { if (queues.get(filename) === next) queues.delete(filename); }).catch(() => {});
    return next;
  }
  async function read() {
    if (!await checkEntry(directory, 'directory')) return null;
    const stat = await checkEntry(filename, 'file'); if (!stat) return null;
    if (stat.size > 2 * 1024 * 1024) throw new Error('Qwen watch report is too large; existing history was preserved.');
    let saved;
    try { saved = JSON.parse(await readFile(filename, 'utf8')); }
    catch (error) { if (error instanceof SyntaxError) throw new Error('Qwen watch report JSON is invalid; existing history was preserved.'); throw error; }
    if (!object(saved) || saved.schemaVersion !== 1 || !iso(saved.generatedAt) || !object(saved.current) || !phases.has(saved.current.phase) || !Array.isArray(saved.current.issues) || !object(saved.current.progress) || !Array.isArray(saved.events) || saved.events.length > LIMIT || saved.events.some(item => !event(item, saved.generatedAt))) throw new Error('Qwen watch report schema is invalid; existing history was preserved.');
    return { schemaVersion: 1, generatedAt: saved.generatedAt, current: current(saved.current, saved.generatedAt), events: saved.events.map(item => event(item, saved.generatedAt)) };
  }
  return {
    read: () => serial(read),
    publish(report) {
      if (!object(report)) return Promise.reject(new Error('Qwen watch report must be an object.'));
      const generatedAt = iso(now());
      if (!generatedAt) return Promise.reject(new Error('Qwen watch report clock is invalid.'));
      // Snapshot whitelisted values now so later caller mutations cannot change a queued write.
      const nextCurrent = current(report, generatedAt);
      const incoming = (Array.isArray(report.events) ? report.events : []).slice(-LIMIT).map(item => event(item, nextCurrent.checkedAt || generatedAt)).filter(Boolean);
      return serial(async () => {
        const saved = await read();
        if (saved?.current.checkedAt && nextCurrent.checkedAt && Date.parse(nextCurrent.checkedAt) < Date.parse(saved.current.checkedAt)) return saved;
        const seen = new Set(), history = [];
        for (const item of [...(saved?.events || []), ...incoming]) if (!seen.has(item.key)) { seen.add(item.key); history.push(item); }
        const value = { schemaVersion: 1, generatedAt, current: nextCurrent, events: history.slice(-LIMIT) };
        // Parent project must exist; never create an arbitrary project tree.
        await checkEntry(path.dirname(directory), 'directory', false);
        await mkdir(directory, { recursive: false }).catch(error => { if (error.code !== 'EEXIST') throw error; });
        await checkEntry(directory, 'directory', false);
        await checkEntry(filename, 'file');
        const temporary = path.join(directory, `.qwen-watch.${process.pid}.${randomUUID()}.tmp`);
        try {
          await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
          await rename(temporary, filename);
        } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
        return value;
      });
    },
  };
}
