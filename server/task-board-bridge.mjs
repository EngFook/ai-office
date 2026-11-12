import path from 'node:path';
import { readFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { TaskBoardError } from './task-store.mjs';
import { validateManagementPlan } from './grok-management.mjs';
import { readGrokConversation } from './grok-conversation.mjs';

const BODY_LIMIT = 128 * 1024;
const httpError = (message, status = 400) => new TaskBoardError(message, 'REQUEST', status);
function allowed(request) {
  const address = request.socket?.remoteAddress || '';
  if (!['127.0.0.1', '::1'].includes(address) && !address.startsWith('::ffff:127.')) return false;
  try {
    const host = new URL(`http://${request.headers.host}`);
    return ['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname) && (!request.headers.origin || new URL(request.headers.origin).origin === host.origin) && (!request.headers['sec-fetch-site'] || ['same-origin', 'none'].includes(request.headers['sec-fetch-site']));
  } catch { return false; }
}
function sameToken(value, token) {
  if (typeof value !== 'string') return false;
  const a = Buffer.from(value), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
async function body(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) throw httpError('Use application/json.', 415);
  if (Number(request.headers['content-length']) > BODY_LIMIT) { request.resume?.(); throw httpError('Request body is too large.', 413); }
  return new Promise((resolve, reject) => {
    let size = 0, failed = false; const chunks = [];
    request.on('data', chunk => {
      size += Buffer.byteLength(chunk);
      if (size > BODY_LIMIT) { if (!failed) reject(httpError('Request body is too large.', 413)); failed = true; chunks.length = 0; }
      else if (!failed) chunks.push(Buffer.from(chunk));
    });
    request.on('error', () => reject(httpError('Could not read request body.')));
    request.on('end', () => {
      if (failed) return;
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        resolve(parsed);
      } catch { reject(httpError('Expected a JSON object.')); }
    });
  });
}

// Live meeting state (written by scripts/office-meeting.mjs). Visual only: it never changes tasks or counts.
export const MEETING_FILE = path.join(import.meta.dirname, '..', 'reports', 'meetings', 'live.json');
const MEETING_PROVIDERS = ['claude', 'codex', 'gemini', 'grok'];
export function readMeeting(file = MEETING_FILE) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    const attendees = Array.isArray(value.attendees) ? value.attendees.filter(a => MEETING_PROVIDERS.includes(a)).slice(0, 4) : [];
    return { active: value.active === true && attendees.length > 0, attendees, topic: typeof value.topic === 'string' ? value.topic.slice(0, 200) : '', startedAt: Number(value.startedAt) || null };
  } catch { return { active: false, attendees: [], topic: '', startedAt: null }; }
}

// Board polling needs live report health, not generated text or source records.
function workLogStatus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const time = input => { const ms = typeof input === 'number' ? input : typeof input === 'string' ? Date.parse(input) : NaN; return Number.isFinite(ms) && !Number.isNaN(new Date(ms).valueOf()) ? new Date(ms).toISOString() : null; };
  return { phase: ['stopped', 'watching', 'summarizing', 'unavailable'].includes(value.phase) ? value.phase : 'unavailable',
    checkedAt: time(value.checkedAt), generatedAt: time(value.generatedAt), stale: value.stale === true,
    error: value.error ? '运行记录整理暂不可用；保留原记录，稍后重试。' : null,
    sourceErrors: [...new Set((Array.isArray(value.sourceErrors) ? value.sourceErrors : []).filter(source => ['claude', 'codex', 'grok', 'runtime', 'watch', 'huddle'].includes(source)))],
  };
}

export function taskBoardBridge({ store, onInstruction, onTaskChange, getRuntimeStatus, getProjectCatalog, getDispatchStatus, getWatchStatus, getHuddleStatus, getWorkReports, getStoryStudio, getGrokPatrol, getBlockedTasks, onHandleBlockedTask, getDailyReports, getPendingReports, onAcknowledgeReport, onConfigureGrok, getGrokStatus, onBotHeartbeat, onAgentHeartbeat, grokWake, onWakeConfigured, readOnly = false, configuration, meetingFile, enabledProviders, defaultProjectPath, conversationReader = readGrokConversation } = {}) {
  if (!store) throw new TypeError('taskBoardBridge requires a store.');
  const csrfToken = randomBytes(32).toString('base64url');
  const safely = async (callback, fallback) => { try { return callback ? await callback() : fallback; } catch { return fallback; } };
  const notify = task => { if (onTaskChange) Promise.resolve().then(() => onTaskChange(task)).catch(() => {}); };
  // Recording a refusal is a state change, but it must not wake unrelated work.
  const notifyAnswer = result => { if (result.applied && ['approve', 'provide_info'].includes(result.request.answer?.decision)) notify(result.task); };
  const enqueue = instruction => {
    if (onInstruction) Promise.resolve().then(() => onInstruction(instruction)).catch(() => {
      try { store.updateInstruction(instruction.id, { status: 'blocked', error: 'Management planning could not complete. Retry after checking the connection.' }); } catch { /* store may already be closed */ }
    });
  };
  const middleware = async (request, response, next) => {
    const pathname = request.url?.split('?')[0] || '';
    if (!pathname.startsWith('/api/office/') && pathname !== '/api/grok/status') return next();
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (value, status = 200) => { response.statusCode = status; response.end(JSON.stringify(value)); };
    try {
      if (!allowed(request)) throw httpError('Local same-origin access only.', 403);
      if (pathname === '/api/office/grok/conversation') {
        if (request.method !== 'GET') throw httpError('Conversation mirror is read-only.', 405);
        const query = new URL(request.url, 'http://localhost').searchParams;
        if ([...query.keys()].some(key => !['botId', 'cursor'].includes(key))) throw httpError('Invalid conversation request.', 400);
        send(conversationReader({ botId: query.get('botId') || undefined, cursor: query.get('cursor') || undefined })); return;
      }
      if (request.method === 'GET' && pathname === '/api/office/board') {
        const [runtime, grok, workReports] = await Promise.all([safely(getRuntimeStatus, { available: false }), safely(getGrokStatus, { connected: false, configured: false }), safely(getWorkReports, null)]);
        const logSummary = workLogStatus(workReports?.logSummary);
        const workReportsSummary = workReports ? { ...(logSummary ? { logSummary } : {}), phase: workReports.phase, started: workReports.started, model: workReports.model || null, intervalMs: workReports.intervalMs, nextCheckAt: workReports.nextCheckAt || null, error: workReports.error || null, notice: workReports.notice || null, generatedAt: workReports.generatedAt || null, lastCheckedAt: workReports.lastCheckedAt || null, counts: workReports.counts || { totalLogs: workReports.runningLogs?.length || 0, totalTasks: workReports.allTasks?.length ?? (workReports.providers || []).reduce((sum, group) => sum + (group.tasks?.length || 0), 0) } } : null;
        send({ ...store.snapshot(), storyStudio: await safely(getStoryStudio, null), grokPatrol: await safely(getGrokPatrol, null), dailyReport: await safely(getDailyReports, null), dispatchSync: await safely(getDispatchStatus, null), projectCatalog: await safely(getProjectCatalog, []), runtime, grok, grokWake: grokWake?.status() || { configured: false, host: null, lastSentAt: null, error: null }, qwenWatch: await safely(getWatchStatus, null), huddle: await safely(getHuddleStatus, null), ...(workReportsSummary ? { workReportsSummary } : {}), meeting: readMeeting(meetingFile), ...(configuration ? { configuration } : {}), csrfToken }); return;
      }
      if (request.method === 'GET' && pathname === '/api/office/grok/blocked-tasks') {
        if (!getBlockedTasks) throw httpError('Grok blocked-task patrol unavailable.', 503);
        try { send(await getBlockedTasks()); } catch (error) { if ([400, 409, 503].includes(error?.status)) throw httpError(error.message, error.status); throw error; }
        return;
      }
      if (request.method === 'GET' && pathname === '/api/office/daily-reports') { send(await safely(getDailyReports, { enabled: false, phase: 'unavailable', error: '日报服务不可用。' })); return; }
      if (request.method === 'GET' && pathname === '/api/office/daily-reports/pending') { if (!getPendingReports) throw httpError('Daily reports unavailable.', 503); send({ reports: await getPendingReports() }); return; }
      if (request.method === 'GET' && pathname === '/api/office/work-reports') { send(await safely(getWorkReports, { phase: 'unavailable', error: '工作报告服务不可用。', providers: [], allTasks: [], runningLogs: [] })); return; }
      if (request.method === 'GET' && pathname === '/api/office/human-requests') { send({ humanRequests: store.snapshot().humanRequests.filter(item => ['pending', 'delivered'].includes(item.state)) }); return; }
      if (request.method === 'GET' && pathname === '/api/grok/status') { send(await safely(getGrokStatus, { connected: false, configured: false })); return; }
      if (readOnly) throw httpError('办公室处于只查看模式，请通过本机 setup 明确启用执行后重启。', 403);
      if (!['POST', 'PATCH'].includes(request.method)) throw httpError('Method not allowed.', 405);
      if (!sameToken(request.headers['x-office-token'], csrfToken)) throw httpError('Refresh the board before making changes.', 403);
      const input = await body(request);
      if (enabledProviders && /\/tasks\/(?:claim-next|[^/]+\/claim)$/.test(pathname)) {
        const worker = input.worker || {};
        const requested = worker.providers || [worker.provider];
        if (!Array.isArray(requested) || requested.some(id => !enabledProviders.includes(id))) throw httpError('该执行者尚未在本机配置中启用。', 403);
      }
      if (defaultProjectPath && ['/api/office/tasks', '/api/office/instructions'].includes(pathname) && !input.projectPath) input.projectPath = defaultProjectPath;
      let match;
      if (request.method === 'POST' && (match = pathname.match(/^\/api\/office\/grok\/blocked-tasks\/([^/]+)\/handle$/))) {
        if (!onHandleBlockedTask || enabledProviders && !enabledProviders.includes('grok-bot')) throw httpError('Grok blocked-task patrol unavailable.', 503);
        try { send(await onHandleBlockedTask(decodeURIComponent(match[1]), input)); }
        catch (error) { if ([400, 403, 404, 409, 503].includes(error?.status)) throw httpError(error.message, error.status); throw error; }
        return;
      }
      if (request.method === 'POST' && (match = pathname.match(/^\/api\/office\/daily-reports\/([^/]+)\/acknowledge$/))) {
        if (!onAcknowledgeReport) throw httpError('Daily reports unavailable.', 503);
        try { send({ report: await onAcknowledgeReport(decodeURIComponent(match[1]), input) }); }
        catch (error) { if ([400, 404, 409, 503].includes(error?.status)) throw httpError(error.message, error.status); throw error; }
        return;
      }
      if (request.method === 'POST' && (match = pathname.match(/^\/api\/office\/human-requests\/([^/]+)\/acknowledge$/))) send({ request: store.acknowledgeHumanRequest(decodeURIComponent(match[1]), input) });
      else if (request.method === 'POST' && (match = pathname.match(/^\/api\/office\/human-requests\/([^/]+)\/respond$/))) { const result = store.answerHumanRequest(decodeURIComponent(match[1]), { ...input, source: 'office-ui', replyAuthor: 'user' }); notifyAnswer(result); send(result); }
      else if (request.method === 'POST' && (match = pathname.match(/^\/api\/office\/human-requests\/([^/]+)\/rerequest$/))) { const result = store.rerequestHumanRequest(decodeURIComponent(match[1]), { ...input, source: 'office-ui' }); if (result.applied) notify(result.task); send(result); }
      else if (request.method === 'POST' && (match = pathname.match(/^\/api\/office\/human-requests\/([^/]+)\/triage$/))) { const result = store.triageHumanRequest(decodeURIComponent(match[1]), input); if (result.applied) notify(result.task); send(result); }
      else if (request.method === 'POST' && (match = pathname.match(/^\/api\/office\/human-requests\/([^/]+)\/answer$/))) { if (input.source !== 'grok-bot') throw httpError('Grok answers must use the grok-bot source.', 400); const result = store.answerHumanRequest(decodeURIComponent(match[1]), input); notifyAnswer(result); send(result); }
      else if (request.method === 'POST' && pathname === '/api/office/tasks/card-actions') {
        if (!['rerequest', 'delete', 'deny', 'restore'].includes(input.action) || !Array.isArray(input.items) || !input.items.length || input.items.length > 100) throw httpError('请选择 1–100 个任务和有效操作。', 400);
        store.syncHumanRequests();
        const results = input.items.map(item => {
          try {
            store.cardAction(item.id, { ...item, action: input.action }, { syncQuestions: false });
            return { id: item.id, ok: true };
          } catch (error) { return { id: item?.id, ok: false, error: error instanceof TaskBoardError ? error.message : '操作失败，请刷新后重试。' }; }
        });
        if (input.action !== 'deny' && results.some(item => item.ok)) notify(null);
        send({ results });
      }
      else if (request.method === 'POST' && pathname === '/api/office/maintenance') send({ maintenance: store.acquireMaintenance(input.ownerToken) });
      else if (request.method === 'POST' && pathname === '/api/office/maintenance/release') send({ maintenance: store.releaseMaintenance(input.ownerToken) });
      else if (request.method === 'POST' && pathname === '/api/office/tasks') { const task = store.createTask(input); notify(task); send({ task }, 201); }
      else if (request.method === 'PATCH' && (match = pathname.match(/^\/api\/office\/tasks\/([^/]+)$/))) { const task = store.updateTask(decodeURIComponent(match[1]), input, { version: input.version }); notify(task); send({ task }); }
      else if (request.method === 'POST' && pathname === '/api/office/tasks/claim-next') { const claim = store.claimTask(input.worker); if (claim) notify(claim.task); send(claim); }
      else if (request.method === 'POST' && (match = pathname.match(/^\/api\/office\/tasks\/([^/]+)\/claim$/))) { const claim = store.claimTask(input.worker, { taskId: decodeURIComponent(match[1]) }); if (claim) notify(claim.task); send(claim); }
      else if (request.method === 'POST' && (match = pathname.match(/^\/api\/office\/tasks\/([^/]+)\/heartbeat$/))) send({ task: store.heartbeat(decodeURIComponent(match[1]), input.claimToken) });
      else if (request.method === 'POST' && (match = pathname.match(/^\/api\/office\/tasks\/([^/]+)\/finish$/))) { const task = store.finishTask(decodeURIComponent(match[1]), input.claimToken, input); notify(task); send({ task }); }
      else if (request.method === 'POST' && pathname === '/api/office/roles') send({ role: store.upsertRole(input) }, 201);
      else if (request.method === 'POST' && pathname === '/api/office/instructions') {
        const existed = typeof input.requestId === 'string' && store.snapshot().instructions.some(item => item.id === input.requestId.toLowerCase());
        const instruction = store.createInstruction(input);
        if (!existed) enqueue(instruction);
        send({ instruction }, 202);
      }
      else if (request.method === 'POST' && (match = pathname.match(/^\/api\/office\/instructions\/([^/]+)\/retry$/))) {
        const id = decodeURIComponent(match[1]), existing = store.snapshot().instructions.find(instruction => instruction.id === id);
        if (!existing) throw httpError('Management instruction not found.', 404);
        if (existing.status !== 'blocked') throw httpError('Only blocked management instructions can be retried.', 409);
        const instruction = store.updateInstruction(id, { status: 'pending', error: '' }); enqueue(instruction); send({ instruction }, 202);
      }
      else if (request.method === 'POST' && (match = pathname.match(/^\/api\/office\/instructions\/([^/]+)\/apply-plan$/))) {
        const id = decodeURIComponent(match[1]), existing = store.snapshot().instructions.find(instruction => instruction.id === id);
        if (!existing) throw httpError('Management instruction not found.', 404);
        if (!['pending', 'blocked', 'done'].includes(existing.status)) throw httpError('This management instruction is already being processed.', 409);
        let plan;
        try { plan = validateManagementPlan(input.plan || input, existing.projectPath); }
        catch { throw httpError('Management plan is invalid. No tasks were added.', 400); }
        const result = store.applyManagementPlan(id, plan); notify(null); send(result);
      }
      else if (request.method === 'PATCH' && pathname === '/api/office/settings') { const settings = store.updateSettings(input); notify(null); send({ settings }); }
      else if (request.method === 'POST' && pathname === '/api/office/grok/wake/config') {
        if (!grokWake) throw httpError('Grok wake is unavailable.', 503);
        try { const status = grokWake.configure(input); await onWakeConfigured?.(); send({ grokWake: status }); }
        catch { throw httpError('Could not configure Grok wake. Check the routine webhook and token.', 400); }
      }
      else if (request.method === 'POST' && pathname === '/api/office/grok/connect') {
        if (!onConfigureGrok) throw httpError('Grok connection is unavailable.', 503);
        // A key may enter this callback; never echo its input or failure details.
        try { send({ grok: await onConfigureGrok(input) }); } catch { throw httpError('Could not connect Grok. Check the key and try again.', 400); }
      }
      else if (request.method === 'POST' && pathname === '/api/office/agents/heartbeat') {
        const provider = input.provider === 'grok' ? 'grok-bot' : input.provider;
        if (enabledProviders && !enabledProviders.includes(provider)) throw httpError('Agent provider is disabled.', 403);
        if (!onAgentHeartbeat) throw httpError('Agent presence is unavailable.', 503);
        send({ agent: await onAgentHeartbeat(input) });
      }
      else if (request.method === 'POST' && pathname === '/api/office/grok/bot/heartbeat') {
        if (!onBotHeartbeat) throw httpError('GrokBot activity is unavailable.', 503);
        send({ bot: await onBotHeartbeat(input) });
      }
      else throw httpError('Endpoint not found.', 404);
    } catch (error) {
      if (error instanceof TaskBoardError) send({ error: error.message, code: error.code }, error.status);
      else send({ error: 'The office request could not complete.', code: 'INTERNAL' }, 500);
    }
  };
  return { name: 'ai-office-task-board', configureServer(server) { server.middlewares.use(middleware); }, configurePreviewServer(server) { server.middlewares.use(middleware); } };
}
