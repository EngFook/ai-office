#!/usr/bin/env node
// Local task-board adapter for an assistant that can run approved commands on
// this computer. It never calls a model, launches a shell, or reads credentials.
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const MAX_INPUT = 256 * 1024;
const commands = new Set(['status', 'pending-questions', 'acknowledge-question', 'answer-question', 'triage-question', 'pending-instructions', 'add-task', 'add-role', 'apply-plan', 'bot-heartbeat', 'claim', 'claim-next', 'heartbeat', 'finish', 'grok-quota']);

function parseArguments(args, environment) {
  const positional = [];
  let port = null;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--port') {
      if (port !== null || !/^\d{1,5}$/.test(args[index + 1] || '') || Number(args[index + 1]) < 1 || Number(args[index + 1]) > 65535) throw new Error('--port must be a number from 1 to 65535.');
      port = String(Number(args[++index]));
    } else if (args[index].startsWith('--')) throw new Error('Unknown option. Use --port to select a local office port.');
    else positional.push(args[index]);
  }
  let base;
  try { base = new URL(environment.AI_OFFICE_URL || 'http://127.0.0.1:5173'); }
  catch { throw new Error('AI_OFFICE_URL must be an HTTP loopback URL.'); }
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('AI_OFFICE_URL must be an HTTP loopback URL without credentials, a path, or query parameters.');
  if (port) base.port = port;
  const [command = 'status', id] = positional;
  if (!commands.has(command)) throw new Error(`Unknown command. Use ${[...commands].join(', ')}.`);
  const needsId = ['apply-plan', 'claim', 'heartbeat', 'finish', 'acknowledge-question', 'answer-question', 'triage-question'].includes(command);
  if (positional.length > (needsId ? 2 : 1) || needsId && (!id || id.length > 240 || !/^[a-zA-Z0-9][a-zA-Z0-9_.:@/-]*$/.test(id))) throw new Error(`${command}${needsId ? ' requires one instruction or task ID.' : ' does not accept positional arguments.'}`);
  return { base: base.origin, command, id };
}

async function jsonInput(stream = process.stdin) {
  if (stream.isTTY) throw new Error('Provide one JSON object on standard input.');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_INPUT) throw new Error('JSON input is too large.');
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Standard input must contain one valid JSON object.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Standard input must contain a JSON object.');
  return value;
}

export async function runOfficeBoardCommand({ args = process.argv.slice(2), environment = process.env, fetchImpl = fetch, readInput = jsonInput } = {}) {
  const { base, command, id } = parseArguments(args, environment);
  const request = async (route, body, token) => {
    let response;
    try {
      response = await fetchImpl(`${base}/api/office/${route}`, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'Origin': base, 'X-Office-Token': token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(10000) });
    } catch { throw new Error('The local office could not be reached. Start the office and check its port.'); }
    let value;
    try { value = await response.json(); }
    catch { throw new Error('The local office returned an invalid JSON response.'); }
    if (!response.ok) throw new Error(`Office request failed (${response.status}): ${typeof value.error === 'string' ? value.error.slice(0, 240) : 'request rejected'}`);
    return value;
  };
  const board = await request('board');
  if (command === 'grok-quota') return writeGrokQuota(await readInput(), environment);
  if (command === 'status') { const { csrfToken, ...publicBoard } = board; return publicBoard; }
  if (command === 'pending-questions') return { workflowVersion: 2, userWorkflowInstruction: '需要你补资料或批准的才交给 Grok 处理，处理不了才转告。所有受阻任务需要我补充或确认的，给我把问题标出来，让我可以在对话框里打字，或者点击什么按键确认或拒绝，也给我加一个重新请求按钮。', handlingPolicy: 'Current office workflow replaces relay-only handling. Grok investigates first using existing records and authorization. For pending questions and delivered info questions not yet triaged, inspect the original task and available records once, without repeating delivered questions. Use triage-question REQUEST_ID with stdin JSON {"source":"grok-bot","questionHash":"CURRENT","outcome":"needs_user","summary":"FINDINGS","evidence":"CHECKS"}. resolved_info may requeue an information-only task; needs_user records what could not be resolved, then relay the specific question. Never invent user replies or approvals. Only acknowledge after actual delivery; answer-question requires the actual user reply.', humanRequests: (Array.isArray(board.humanRequests) ? board.humanRequests : []).filter(item => ['pending', 'delivered'].includes(item.state)) };
  if (command === 'pending-instructions') return { instructions: (Array.isArray(board.instructions) ? board.instructions : []).filter(instruction => instruction.status === 'pending') };
  if (typeof board.csrfToken !== 'string' || !board.csrfToken) throw new Error('The local office did not provide a request token.');
  const input = await readInput();
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Standard input must contain a JSON object.');
  const route = command === 'triage-question' ? `human-requests/${encodeURIComponent(id)}/triage` : command === 'acknowledge-question' ? `human-requests/${encodeURIComponent(id)}/acknowledge` : command === 'answer-question' ? `human-requests/${encodeURIComponent(id)}/answer` : command === 'add-task' ? 'tasks' : command === 'add-role' ? 'roles' : command === 'apply-plan' ? `instructions/${encodeURIComponent(id)}/apply-plan` : command === 'bot-heartbeat' ? 'grok/bot/heartbeat' : command === 'claim-next' ? 'tasks/claim-next' : `tasks/${encodeURIComponent(id)}/${command}`;
  const body = ['claim', 'claim-next'].includes(command) && !input.worker ? { worker: input } : input;
  return request(route, body, board.csrfToken);
}

// Grok Bot's own usage report -> reports/grok-quota.json (read by /api/usage).
export function writeGrokQuota(input, environment = process.env, now = Date.now()) {
  const used = Number(input?.usedPercent), reset = input?.resetsAt == null ? null : typeof input.resetsAt === 'number' ? input.resetsAt : Date.parse(input.resetsAt);
  if (!Number.isFinite(used) || used < 0 || used > 100) throw new Error('usedPercent must be a number from 0 to 100.');
  if (reset !== null && !Number.isFinite(reset)) throw new Error('resetsAt must be an ISO time or epoch ms.');
  const root = environment.AI_OFFICE_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const value = { usedPercent: used, resetsAt: reset, plan: typeof input.plan === 'string' ? input.plan.slice(0, 40) : null, note: typeof input.note === 'string' ? input.note.slice(0, 200) : null, observedAt: now };
  fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(root, 'reports', 'grok-quota.json'), JSON.stringify(value, null, 2) + '\n');
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runOfficeBoardCommand().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(`Office board: ${error.message}`); process.exitCode = 1; });
}
