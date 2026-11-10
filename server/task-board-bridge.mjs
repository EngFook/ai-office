import path from 'node:path';
import { readFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { TaskBoardError } from './task-store.mjs';
import { validateManagementPlan } from './grok-management.mjs';

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

export function taskBoardBridge({ store, onInstruction, onTaskChange, getRuntimeStatus, getWatchStatus, getHuddleStatus, onConfigureGrok, getGrokStatus, onBotHeartbeat, grokWake } = {}) {
  if (!store) throw new TypeError('taskBoardBridge requires a store.');
  const csrfToken = randomBytes(32).toString('base64url');
  const safely = async (callback, fallback) => { try { return callback ? await callback() : fallback; } catch { return fallback; } };
  const notify = task => { if (onTaskChange) Promise.resolve().then(() => onTaskChange(task)).catch(() => {}); };
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
      if (request.method === 'GET' && pathname === '/api/office/board') {
        const [runtime, grok] = await Promise.all([safely(getRuntimeStatus, { available: false }), safely(getGrokStatus, { connected: false, configured: false })]);
        send({ ...store.snapshot(), runtime, grok, grokWake: grokWake?.status() || { configured: false, host: null, lastSentAt: null, error: null }, qwenWatch: await safely(getWatchStatus, null), huddle: await safely(getHuddleStatus, null), meeting: readMeeting(), csrfToken }); return;
      }
      if (request.method === 'GET' && pathname === '/api/office/human-requests') { send({ humanRequests: store.snapshot().humanRequests.filter(item => ['pending', 'delivered'].includes(item.state)) }); return; }
      if (request.method === 'GET' && pathname === '/api/grok/status') { send(await safely(getGrokStatus, { connected: false, configured: false })); return; }
      if (!['POST', 'PATCH'].includes(request.method)) throw httpError('Method not allowed.', 405);
      if (!sameToken(request.headers['x-office-token'], csrfToken)) throw httpError('Refresh the board before making changes.', 403);
      const input = await body(request);
      let match;
      if (request.method === 'POST' && (match = pathname.match(/^\/api\/office\/human-requests\/([^/]+)\/acknowledge$/))) send({ request: store.acknowledgeHumanRequest(decodeURIComponent(match[1]), input) });
      else if (request.method === 'POST' && (match = pathname.match(/^\/api\/office\/human-requests\/([^/]+)\/respond$/))) { const result = store.answerHumanRequest(decodeURIComponent(match[1]), { ...input, source: 'office-ui', replyAuthor: 'user' }); if (result.applied) notify(result.task); send(result); }
      else if (request.method === 'POST' && (match = pathname.match(/^\/api\/office\/human-requests\/([^/]+)\/rerequest$/))) { const result = store.rerequestHumanRequest(decodeURIComponent(match[1]), { ...input, source: 'office-ui' }); if (result.applied) notify(result.task); send(result); }
      else if (request.method === 'POST' && (match = pathname.match(/^\/api\/office\/human-requests\/([^/]+)\/triage$/))) { const result = store.triageHumanRequest(decodeURIComponent(match[1]), input); if (result.applied) notify(result.task); send(result); }
      else if (request.method === 'POST' && (match = pathname.match(/^\/api\/office\/human-requests\/([^/]+)\/answer$/))) { if (input.source !== 'grok-bot') throw httpError('Grok answers must use the grok-bot source.', 400); const result = store.answerHumanRequest(decodeURIComponent(match[1]), input); if (result.applied) notify(result.task); send(result); }
      else if (request.method === 'POST' && pathname === '/api/office/tasks/card-actions') {
        if (!['rerequest', 'delete', 'deny', 'restore'].includes(input.action) || !Array.isArray(input.items) || !input.items.length || input.items.length > 100) throw httpError('请选择 1–100 个任务和有效操作。', 400);
        store.syncHumanRequests();
        const results = input.items.map(item => {
          try {
            store.cardAction(item.id, { ...item, action: input.action }, { syncQuestions: false });
            return { id: item.id, ok: true };
          } catch (error) { return { id: item?.id, ok: false, error: error instanceof TaskBoardError ? error.message : '操作失败，请刷新后重试。' }; }
        });
        if (results.some(item => item.ok)) notify(null);
        send({ results });
      }
      else if (request.method === 'POST' && pathname === '/api/office/tasks') { const task = store.createTask(input); notify(task); send({ task }, 201); }
      else if (request.method === 'PATCH' && (match = pathname.match(/^\/api\/office\/tasks\/([^/]+)$/))) { const task = store.updateTask(decodeURIComponent(match[1]), input, { version: input.version }); notify(task); send({ task }); }
      else if (request.method === 'POST' && pathname === '/api/office/tasks/claim-next') { const claim = store.claimTask(input.worker); if (claim) notify(claim.task); send(claim); }
      else if (request.method === 'POST' && (match = pathname.match(/^\/api\/office\/tasks\/([^/]+)\/claim$/))) { const claim = store.claimTask(input.worker, { taskId: decodeURIComponent(match[1]) }); if (claim) notify(claim.task); send(claim); }
      else if (request.method === 'POST' && (match = pathname.match(/^\/api\/office\/tasks\/([^/]+)\/heartbeat$/))) send({ task: store.heartbeat(decodeURIComponent(match[1]), input.claimToken) });
      else if (request.method === 'POST' && (match = pathname.match(/^\/api\/office\/tasks\/([^/]+)\/finish$/))) { const task = store.finishTask(decodeURIComponent(match[1]), input.claimToken, input); notify(task); send({ task }); }
      else if (request.method === 'POST' && pathname === '/api/office/roles') send({ role: store.upsertRole(input) }, 201);
      else if (request.method === 'POST' && pathname === '/api/office/instructions') { const instruction = store.createInstruction(input); enqueue(instruction); send({ instruction }, 202); }
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
        try { send({ grokWake: grokWake.configure(input) }); }
        catch { throw httpError('Could not configure Grok wake. Check the routine webhook and token.', 400); }
      }
      else if (request.method === 'POST' && pathname === '/api/office/grok/connect') {
        if (!onConfigureGrok) throw httpError('Grok connection is unavailable.', 503);
        // A key may enter this callback; never echo its input or failure details.
        try { send({ grok: await onConfigureGrok(input) }); } catch { throw httpError('Could not connect Grok. Check the key and try again.', 400); }
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
