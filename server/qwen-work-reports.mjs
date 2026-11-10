import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { localQwen } from './local-qwen.mjs';

export const WORK_REPORT_INTERVAL_MS = 5 * 60 * 1000;
export const WORK_REPORT_PREREQUISITES = ['a46df86d-a688-4532-9d90-5170515ba0ec', '5d2382b0-871b-4521-b12a-c1938bbcea3d'];
export const WORK_REPORT_PROVIDERS = ['claude', 'codex', 'gemini', 'local-qwen'];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const providerOf = task => task.assignee?.provider || task.provider;
const fingerprint = task => hash([task.id, providerOf(task), task.title, task.result, task.updatedAt, task.completionSource]);
const changeEvidence = text => /(?:新增|修改|改动|更新|修复|删除|添加|创建|\b(?:changed|modified|added|updated|removed|deleted|created)\b)/i.test(text) && !/(?:未|没有|不改|不动|审查|复审|备份|部署|参考|引用|查阅|查看|对照|计划|建议|可能|准备|待修改|待新增|\b(?:review|unchanged|backup|deploy|read|inspect|context|reference|plan|suggest|should|would|will|propos)|did not|no change)/i.test(text);
export function workReportSource(task) {
  let text = (task.result || '').slice(0, 6000), value;
  do {
    const excerpts = text.match(/[\s\S]{1,500}/g) || [''];
    const files = [];
    const addFiles = evidence => {
      if (evidence.length > 400 || !changeEvidence(evidence)) return;
      for (const match of evidence.matchAll(/(?:`([^`\n]+\.[a-zA-Z][\w-]{0,15})`|((?:[~./]|\b)[\w@./-]+\.[a-zA-Z][\w-]{0,15}))/g)) {
        const filename = match[1] || match[2];
        if (!files.some(file => file.path === filename) && filename.length <= 240) files.push({ path: filename, evidence });
      }
    };
    let section = '';
    for (const line of text.split('\n')) {
      if (/^\s*(?:#{1,6}\s*)?(?:新增|修改|改动|更新|删除|添加|创建|Changed|Modified|Added|Updated|Removed|Deleted|Created)\s*(?:的?文件|files)\s*[:：]\s*$/i.test(line)) { section = line; continue; }
      if (section && /^\s*[-*]\s+/.test(line)) {
        section += '\n' + line;
        addFiles(section);
      } else section = '';
      for (const clause of line.split(/[。！？，；;]/)) addFiles(clause);
    }
    value = { id: task.id, excerpts, files: files.slice(0, 12) };
    if (JSON.stringify(value).length <= 6500) return value;
    text = text.slice(0, Math.floor(text.length * 0.8));
  } while (text.length);
  return { id: task.id, excerpts: [''], files: [] };
}
function selectedExtract(value, tasks) {
  if (!Array.isArray(value?.entries) || value.entries.length !== tasks.length) throw new Error('Incomplete work report selection.');
  return { entries: value.entries.map(entry => {
    const task = tasks.find(task => task.id === entry?.id);
    if (!task) throw new Error('Unknown work report task.');
    const source = workReportSource(task);
    if (!Number.isSafeInteger(entry.quoteIndex) || entry.quoteIndex < 0 || entry.quoteIndex >= source.excerpts.length || !Array.isArray(entry.fileIndices) || entry.fileIndices.some(index => !Number.isSafeInteger(index) || index < 0 || index >= source.files.length)) throw new Error('Invalid work report selection.');
    return { id: task.id, quote: source.excerpts[entry.quoteIndex], files: [...new Set(entry.fileIndices)].map(index => source.files[index]) };
  }) };
}
const iso = now => new Date(now()).toISOString();

export function validateWorkExtract(value, tasks) {
  if (!Array.isArray(value?.entries) || value.entries.length !== tasks.length) throw new Error('Incomplete work report.');
  const seen = new Set();
  return value.entries.map(entry => {
    const task = tasks.find(task => task.id === entry?.id), source = task?.result || '';
    if (!task || seen.has(entry.id) || typeof entry.quote !== 'string' || entry.quote.length > 600 || (source && !entry.quote.trim()) || !source.includes(entry.quote) || !Array.isArray(entry.files) || entry.files.length > 12) throw new Error('Work report must use exact source excerpts.');
    seen.add(entry.id);
    const files = entry.files.map(file => {
      if (typeof file?.path !== 'string' || file.path.length > 240 || /[\x00-\x1f<>]/.test(file.path) || !/\.[a-zA-Z][\w-]{0,15}$/.test(file.path) || typeof file.evidence !== 'string' || file.evidence.length > 400 || !file.evidence.includes(file.path) || !source.includes(file.evidence) || !changeEvidence(file.evidence) || !workReportSource(task).files.some(candidate => candidate.path === file.path && candidate.evidence === file.evidence)) throw new Error('File evidence must be an exact source excerpt.');
      return { path: file.path, evidence: file.evidence };
    });
    return { id: task.id, fingerprint: fingerprint(task), quote: entry.quote, files };
  });
}

// Local runtime cache. Refuse nonregular entries and preserve invalid history.
export function createWorkReportFile(projectPath) {
  if (!path.isAbsolute(projectPath)) throw new Error('Work reports require an absolute project path.');
  const directory = path.join(projectPath, 'reports'), filename = path.join(directory, 'qwen-work-reports.json');
  async function regular(name, directory = false) {
    try { const stat = await lstat(name); if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile())) throw new Error('Invalid work report path.'); return stat; }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  return {
    async read() {
      if (!await regular(directory, true)) return null;
      const stat = await regular(filename); if (!stat) return null;
      if (stat.size > 16 * 1024 * 1024) throw new Error('Work report cache too large.');
      const data = JSON.parse(await readFile(filename, 'utf8'));
      if (data.schemaVersion !== 1 || !Array.isArray(data.entries) || data.entries.some(entry => typeof entry.id !== 'string' || typeof entry.fingerprint !== 'string' || typeof entry.quote !== 'string' || !Array.isArray(entry.files))) throw new Error('Invalid work report cache.');
      return data;
    },
    async write(data) {
      await regular(projectPath, true).then(stat => { if (!stat) throw new Error('Project missing.'); });
      await mkdir(directory).catch(error => { if (error.code !== 'EEXIST') throw error; });
      await regular(directory, true); await regular(filename);
      const temp = path.join(directory, `.qwen-work-reports.${randomUUID()}.tmp`);
      try { await writeFile(temp, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); await rename(temp, filename); }
      finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    },
  };
}

export function createQwenWorkReports({ store, projectPath, qwenClient = localQwen, file = createWorkReportFile(projectPath), now = Date.now, intervalMs = WORK_REPORT_INTERVAL_MS, batchSize = 4 } = {}) {
  let stopped = true, timer, pending, controller, loaded = false, cache = new Map(), nextProvider = 0;
  let state = { phase: 'stopped', generatedAt: null, lastCheckedAt: null, nextCheckAt: null, error: null, providers: [] };
  const status = () => structuredClone({ ...state, noQuota: true, model: 'qwen3:14b', intervalMs });
  function facts() {
    const board = store.snapshot({ recoverLeases: false });
    const ready = WORK_REPORT_PREREQUISITES.every(id => board.tasks.some(task => task.id === id && task.status === 'done'));
    const tasks = board.tasks.filter(task => task.status === 'done' && WORK_REPORT_PROVIDERS.includes(providerOf(task))).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || a.id.localeCompare(b.id));
    return { ready, tasks };
  }
  function render(tasks) {
    state.providers = WORK_REPORT_PROVIDERS.map(provider => ({ provider, tasks: tasks.filter(task => providerOf(task) === provider).map(task => {
      const saved = cache.get(task.id), valid = saved?.fingerprint === fingerprint(task);
      return { id: task.id, title: task.title, completedAt: task.updatedAt, kind: task.kind || 'task', completionSource: task.completionSource || 'unknown',
        sourceResult: task.result || '', sourceTruncated: (task.result || '').length > workReportSource(task).excerpts.join('').length, extracted: valid, quote: valid ? saved.quote : '', files: valid ? saved.files : [] };
    }) }));
  }
  async function scan() {
    let current = facts(); state.lastCheckedAt = iso(now); state.error = null;
    if (!current.ready) { state.phase = 'waiting'; state.providers = []; return status(); }
    if (!loaded) {
      const saved = await file.read();
      if (saved) { cache = new Map(saved.entries.map(entry => [entry.id, entry])); state.generatedAt = saved.generatedAt || null; }
      loaded = true;
    }
    if (stopped) return status();
    // Revalidate persisted extracts against the current board; never trust generated prose.
    for (const [id, entry] of cache) {
      const task = current.tasks.find(task => task.id === id);
      try { if (!task || entry.fingerprint !== fingerprint(task)) throw new Error(); validateWorkExtract({ entries: [entry] }, [task]); }
      catch { cache.delete(id); }
    }
    render(current.tasks);
    const waiting = current.tasks.filter(task => !cache.has(task.id));
    // Round robin across providers so initial backfill covers all four AIs.
    const order = [...WORK_REPORT_PROVIDERS.slice(nextProvider), ...WORK_REPORT_PROVIDERS.slice(0, nextProvider)];
    nextProvider = (nextProvider + 1) % WORK_REPORT_PROVIDERS.length;
    const queues = order.map(provider => waiting.filter(task => providerOf(task) === provider));
    const batch = [];
    while (batch.length < batchSize && queues.some(queue => queue.length)) for (const queue of queues) {
      if (!queue.length || batch.length >= batchSize) continue;
      const task = queue.shift();
      const candidate = [...batch, task].map(workReportSource);
      if (JSON.stringify(candidate).length <= 7000) batch.push(task);
    }
    if (stopped) return status();
    if (batch.length) {
      state.phase = 'generating'; controller = new AbortController();
      try {
        const output = await qwenClient.extractWorkReport(JSON.stringify(batch.map(workReportSource)), { signal: controller.signal });
        const entries = validateWorkExtract(selectedExtract(output, batch), batch);
        if (stopped) return status();
        current = facts();
        if (!current.ready) { state.phase = 'waiting'; state.providers = []; return status(); }
        const next = new Map(cache);
        for (const entry of entries) if (current.tasks.some(task => task.id === entry.id && fingerprint(task) === entry.fingerprint)) next.set(entry.id, entry);
        // Do not publish extracts for tasks changed, retried or removed during inference.
        for (const [id, entry] of next) if (!current.tasks.some(task => task.id === id && fingerprint(task) === entry.fingerprint)) next.delete(id);
        const generatedAt = iso(now);
        if (stopped) return status();
        await file.write({ schemaVersion: 1, generatedAt, entries: [...next.values()] });
        cache = next; state.generatedAt = generatedAt;
      } finally { controller = null; }
    }
    render(current.tasks);
    state.phase = current.tasks.some(task => !cache.has(task.id)) ? 'backfill' : 'ready';
    return status();
  }
  function tick() {
    if (stopped) return Promise.resolve(status());
    if (!pending) pending = scan().catch(() => { state.phase = 'unavailable'; state.error = '本地 Qwen 忙碌、不可用或摘录校验/保存失败；保留已验证报告，下次重试。'; return status(); }).finally(() => { pending = null; });
    return pending;
  }
  function schedule() {
    if (stopped) return;
    // The watcher and report writer share a single Ollama slot. Offset retries
    // after contention instead of colliding with the watcher's five-minute timer forever.
    const delay = state.phase === 'unavailable' ? Math.min(intervalMs, 30000) : intervalMs;
    state.nextCheckAt = new Date(now() + delay).toISOString();
    timer = setTimeout(() => { state.nextCheckAt = null; void tick().finally(schedule); }, delay); timer.unref?.();
  }
  return { status, tick,
    start() {
      if (!stopped) return tick(); stopped = false;
      return tick().finally(schedule);
    },
    async stop() { stopped = true; clearTimeout(timer); controller?.abort(); await pending; state.phase = 'stopped'; state.nextCheckAt = null; },
  };
}
