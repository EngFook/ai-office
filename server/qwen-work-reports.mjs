import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { localQwen, LOCAL_QWEN_MODEL } from './local-qwen.mjs';
import { isConfirmedExecution } from '../src/claude-execution.js';
import { readQwenPrerequisites } from './qwen-prerequisites.mjs';

export const WORK_REPORT_INTERVAL_MS = 5 * 60 * 1000;
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
// A model failure must not hide completed work. This fallback only selects
// exact source text; it does not invent an analysis or claim a Qwen inference.
function sourceFallback(tasks) {
  return { entries: tasks.map(task => {
    const source = workReportSource(task);
    return { id: task.id, quote: source.excerpts.find(text => text.trim()) || '', files: source.files };
  }) };
}
const iso = now => new Date(now()).toISOString();
const LOG_LIMIT = 160, LOG_SOURCE_BYTES = 16000;
const LOG_TYPES = new Set(['task_started', 'task_done', 'task_blocked', 'session_started', 'turn_started', 'turn_completed', 'turn_failed', 'tool_started', 'tool_completed']);
const LOG_PROVIDERS = new Set([...WORK_REPORT_PROVIDERS, 'grok']);
const atom = value => typeof value === 'string' && /^[\w.:/@+ -]{1,160}$/.test(value) ? value : null;
const stamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const list = value => Array.isArray(value) ? value : [];
const providerId = value => ({ 'Claude Code': 'claude', 'Codex': 'codex', 'Gemini': 'gemini', 'Local Qwen': 'local-qwen', 'Grok': 'grok' }[value] || value);
// Only lifecycle metadata enters this report: never prompts, arguments, output,
// chat text, arbitrary errors or credentials from reader/runner payloads.
function nativeLog(agent, provider, connected, unavailable = false) {
  const id = atom(agent?.id || agent?.agentId || agent?.sessionId);
  if (!id) return null;
  const declared = agent.executionState;
  const status = connected === false || declared === 'offline' ? 'offline'
    : unavailable || agent.observed !== true ? 'unconfirmed'
    : isConfirmedExecution(agent) ? 'working'
    : ['idle', 'waiting', 'failed', 'unconfirmed'].includes(declared) && declared === agent.status ? declared : 'unconfirmed';
  return { key: `native:${provider}:${id}`, category: 'native-state', provider, agentId: id, status,
    tool: status === 'working' ? atom(agent.tool) : null, lastTool: atom(agent.lastTool),
    outcome: ['success', 'failed', 'error', 'completed'].includes(agent.lastToolOutcome) ? agent.lastToolOutcome : null,
    isSubagent: agent.isSubagent === true, occurredAt: stamp(agent.lastEventAt || agent.updatedAt) };
}
async function readLogSource(reader) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(reader), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('source timeout')), 2500); timer.unref?.(); })]); }
  finally { clearTimeout(timer); }
}


export function validateWorkExtract(value, tasks) {
  if (!Array.isArray(value?.entries) || value.entries.length !== tasks.length) throw new Error('Incomplete work report.');
  const seen = new Set();
  return value.entries.map(entry => {
    const task = tasks.find(task => task.id === entry?.id), source = task?.result || '';
    if (!task || seen.has(entry.id) || typeof entry.quote !== 'string' || entry.quote.length > 600 || (source.trim() && !entry.quote.trim()) || !source.includes(entry.quote) || !Array.isArray(entry.files) || entry.files.length > 12) throw new Error('Work report must use exact source excerpts.');
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

export function createQwenWorkReports({ store, projectPath, qwenClient = localQwen, file = createWorkReportFile(projectPath), now = Date.now, intervalMs = WORK_REPORT_INTERVAL_MS, batchSize = 4, prerequisiteIds = readQwenPrerequisites('workReports'), runtimeReader, claudeReader, codexReader, grokReader, watchReader, huddleReader, logSummaryIntervalMs = 60000 } = {}) {
  let stopped = true, timer, pending, controller, loaded = false, cache = new Map(), nextProvider = 0;
  let state = { phase: 'stopped', generatedAt: null, lastCheckedAt: null, nextCheckAt: null, error: null, notice: null, providers: [] };
  let failureStage = 'source';
  const runnerLogs = [], readers = Object.entries({ runtime: runtimeReader, claude: claudeReader, codex: codexReader, grok: grokReader, watch: watchReader, huddle: huddleReader }).filter(([, reader]) => typeof reader === 'function');
  let logAttemptAt = -Infinity, summarizedFingerprint = null, logRevision = 0;
  state.runningLogs = [];
  state.logSummary = { phase: 'stopped', source: 'structured-facts', summary: '', highlights: [], generatedAt: null, checkedAt: null, error: null, sourceErrors: [], sourceFingerprint: null, stale: false, facts: { nativeAgents: 0, runnerJobs: 0, runnerEvents: 0, omitted: 0 } };
  function recordLog(entry) {
    if (stopped || !entry || !LOG_TYPES.has(entry.type) || !LOG_PROVIDERS.has(entry.provider)) return false;
    const taskId = atom(entry.taskId), key = atom(entry.key);
    if (!taskId || !key || runnerLogs.some(log => log.key === key)) return false;
    runnerLogs.push({ key, category: 'runner', provider: entry.provider, type: entry.type, taskId,
      workerId: atom(entry.workerId), tool: atom(entry.tool), occurredAt: stamp(entry.occurredAt) || iso(now) });
    runnerLogs.splice(0, Math.max(0, runnerLogs.length - 80)); logRevision++;
    return true;
  }
  async function collectLogs() {
    if (!readers.length && !runnerLogs.length) return;
    const values = await Promise.allSettled(readers.map(([, reader]) => readLogSource(reader)));
    if (stopped) return;
    const errors = [], current = [], facts = { nativeAgents: 0, runnerJobs: 0, runnerEvents: runnerLogs.length, omitted: 0 };
    for (let index = 0; index < readers.length; index++) {
      const name = readers[index][0], result = values[index];
      if (result.status === 'rejected' || !result.value || typeof result.value !== 'object') { errors.push(name); continue; }
      const value = result.value;
      if (value.error || value.metadataAvailable === false || value.sourceErrors?.length) errors.push(name);
      if (['claude', 'codex', 'grok'].includes(name)) {
        const agents = list(value.agents); facts.nativeAgents += agents.length;
        if (Number.isSafeInteger(value.omittedOfflineCount) && value.omittedOfflineCount > 0) {
          facts.omitted += value.omittedOfflineCount;
          facts.archivedOfflineOmitted = (facts.archivedOfflineOmitted || 0) + value.omittedOfflineCount;
        }
        for (const agent of agents.slice(0, 300)) { const row = nativeLog(agent, name, value.connected, Boolean(value.error || value.metadataAvailable === false)); if (row) current.push(row); }
        facts.omitted += Math.max(0, agents.length - 300);
      } else if (name === 'runtime') {
        const jobs = value.started === true ? list(value.running).filter(job => job.finished !== true) : []; facts.runnerJobs = jobs.length;
        for (const job of jobs.slice(0, 80)) {
          const taskId = atom(job.taskId), provider = providerId(job.provider);
          if (taskId && LOG_PROVIDERS.has(provider)) current.push({ key: `job:${taskId}`, category: 'runner-state', provider, taskId, status: 'working', workerId: atom(job.workerId), occurredAt: stamp(job.startedAt) });
        }
        facts.omitted += Math.max(0, jobs.length - 80);
      } else if (name === 'watch') facts.watch = { started: value.started === true, issues: list(value.issues).length };
      else if (name === 'huddle') facts.huddle = { started: value.started === true, blocked: Number.isSafeInteger(value.blockedCount) ? value.blockedCount : null, actions: list(value.decisions).map(item => atom(item.action)).filter(Boolean).sort() };
    }
    current.sort((a, b) => a.key.localeCompare(b.key));
    const rows = [...runnerLogs, ...current].slice(-LOG_LIMIT);
    facts.omitted += Math.max(0, runnerLogs.length + current.length - rows.length);
    // Native heartbeats can refresh timestamps without changing any work.
    const sourceFingerprint = hash([runnerLogs, current.map(row => row.category === 'native-state' ? { ...row, occurredAt: null } : row), facts, errors]);
    state.runningLogs = rows;
    state.logSummary = { ...state.logSummary, checkedAt: iso(now), sourceErrors: errors, sourceFingerprint, facts,
      stale: summarizedFingerprint !== null && summarizedFingerprint !== sourceFingerprint,
      phase: errors.length || state.logSummary.error ? 'unavailable' : 'watching' };
    const meaningful = runnerLogs.length > 0 || current.some(row => ['working', 'waiting', 'failed'].includes(row.status)) || (summarizedFingerprint !== null && state.logSummary.stale);
    const busy = qwenClient.runtimeState?.().busy === true;
    if (!meaningful || busy || typeof qwenClient.summarizeRunningLogs !== 'function' || sourceFingerprint === summarizedFingerprint || now() - logAttemptAt < Math.max(60000, logSummaryIntervalMs)) return;
    const source = { facts, sourceErrors: errors, records: [], omittedFromPrompt: 0 };
    // Recent runner events first, then current native/runner state. Account for
    // every omitted row; UTF-8 budget also bounds multilingual model input.
    const sourceRows = [...runnerLogs].reverse().concat(current);
    for (const row of sourceRows) {
      source.records.push(row);
      if (Buffer.byteLength(JSON.stringify(source), 'utf8') > LOG_SOURCE_BYTES) { source.records.pop(); source.omittedFromPrompt++; }
    }
    while (source.records.length && Buffer.byteLength(JSON.stringify(source), 'utf8') > LOG_SOURCE_BYTES) { source.records.pop(); source.omittedFromPrompt++; }
    logAttemptAt = now(); const revision = logRevision;
    state.logSummary.phase = 'summarizing'; controller = new AbortController();
    try {
      const result = await qwenClient.summarizeRunningLogs(JSON.stringify(source), { signal: controller.signal });
      if (stopped || controller.signal.aborted) return;
      if (typeof result?.summary !== 'string' || !result.summary.trim() || !Array.isArray(result.highlights)) throw new Error('Incomplete log summary');
      summarizedFingerprint = sourceFingerprint;
      state.logSummary = { ...state.logSummary, source: 'local-qwen', summary: result.summary.slice(0, 1200), highlights: result.highlights.filter(item => typeof item === 'string').slice(0, 16).map(item => item.slice(0, 400)), generatedAt: iso(now), error: null,
        phase: errors.length ? 'unavailable' : 'watching', stale: revision !== logRevision };
    } catch {
      if (!stopped) state.logSummary = { ...state.logSummary, phase: 'unavailable', error: '本地运行摘要暂不可用；保留真实状态记录，稍后重试。' };
    } finally { controller = null; }
  }
  const status = () => {
    const tasks = state.providers.flatMap(provider => provider.tasks);
    const extractedTasks = tasks.filter(task => task.extracted).length;
    const sourceFallbackTasks = tasks.filter(task => task.extracted && task.extractionSource === 'source-fallback').length;
    return structuredClone({ ...state, started: !stopped, noQuota: true, model: qwenClient.model || LOCAL_QWEN_MODEL, intervalMs,
      counts: { totalLogs: state.runningLogs.length, totalTasks: tasks.length, extractedTasks, pendingTasks: tasks.length - extractedTasks, sourceFallbackTasks } });
  };
  function facts() {
    const board = store.snapshot({ recoverLeases: false });
    const ready = prerequisiteIds.every(id => board.tasks.some(task => task.id === id && task.status === 'done'));
    const tasks = board.tasks.filter(task => task.status === 'done' && WORK_REPORT_PROVIDERS.includes(providerOf(task))).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || a.id.localeCompare(b.id));
    return { ready, tasks };
  }
  function render(tasks) {
    state.providers = WORK_REPORT_PROVIDERS.map(provider => ({ provider, tasks: tasks.filter(task => providerOf(task) === provider).map(task => {
      const saved = cache.get(task.id), valid = saved?.fingerprint === fingerprint(task);
      return { id: task.id, title: task.title, completedAt: task.updatedAt, kind: task.kind || 'task', completionSource: task.completionSource || 'unknown',
        sourceResult: task.result || '', sourceTruncated: (task.result || '').length > workReportSource(task).excerpts.join('').length, extracted: valid, extractionSource: valid ? saved.extractionSource === 'source-fallback' ? 'source-fallback' : 'qwen' : null, quote: valid ? saved.quote : '', files: valid ? saved.files : [] };
    }) }));
    const fallbackCount = state.providers.flatMap(provider => provider.tasks).filter(task => task.extractionSource === 'source-fallback').length;
    state.notice = fallbackCount ? `${fallbackCount} 张卡使用系统原文摘录；本地模型未给出可验证的选择，摘录不代表 Qwen 分析或独立核验。` : null;
  }
  async function scan() {
    failureStage = 'source';
    if (state.phase === 'stopped') state.phase = 'collecting';
    try { await collectLogs(); } catch { state.logSummary = { ...state.logSummary, phase: 'unavailable', error: '运行状态记录暂不可用；已完成卡片报告不受影响。' }; }
    if (stopped) return status();
    let current = facts(); state.lastCheckedAt = iso(now); state.error = null;
    if (!current.ready) { state.phase = 'waiting'; state.providers = []; return status(); }
    if (!loaded) {
      failureStage = 'cache-read';
      const saved = await file.read();
      if (saved) { cache = new Map(saved.entries.map(entry => [entry.id, entry])); state.generatedAt = saved.generatedAt || null; }
      loaded = true;
      failureStage = 'source';
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
        let entries, extractionSource = 'qwen';
        try {
          const output = await qwenClient.extractWorkReport(JSON.stringify(batch.map(workReportSource)), { signal: controller.signal });
          entries = validateWorkExtract(selectedExtract(output, batch), batch);
        } catch (error) {
          if (stopped || controller.signal.aborted) throw error;
          extractionSource = 'source-fallback';
          entries = validateWorkExtract(sourceFallback(batch), batch);
        }
        entries = entries.map(entry => ({ ...entry, extractionSource }));
        if (stopped) return status();
        current = facts();
        if (!current.ready) { state.phase = 'waiting'; state.providers = []; return status(); }
        const next = new Map(cache);
        for (const entry of entries) if (current.tasks.some(task => task.id === entry.id && fingerprint(task) === entry.fingerprint)) next.set(entry.id, entry);
        // Do not publish extracts for tasks changed, retried or removed during inference.
        for (const [id, entry] of next) if (!current.tasks.some(task => task.id === id && fingerprint(task) === entry.fingerprint)) next.delete(id);
        const generatedAt = iso(now);
        if (stopped) return status();
        failureStage = 'cache-write';
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
    if (!pending) pending = scan().catch(() => {
      if (stopped) return status();
      state.phase = 'unavailable';
      state.error = failureStage === 'cache-read' ? '无法读取报告缓存；保留原文件，下次重试。'
        : failureStage === 'cache-write' ? '无法保存新摘录；保留已验证报告，下次重试。'
        : '任务记录暂不可用；保留已验证报告，下次重试。';
      return status();
    }).finally(() => { pending = null; });
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
  return { status, tick, recordLog,
    start() {
      if (!stopped) return tick(); stopped = false;
      return tick().finally(schedule);
    },
    async stop() { stopped = true; clearTimeout(timer); controller?.abort(); await pending; state.phase = 'stopped'; state.logSummary.phase = 'stopped'; state.nextCheckAt = null; },
  };
}
