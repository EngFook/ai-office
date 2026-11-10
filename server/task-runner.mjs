import { spawn as nativeSpawn, execFile } from 'node:child_process';
import { access, readdir, realpath, stat, writeFile, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

// CLI contracts: https://learn.chatgpt.com/docs/non-interactive-mode and
// https://code.claude.com/docs/en/headless. No agent configuration is changed.
import { localQwen, LOCAL_QWEN_MODEL } from './local-qwen.mjs';
import { localQwenTaskError } from './local-qwen-policy.mjs';
import { recoveryPrompt, investigationPrompt, resolutionPaused } from './resolution-policy.mjs';
import { watchHoldReason } from './watch-task-policy.mjs';
import { huddleQuota } from './huddle-policy.mjs';
import { parallelCapabilities, codexSubagentArgs } from './parallel-policy.mjs';
import { workerEnvironment as childEnvironment } from './worker-environment.mjs';
import { GROK_COMMUNICATION_POLICY } from './communication-policy.mjs';
const LABELS = { codex: 'Codex', claude: 'Claude Code', gemini: 'Gemini', 'local-qwen': 'Local Qwen' };
const CODERS = ['codex', 'claude'];
export const GROK_BOT_PENDING_REASON = 'Externally managed: waiting for Grok Bot to claim this task through the office CLI/API. The office runner does not execute Grok Bot tasks.';
const OTHER = { codex: 'claude', claude: 'codex' };
export const LOW_QUOTA_PERCENT = 20;
import { codexTier, isBalance, isRelease, isHighRisk, isReviewLike } from './division-policy.mjs';
export const AGY_PATH = '/Applications/Gemini.app/Contents/Helpers/agy';
export const GEMINI_MODEL = 'gemini-4-argon-medium', GEMINI_MODEL_HIGH = 'gemini-4-argon-high';
export const geminiModelFor = task => task?.priority === 'high' ? GEMINI_MODEL_HIGH : GEMINI_MODEL;
export const GEMINI_LOGIN_REASON = 'Needs login: open Terminal, run `/Applications/Gemini.app/Contents/Helpers/agy` and sign in with your Google account (subscription, no API key).';
const ROLES = ['Helper', 'Facilitator', 'Admin', 'Tester'];
const MAX_LINE_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_RESULT = 12000;
const validId = value => typeof value === 'string' && value.length <= 512 && /^[a-zA-Z0-9][a-zA-Z0-9_.:@/-]*$/.test(value) ? value : null;
const bounded = (value, max = MAX_RESULT) => typeof value === 'string' ? value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, max) : '';

async function executable(file) {
  if (!file || !path.isAbsolute(file)) return null;
  try {
    await access(file, constants.X_OK);
    return (await stat(file)).isFile() ? file : null;
  } catch { return null; }
}

async function fromPath(name, environment) {
  for (const directory of String(environment.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = await executable(path.resolve(directory, name));
    if (candidate) return candidate;
  }
  return null;
}

async function discoverCodex({ codexPath, env = process.env } = {}) {
  if (codexPath) return executable(codexPath);
  return await fromPath('codex', env) || await executable('/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
}

async function discoverClaude({ claudePath, env = process.env, home = homedir() } = {}) {
  if (claudePath) return executable(claudePath);
  const conventional = await fromPath('claude', env) || await executable(path.join(home, '.local', 'bin', 'claude'));
  if (conventional) return conventional;
  // Bounded enumeration of Claude Desktop's public binary cache only. Never
  // recurse through the home directory or open authentication files.
  const cache = path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code');
  const versions = (await readdir(cache, { withFileTypes: true }).catch(() => [])).filter(entry => entry.isDirectory() && /^\d[\w.-]*$/.test(entry.name)).sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true })).slice(0, 12);
  for (const version of versions) {
    const directory = path.join(cache, version.name);
    const builds = (await readdir(directory, { withFileTypes: true }).catch(() => [])).filter(entry => entry.isDirectory() && /^[a-zA-Z0-9._-]+$/.test(entry.name)).slice(0, 16);
    for (const build of builds) {
      const candidate = await executable(path.join(directory, build.name, 'claude.app', 'Contents', 'MacOS', 'claude'));
      if (candidate) return candidate;
    }
  }
  return null;
}

// Gemini runs through Antigravity's agy CLI on the user's Google subscription login. No API keys.
async function discoverGemini({ geminiPath } = {}) {
  return executable(geminiPath || AGY_PATH);
}

// Subscription login check: `agy models` only succeeds when signed in. API-key env vars are ignored on purpose.
export async function geminiAuthenticated({ geminiPath, check, env = process.env } = {}) {
  const bin = geminiPath || AGY_PATH;
  if (check) return !!(await check(bin));
  return new Promise(resolve => execFile(bin, ['models'], { env: childEnvironment(env), timeout: 30000, maxBuffer: 256 * 1024 }, (error, stdout) => resolve(!error && /gemini-/i.test(String(stdout)))));
}

// Lowest weekly remaining percentage from the usage bridge quota snapshot.
export function weeklyRemaining(quota, provider) {
  const windows = quota?.[provider]?.windows;
  if (!Array.isArray(windows)) return null;
  const weekly = windows.filter(win => /^weekly/i.test(win?.name || '') && Number.isFinite(win.remainingPercent)).map(win => win.remainingPercent);
  return weekly.length ? Math.min(...weekly) : null;
}
// Codex has no quota limit (user, 2026-11-02 19:59 SGT): use it until its weekly quota is actually exhausted.
// Claude keeps the old low-quota rule. Free reset credits are never used.
const isLow = (quota, provider) => { const left = weeklyRemaining(quota, provider); if (left == null) return false; return provider === "codex" ? left <= 0 : left < LOW_QUOTA_PERCENT; };
export function routeTask(task, quota) {
  const requested = String(task.provider || 'any').toLowerCase();
  const pauseReason = watchHoldReason(task);
  if (pauseReason) return { eligible: [], reason: pauseReason };
  if ((task.huddleRetry?.active || task.kind === 'resolution') && resolutionPaused(task)) return { eligible: [], reason: 'User-paused task.' };
  if (task.kind === 'resolution') return { eligible: ['codex', 'claude'].includes(requested) ? [requested] : [] };
  // Keep this before quota, balance and review rules: no rule may reroute a
  // user-assigned external bot card to a local coding process.
  if (requested === 'grok-bot') return { eligible: [], reason: GROK_BOT_PENDING_REASON };
  const review = task.kind === 'review';
  // An exhausted reviewer must wait; switching providers could select the author.
  if (review && CODERS.includes(requested) && weeklyRemaining(quota, requested) !== null && weeklyRemaining(quota, requested) <= 0) {
    return { eligible: [], reason: `${LABELS[requested]} weekly quota is exhausted; this cross review waits for its independent reviewer.` };
  }
  if (requested === 'local-qwen') {
    const reason = localQwenTaskError(task);
    return reason ? { eligible: [], reason } : { eligible: ['local-qwen'] };
  }
  if (requested === 'gemini') {
    if (isReviewLike(task)) return { eligible: [], reason: 'Gemini does research only; it does not review or pre-review. Reviews go to Codex (Claude work) or Claude (Codex work).' };
    return isBalance(task)
      ? { eligible: [], reason: "Game balance is owned by Codex; Gemini does not write balance proposals. Re-create this as a Codex task." }
      : { eligible: ["gemini"] };
  }
  const codexOut = isLow(quota, "codex");
  // Game balance is owned fully by Codex: never rerouted to Claude; waits only when Codex is exhausted.
  if (!review && isBalance(task)) return codexOut ? { eligible: [], reason: "Game balance is owned by Codex, whose weekly quota is exhausted; waiting." } : { eligible: ["codex"], ...(requested !== "codex" ? { reroute: "codex" } : {}) };
  if (codexOut && requested === "codex") {
    if (review) return { eligible: [], reason: "Codex weekly quota is exhausted; this cross review waits for Codex (ask the owner at the deploy gate)." };
    if (!isLow(quota, "claude") || task.priority === "high") return { eligible: ["claude"], reroute: "claude" };
    return { eligible: [], reason: "Codex weekly quota is exhausted and Claude Code is below 20%; waiting." };
  }
  const lowOk = key => !isLow(quota, key) || task.priority === "high" || review;
  if (requested === "any") { const eligible = CODERS.filter(lowOk); return { eligible, reason: eligible.length ? null : "Codex is exhausted and Claude Code is below 20% weekly quota; only high-priority or review work runs now." }; }
  if (!CODERS.includes(requested)) return { eligible: [] };
  if (lowOk(requested)) return { eligible: [requested] };
  if (!review && lowOk(OTHER[requested])) return { eligible: [OTHER[requested]], reroute: OTHER[requested] };
  return { eligible: [], reason: `${LABELS[requested]} is below 20% weekly quota; waiting (only high-priority or review work runs on it).` };
}

function runAuthCheck(file, args, environment) {
  return new Promise(resolve => {
    execFile(file, args, { env: environment, timeout: 6000, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout) => resolve({ success: !error, stdout: bounded(stdout, 64 * 1024) }));
  });
}

export async function probeTaskProviders(options = {}) {
  const environment = childEnvironment(options.env || process.env);
  const paths = await Promise.all([discoverCodex(options), discoverClaude(options)]);
  const geminiPath = await discoverGemini(options);
  const gemini = !geminiPath ? { available: false, authenticated: false, label: LABELS.gemini, reason: 'Antigravity agy CLI was not found at /Applications/Gemini.app/Contents/Helpers/agy.', path: null }
    : await geminiAuthenticated({ geminiPath, check: options.geminiCheck, env: environment }) ? { available: true, authenticated: true, label: LABELS.gemini, reason: null, path: geminiPath }
    : { available: true, authenticated: false, label: LABELS.gemini, reason: GEMINI_LOGIN_REASON, needsLogin: true, path: geminiPath };
  const entries = await Promise.all(['codex', 'claude'].map(async (provider, index) => {
    const binary = paths[index];
    if (!binary) return [provider, { available: false, authenticated: false, label: LABELS[provider], reason: `${LABELS[provider]} CLI was not found.`, path: null }];
    const checked = await runAuthCheck(binary, provider === 'codex' ? ['login', 'status'] : ['auth', 'status', '--json'], environment);
    let authenticated = false;
    if (provider === 'codex') authenticated = checked.success;
    else {
      try { const value = JSON.parse(checked.stdout); authenticated = checked.success && (value.loggedIn === true || value.logged_in === true); } catch {}
    }
    return [provider, { available: true, authenticated, label: LABELS[provider], reason: authenticated ? null : `Sign in to ${LABELS[provider]} to enable task pickup.`, path: binary }];
  }));
  const qwen = await localQwen.probe();
  return { ...Object.fromEntries(entries), gemini, 'local-qwen': { available: qwen.online, authenticated: qwen.installed, label: LABELS['local-qwen'], reason: !qwen.online ? 'Ollama offline.' : !qwen.installed ? `${LOCAL_QWEN_MODEL} is not installed.` : null } };
}

async function validateProject(projectPath) {
  if (typeof projectPath !== 'string' || !projectPath.trim()) return { valid: false, reason: 'Add a project folder before this task can be picked up.' };
  if (!path.isAbsolute(projectPath) || /[\x00\r\n]/.test(projectPath)) return { valid: false, reason: 'The project folder must be an existing absolute path.' };
  try {
    const canonical = await realpath(projectPath);
    if (!(await stat(canonical)).isDirectory()) return { valid: false, reason: 'The project path must point to a folder.' };
    return { valid: true, projectPath: path.resolve(projectPath), canonical };
  } catch { return { valid: false, reason: 'The project folder does not exist or cannot be opened.' }; }
}

const RESEARCH_FIRST = `\n\nResearch first: if you need outside facts (docs, APIs, prices, references), do not browse yourself. Request a lookup by creating a Gemini research task: node "${path.resolve(import.meta.dirname, '..', 'scripts', 'office-board.mjs')}" add-task '{"provider":"gemini","title":"Research: <topic>","description":"<exact questions>"}'. Notes appear in ai-office/reports/research/. If Gemini is not logged in (status shows "needs login") or the answer is needed immediately, search yourself and say so in the summary.`;

// User rule 2026-11-03: every worker should split its own task and run the
// independent parts in parallel instead of doing them one after another.
const PARALLEL_FIRST = `\n\nSplit and parallelize: before starting, decide whether this task breaks into independent parts (separate files, modules, checks, or questions). If it does, use native sub-agents when the runtime exposes them (Codex collaboration tools or Claude Agent), or parallel tool calls, then combine and verify the results yourself. This task explicitly authorizes useful delegation. Keep at most two native sub-agents active per worker; they share the provider quota, not an extra allowance. Do not invent unsupported spawning commands. If native sub-agents are unavailable, delegate substantial independent work through separate office board tasks instead. Parts that edit files in parallel each need their own git worktree; never let two parallel parts edit the same folder. If a part is large enough to be its own board task, add it with office-board.mjs add-task and include the parent task ID in its description, assign the appropriate provider and role, and give code-writing tasks their own worktree folder as projectPath (the board runs only one code-writing task per folder at a time). Gemini research tasks can share the research notes folder. Check office-board.mjs status first for runtime.parallelCapabilities, current workers and quota; only delegate a board child when its independent provider slot is available. If all slots are occupied, use a native sub-agent within your limit or complete the dependent work yourself; never occupy every parent worker waiting for queued children. Do not create duplicate cards for an existing assignment, and wait for delegated results before reporting the parent done. Keep small or tightly coupled work in one stream; do not split just to split.`;

const PARALLEL_RESEARCH = ' If there are several questions, split them and run the searches in parallel rather than one by one.';

export function researchPrompt(task) {
  return `${GROK_COMMUNICATION_POLICY}\n\nYou are the AI Office research and logistics assistant (read-only). Look things up for the team.\n\nTitle: ${bounded(task.title || task.name, 500)}\n\nQuestions:\n${bounded(task.description || task.brief, 20000)}\n\nUse web search and fetch to find current, sourced answers.${PARALLEL_RESEARCH} You cannot edit files or run commands; do not try. Never write game balance proposals or numbers; game balance is owned by Codex. Reply with a concise Markdown research note: a short answer first, then key findings with source links, then open questions. Do not include credentials or private data.\n`;
}

export function taskPrompt(task) {
  if (task.kind === 'resolution') return investigationPrompt(task);
  if (task.provider === 'gemini' || task.kind === 'research') return researchPrompt(task) + recoveryPrompt(task);
  return `${GROK_COMMUNICATION_POLICY}\n\nYou are carrying out one task claimed from the user's AI Office task board.\nTask ID: ${bounded(task.id || '', 240)}\n\nTitle: ${bounded(task.title || task.name, 500)}\n\nTask description:\n${bounded(task.description || task.brief, 20000)}\n\nWork within the assigned project folder and complete this task only.${(task.kind || 'task') === 'task' && (task.assignee?.provider || task.provider) === 'claude' ? ' Unless the task names a branch, commit on a branch named pending-acceptance/<short-slug> (never main); it waits there for an independent Codex review. Run the project analyze and full test suite and only report done when they pass.' : ''} Follow the project's existing instructions and permission rules. Do not deploy, publish, merge, or change account/security settings unless this task explicitly requests that action. If required permission, information, authentication, or a tool is unavailable, report the task as blocked. Verify your work with appropriate project checks.\n\nYour final response must be one JSON object with exactly these fields: {"status":"done" or "blocked","summary":"A concise description of the result, verification, and any blocker."}. Only use done when the requested work is complete. Do not put tool logs, reasoning, credentials, or raw command output in the summary.${recoveryPrompt(task)}${PARALLEL_FIRST}${RESEARCH_FIRST}\n`;
}

function completion(text) {
  try {
    const value = JSON.parse(text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, '$1'));
    if (!['done', 'blocked'].includes(value.status) || typeof value.summary !== 'string' || !value.summary.trim()) return null;
    return { status: value.status, result: bounded(value.summary.trim()), ...(value.unblock && ['resume', 'repair', 'needs_user'].includes(value.unblock.action) && typeof value.unblock.nextAction === 'string' ? { unblock: { action: value.unblock.action, nextAction: bounded(value.unblock.nextAction, 2000) } } : {}) };
  } catch { return null; }
}

function terminateOwned(child, signal, platform) {
  if (!Number.isSafeInteger(child?.pid) || child.pid <= 1 || child.pid === process.pid || child.exitCode != null || child.signalCode != null) return;
  try {
    // Every real child is spawned detached on POSIX, so this group belongs only
    // to that run and its descendants. Never signal a searched/guessed PID.
    if (platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) { if (error.code !== 'ESRCH') { try { child.kill(signal); } catch {} } }
}

// Bounded independent workers. Coding tasks still require separate worktrees;
// Gemini research is read-only and saves a distinct note for each task.
export const PROVIDER_CONCURRENCY = Object.freeze({ claude: 3, codex: 2, gemini: 2, 'local-qwen': 1 });
export function maxConcurrentFor(provider, limits = PROVIDER_CONCURRENCY) {
  if (provider === 'local-qwen') return 1;
  const value = Number(limits?.[provider]);
  return Number.isSafeInteger(value) && value >= 1 ? Math.min(value, 8) : 1;
}

export function createTaskRunner({ store, onChange = () => {}, codexPath, claudePath, geminiPath, quotaReader = () => null, env = process.env, home = homedir(), spawnProcess = nativeSpawn, probeProviders, qwenClient = localQwen, projectValidator = validateProject, pollIntervalMs = 2000, heartbeatMs = 15000, authRefreshMs = 60000, taskTimeoutMs = 120 * 60 * 1000, killGraceMs = 1500, platform = process.platform, terminate = terminateOwned, now = Date.now, providerConcurrency = PROVIDER_CONCURRENCY } = {}) {
  if (!store?.snapshot || !store?.claimTask || !store?.heartbeat || !store?.finishTask) throw new Error('A task store with claim, heartbeat and finish methods is required.');
  const running = new Map();
  let started = false, timer = null, pumping = null, lastProbe = -Infinity, pending = [], stopping = null;
  let providers = Object.fromEntries(Object.entries(LABELS).map(([key, label]) => [key, { available: false, authenticated: false, label, reason: 'Checking local CLI availability.', path: null }]));
  const checkProviders = probeProviders || (() => probeTaskProviders({ codexPath, claudePath, geminiPath, env, home }));
  const notify = () => { try { onChange(status()); } catch {} };

  function status() {
    const jobs = [...running.values()].filter(job => !job.finished);
    const publicProviders = Object.fromEntries(Object.entries(LABELS).map(([key, label]) => [key, { available: !!providers[key]?.available, authenticated: !!providers[key]?.authenticated, label, reason: providers[key]?.reason || null, ...(key === 'gemini' ? { needsLogin: !!providers[key]?.available && !providers[key]?.authenticated } : {}) }]));
    const agents = jobs.filter(job => job.sessionId).map(job => {
      const role = job.task.assignee?.role || (job.task.role !== 'any' && job.task.role) || 'Helper';
      return { id: job.provider === 'claude' ? `${job.sessionId}:main` : job.sessionId, sessionId: job.sessionId, agentType: 'office-task-runner', name: `${LABELS[job.provider]} task worker`, provider: LABELS[job.provider], status: 'working', cwd: job.projectPath, tool: null, updatedAt: new Date(job.startedAt).toISOString(), isSubagent: false, observed: true, taskId: job.task.id, role, agentRole: role };
    });
    const coding = jobs.filter(job => !['gemini', 'local-qwen'].includes(job.provider) && job.task.kind !== 'review').length;
    const reviewing = jobs.filter(job => job.task.kind === 'review').length, research = jobs.filter(job => job.provider === 'gemini').length;
    const support = jobs.filter(job => job.provider === 'local-qwen').length;
    const active = { total: jobs.length, coding, reviewing, research, support, label: support ? `实际同时工作: ${coding} 写代码 + ${reviewing} 审查 + ${research} 研究 + ${support} 杂活` : `实际同时工作: ${coding} 写代码 + ${reviewing} 审查 + ${research} 研究` };
    return { started, active, parallelCapabilities: parallelCapabilities({ providers: publicProviders, limits: Object.fromEntries(Object.keys(LABELS).map(key => [key, maxConcurrentFor(key, providerConcurrency)])) }), autoPickup: store.snapshot({ recoverLeases: false }).settings?.autoPickup !== false, providers: publicProviders, running: jobs.map(job => ({ taskId: job.task.id, kind: job.task.kind || 'task', provider: job.provider, workerId: job.workerId, sessionId: job.sessionId || null, startedAt: new Date(job.startedAt).toISOString(), lastProgressAt: new Date(job.lastProgressAt ?? job.startedAt).toISOString() })), agents, pending: pending.map(item => ({ ...item })) };
  }

  function finish(job, outcome) {
    if (job.finished) return;
    job.finished = true;
    clearTimeout(job.timeout); clearTimeout(job.killTimer); clearInterval(job.heartbeat);
    running.delete(job.task.id);
    try { store.finishTask(job.task.id, job.token, outcome); } catch {}
    job.resolveDone();
    notify();
    if (started) queueMicrotask(() => { kick().catch(() => {}); });
  }

  function cancel(job, reason) {
    if (job.finished || job.abortReason) return;
    job.abortReason = reason;
    // Keep the concurrency slot until HTTP cancellation has settled.
    if (job.abortController) { job.abortController.abort(); return; }
    try { terminate(job.child, 'SIGTERM', platform); } catch {}
    if (job.finished) return;
    job.killTimer = setTimeout(() => {
      try { terminate(job.child, 'SIGKILL', platform); } catch {}
      finish(job, { status: 'blocked', result: '', error: reason });
    }, Math.max(1, killGraceMs));
  }

  function consumeEvent(job, event) {
    if (!event || typeof event !== 'object' || job.finished) return;
    const sessionId = job.provider === 'codex' && event.type === 'thread.started' ? validId(event.thread_id) : job.provider === 'claude' && ['system', 'result'].includes(event.type) ? validId(event.session_id) : null;
    if (sessionId && !job.sessionId) { job.sessionId = sessionId; notify(); }
    if (job.provider === 'gemini') {
      // agy --output-format json prints one object: {status, response, usage, conversation_id}
      if (event.conversation_id && !job.sessionId) { const id = validId(event.conversation_id); if (id) { job.sessionId = id; notify(); } }
      if (typeof event.status === 'string') {
        job.completed = event.status === 'SUCCESS' && typeof event.response === 'string';
        if (job.completed) { job.finalText = bounded(event.response, MAX_LINE_BYTES); job.usage = event.usage || null; }
        else job.failure = `Gemini (agy) reported ${event.status}. Check that Antigravity is signed in.`;
      }
    } else if (job.provider === 'codex') {
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') job.finalText = bounded(event.item.text, MAX_LINE_BYTES);
      if (event.type === 'turn.completed') job.completed = true;
      if (event.type === 'turn.failed' || event.type === 'error') job.failure = 'Codex reported an execution failure. Check its local session for details.';
    } else if (event.type === 'result') {
      job.completed = event.is_error !== true && (!event.subtype || event.subtype === 'success');
      if (job.completed) job.finalText = event.structured_output ? JSON.stringify(event.structured_output) : bounded(event.result, MAX_LINE_BYTES);
      else job.failure = 'Claude Code reported an execution failure. Check its local session for details.';
    }
  }

  async function saveResearch(job) {
    const note = String(job.finalText || '').trim();
    if (!note) return { status: 'blocked', result: '', error: 'Gemini returned an empty research note.' };
    const date = new Date(now()).toISOString().slice(0, 10);
    const slug = String(job.task.title || 'research').toLowerCase().replace(/^research:\s*/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'research';
    await mkdir(job.projectPath, { recursive: true });
    const file = path.join(job.projectPath, `${date}-${slug}-${createHash('sha256').update(String(job.task.id)).digest('hex').slice(0, 16)}.md`);
    await writeFile(file, `# ${job.task.title}\n\n_Gemini research · task ${job.task.id} · ${new Date(now()).toISOString()}_\n\n${note}\n`);
    return { status: 'done', result: bounded(`Research note: ${file}\n\n${note}`, 6000), error: '' };
  }

  // Codex reasoning effort: ultra only for game balance and pre-merge/pre-deploy review; high otherwise.
  function codexEffortFor(task) { return (task.kind === 'review' || isReviewLike(task) || isBalance(task)) ? 'ultra' : 'high'; }
  function launchLocal(task, token, project) {
    const job = { task, token, provider: 'local-qwen', workerId: task.assignee.id, projectPath: project.canonical, startedAt: now(), sessionId: `local-qwen:${task.id}`, finished: false, abortController: new AbortController() };
    job.done = new Promise(resolve => { job.resolveDone = resolve; });
    running.set(task.id, job);
    job.timeout = setTimeout(() => cancel(job, 'Local Qwen timed out; retry explicitly.'), Math.min(taskTimeoutMs, 180000));
    job.heartbeat = setInterval(() => {
      try { if (store.heartbeat(task.id, token) === false) cancel(job, 'Local Qwen claim expired.'); }
      catch { cancel(job, 'Local Qwen claim expired.'); }
    }, Math.max(1, Math.min(heartbeatMs, 20000)));
    job.timeout.unref?.(); job.heartbeat.unref?.();
    Promise.resolve().then(() => qwenClient.run(task, { signal: job.abortController.signal }))
      .then(result => finish(job, job.abortReason ? { status: 'blocked', result: '', error: job.abortReason } : { status: 'done', result, error: '' }), () => finish(job, { status: 'blocked', result: '', error: job.abortReason || 'Local Qwen failed or was cancelled. Check Ollama and retry explicitly.' }));
    notify();
  }

  function launch(task, token, provider, project) {
    if (provider === 'local-qwen') return launchLocal(task, token, project);
    const workerId = task.assignee?.id || task.claimedBy?.id || task.worker?.id || task._runnerWorkerId;
    const job = { task, token, provider, workerId, projectPath: project.canonical, startedAt: now(), sessionId: null, finalText: '', completed: false, failure: null, finished: false, abortReason: null, child: null };
    job.done = new Promise(resolve => { job.resolveDone = resolve; });
    running.set(task.id, job);
    const args = provider === 'gemini' ? ['-p', taskPrompt(task), '--mode', 'plan', '--output-format', 'json', '--print-timeout', '600s', '--model', geminiModelFor(task)] : provider === 'codex' ? ['exec', '--json', ...codexSubagentArgs(task), '-c', `model_reasoning_effort="${codexEffortFor(task)}"`, '--dangerously-bypass-approvals-and-sandbox', '-C', project.canonical, '-'] : ['--print', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
    if (task.kind === 'resolution') {
      if (provider === 'codex') args.splice(args.indexOf('--dangerously-bypass-approvals-and-sandbox'), 1, '--sandbox', 'read-only', '--skip-git-repo-check', '-c', 'approval_policy="never"');
      else if (provider === 'claude') args.splice(args.indexOf('--dangerously-skip-permissions'), 1, '--permission-mode', 'plan', '--tools', 'Read,Glob,Grep', '--allowedTools', 'Read,Glob,Grep');
    }
    let child;
    try {
      child = spawnProcess(providers[provider].path, args, { cwd: project.canonical, env: provider === 'gemini' ? { ...childEnvironment(env), PATH: [path.dirname(providers[provider].path), env.PATH].filter(Boolean).join(path.delimiter) } : childEnvironment(env), shell: false, detached: platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      job.child = child;
    } catch {
      finish(job, { status: 'blocked', result: '', error: `${LABELS[provider]} could not be started. Check the local CLI installation.` });
      return;
    }
    const decoder = new StringDecoder('utf8');
    let buffer = '', skippingLine = false, outputBytes = 0;
    const parseLine = line => { try { consumeEvent(job, JSON.parse(line)); } catch {} };
    child.stdout?.on('data', chunk => {
      if (job.finished) return;
      if (chunk.length) job.lastProgressAt = now();
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > MAX_OUTPUT_BYTES) { cancel(job, 'The agent exceeded the local output processing limit. Retry the task explicitly.'); return; }
      const lines = decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)).split('\n');
      for (let index = 0; index < lines.length; index++) {
        const part = lines[index];
        if (!skippingLine) buffer += part;
        if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) { skippingLine = true; buffer = ''; }
        if (index < lines.length - 1) {
          if (!skippingLine && buffer.trim()) parseLine(buffer);
          buffer = ''; skippingLine = false;
        }
      }
    });
    // Drain stderr but never retain or expose CLI logs, provider messages, tool
    // arguments/results, reasoning or authentication output through the board.
    child.stderr?.on('data', () => {});
    child.stdin?.on('error', () => {});
    child.on('error', () => finish(job, { status: 'blocked', result: '', error: `${LABELS[provider]} could not be started. Check the local CLI installation.` }));
    child.on('close', code => {
      if (job.finished) return;
      buffer += decoder.end();
      if (!skippingLine && buffer.trim() && Buffer.byteLength(buffer) <= MAX_LINE_BYTES) parseLine(buffer);
      if (job.abortReason) { finish(job, { status: 'blocked', result: '', error: job.abortReason }); return; }
      if (code !== 0 || !job.completed || job.failure) { finish(job, { status: 'blocked', result: '', error: job.failure || `${LABELS[provider]} ended without a successful completion. Check its local session for details.` }); return; }
      if (provider === 'gemini') { saveResearch(job).then(saved => finish(job, saved), () => finish(job, { status: 'blocked', result: bounded(job.finalText), error: 'The research note could not be saved.' })); return; }
      const outcome = completion(job.finalText);
      if (!outcome) { finish(job, { status: 'blocked', result: bounded(job.finalText), error: 'The agent ended without a structured completion confirmation. Review its result before retrying.' }); return; }
      finish(job, { ...outcome, error: outcome.status === 'blocked' ? 'The agent reported a blocker. See its result for details.' : '' });
    });
    job.timeout = setTimeout(() => cancel(job, 'The task execution time limit was reached. Retry the task explicitly if needed.'), Math.max(1, Math.min(taskTimeoutMs, 120 * 60 * 1000)));
    job.timeout.unref?.();
    job.heartbeat = setInterval(() => {
      try { if (store.heartbeat(task.id, token) === false) cancel(job, 'The task claim was cancelled or expired. Retry the task explicitly if needed.'); }
      catch { cancel(job, 'The task claim could not be renewed. Retry the task explicitly if needed.'); }
    }, Math.max(1, Math.min(heartbeatMs, 20000)));
    job.heartbeat.unref?.();
    try { child.stdin?.end(taskPrompt(task)); }
    catch { cancel(job, 'The task could not be delivered to the local agent. Retry explicitly if needed.'); }
    notify();
  }

  async function pump() {
    if (!started) return status();
    if (now() - lastProbe >= authRefreshMs) {
      try { providers = await checkProviders(); } catch { providers = Object.fromEntries(Object.entries(LABELS).map(([key, label]) => [key, { available: false, authenticated: false, label, reason: 'Local CLI authentication could not be checked.', path: null }])); }
      lastProbe = now();
      notify();
    }
    if (!started) return status();
    const snapshot = store.snapshot();
    pending = (snapshot.tasks || []).filter(task => task.status === 'pending' && task.provider === 'grok-bot').map(task => ({ taskId: task.id, reason: GROK_BOT_PENDING_REASON }));
    if (snapshot.settings?.autoPickup === false) return status();
    const tasks = [...(snapshot.tasks || [])].sort((a, b) => ({high:0,normal:1,low:2}[a.priority] ?? 1) - ({high:0,normal:1,low:2}[b.priority] ?? 1) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a.id).localeCompare(String(b.id)));
    for (const task of tasks) {
      if (!started || task.status !== 'pending' || task.provider === 'grok-bot') continue;
      let quota = null; try { quota = quotaReader(); } catch {}
      const route = routeTask(task, quota);
      // A discussed retry can wait in the queue. Concrete assignments stay pinned.
      // A user reply to an 'any' task keeps its original provider preference and
      // may select either suitable coder, subject to fresh quota checks.
      const managed = task.huddleRetry?.active || task.kind === 'resolution';
      const flexibleHumanAssignment = task.provider === 'any' && task.kind !== 'resolution' && task.humanGate?.state === 'answered' && Boolean(task.humanReply);
      const eligible = managed ? route.eligible.filter(key => (flexibleHumanAssignment || key === task.provider) && huddleQuota(key, quota, task, now()).allowed) : route.eligible;
      if (managed && !eligible.length) { pending.push({ taskId: task.id, reason: route.reason || (flexibleHumanAssignment ? route.eligible.map(key => `${LABELS[key]}: ${huddleQuota(key, quota, task, now()).reason}`).join(' ') : huddleQuota(task.provider, quota, task, now()).reason) || 'Waiting for a suitable provider with fresh quota.' }); continue; }
      if (!eligible.length && route.reason) { pending.push({ taskId: task.id, reason: route.reason }); continue; }
      const provider = eligible.find(key => providers[key]?.available && providers[key]?.authenticated && (key === 'local-qwen' || providers[key]?.path) && [...running.values()].filter(job => !job.finished && job.provider === key).length < maxConcurrentFor(key, providerConcurrency));
      const textOnlyLocal = task.provider === 'local-qwen' && !task.projectPath && !localQwenTaskError(task);
      const project = textOnlyLocal ? { valid: true, projectPath: '', canonical: '' } : await projectValidator(task.projectPath);
      if (!started || store.snapshot().settings?.autoPickup === false) break;
      if (!project.valid) { pending.push({ taskId: task.id, reason: project.reason }); continue; }
      if (!provider && eligible[0] === 'local-qwen') { pending.push({ taskId: task.id, reason: providers['local-qwen']?.reason || 'Waiting for the local Qwen worker to finish.' }); continue; }
      if (!provider && eligible[0] === 'gemini') { pending.push({ taskId: task.id, reason: providers.gemini?.reason || 'Waiting for the Gemini research desk.' }); continue; }
      if (!provider) { pending.push({ taskId: task.id, reason: eligible.some(key => [...running.values()].filter(job => !job.finished && job.provider === key).length >= maxConcurrentFor(key, providerConcurrency)) ? 'Waiting for a matching local worker to finish.' : 'Waiting for an authenticated matching Claude Code or Codex CLI.' }); continue; }
      if (!['local-qwen', 'gemini'].includes(provider) && [...running.values()].some(job => !['local-qwen', 'gemini'].includes(job.provider) && job.projectPath === project.canonical)) { pending.push({ taskId: task.id, reason: 'Another task is already working in this project folder.' }); continue; }
      if (managed) {
        const latest = store.snapshot({ recoverLeases: false }).tasks.find(item => item.id === task.id);
        let currentQuota = null; try { currentQuota = quotaReader(); } catch {}
        const checkedQuota = huddleQuota(provider, currentQuota, task, now());
        if (!latest || latest.version !== task.version || latest.status !== 'pending' || !checkedQuota.allowed) {
          pending.push({ taskId: task.id, reason: checkedQuota.allowed ? 'Task changed while validating its project; checking again next cycle.' : checkedQuota.reason }); continue;
        }
      }
      const worker = { id: `office-${provider}-${randomUUID()}`, provider, name: `${LABELS[provider]} task worker`, roles: [...ROLES], projectPath: textOnlyLocal ? '' : project.projectPath || path.resolve(task.projectPath) };
      if (route.reroute && !flexibleHumanAssignment) {
        try { store.updateTask(task.id, { provider: route.reroute }); } catch { continue; }
      }
      let claimed;
      try { claimed = store.claimTask(worker, { taskId: task.id }); } catch { continue; }
      if (!claimed?.task || !claimed.claimToken) { pending.push({ taskId: task.id, reason: 'Waiting for a matching role or an available project claim.' }); continue; }
      launch({ ...claimed.task, _runnerWorkerId: worker.id }, claimed.claimToken, provider, project);
    }
    notify();
    return status();
  }

  function kick() {
    if (!pumping) pumping = pump().finally(() => { pumping = null; });
    return pumping;
  }

  async function start() {
    if (started) return status();
    if (stopping) await stopping;
    if (started) return status();
    started = true;
    lastProbe = -Infinity;
    timer = setInterval(() => { kick().catch(() => {}); }, Math.max(10, pollIntervalMs));
    timer.unref?.();
    await kick();
    return status();
  }

  function stop() {
    if (stopping) return stopping;
    started = false;
    clearInterval(timer); timer = null;
    stopping = (async () => {
      if (pumping) await pumping.catch(() => {});
      const jobs = [...running.values()];
      for (const job of jobs) cancel(job, 'The office runner stopped. This task will not restart automatically; retry it explicitly if needed.');
      await Promise.all(jobs.map(job => job.done));
      notify();
    })().finally(() => { stopping = null; });
    return stopping;
  }

  return { start, stop, kick, status };
}
