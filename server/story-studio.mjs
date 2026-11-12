import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { lstatSync, mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, unlinkSync, realpathSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { homedir } from 'node:os';
import path from 'node:path';
import { readStoryStudioConfig, validateStoryStudioConfig } from './story-studio-config.mjs';
import { resolutionPaused } from './resolution-policy.mjs';
import { humanRequestHold } from './human-relay-policy.mjs';
import { quotaFresh, validQuotaUsed } from '../src/usage-utils.js';

const DAY = 86400000, COOLDOWN = 15 * 60000, POLL = 30000;
const SOURCE_FILES = ['agent-tools/story-bible-2099.md', 'agent-tools/tuijie-story-reconstruction-2026-11-12.md', 'lib/core/services/story_adventure_catalog.dart'];
const FOCUS = ['热血：行动与代价', '团队牺牲：每个人的选择', '悬疑：可核对的线索', '证据反转：改变解释但不改事实', '敌我困境：冲突双方的理由', '伏笔回收：局部兑现与新问题'];
const STAGES = ['research', 'draft', 'review', 'revise', 'complete'];
const NAMES = { research: 'Gemini：资料研究与原创选题', draft: 'Qwen：撰写候选场景', review: 'Gemini：剧情编辑评议', revise: 'Qwen：按具体意见修订', complete: '候选稿已保存，等待下一轮' };
const iso = value => new Date(value).toISOString();
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const stamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const bytes = value => Buffer.byteLength(value, 'utf8');
const clean = (value, max = 1500) => String(value || '').replace(/\b(?:sk-|xai-|crsr_|ghp_|github_pat_)[a-zA-Z0-9_-]{12,}/g, '[REDACTED]').replace(/\b(Bearer|Basic)\s+[^\s"'`,;]+/gi, '$1 [REDACTED]').replace(/((?:password|token|secret|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]').slice(0, max);
const fail = message => { throw new Error(message); };
function privateRead(file) {
  try { const stat = lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) fail('Invalid story state'); return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function directory(folder) {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  if (!lstatSync(folder).isDirectory() || lstatSync(folder).isSymbolicLink()) fail('Story output directory is unavailable');
}
function privateWrite(file, value) {
  directory(path.dirname(file)); const temp = `${file}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); renameSync(temp, file); chmodSync(file, 0o600); }
  finally { try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
function lockStudio(home) {
  directory(home); const lockFile = path.join(home, 'story-studio.lock'), dbFile = path.join(home, 'story-studio-lock.sqlite'), token = randomUUID();
  try { const stat = lstatSync(dbFile); if (!stat.isFile() || stat.isSymbolicLink()) fail('Invalid lock'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const transact = callback => { const db = new DatabaseSync(dbFile); try { chmodSync(dbFile, 0o600); db.exec('PRAGMA busy_timeout=3000; BEGIN IMMEDIATE'); try { const value = callback(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } } finally { db.close(); } };
  const owns = () => { try { const value = privateRead(lockFile); return value?.pid === process.pid && value.token === token; } catch { return false; } };
  transact(() => {
    const previous = privateRead(lockFile);
    if (previous) {
      if (!Number.isInteger(previous.pid) || previous.pid < 1 || typeof previous.token !== 'string') fail('Invalid lock');
      let alive = true; try { process.kill(previous.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
      if (alive) fail('Another story studio is running'); unlinkSync(lockFile);
    }
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 });
  });
  return { owns, release() { transact(() => { if (owns()) unlinkSync(lockFile); }); } };
}
function validState(value) {
  if (!value || value.version !== 1 || !stamp(value.nextCycleAt) || !Array.isArray(value.geminiRequests) || value.geminiRequests.length > 100 || value.geminiRequests.some(at => !stamp(at))) fail('Invalid story state');
  const cycle = value.cycle;
  if (cycle && (!/^[a-f0-9-]{36}$/.test(cycle.id) || !STAGES.includes(cycle.stage) || !stamp(cycle.createdAt) || !Array.isArray(cycle.sourceManifest) || typeof cycle.canon !== 'string' || bytes(cycle.canon) > 8000 || !cycle.attempts || typeof cycle.attempts !== 'object' || !cycle.tasks || typeof cycle.tasks !== 'object')) fail('Invalid story cycle');
  return value;
}
function captureSources(root) {
  const canonicalRoot = realpathSync(root), sources = [], chunks = [];
  for (const relative of SOURCE_FILES) {
    const file = path.join(root, relative), resolved = realpathSync(file), stat = lstatSync(file);
    if (!resolved.startsWith(`${canonicalRoot}${path.sep}`) || stat.isSymbolicLink() || !stat.isFile() || stat.size > 512000) fail('剧情正典来源缺失、过大或不在配置项目内。');
    const content = readFileSync(file, 'utf8'); sources.push({ path: file, relative, sha256: hash(content), bytes: bytes(content) }); chunks.push(content);
  }
  const version = /tuijieStoryContentVersion\s*=\s*['"](tuijie\.main\.(\d+))['"]/.exec(chunks[2]);
  if (!version || Number(version[2]) < 6 || !chunks[1].includes('tuijie.main.6')) fail('剧情来源不是已核对的 main.6 或后续版本；请核对 sourceRoot。');
  const patterns = [/^2099年12月1日凌晨/, /^1\. 我是谁/, /^2\. 为什么只有/, /^3\. 那颗陨石/, /^3\. 两者合起来/, /^4\. \*\*WORLD INTEGRITY/, /^   - 锚石能/, /^   - 主角的“补全”/, /^EVE 是救援终端/, /^不列入层级：EVE/, /^- \*\*主角（你）/, /^- \*\*术语\*\*/, /^  - 后期揭示：/, /^- \*\*必须保持不变/];
  const selected = chunks[0].split(/\r?\n/).filter(line => patterns.some(pattern => pattern.test(line)));
  if (selected.length < 7) fail('世界设定格式已改变，不能猜测正典约束。');
  const chapters = chunks[1].split(/\r?\n/).filter(line => /^## [123]\.[1-6][\s　]/.test(line));
  const ending = /## 3\.6[\s\S]*?### 收束\s*([\s\S]*?)(?:\n---|$)/.exec(chunks[1])?.[1]?.trim();
  if (chapters.length !== 18 || !ending) fail('当前剧情章节或第三章收束缺失，不能猜测续写起点。');
  const canon = `版本：${version[1]}。以下为世界圣经的逐字约束摘录；不是完整正典。仅写可供用户选择的新候选场景，不能把新设定当作已有事实。不得改变旧故事/节点ID、谜题答案、难度、奖励或招募关系；未定的身世、倒数归零及终局只能提出备选，不擅自定案。\n\n${selected.join('\n\n')}\n\n当前十八节目录（逐字摘录）：\n${chapters.join('\n')}\n\n第三章3.6收束（逐字摘录）：\n${ending}`;
  if (bytes(canon) > 8000) fail('世界约束超过本地写作预算，请拆分资料，不能静默截断。');
  return { sourceManifest: sources, sourceHash: hash(sources), canon, contentVersion: version[1] };
}
function publicUrl(raw) {
  let url; try { url = new URL(raw); } catch { fail('研究来源 URL 无效。'); }
  if (url.protocol !== 'https:' || url.username || url.password || isIP(url.hostname.replace(/^\[|\]$/g, '')) || !url.hostname.includes('.') || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(url.hostname) || raw.length > 2000) fail('研究来源必须是公开 HTTPS 页面。');
  return url;
}
const publicAddress = address => {
  if (isIP(address) === 4) { const [a, b] = address.split('.').map(Number); return !(a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127 || a >= 224); }
  return isIP(address) === 6 && !/^::|^f[cd]|^fe[89ab]|^2001:db8/i.test(address);
};
async function verifyPublicSource(raw, { signal } = {}) {
  let url = publicUrl(raw);
  const request = async (url, method, addresses) => new Promise((resolve, reject) => {
    const req = httpsRequest(url, { method, signal, timeout: 8000, lookup: (_name, options, callback) => {
      callback(null, options?.all ? addresses : addresses[0].address, addresses[0].family);
    } }, response => { resolve({ status: response.statusCode, location: response.headers.location }); response.destroy(); });
    req.once('timeout', () => req.destroy(new Error('公开来源验证超时。'))); req.once('error', reject); req.end();
  });
  for (let redirect = 0; redirect < 3; redirect++) {
    let timeout;
    const addresses = await Promise.race([lookup(url.hostname, { all: true }), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('公开来源 DNS 验证超时。')), 8000); })]).finally(() => clearTimeout(timeout));
    signal?.throwIfAborted();
    if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) fail('研究来源解析到非公开地址。');
    let response = await request(url, 'HEAD', addresses);
    if ([403, 405].includes(response.status)) response = await request(url, 'GET', addresses);
    if (response.status >= 300 && response.status < 400 && response.location) { url = publicUrl(new URL(response.location, url).href); continue; }
    return response.status >= 200 && response.status < 300;
  }
  return false;
}
function taskResult(task) {
  const prefix = /^Research note: ([^\n]+)\n\n/.exec(task.result || '');
  if (!prefix) return task.result;
  const root = realpathSync(task.projectPath), file = prefix[1], target = realpathSync(file), stat = lstatSync(file);
  const suffix = `-${hash(String(task.id)).slice(0, 16)}.md`;
  if (!path.isAbsolute(file) || path.dirname(target) !== root || stat.isSymbolicLink() || !stat.isFile() || stat.size > 64000 || !path.basename(file).endsWith(suffix)) fail('研究产物路径或任务绑定无效。');
  const text = readFileSync(file, 'utf8'), header = new RegExp(`^# [^\\n]+\\n\\n_Gemini research · task ${task.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} · [^\\n]+_\\n\\n`);
  if (!header.test(text)) fail('研究笔记不属于当前剧情任务。');
  return text.replace(header, '').trim();
}

function parseObject(raw) {
  if (typeof raw !== 'string' || bytes(raw) > 50000) fail('Gemini 未返回完整可核对的结构化产物。');
  const text = raw.replace(/^Research note: [^\n]+\n\n/, '').trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(text);
  let value; try { value = JSON.parse(fenced ? fenced[1] : text); } catch { fail('Gemini 结果不是完整 JSON；保留原卡，不能据此推进写作。'); }
  if (!value || Array.isArray(value) || typeof value !== 'object') fail('Gemini 尚未完成可验证的研究或审稿。');
  if (value.blocked === true) fail(`Gemini 本轮尚未完成：${clean(value.reason, 600) || '缺少可验证研究或审稿产物'}。`);
  return value;
}
function checkedString(value, max = 1500) { if (typeof value !== 'string' || !value.trim() || bytes(value) > max || /[\x00-\x08\x0b-\x1f\x7f]/.test(value)) fail('结构化产物有空白或超预算字段。'); return value.trim(); }
function researchResult(raw, now) {
  const value = parseObject(raw);
  if (!Array.isArray(value.sources) || value.sources.length < 1 || value.sources.length > 6 || !Array.isArray(value.ideas) || value.ideas.length < 1 || value.ideas.length > 3 || !Array.isArray(value.outline) || value.outline.length < 3 || value.outline.length > 8) fail('研究需公开来源、原创选题及完整场景节拍。');
  const sources = value.sources.map(source => {
    const url = publicUrl(checkedString(source.url, 2000)).href, title = checkedString(source.title, 500), accessedAt = checkedString(source.accessedAt, 10);
    if (!/^\d{4}-\d\d-\d\d$/.test(accessedAt) || !stamp(accessedAt) || iso(Date.parse(accessedAt)).slice(0, 10) !== accessedAt || Date.parse(accessedAt) > now + DAY) fail('来源访问日期无效。');
    return { url, title, accessedAt };
  });
  const ideas = value.ideas.map(item => ({ title: checkedString(item.title, 300), premise: checkedString(item.premise, 1500), technique: checkedString(item.technique, 1500) }));
  const outline = value.outline.map(item => ({ beat: checkedString(item.beat, 1000), purpose: checkedString(item.purpose, 1000) }));
  const result = { sources, ideas, outline };
  if (bytes(JSON.stringify(result)) > 12000) fail('研究产物超预算；不能截断后继续。');
  return result;
}
function reviewResult(raw) {
  const value = parseObject(raw);
  if (!['revise', 'ready'].includes(value.verdict) || !Array.isArray(value.feedback) || !value.feedback.length || value.feedback.length > 8) fail('编辑评议缺少具体反馈。');
  const feedback = value.feedback.map(item => ({ issue: checkedString(item.issue, 900), evidence: checkedString(item.evidence, 900), suggestion: checkedString(item.suggestion, 900) }));
  const result = { verdict: value.verdict, feedback };
  if (bytes(JSON.stringify(result)) > 4000) fail('审稿意见超出本地修订预算，不能静默截断。');
  return result;
}

export function createStoryStudio({ store, home = process.env.AI_OFFICE_HOME || path.join(homedir(), '.ai-office'), qwenClient,
  runtimeReader = () => ({}), quotaReader = () => null, config: configInput, configuration, now = Date.now, onTaskChange = async () => {}, verifySource = verifyPublicSource } = {}) {
  if (!store) throw new Error('Story studio requires a task store');
  const config = configInput ? validateStoryStudioConfig(configInput) : readStoryStudioConfig(home);
  const stateFile = path.join(home, 'story-studio.json'), outputRoot = path.join(home, 'creative', 'walkalone');
  let state = null, stopped = true, lock = null, timer = null, flight = null, controller = null, activeWriting = false, storageError = null, phase = 'stopped', reason = null, error = config.error || null;
  try { const saved = privateRead(stateFile); if (saved) state = validState(saved); } catch { storageError = '剧情协作记录不可读；保留原记录，未启动新任务。'; }
  const cycle = () => state?.cycle;
  const currentTaskId = () => cycle()?.tasks?.[cycle().stage === 'review' ? 'review' : 'research']?.id || null;
  const calls = () => (state?.geminiRequests || []).filter(at => now() - Date.parse(at) < DAY).length;
  const status = () => {
    const c = cycle(); let geminiBusy = false;
    try { geminiBusy = ['research', 'review'].includes(c?.stage) && (runtimeReader()?.running || []).some(job => job.taskId === currentTaskId() && job.provider === 'gemini' && !job.finished); } catch {}
    return { enabled: config.enabled, started: !stopped, phase: storageError ? 'unavailable' : !config.enabled ? 'disabled' : stopped ? 'stopped' : phase,
      currentStage: c ? NAMES[c.stage] : '等待首次剧情研究', busy: activeWriting || geminiBusy, nextCheckAt: state?.nextCheckAt || null,
      nextCycleAt: state?.nextCycleAt || null, currentTaskId: ['research', 'review'].includes(c?.stage) ? currentTaskId() : null,
      lastCompletedAt: state?.lastCompletedAt || null, lastArtifact: state?.lastArtifact || null,
      draftPreview: clean(c?.revised || c?.draft || state?.lastPreview || '', 2000), error: storageError || error, reason,
      geminiCalls24h: calls(), geminiDailyLimit: config.geminiDailyLimit, intervalMs: config.intervalMs, projectId: 'walkalone' };
  };
  function persist() { try { state.phase = phase; state.reason = reason; state.error = error; privateWrite(stateFile, state); } catch { storageError = '剧情协作存储失败；停止推进并保留已有产物。'; throw new Error(storageError); } }
  function artifact(name, text) {
    const folder = path.join(outputRoot, cycle().id);
    directory(path.join(home, 'creative')); directory(outputRoot); directory(folder);
    const file = path.join(folder, name);
    try { const stat = lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || hash(readFileSync(file, 'utf8')) !== hash(text)) fail('已有候选产物不一致，不能覆盖。'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; writeFileSync(file, text, { flag: 'wx', mode: 0o600 }); }
    return file;
  }
  function hold(message, target = 'blocked') { phase = target; reason = message; error = target === 'blocked' || target === 'unavailable' ? message : null; persist(); return status(); }
  function guard(board = store.snapshot({ recoverLeases: false })) {
    if (board.maintenance?.active || board.settings?.autoPickup === false) return '办公室维护或自动领取已暂停；剧情协作等待恢复。';
    if (configuration?.providers && ['gemini', 'local-qwen'].some(id => configuration.providers[id]?.enabled !== true)) return '剧情协作所需 Gemini 或 Qwen 已停用，等待用户恢复配置。';
    const all = [...(board.tasks || []), ...(board.deletedTasks || [])];
    for (const link of Object.values(cycle()?.tasks || {})) {
      const task = all.find(item => item.id === link.id);
      if (link.created && !task) return '用户已移除本轮剧情卡，自动协作不会重建。';
      if (task && (resolutionPaused(task) || task.status === 'deleted' || humanRequestHold(task))) return '剧情卡已暂停、删除或等待用户回应；自动协作保持原状态。';
      if (task && (hash(task.description) !== link.inputHash || task.provider !== 'gemini' || task.kind !== 'research')) return '本轮剧情卡内容已改变，保留产物等待核对。';
      if (task && link.resultHash && (task.status !== 'done' || task.completionSource !== 'agent' || hash(task.result) !== link.resultHash)) return '已使用的剧情阶段结果被改动，不能继续套用旧依据。';
    }
    return null;
  }
  function currentSources() {
    const source = captureSources(config.sourceRoot);
    if (cycle() && source.sourceHash !== cycle().sourceHash) fail('正典来源已改变，保留候选稿；需重新核对本轮依据，不能套用旧结论。');
    return source;
  }
  function readyForGemini(runtime, quota) {
    const provider = runtime.providers?.gemini;
    if (runtime.started === false || !provider?.available || !provider.authenticated || provider.modelSupported === false) return 'Gemini 未就绪或模型不可用，保留当前阶段。';
    if ((runtime.running || []).some(job => job.provider === 'gemini' && !job.finished)) return 'Gemini 正在处理其他任务，本轮等待空闲。';
    const value = quota?.gemini;
    if (quotaFresh(value, 'Gemini', now()) && Array.isArray(value?.windows) && value.windows.some(win => validQuotaUsed(win) && (win.remainingPercent === 0 || win.usedPercent >= 100))) return 'Gemini 当前额度已耗尽，等待真实恢复。';
    if (calls() >= config.geminiDailyLimit) return '已到本流程每日八张 Gemini 工作卡预算，等待滚动窗口恢复。';
    return null;
  }
  function taskPayload(stage) {
    const c = cycle();
    return { officeWorkflow: 'story-studio-v1', stage: stage === 'review' ? 'story_review' : 'research', cycleId: c.id, projectId: 'walkalone',
      goal: c.goal || config.goal, canon: c.canon, sourceManifest: c.sourceManifest,
      ...(stage === 'review' ? { draft: c.draft, researchBrief: JSON.stringify({ ideas: c.research.ideas, outline: c.research.outline }) } : {}) };
  }
  async function geminiStage(board, runtime, quota) {
    const c = cycle(), stage = c.stage, expected = JSON.stringify(taskPayload(stage));
    if (expected.length > 20000) return hold('剧情研究输入超过任务卡预算；保留资料，不能截断约束。');
    let link = c.tasks[stage], task = link && [...board.tasks, ...(board.deletedTasks || [])].find(item => item.id === link.id);
    if (!task) {
      if (link?.created) return hold('用户已移除本轮研究卡，自动协作不会重建。');
      const unavailable = readyForGemini(runtime, quota); if (unavailable) return hold(unavailable, 'waiting');
      if (!link) { link = c.tasks[stage] = { id: `story:${c.id}:${stage}`, inputHash: hash(expected), created: false }; persist(); }
      if (link.inputHash !== hash(expected)) return hold('本轮研究请求的输入已改变，保留旧请求。');
      // Durable task ID first; restart reuses a created card instead of duplicating it.
      const created = store.createTask({ title: stage === 'research' ? '退界剧情·资料与原创选题' : '退界剧情·编辑评议', description: expected, provider: 'gemini', role: 'Helper', projectPath: config.projectPath, priority: 'normal' }, { id: link.id });
      link.created = true; link.descriptionHash = hash(created.description); state.geminiRequests.push(iso(now())); persist();
      try { await onTaskChange(); } catch { return hold('剧情卡已入队，但执行器唤醒失败；保留原卡，等待恢复。', 'unavailable'); }
      phase = stage === 'research' ? 'researching' : 'reviewing'; reason = '等待此阶段的真实执行结果。'; error = null; persist(); return status();
    }
    if (!link.created) { link.created = true; link.descriptionHash = hash(task.description); if (!link.recoveredAt) { state.geminiRequests.push(iso(now())); link.recoveredAt = iso(now()); } persist(); }
    if (hash(task.description) !== link.inputHash || task.provider !== 'gemini' || task.kind !== 'research') return hold('本轮研究卡已被修改，不使用改变后的内容继续自动写作。');
    if (resolutionPaused(task) || task.status === 'deleted' || humanRequestHold(task)) return hold('研究卡已暂停、删除或等待用户回应；自动协作保持原状态。', 'paused');
    if (task.status === 'blocked' || task.status === 'failed') return hold(`Gemini 本轮受阻：${clean(task.error || task.result, 600)}。原卡保留，不重复建卡。`);
    if (task.status !== 'done') { phase = stage === 'research' ? 'researching' : 'reviewing'; reason = task.status === 'running' ? 'Gemini 正在执行本轮任务。' : '此阶段排队中，尚未宣称完成。'; error = null; persist(); return status(); }
    if (task.completionSource !== 'agent') return hold('研究卡没有真实代理完成记录，手动完成不能代替可验证产物。');
    if (stage === 'research') {
      const result = researchResult(taskResult(task), now()); controller = new AbortController();
      try { for (const source of result.sources) if (!await verifySource(source.url, { signal: controller.signal })) fail(`公开来源暂不可达，等待核验：${source.url}。这不代表来源伪造；保留原研究。`); }
      finally { controller = null; }
      if (stopped) return status();
      const held = guard(); if (held) return hold(held, 'paused');
      currentSources();
      const freshTask = store.snapshot({ recoverLeases: false }).tasks.find(item => item.id === task.id);
      if (!freshTask || freshTask.version !== task.version || freshTask.result !== task.result) return hold('验证期间研究结果改变，保留记录并重新核对。');
      const brief = JSON.stringify({ idea: result.ideas[0], outline: result.outline });
      if (bytes(brief) > 3000) return hold('研究大纲超过单场写作预算，需缩短具体节拍，不能自动丢弃情节。');
      c.research = result; c.researchBrief = brief; c.researchHash = hash(task.result); artifact('01-research.json', JSON.stringify(result, null, 2)); c.stage = 'draft';
    } else {
      const result = reviewResult(taskResult(task));
      if (result.feedback.some(item => !c.draft.includes(item.evidence))) return hold('审稿证据不在当前候选稿中，不能按无依据意见修订。');
      c.review = result; c.reviewHash = hash(task.result); artifact('03-editorial.json', JSON.stringify(result, null, 2)); c.stage = 'revise';
    }
    link.resultHash = hash(task.result);
    phase = 'waiting'; reason = '上阶段已验证并保存，下一次检查继续。'; error = null; persist(); return status();
  }
  async function writeStage(board, runtime) {
    const c = cycle(), stage = c.stage;
    if (!qwenClient?.writeStory) return hold('本地 Qwen 写作能力尚未接入。', 'unavailable');
    if (runtime.providers?.['local-qwen']?.available === false) return hold('本地 Qwen 当前不可用，保留阶段等待恢复。', 'waiting');
    const brief = `${stage === 'draft' ? '按给定节拍写一场600–1000字的中文候选剧本。' : '依据编辑反馈定向修订这场候选剧本，不扩充未定的世界真相。'}保留人物行动、清楚冲突、具体代价、结尾钩子。正文加标记总长不超过2400汉字，不要输出点评代替正文。\n${c.researchBrief}`;
    const input = { brief, canon: c.canon, draft: stage === 'revise' ? c.draft : '', feedback: stage === 'revise' ? JSON.stringify(c.review) : '' };
    if (bytes(brief) > 4000 || bytes(JSON.stringify(input)) > 20000) return hold('完整写作输入超过预算；保留研究，需缩短本场节拍或反馈。');
    const inputHash = hash(input), journalFile = path.join(outputRoot, c.id, `${stage}-generation.json`);
    let generated = privateRead(journalFile);
    if (generated && (generated.inputHash !== inputHash || generated.sourceHash !== c.sourceHash || typeof generated.text !== 'string' || generated.text.length < 250 || bytes(generated.text) > 8000)) return hold('已保存生成结果与当前输入不一致，不能覆盖。');
    if (!generated) {
      if (qwenClient.runtimeState?.().busy || (board.tasks || []).some(task => task.provider === 'local-qwen' && task.status === 'running')) return hold('共享本地模型正在处理其他任务，候选写作等待空闲。', 'waiting');
      if ((c.attempts[stage] || 0) >= 2) return hold('本阶段已失败两次；保留已有稿件，需检查失败原因后再继续。');
      phase = stage === 'draft' ? 'drafting' : 'revising'; error = null; reason = 'Qwen 正在生成候选稿，不会改写游戏正典。'; persist();
      controller = new AbortController(); activeWriting = true;
      try {
        const text = await qwenClient.writeStory({ ...input, signal: controller.signal });
        if (stopped || controller.signal.aborted) return status();
        if (typeof text !== 'string' || text.trim().length < 250 || bytes(text) > 8000 || /^(?:SUCCESS|DONE|OK|APPROVED)\b/i.test(text.trim())) fail('Qwen 没有返回完整且符合预算的候选正文。');
        // Journal the completed output before advancing state. A restart can recover
        // this exact generation without repeating inference or replacing its text.
        generated = { inputHash, sourceHash: c.sourceHash, text: text.trim(), generatedAt: iso(now()) };
        privateWrite(journalFile, generated);
      } catch (cause) {
        if (stopped) return status();
        if (/yielded to a user task|Local Qwen is busy|Local Qwen concurrency is 1/i.test(cause.message || '')) return hold('本地写作让位给用户任务，空闲后继续；未消耗失败次数。', 'waiting');
        c.attempts[stage] = (c.attempts[stage] || 0) + 1;
        c.cooldownUntil = iso(now() + COOLDOWN); c.cooldownReason = `本地写作未完成：${clean(cause.message, 500)}。十五分钟后最多补试一次。`;
        return hold(c.cooldownReason, 'cooldown');
      } finally { controller = null; activeWriting = false; }
    }
    const held = guard(); if (held) return hold(held, 'paused');
    currentSources();
    if (stage === 'draft') { c.draft = generated.text; c.draftHash = hash(c.draft); artifact('02-draft.md', c.draft); c.stage = 'review'; phase = 'waiting'; reason = '初稿已保存，等待 Gemini 编辑评议。'; }
    else { c.revised = generated.text; c.revisedHash = hash(c.revised); const file = artifact('04-candidate.md', c.revised); c.stage = 'complete'; c.completedAt = iso(now()); state.lastCompletedAt = c.completedAt; state.lastArtifact = file; state.lastPreview = c.revised.slice(0, 2000); phase = 'ready'; reason = '候选稿已完成一轮研究、写作、审稿与修订；未覆盖正典。'; }
    error = null; persist(); return status();
  }
  async function scan() {
    if (!config.enabled || stopped || storageError) return status();
    if (!lock?.owns()) { storageError = '剧情协作运行锁已失效，停止自动推进。'; return status(); }
    if (!state) { state = { version: 1, nextCycleAt: iso(now()), geminiRequests: [], cycle: null }; persist(); }
    state.geminiRequests = state.geminiRequests.filter(at => now() - Date.parse(at) < DAY);
    state.nextCheckAt = iso(now() + POLL);
    const board = store.snapshot({ recoverLeases: false });
    const held = guard(board); if (held) return hold(held, 'paused');
    if (!cycle() || cycle().stage === 'complete') {
      if (now() < Date.parse(state.nextCycleAt)) { phase = cycle() ? 'ready' : 'waiting'; reason = '本轮已结束，等待六小时周期。'; error = null; persist(); return status(); }
      const source = captureSources(config.sourceRoot);
      const sequence = (state.sequence || 0) + 1, focus = FOCUS[(sequence - 1) % FOCUS.length];
      const goal = `${config.goal}\n本轮创作重点：${focus}。以新的局部场景探索该角度，不反复改写上一轮；上一轮候选只是未确认创意，不能升级为正典。${state.lastPreview ? `\n上一轮候选节选：${state.lastPreview.slice(0, 500)}` : ''}`;
      state.sequence = sequence; state.cycle = { id: randomUUID(), stage: 'research', createdAt: iso(now()), ...source, goal, focus, attempts: {}, tasks: {} };
      state.nextCycleAt = iso(now() + config.intervalMs); persist(); artifact('00-sources.json', JSON.stringify({ ...source, goal }, null, 2));
    } else currentSources();
    if (cycle().cooldownUntil && now() < Date.parse(cycle().cooldownUntil)) return hold(cycle().cooldownReason || '验证或写作冷却中，保留上一次产物。', 'cooldown');
    let runtime, quota; try { runtime = runtimeReader(); quota = quotaReader(); } catch { return hold('运行状态或额度来源暂不可用，未发起新调用。', 'unavailable'); }
    return ['research', 'review'].includes(cycle().stage) ? geminiStage(board, runtime, quota) : writeStage(board, runtime);
  }
  function tick() {
    if (!flight) flight = scan().catch(cause => { if (state && !storageError) { try { if (cycle()) { cycle().cooldownUntil = iso(now() + COOLDOWN); cycle().cooldownReason = clean(cause.message) || '剧情资料或产物验证失败，保留本轮任务。'; } return hold(clean(cause.message) || '剧情资料或产物验证失败，保留本轮任务。'); } catch {} } phase = 'unavailable'; error = '剧情协作资料或存储不可用；未推进后续阶段。'; return status(); }).finally(() => { flight = null; });
    return flight;
  }
  return { status, tick,
    async start() {
      if (!stopped) return tick(); if (!config.enabled || storageError) return status();
      try { lock = lockStudio(home); const saved = privateRead(stateFile); state = saved ? validState(saved) : null; }
      catch { try { lock?.release(); } catch {} lock = null; storageError = '另一个剧情服务已运行，或记录/运行锁不可用。'; return status(); }
      stopped = false; phase = state?.phase || 'waiting'; reason = state?.reason || null; error = state?.error || null;
      await tick(); if (!stopped && !storageError) { timer = setInterval(() => { void tick(); }, POLL); timer.unref?.(); } return status();
    },
    async stop() { stopped = true; clearInterval(timer); controller?.abort(); await flight; try { lock?.release(); } catch {} lock = null; },
  };
}
