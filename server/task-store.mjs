import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, realpathSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';

import { REVIEW_POLICY, MAX_REPAIR_ROUNDS, parseReviewVerdict, reviewScopeFingerprint, reviewCompletionFingerprint, reviewWorkHold, reviewRepairDescription } from './review-policy.mjs';
import { isHighRisk, PRE_REVIEW_SUFFIX } from './division-policy.mjs';
import { localQwenTaskError } from './local-qwen-policy.mjs';
import { blockingKey, meetingScope, meetingBlocked, meetingBarrierAllows, parseMeetingDecisions } from './blocked-meeting-policy.mjs';
import { watchHoldReason, watchOwners, watchFingerprint, WATCH_RECIPIENTS } from './watch-task-policy.mjs';
// Versioned atomic deployment gate; ownership is stored only as a hash.
export const MAINTENANCE_PROTOCOL = 1;
import { resolutionPaused } from './resolution-policy.mjs';
import { huddleInputHash, huddleFingerprint, huddleRetryHold, HUDDLE_MAX_RETRIES } from './huddle-policy.mjs';
import { PREPARE_ACTION, preparationScope, parsePreparationApproval } from './scoped-approval.mjs';
import { humanRequestFingerprint, humanRequestSpec, humanRequestHold, explicitApproval } from './human-relay-policy.mjs';
const PROVIDERS = ['any', 'codex', 'claude', 'grok', 'grok-bot', 'gemini', 'local-qwen'];
// Text assistance and external Grok Bot work do not hold the coding-folder lock.
// Grok Bot still serializes its own claims within the same project.
const projectLockKey = task => task.provider === 'gemini' ? `provider:gemini:${task.id}` : task.provider === 'local-qwen' ? 'provider:local-qwen' : task.provider === 'grok-bot' ? `provider:grok-bot:${task.projectPath}` : task.projectPath;
const KINDS = ['task', 'review', 'research', 'resolution'];
// Gemini is the read-only research desk. Its tasks always lock this notes folder,
// never a product repo, so research runs alongside coding work.
export const RESEARCH_DIR = path.resolve(import.meta.dirname, '..', 'reports', 'research');
// Cross review: the provider that wrote the code never does its final QA.
export const REVIEWER_FOR = { claude: 'codex', codex: 'claude' };
export function reviewTaskFor(task, preReview = null, reviewerFor = REVIEWER_FOR) {
  if (task?.source === 'qwen-watch') return null;
  const author = task?.assignee?.provider;
  if (task?.status !== 'done' || (task.kind || 'task') !== 'task' || !reviewerFor[author] || !task.projectPath) return null;
  const risk = isHighRisk(task) ? 'high' : 'ordinary';
  const pre = preReview ? `\n\nGemini pre-review (read-only, ${preReview.status}):\n${String(preReview.result || preReview.error || '').slice(0, 4000)}` : '';
  return {
    title: `Review: ${String(task.title || '').slice(0, 220)}`,
    description: `Cross review of task ${task.id}, written by ${author === 'claude' ? 'Claude Code' : 'Codex'}. You are the independent reviewer and did not write this code.\n\n1. Read the branch diff / recent commits for this work (git status, git diff, git log).\n2. Run the project's analyze and test commands.\n3. Do NOT rewrite or extend the feature. Either approve, or write concrete fix notes (file, problem, suggested fix).\n4. Report status "done" with "APPROVED: ..." or "FIX NOTES: ..." in the summary; use "blocked" only if you could not review.\n\nOriginal task description:\n${String(task.description || '').slice(0, 12000)}\n\nAuthor summary:\n${String(task.result || '').slice(0, 4000)}${pre}\nRisk: ${risk}`,
    projectPath: task.projectPath, provider: reviewerFor[author], role: 'Tester', priority: author === 'claude' && risk === 'ordinary' ? 'normal' : 'high', kind: 'review', reviewOf: task.id,
  };
}
const ROLES = ['any', 'Facilitator', 'Admin', 'Helper', 'Tester', 'Manager'];
const PRIORITIES = ['normal', 'high', 'low'];
const TEXT_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const own = (object, key) => Object.hasOwn(object || {}, key);

export class TaskBoardError extends Error {
  constructor(message, code = 'VALIDATION', status = 400) { super(message); this.name = 'TaskBoardError'; this.code = code; this.status = status; }
}
const fail = (message, code = 'VALIDATION', status = 400) => { throw new TaskBoardError(message, code, status); };
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : fail('Expected a JSON object.');
function text(value, name, max, required = false) {
  if (value == null && !required) return '';
  if (typeof value !== 'string' || value.length > max || TEXT_CONTROL.test(value)) fail(`${name} must be text up to ${max} characters.`);
  const result = value.trim();
  if (required && !result) fail(`${name} is required.`);
  return result;
}
function choice(value, name, allowed, fallback) { const result = value ?? fallback; return allowed.includes(result) ? result : fail(`Invalid ${name}.`); }
function identity(value, name = 'ID') { const result = text(value, name, 240, true); return /^[a-zA-Z0-9][a-zA-Z0-9_.:@/-]*$/.test(result) ? result : fail(`Invalid ${name}.`); }
function maintenanceOwner(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) fail('Maintenance owner token must be a UUID.');
  return value;
}
const tokenHash = token => createHash('sha256').update(token).digest('hex');
function sameToken(token, hash) {
  if (typeof token !== 'string' || token.length > 256 || !hash) return false;
  const a = Buffer.from(tokenHash(token)), b = Buffer.from(hash);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function normalizeTaskProject(value, requireExists = false) {
  const project = text(value, 'Project path', 4096);
  if (!project) return '';
  if (!path.isAbsolute(project)) fail('Project path must be absolute.');
  try {
    const normalized = realpathSync(project);
    if (!statSync(normalized).isDirectory()) fail('Project path must be a directory.');
    return normalized;
  } catch (error) {
    if (error instanceof TaskBoardError) throw error;
    if (requireExists) fail('Project directory is unavailable.');
    return path.resolve(project);
  }
}

export function createTaskStore(options = {}) {
  const home = path.resolve(options.home || process.env.AI_OFFICE_HOME || path.join(homedir(), '.ai-office'));
  const dbPath = options.dbPath || path.join(home, 'board.sqlite');
  const existingDatabase = existsSync(dbPath);
  const now = options.now || Date.now;
  const researchDir = path.resolve(options.researchDir || RESEARCH_DIR);
  const crossReview = options.crossReview !== false;
  const leaseMs = options.leaseMs ?? 60000;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 3600000) fail('Invalid claim lease duration.');
  mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,record TEXT NOT NULL,status TEXT NOT NULL,project_key TEXT NOT NULL,assignee_id TEXT,claim_hash TEXT,lease_until INTEGER,management_id TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS running_project ON tasks(project_key) WHERE status='running' AND project_key<>'';
    CREATE UNIQUE INDEX IF NOT EXISTS running_worker ON tasks(assignee_id) WHERE status='running' AND assignee_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS watch_provider_choices(task_id TEXT NOT NULL,provider TEXT NOT NULL,version INTEGER NOT NULL,action TEXT NOT NULL,PRIMARY KEY(task_id,provider));
    CREATE TABLE IF NOT EXISTS watch_receipts(provider TEXT PRIMARY KEY,record TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS watch_retries(task_id TEXT NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(task_id,fingerprint));
    CREATE TABLE IF NOT EXISTS blocked_meetings(key TEXT PRIMARY KEY,record TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS roles(id TEXT PRIMARY KEY,record TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS instructions(id TEXT PRIMARY KEY,record TEXT NOT NULL,plan_applied INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1),record TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS maintenance(id INTEGER PRIMARY KEY CHECK(id=1),owner_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS human_requests(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,state TEXT NOT NULL,record TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS human_replies(message_id TEXT PRIMARY KEY,request_id TEXT NOT NULL,reply_hash TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS human_requests_task ON human_requests(task_id);
    CREATE TABLE IF NOT EXISTS office_huddle(id INTEGER PRIMARY KEY CHECK(id=1),record TEXT NOT NULL);
    INSERT OR IGNORE INTO settings(id,record) VALUES(1,'{"autoPickup":true}');`);
  const maintenanceRow = () => db.prepare('SELECT owner_hash FROM maintenance WHERE id=1').get();
  const maintenanceStatus = () => ({ protocol: MAINTENANCE_PROTOCOL, active: Boolean(maintenanceRow()) });
  const stamp = () => new Date(now()).toISOString();
  const transaction = callback => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = callback(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const rowFor = id => db.prepare('SELECT * FROM tasks WHERE id=?').get(identity(id));
  const requestFor = id => { const row = db.prepare('SELECT record FROM human_requests WHERE id=?').get(identity(id)); return row ? JSON.parse(row.record) : fail('Human question not found.', 'NOT_FOUND', 404); };
  const writeRequest = value => { db.prepare('INSERT INTO human_requests(id,task_id,state,record) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,record=excluded.record').run(value.id, value.taskId, value.state, JSON.stringify(value)); return value; };
  const taskFor = id => { const row = rowFor(id); return row ? JSON.parse(row.record) : fail('Task not found.', 'NOT_FOUND', 404); };
  const instructionFor = id => { const row = db.prepare('SELECT * FROM instructions WHERE id=?').get(identity(id)); return row ? { row, instruction: JSON.parse(row.record) } : fail('Management instruction not found.', 'NOT_FOUND', 404); };
  function writeTask(task, fields = {}) {
    const previous = rowFor(task.id);
    db.prepare(`INSERT INTO tasks(id,record,status,project_key,assignee_id,claim_hash,lease_until,management_id) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET record=excluded.record,status=excluded.status,project_key=excluded.project_key,assignee_id=excluded.assignee_id,claim_hash=excluded.claim_hash,lease_until=excluded.lease_until,management_id=excluded.management_id`).run(task.id, JSON.stringify(task), task.status, fields.projectKey ?? previous?.project_key ?? projectLockKey(task), own(fields, 'assigneeId') ? fields.assigneeId : previous?.assignee_id ?? null, own(fields, 'claimHash') ? fields.claimHash : previous?.claim_hash ?? null, own(fields, 'leaseUntil') ? fields.leaseUntil : previous?.lease_until ?? null, task.managementRequestId || null);
    return task;
  }
  function recoverExpired() {
    return transaction(() => {
      for (const row of db.prepare("SELECT * FROM tasks WHERE status='running' AND lease_until<=?").all(now())) {
        const task = JSON.parse(row.record);
        writeTask(reviewInterrupted({ ...task, status: 'blocked', error: 'Worker lease expired. Review the project before explicitly retrying this task.', updatedAt: stamp(), version: task.version + 1 }), { claimHash: null, leaseUntil: null });
      }
    });
  }
  function normalizeTask(input, meta = {}) {
    object(input);
    const provider = choice(input.provider, 'provider', PROVIDERS, 'any');
    if (provider === 'grok') fail('Use a management instruction for Grok management, or grok-bot for externally executed Grok Bot tasks.');
    const localError = provider === 'local-qwen' && localQwenTaskError(input);
    if (localError) fail(localError);
    const approvalAction = input.approvalAction == null ? null : choice(input.approvalAction, 'approval action', [PREPARE_ACTION]);
    if (approvalAction && !['any', 'codex', 'claude'].includes(provider)) fail('Scoped preparation requires a coding worker.');
    if (own(input, 'parked') && typeof input.parked !== 'boolean') fail('parked must be true or false.');
    const createdAt = stamp();
    const kind = provider === 'gemini' ? 'research' : choice(input.kind === 'research' ? 'task' : input.kind, 'kind', KINDS, 'task');
    if (provider === 'gemini') mkdirSync(researchDir, { recursive: true });
    if (approvalAction && kind !== 'task') fail('Scoped preparation requires an ordinary coding task.');
    const reviewOf = kind === 'review' && typeof input.reviewOf === 'string' ? text(input.reviewOf, 'Reviewed task', 200) : null;
    return { id: meta.id || randomUUID(), kind, reviewOf, ...(approvalAction ? { approvalAction } : {}), title: text(input.title, 'Title', 240, true), description: text(input.description, 'Description', 20000), projectPath: provider === 'gemini' ? researchDir : normalizeTaskProject(input.projectPath), provider, ...(provider === 'local-qwen' ? { supportType: input.supportType } : {}), role: choice(input.role, 'role', ROLES, 'any'), priority: choice(input.priority, 'priority', PRIORITIES, 'normal'), status: approvalAction ? 'blocked' : 'pending', ...(own(input, 'parked') ? { parked: input.parked } : {}), source: ['grok', 'qwen-watch', 'qwen-huddle'].includes(meta.source) ? meta.source : 'user', managementRequestId: meta.managementRequestId || null, assignee: null, result: '', error: approvalAction ? 'Approval required: prepare_sanitized_snapshot.' : '', createdAt, updatedAt: createdAt, version: 1 };
  }
  const maybeTask = id => { const row = id && rowFor(id); return row ? JSON.parse(row.record) : null; };
  const reviewEditable = task => task && ['done', 'blocked'].includes(task.status) && !resolutionPaused(task) &&
    !humanRequestHold(task) && task.reviewState !== 'stale' && task.completionSource !== 'manual';
  function currentRepairRoot(task) {
    const binding = task.repairBinding, root = maybeTask(task.repairOf);
    return binding?.policy === REVIEW_POLICY && reviewEditable(root) && root.reviewPolicy === REVIEW_POLICY &&
      root.reviewRepairTaskId === task.id && reviewCompletionFingerprint(root) === binding.rootFingerprint &&
      task.provider === binding.author && reviewScopeFingerprint(task) === binding.scopeFingerprint ? root : null;
  }
  function currentReviewParents(task) {
    const binding = task.reviewBinding;
    if (binding?.policy !== REVIEW_POLICY || reviewScopeFingerprint(task) !== binding.scopeFingerprint) return null;
    const parent = maybeTask(task.reviewOf), root = maybeTask(binding.rootId);
    if (!reviewEditable(parent) || !reviewEditable(root) || parent.reviewPolicy !== REVIEW_POLICY || root.reviewPolicy !== REVIEW_POLICY ||
      parent.reviewTaskId !== task.id || root.reviewTaskId !== task.id ||
      reviewCompletionFingerprint(parent) !== binding.parentFingerprint || reviewCompletionFingerprint(root) !== binding.rootFingerprint ||
      parent.assignee?.provider !== binding.author || task.provider !== binding.reviewer || binding.author === binding.reviewer) return null;
    return { parent, root, binding };
  }
  const reviewRelatives = id => db.prepare('SELECT record FROM tasks').all().map(row => JSON.parse(row.record))
    .filter(child => child.id !== id && (child.repairOf === id || child.reviewOf === id || child.reviewBinding?.rootId === id));
  function cancelIntermediateReview(task) {
    if (task.status === 'done' && task.reviewPolicy === REVIEW_POLICY && task.reviewState === 'pending')
      writeTask({ ...task, reviewState: 'stale', reviewTaskId: null, error: 'The independent review was cancelled; this completed repair has no current approval.', updatedAt: stamp(), version: task.version + 1 });
  }
  function stopReviewChildren(task) {
    for (const child of reviewRelatives(task.id)) {
      if (['pending', 'blocked'].includes(child.status))
        writeTask({ ...child, status: 'blocked', paused: true, error: 'Review follow-up cancelled: the user changed the original task.', updatedAt: stamp(), version: child.version + 1 });
      else cancelIntermediateReview(child);
    }
  }
  function invalidateReviewParent(task) {
    const root = maybeTask(task.repairOf || task.reviewBinding?.rootId);
    // Removing historical evidence is not revoking an already applied verdict.
    if (root?.reviewState === 'approved' || task.status === 'done' && task.reviewApplied === true) return;
    const parent = maybeTask(task.reviewOf);
    if (parent && parent.id !== root?.id && parent.reviewTaskId === task.id) cancelIntermediateReview(parent);
    const linkedReview = maybeTask(root?.reviewTaskId);
    const activeLink = root && ([root.reviewTaskId, root.reviewRepairTaskId].includes(task.id) || linkedReview?.reviewOf === task.id);
    if (root?.reviewPolicy === REVIEW_POLICY && root.status !== 'deleted' && !resolutionPaused(root) && !humanRequestHold(root) && activeLink)
      writeTask({ ...root, status: 'blocked', reviewState: 'stale', reviewTaskId: null, reviewRepairTaskId: null, reviewCancelledTaskId: task.id, error: 'The linked review or repair was changed or stopped by the user. Inspect the updated scope before explicitly requesting the original task again.', updatedAt: stamp(), version: root.version + 1 });
  }
  function staleReviewFollowup(task) {
    invalidateReviewParent(task);
    return { ...task, status: 'blocked', reviewPolicy: REVIEW_POLICY, reviewState: 'stale',
      error: 'The review follow-up no longer matches its completed task or authorized scope. Inspect the original task and request it explicitly; this card will not run automatically.' };
  }
  const boundScopeChanged = task => (task.repairBinding || task.reviewBinding) &&
    reviewScopeFingerprint(task) !== (task.repairBinding || task.reviewBinding).scopeFingerprint;
  const clearReview = { reviewPolicy: undefined, reviewState: undefined, reviewTaskId: undefined, reviewRepairTaskId: undefined,
    reviewRepairRound: undefined, reviewCancelledTaskId: undefined, reviewFeedback: undefined, reviewCompletedAt: undefined, reviewRepairResult: undefined };
  function applyReviewResult(finished) {
    const verdict = finished.status === 'done' ? parseReviewVerdict(finished.result) : null;
    const observed = { ...finished, reviewVerdict: verdict || (finished.status === 'blocked' ? 'blocked' : 'unconfirmed') };
    const current = currentReviewParents(finished);
    if (!current || finished.assignee?.provider !== current.binding.reviewer) return { ...observed, reviewApplied: false };
    const { parent, root, binding } = current;
    const feedback = finished.result.slice(0, 6000);
    let state = verdict || 'blocked', repairId = null, round = binding.round;
    const description = reviewRepairDescription(root, finished, round + 1);
    if (crossReview && verdict === 'changes_requested' && round < MAX_REPAIR_ROUNDS && !root.approvalAction && !root.humanReply?.approvalScope && root.humanReply?.kind !== 'approval' && description) {
      round++;
      repairId = `${root.id}:repair:${binding.rootFingerprint.slice(0, 12)}:${round}`;
      if (!rowFor(repairId)) {
        const repair = normalizeTask({ title: `Repair ${round}: ${root.title}`.slice(0, 240),
          description, projectPath: root.projectPath,
          provider: root.assignee.provider, role: root.role, priority: root.priority }, { id: repairId });
        writeTask({ ...repair, repairOf: root.id, repairRound: round, repairReviewId: finished.id,
          repairBinding: { policy: REVIEW_POLICY, rootFingerprint: binding.rootFingerprint, author: root.assignee.provider,
            scopeFingerprint: reviewScopeFingerprint(repair) } });
      }
    }
    const patch = { status: verdict === 'approved' ? 'done' : 'blocked', reviewPolicy: REVIEW_POLICY, reviewState: state,
      reviewTaskId: finished.id, reviewRepairTaskId: repairId, reviewRepairRound: round, reviewFeedback: feedback,
      reviewCompletedAt: stamp(), error: verdict === 'approved' ? '' : verdict === 'changes_requested'
        ? 'Independent review requested changes. Follow the linked repair or inspect the review before an explicit retry.'
        : 'Independent review is incomplete or has no explicit verdict. Inspect the linked review; acceptance is unconfirmed.' };
    if (parent.id !== root.id) writeTask({ ...parent, ...patch, ...(repairId ? { status: 'done', reviewState: 'superseded' } : {}), updatedAt: stamp(), version: parent.version + 1 });
    writeTask({ ...root, ...patch, ...(verdict === 'approved' && parent.id !== root.id ? { reviewRepairResult: { taskId: parent.id, result: parent.result, reviewId: finished.id } } : {}),
      updatedAt: stamp(), version: root.version + 1 });
    return { ...observed, reviewApplied: true };
  }
  function reviewInterrupted(task) {
    if (task.reviewBinding) return applyReviewResult(task);
    const root = task.repairBinding && currentRepairRoot(task);
    if (root) writeTask({ ...root, reviewState: 'blocked', error: 'The linked repair stopped before confirmed completion. Inspect its blocker before retrying.', updatedAt: stamp(), version: root.version + 1 });
    return task;
  }
  function queueIndependentReview(finished) {
    if (finished.status !== 'done' || finished.id.endsWith(PRE_REVIEW_SUFFIX)) return finished;
    const root = finished.repairOf ? currentRepairRoot(finished) : finished;
    if (!root) return { ...finished, status: 'blocked', reviewPolicy: REVIEW_POLICY, reviewState: 'stale',
      error: 'Repair completed after its original task or binding changed. Its result is preserved, but cannot update or approve the original task.' };
    const specification = crossReview ? reviewTaskFor(finished, null, options.reviewerFor) : null;
    if (!specification) {
      if (!finished.repairOf) return finished;
      const error = 'Repair finished, but no independent review could be queued with the current review configuration. Approval remains unconfirmed; inspect the result and configure a reviewer before explicitly continuing.';
      writeTask({ ...root, status: 'blocked', reviewState: 'blocked', reviewTaskId: null, reviewRepairTaskId: null, error, updatedAt: stamp(), version: root.version + 1 });
      return { ...finished, reviewPolicy: REVIEW_POLICY, reviewState: 'blocked', reviewTaskId: null, error };
    }
    const fingerprint = reviewCompletionFingerprint(finished), rootFingerprint = reviewCompletionFingerprint(root);
    const firstId = `${finished.id}:review`;
    const id = rowFor(firstId) ? `${firstId}:${fingerprint.slice(0, 12)}` : firstId;
    if (!rowFor(id)) {
      const review = normalizeTask(specification, { id });
      writeTask({ ...review, reviewBinding: { policy: REVIEW_POLICY, parentFingerprint: fingerprint, rootId: root.id,
        rootFingerprint, author: finished.assignee.provider, reviewer: review.provider, round: finished.repairRound || 0,
        scopeFingerprint: reviewScopeFingerprint(review) } });
    }
    if (root.id !== finished.id) writeTask({ ...root, reviewState: 'pending', reviewTaskId: id, updatedAt: stamp(), version: root.version + 1 });
    return { ...finished, reviewPolicy: REVIEW_POLICY, reviewState: 'pending', reviewTaskId: id };
  }

  function roleRecord(input) {
    object(input);
    const name = text(input.name, 'Role name', 160, true);
    if (input.provider != null && input.provider !== 'grok') fail('Management roles belong to Grok.');
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'management';
    return { id: input.id ? identity(input.id) : `grok-role-${slug}`, name, description: text(input.description, 'Role description', 4000), provider: 'grok' };
  }
  function saveRole(role) { db.prepare('INSERT INTO roles(id,record) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record').run(role.id, JSON.stringify(role)); return role; }
  function saveInstruction(instruction, applied) {
    db.prepare('UPDATE instructions SET record=?,plan_applied=COALESCE(?,plan_applied) WHERE id=?').run(JSON.stringify(instruction), applied == null ? null : Number(applied), instruction.id);
    return instruction;
  }
  function normalizeWorker(input) {
    object(input);
    const id = identity(input.id, 'Worker ID');
    const providers = [...new Set((Array.isArray(input.providers) ? input.providers : [input.provider]).filter(value => PROVIDERS.includes(value) && value !== 'any'))];
    if (!providers.length) fail('Worker must declare an execution provider.');
    // External bots must opt into their own lane explicitly. Mixed declarations
    // cannot let a coding worker claim bot cards, or a bot absorb wildcard work.
    if (providers.includes('grok-bot') && (input.provider !== 'grok-bot' || providers.length !== 1)) fail('Grok Bot workers must declare only the grok-bot provider explicitly.');
    const roles = [...new Set((Array.isArray(input.roles) ? input.roles : [input.role || 'any']).map(value => choice(value, 'worker role', ROLES, 'any')))];
    const paths = Array.isArray(input.projectPaths) ? input.projectPaths : [input.projectPath];
    const projectPaths = [...new Set(paths.filter(Boolean).map(value => normalizeTaskProject(value, true)))];
    return { id, name: text(input.name || id, 'Worker name', 200, true), provider: choice(input.provider, 'worker provider', providers, providers[0]), providers, roles, projectPaths };
  }
  function claimedRow(id, token) {
    const row = rowFor(id);
    if (!row) fail('Task not found.', 'NOT_FOUND', 404);
    if (row.status !== 'running' || !sameToken(token, row.claim_hash)) fail('This task claim is no longer active.', 'CLAIM_CONFLICT', 409);
    return row;
  }

  function syncHumanRequests() {
    return transaction(() => {
      const tasks = db.prepare('SELECT record FROM tasks').all().map(row => JSON.parse(row.record));
      const taskMap = new Map(tasks.map(task => [task.id, task]));
      for (const row of db.prepare('SELECT record FROM human_requests').all()) {
        const request = JSON.parse(row.record), task = taskMap.get(request.taskId);
        if (task?.status === 'deleted') continue;
        if (['pending', 'delivered', 'denied'].includes(request.state) && (!task || task.status !== 'blocked' || resolutionPaused(task) || humanRequestFingerprint(task) !== request.fingerprint)) {
          writeRequest({ ...request, state: 'stale', updatedAt: stamp() });
          if (task?.humanGate?.requestId === request.id && task.status === 'blocked') {
            const updated = writeTask({ ...task, humanGate: { ...task.humanGate, state: 'stale' }, version: task.version + 1 });
            taskMap.set(task.id, updated);
          }
        }
      }
      for (const task of taskMap.values()) {
        let spec = humanRequestSpec(task);
        if (!spec && task.status === 'blocked' && !resolutionPaused(task) && task.humanGate?.state === 'stale') {
          const previous = requestFor(task.humanGate.requestId);
          if (previous.approvalScope || task.approvalAction) continue;
          const fingerprint = humanRequestFingerprint(task);
          const question = `任务「${task.title}」已经更新，旧回复不能用于新版本。请重新回答以下未解决事项：\n${previous.question.slice(0, 2600)}`;
          spec = { kind: previous.kind, requiresUserAction: previous.requiresUserAction, question, fingerprint, questionHash: createHash('sha256').update(JSON.stringify([task.id, fingerprint, previous.kind, question])).digest('hex') };
        }
        if (!spec) continue;
        const id = `human:${createHash('sha256').update(task.id + spec.fingerprint).digest('hex').slice(0, 32)}`;
        const row = db.prepare('SELECT record FROM human_requests WHERE id=?').get(id);
        const request = row ? JSON.parse(row.record) : writeRequest({ id, taskId: task.id, taskTitle: task.title,
          taskVersion: task.version, ...spec, state: 'pending', requestedBy: 'local-qwen', relay: 'grok-bot',
          createdAt: stamp(), updatedAt: stamp(), delivery: null, answer: null });
        if (!['pending', 'delivered', 'denied'].includes(request.state)) continue;
        if (task.humanGate?.requestId !== id || task.humanGate?.state !== request.state) writeTask({ ...task,
          humanGate: { requestId: id, kind: request.kind, state: request.state, fingerprint: spec.fingerprint },
          resolution: { ...task.resolution, humanRequestId: id, state: request.state === 'denied' ? 'user_denied' : 'needs_user', nextAction: task.resolution?.nextAction || (task.error || task.result || '等待用户补充此任务缺少的具体信息。').slice(0, 2000) },
          version: task.version + 1 });
      }
      return db.prepare('SELECT record FROM human_requests ORDER BY rowid').all().map(row => JSON.parse(row.record)).filter(request => taskMap.get(request.taskId)?.status !== 'deleted');
    });
  }

  const watchRetryAvailable = task => !reviewWorkHold(task) && !watchHoldReason(task) && !resolutionPaused(task) && !humanRequestHold(task) && !humanRequestSpec(task) && db.prepare('SELECT count(*) AS total FROM watch_retries WHERE task_id=?').get(task.id).total < 2
    && !db.prepare('SELECT task_id FROM watch_retries WHERE task_id=? AND fingerprint=?').get(task.id, watchFingerprint(task));
  const meetingBarrierClear = () => {
    const records = new Map(db.prepare('SELECT record FROM blocked_meetings').all().map(row => JSON.parse(row.record)).map(record => [record.key, record]));
    return db.prepare("SELECT record FROM tasks WHERE status='blocked'").all().map(row => JSON.parse(row.record)).filter(meetingBlocked).every(task => meetingBarrierAllows(task, records.get(blockingKey(task)), watchRetryAvailable(task)));
  };
  if (options.autoPickup === false) {
    // Only initialize a new store; existing explicit settings remain untouched.
    if (!existingDatabase) db.prepare('UPDATE settings SET record=? WHERE id=1').run(JSON.stringify({ autoPickup: false }));
  }
  recoverExpired();
  return {
    dbPath,
    close() { db.close(); },
    snapshot({ recoverLeases = true } = {}) {
      if (recoverLeases) recoverExpired();
      const tasks = db.prepare('SELECT record FROM tasks ORDER BY rowid DESC').all().map(row => { const task = JSON.parse(row.record); return resolutionPaused(task) ? { ...task, resolution: { owner: 'local-qwen', state: 'paused', nextAction: '用户已暂停或任务已被替代，保留记录，不自动运行。' } } : task; });
      const roles = db.prepare('SELECT record FROM roles ORDER BY id').all().map(row => JSON.parse(row.record));
      const instructions = db.prepare('SELECT record FROM instructions ORDER BY rowid DESC').all().map(row => JSON.parse(row.record));
      const humanRequests = db.prepare('SELECT record FROM human_requests ORDER BY rowid DESC').all().map(row => JSON.parse(row.record));
      return { tasks: tasks.filter(task => task.status !== 'deleted'), deletedTasks: tasks.filter(task => task.status === 'deleted'), roles, instructions, maintenance: maintenanceStatus(), humanRequests: humanRequests.filter(request => !tasks.some(task => task.id === request.taskId && task.status === 'deleted')), settings: JSON.parse(db.prepare('SELECT record FROM settings WHERE id=1').get().record), updatedAt: stamp() };
    },
    acquireMaintenance(ownerToken) {
      maintenanceOwner(ownerToken);
      return transaction(() => {
        const row = maintenanceRow();
        if (row && !sameToken(ownerToken, row.owner_hash)) fail('Maintenance is owned by another deployment.', 'MAINTENANCE_CONFLICT', 409);
        if (!row) db.prepare('INSERT INTO maintenance(id,owner_hash) VALUES(1,?)').run(tokenHash(ownerToken));
        return maintenanceStatus();
      });
    },
    releaseMaintenance(ownerToken) {
      maintenanceOwner(ownerToken);
      return transaction(() => {
        const row = maintenanceRow();
        if (row && !sameToken(ownerToken, row.owner_hash)) fail('Maintenance is owned by another deployment.', 'MAINTENANCE_CONFLICT', 409);
        db.prepare('DELETE FROM maintenance WHERE id=1').run();
        return maintenanceStatus();
      });
    },
    syncHumanRequests,
    rerequestHumanRequest(id, input = {}) {
      object(input); syncHumanRequests();
      return transaction(() => {
        const request = requestFor(id), task = taskFor(request.taskId);
        if (input.source !== 'office-ui') fail('Re-request must come from an explicit office user action.');
        const operationId = identity(input.operationId, 'Re-request operation ID');
        if (request.rerequest?.operationId === operationId && request.rerequest.previousHash === input.questionHash) return { request, task, applied: false };
        if (input.questionHash !== request.questionHash) fail('Question binding does not match.', 'VERSION_CONFLICT', 409);
        if (!['pending', 'delivered', 'denied'].includes(request.state) || task.status !== 'blocked' || resolutionPaused(task)
          || humanRequestFingerprint(task) !== request.fingerprint || task.humanGate?.requestId !== id) fail('This question is no longer current.', 'VERSION_CONFLICT', 409);
        if ((request.rerequestCount || 0) >= 5) fail('This question has reached five re-requests. Reply with new information or a decision instead.', 'REREQUEST_LIMIT', 409);
        if (request.rerequest && now() - Date.parse(request.rerequest.at) < 60000) fail('Please wait one minute before requesting another check.', 'RETRY_COOLDOWN', 429);
        const count = (request.rerequestCount || 0) + 1;
        const questionHash = createHash('sha256').update(JSON.stringify([id, request.fingerprint, request.questionHash, count])).digest('hex');
        const updated = writeRequest({ ...request, state: 'pending', questionHash, rerequestCount: count,
          history: [...(request.history || []), { questionHash: request.questionHash, state: request.state, delivery: request.delivery, answer: request.answer, triage: request.triage, at: stamp() }].slice(-20),
          rerequest: { operationId, previousHash: request.questionHash, at: stamp(), source: 'office-ui' },
          requiresUserAction: request.requiresUserAction || request.state === 'denied', delivery: null, answer: null, triage: null, updatedAt: stamp() });
        const updatedTask = writeTask({ ...task, humanGate: { ...task.humanGate, state: 'pending' },
          resolution: { ...task.resolution, state: 'needs_user', nextAction: '用户重新请求 Grok 核查当前问题；不代表批准或允许直接重跑。' },
          version: task.version + 1 });
        return { request: updated, task: updatedTask, applied: true };
      });
    },
    triageHumanRequest(id, input = {}) {
      object(input); syncHumanRequests();
      return transaction(() => {
        const request = requestFor(id), task = taskFor(request.taskId);
        if (input.source !== 'grok-bot') fail('Only Grok Bot can record its triage.');
        if (input.questionHash !== request.questionHash) fail('Question binding does not match.', 'VERSION_CONFLICT', 409);
        if (!['pending', 'delivered'].includes(request.state) || task.status !== 'blocked' || resolutionPaused(task)
          || humanRequestFingerprint(task) !== request.fingerprint || task.humanGate?.requestId !== id) fail('This question is no longer current.', 'VERSION_CONFLICT', 409);
        const outcome = choice(input.outcome, 'triage outcome', ['resolved_info', 'needs_user']);
        const summary = text(input.summary, 'Triage findings', 4000, true);
        const evidence = text(input.evidence, 'Verification evidence', 4000, true);
        if (['userReply', 'userMessageId', 'replyAuthor', 'decision', 'projectPath'].some(key => own(input, key))) fail('Triage is not a user answer, approval, or permission to change the project.');
        if (outcome === 'resolved_info' && request.kind !== 'info') fail('Grok cannot resolve an approval request on the user behalf.');
        if (outcome === 'resolved_info' && (request.requiresUserAction || humanRequestSpec(task)?.requiresUserAction)) fail('Approval, prior refusal, login, permission and credential boundaries require the actual user; record needs_user instead.');
        const triage = { source: 'grok-bot', outcome, summary, evidence, checkedAt: stamp() };
        if (outcome === 'needs_user') {
          return { request: writeRequest({ ...request, triage, updatedAt: stamp() }), task, applied: false };
        }
        const inputHash = huddleInputHash(task), previous = task.huddleRetry?.inputHash === inputHash ? task.huddleRetry : null;
        if ((previous?.attempts || 0) >= HUDDLE_MAX_RETRIES) fail('Automatic recovery budget exhausted; record needs_user with the failed attempts instead.', 'RETRY_LIMIT', 409);
        // Keep the original project, review identity and authorization. Grok may
        // supply verified facts, never a synthetic human answer or new permission.
        const textOnlyLocal = task.provider === 'local-qwen' && !task.projectPath && !localQwenTaskError(task);
        if (!textOnlyLocal && !normalizeTaskProject(task.projectPath, true)) fail('Restore the original project before resolving this question.', 'MISSING_PROJECT', 409);
        const updatedRequest = writeRequest({ ...request, state: 'resolved', triage, updatedAt: stamp() });
        const updated = writeTask({ ...task, status: 'pending', humanGate: { ...task.humanGate, state: 'resolved' },
          grokTriage: { requestId: id, questionHash: request.questionHash, ...triage },
          huddleRetry: { ...previous, active: true, inputHash, provider: task.provider, attempts: (previous?.attempts || 0) + 1,
            fingerprints: [...(previous?.fingerprints || []), huddleFingerprint(task)], recoveryPlan: '',
            previousError: task.error.slice(0, 2000), previousResult: task.result.slice(-6000), lastAt: stamp(),
            reason: 'Grok 已核实所缺资料；负责人按证据调整方案、重新调试。此记录不是用户批准。' },
          resolution: { ...task.resolution, clearance: null, state: 'awaiting_capacity', nextAction: summary }, updatedAt: stamp(), version: task.version + 1 },
          { claimHash: null, leaseUntil: null, assigneeId: null, projectKey: projectLockKey(task) });
        return { request: updatedRequest, task: updated, applied: true };
      });
    },
    acknowledgeHumanRequest(id, input = {}) {
      object(input); syncHumanRequests();
      return transaction(() => {
        const request = requestFor(id);
        if (input.source !== 'grok-bot') fail('Only the Grok Bot relay can acknowledge delivery.');
        if (input.questionHash !== request.questionHash) fail('Question binding does not match.', 'VERSION_CONFLICT', 409);
        if (!['pending', 'delivered'].includes(request.state)) fail('This question is no longer awaiting delivery.', 'CONFLICT', 409);
        if (taskFor(request.taskId).status === 'deleted') fail('任务已删除，问题不再等待转告。', 'CONFLICT', 409);
        const messageId = identity(input.messageId, 'Delivered message ID');
        if (request.state === 'delivered') return request;
        const updated = writeRequest({ ...request, state: 'delivered', delivery: { source: 'grok-bot', messageId, deliveredAt: stamp() }, updatedAt: stamp() });
        const task = taskFor(request.taskId);
        writeTask({ ...task, humanGate: { ...task.humanGate, state: 'delivered' }, version: task.version + 1 });
        return updated;
      });
    },
    answerHumanRequest(id, input = {}) {
      object(input);
      return transaction(() => {
        const request = requestFor(id), task = taskFor(request.taskId);
        if (!['grok-bot', 'office-ui'].includes(input.source) || input.replyAuthor !== 'user') fail('The relay must provide an actual user reply, never its own approval.');
        if (input.questionHash !== request.questionHash) fail('Question binding does not match.', 'VERSION_CONFLICT', 409);
        const userMessageId = identity(input.userMessageId, 'User message ID');
        const userAction = input.source === 'office-ui' ? choice(input.userAction, 'user button action', ['provide_info', 'approve', 'deny', 'restored']) : null;
        const checkedReply = text(input.userReply, 'User reply', 8000, !!request.approvalScope && userAction !== 'deny' || !userAction || userAction === 'provide_info');
        const userReply = request.approvalScope && typeof input.userReply === 'string' ? input.userReply : checkedReply;
        const decision = choice(input.decision, 'human decision', ['provide_info', 'approve', 'deny']);
        if (request.kind === 'info' && decision === 'approve' || request.kind === 'approval' && decision === 'provide_info') fail('Information and approval are distinct; answer the actual question.');
        if (userAction && (userAction === 'restored' ? 'provide_info' : userAction) !== decision) fail('Button action and decision must match.');
        if (own(input, 'projectPath') && (request.kind !== 'info' || decision !== 'provide_info')) fail('A replacement project folder is allowed only for information replies when the original folder is unavailable.');
        const currentScope = preparationScope(task);
        if (JSON.stringify(request.approvalScope || null) !== JSON.stringify(currentScope && request.kind === 'approval' ? currentScope : null)) fail('Approval scope binding does not match; legacy requests are not migrated.', 'VERSION_CONFLICT', 409);
        const authorization = request.approvalScope && decision === 'approve' ? parsePreparationApproval(userReply) : null;
        if (decision === 'approve' && request.approvalScope && !authorization) fail('Scoped approval requires an explicit affirmative reply naming sanitized snapshot preparation; unrecognized clauses do not grant permission.');
        if (decision === 'approve' && !request.approvalScope && !(input.source === 'office-ui' && userReply === '') && !explicitApproval(userReply)) fail('Approval requires an explicit affirmative user reply for the exact action; partial or conditional legacy replies require explicit action binding.');
        if (request.approvalScope && input.source === 'grok-bot' && (!request.delivery || request.delivery.source !== 'grok-bot' || !request.delivery.messageId || !request.delivery.deliveredAt || request.delivery.messageId === userMessageId)) fail('Scoped approval requires distinct delivered message evidence.');
        const replyHash = createHash('sha256').update(JSON.stringify([id, request.questionHash, userReply, decision, input.projectPath ?? null, ...(userAction ? [userAction] : []), ...(request.approvalScope ? [input.source, input.replyAuthor, request.approvalScope] : [])])).digest('hex');
        const oldReply = db.prepare('SELECT * FROM human_replies WHERE message_id=?').get(userMessageId);
        if (oldReply) {
          if (oldReply.request_id === id && oldReply.reply_hash === replyHash) return { request, task, applied: false, duplicate: true };
          fail('This user message has already answered a different question.', 'CONFLICT', 409);
        }
        if (input.source === 'office-ui' ? !['pending', 'delivered'].includes(request.state) : request.state !== 'delivered' || !request.delivery) fail('Only a delivered, unanswered question can receive a reply.', 'CONFLICT', 409);
        if (task.status !== 'blocked' || resolutionPaused(task) || humanRequestFingerprint(task) !== request.fingerprint || task.humanGate?.requestId !== id) fail('Only a current, unanswered question can receive a reply; the task changed after this question.', 'VERSION_CONFLICT', 409);
        const textOnlyLocal = task.provider === 'local-qwen' && !task.projectPath && !localQwenTaskError(task);
        let existingProject = '';
        try { existingProject = normalizeTaskProject(task.projectPath, true); } catch {}
        let resolvedProject = existingProject;
        if (own(input, 'projectPath')) {
          if (request.kind !== 'info' || decision !== 'provide_info' || existingProject) fail('A replacement project folder is allowed only for information replies when the original folder is unavailable.');
          const provided = text(input.projectPath, 'User-provided project folder', 4096, true);
          if (!path.isAbsolute(provided) || !userReply.includes(provided)) fail('The replacement folder must be an absolute path explicitly present in the user reply.');
          resolvedProject = normalizeTaskProject(provided, true);
          if (!resolvedProject) fail('The replacement project folder must exist.');
        }
        if (decision !== 'deny' && !resolvedProject && !textOnlyLocal) fail('The project folder is still unavailable. Provide an existing projectPath explicitly quoted in the user reply, or restore the original folder.', 'MISSING_PROJECT', 409);
        const answeredAt = stamp(), state = decision === 'deny' ? 'denied' : 'answered';
        const pathEvidence = own(input, 'projectPath') ? { originalProjectPath: task.projectPath, providedProjectPath: input.projectPath, resolvedProjectPath: resolvedProject } : {};
        const answer = { source: input.source, replyAuthor: 'user', userMessageId, userReply, decision, ...(userAction ? { userAction } : {}), answeredAt, ...pathEvidence, ...(request.approvalScope ? { requestId: id, questionHash: request.questionHash, fingerprint: request.fingerprint, approvalScope: request.approvalScope, delivery: request.delivery, ...(authorization ? { authorization } : {}) } : {}) };
        const needsPreparationApproval = !!task.approvalAction && request.kind === 'info' && decision === 'provide_info';
        const resumedTask = { ...task, projectPath: resolvedProject || task.projectPath, ...(needsPreparationApproval ? { humanRevision: (task.humanRevision || 0) + 1 } : {}) };
        db.prepare('INSERT INTO human_replies(message_id,request_id,reply_hash) VALUES(?,?,?)').run(userMessageId, id, replyHash);
        const updatedRequest = writeRequest({ ...request, state, answer, updatedAt: answeredAt });
        const gate = { ...task.humanGate, state };
        let updated = decision === 'deny'
          ? { ...task, humanGate: gate, resolution: { ...task.resolution, state: 'user_denied', nextAction: '用户已拒绝此请求；保持受阻，等待用户主动修改指示。' } }
          : { ...resumedTask, status: needsPreparationApproval ? 'blocked' : 'pending', humanGate: gate, humanReply: { requestId: id, kind: request.kind, question: request.question, questionHash: request.questionHash, ...answer },
            huddleRetry: { ...task.huddleRetry, active: true, inputHash: huddleInputHash(resumedTask), provider: task.provider,
              previousError: task.error.slice(0, 2000), previousResult: task.result.slice(-6000), lastAt: answeredAt, reason: '用户已回复当前绑定问题，等待重新检查权限、额度和任务范围。' },
            resolution: { ...task.resolution, state: 'awaiting_capacity', nextAction: '用户已回复；重新检查额度、登录及并发位置后继续原任务。', humanRequestId: id } };
        if (decision === 'deny' && (task.repairBinding || task.reviewBinding)) invalidateReviewParent(task);
        if (decision !== 'deny' && boundScopeChanged(updated)) updated = staleReviewFollowup(updated);
        if (decision === 'deny') for (const row of db.prepare('SELECT record FROM tasks').all()) {
          const child = JSON.parse(row.record);
          if ((child.resolutionOf === task.id || child.reviewOf === task.id || child.repairOf === task.id || child.reviewBinding?.rootId === task.id || child.id === task.resolution?.investigationTaskId) && ['pending', 'blocked'].includes(child.status)) writeTask({ ...child, status: 'blocked', paused: true, updatedAt: answeredAt, version: child.version + 1 });
        }
        const result = writeTask({ ...updated, updatedAt: answeredAt, version: task.version + 1 }, { claimHash: null, leaseUntil: null, assigneeId: null, projectKey: projectLockKey(updated) });
        return { request: updatedRequest, task: result, applied: true };
      });
    },
    createTask(input, meta = {}) { const task = normalizeTask(input, meta); return transaction(() => writeTask(task)); },
    readHuddle() {
      const row = db.prepare('SELECT record FROM office_huddle WHERE id=1').get();
      return row ? JSON.parse(row.record) : null;
    },
    saveHuddle(state) {
      const record = JSON.stringify(object(state));
      if (Buffer.byteLength(record) > 256 * 1024) fail('Huddle report too large.');
      db.prepare('INSERT INTO office_huddle(id,record) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record').run(record);
    },
    recordResolution(id, { version, owner, state, nextAction, nextCheckAt }) {
      return transaction(() => {
        const task = taskFor(id);
        if (task.version !== version || task.status !== 'blocked') fail('Task changed during discussion.', 'VERSION_CONFLICT', 409);
        const fingerprint = huddleFingerprint(task), old = task.resolution?.fingerprint === fingerprint ? task.resolution : {};
        const resolution = { ...old, fingerprint, owner: choice(owner, 'resolution owner', [...PROVIDERS, 'local-qwen']),
          state: text(state, 'Resolution state', 80, true), nextAction: text(nextAction, 'Next action', 2000, true),
          checkedAt: stamp(), nextCheckAt: text(nextCheckAt, 'Next check', 100, true) };
        // A repeated follow-up is observation metadata, not changed work. Keep
        // optimistic edit versions stable while advancing the actual check time.
        const unchanged = old.fingerprint === fingerprint && old.owner === resolution.owner &&
          old.state === resolution.state && old.nextAction === resolution.nextAction;
        return writeTask({ ...task, resolution, version: task.version + (unchanged ? 0 : 1) });
      });
    },
    investigateBlockedTask(id, { version, provider, reason }) {
      return transaction(() => {
        const task = taskFor(id);
        if (task.version !== version || task.status !== 'blocked') fail('Task changed during discussion.', 'VERSION_CONFLICT', 409);
        if (humanRequestHold(task) || reviewWorkHold(task)) fail(humanRequestHold(task) || reviewWorkHold(task), 'CONFLICT', 409);
        if (resolutionPaused(task) || task.kind === 'resolution') fail('Cannot investigate a paused card or create recursive investigations.');
        if (JSON.parse(db.prepare('SELECT record FROM settings WHERE id=1').get().record).autoPickup === false) fail('Automatic pickup is paused.', 'CONFLICT', 409);
        if (!['claude', 'codex'].includes(provider)) fail('Investigations require a coding investigator.');
        const fingerprint = huddleFingerprint(task);
        const investigationId = `unblock:${createHash('sha256').update(task.id + huddleInputHash(task) + task.provider).digest('hex').slice(0, 32)}`;
        const existing = rowFor(investigationId);
        if (existing) {
          const old = JSON.parse(existing.record);
          if (old.investigationPolicy !== 2 && ['blocked', 'done'].includes(old.status) && !resolutionPaused(old)) {
            const renewed = writeTask({ ...old, provider, status: 'pending', investigationPolicy: 2,
              description: JSON.stringify({ taskId: task.id, title: task.title, provider: task.provider, projectPath: task.projectPath,
                request: task.description.slice(0, 10000), error: task.error.slice(0, 2000), priorResult: task.result.slice(-4000),
                previousDiagnosis: old.result.slice(-2500) }),
              resolutionFingerprint: fingerprint, result: '', error: '', updatedAt: stamp(), version: old.version + 1 },
              { assigneeId: null, claimHash: null, leaseUntil: null });
            writeTask({ ...task, resolution: { ...task.resolution, fingerprint, owner: provider, state: 'queued',
              investigationTaskId: old.id, nextAction: '按新行动要求复核一次：从失败经验提出修复方案，交回原任务执行；不重复空转排查。', checkedAt: stamp() }, version: task.version + 1 });
            return { task: renewed, created: true };
          }
          writeTask({ ...task, resolution: { ...task.resolution, fingerprint, owner: old.provider, state: 'needs_user', investigationTaskId: old.id,
            finding: old.result, nextAction: '同一任务已完成或尝试过排查，请按排查结论补充条件；不会重复生成排查卡。' }, version: task.version + 1 });
          return { task: old, created: false };
        }
        let projectPath;
        try { projectPath = normalizeTaskProject(task.projectPath, true); } catch {}
        if (!projectPath) { projectPath = path.join(home, 'unblock-investigations'); mkdirSync(projectPath, { recursive: true }); }
        const evidence = { taskId: task.id, title: task.title, provider: task.provider, kind: task.kind, projectPath: task.projectPath,
          request: task.description.slice(0, 10000), error: task.error.slice(0, 2000), priorResult: task.result.slice(-5000) };
        const child = { ...normalizeTask({ title: `排查受阻：${task.title}`.slice(0, 240), description: JSON.stringify(evidence).slice(0, 19500),
          provider, kind: 'resolution', role: 'Facilitator', projectPath, priority: task.priority }, { id: investigationId, source: 'qwen-huddle' }),
          investigationPolicy: 2, resolutionOf: task.id, resolutionFingerprint: fingerprint, resolutionOriginalProvider: task.provider };
        writeTask(child);
        writeTask({ ...task, resolution: { ...task.resolution, fingerprint, owner: provider, state: 'queued',
          investigationTaskId: child.id, nextAction: text(reason, 'Investigation reason', 2000, true), checkedAt: stamp() }, version: task.version + 1 });
        return { task: child, created: true };
      });
    },
    retryBlockedTask(id, { version, provider, reason }) {
      return transaction(() => {
        const task = taskFor(id);
        if (task.version !== version || task.status !== 'blocked') fail('Task changed during discussion.', 'VERSION_CONFLICT', 409);
        if (JSON.parse(db.prepare('SELECT record FROM settings WHERE id=1').get().record).autoPickup === false) fail('Automatic pickup is paused.', 'CONFLICT', 409);
        const hold = humanRequestHold(task) || reviewWorkHold(task) || huddleRetryHold(task);
        if (hold) fail(hold, 'CONFLICT', 409);
        const checked = normalizeTask({ ...task, provider });
        // Huddles may reroute coding providers, but never turn research, support,
        // external management or a review into a different kind of task.
        if (provider !== task.provider && !(provider === 'codex' || provider === 'claude') ||
            provider !== task.provider && !['any', 'codex', 'claude'].includes(task.provider)) fail('Invalid huddle reassignment.');
        if (task.repairOf && provider !== task.provider) fail('Review repair must keep its original author.');
        if (task.kind === 'review' && provider !== task.provider && task.provider !== 'any') fail('Independent review must keep its reviewer.');
        const inputHash = huddleInputHash(task), previous = task.huddleRetry?.inputHash === inputHash ? task.huddleRetry : null;
        const recoveryPlan = task.resolution?.fingerprint === huddleFingerprint(task) && task.resolution?.clearance ? task.resolution.nextAction : '';
        const huddleRetry = { inputHash, active: true, attempts: (previous?.attempts || 0) + 1, recoveryPlan,
          fingerprints: [...(previous?.fingerprints || []), huddleFingerprint(task)],
          lastAt: stamp(), provider, reason: text(reason, 'Dispatch reason', 1000, true),
          previousError: task.error.slice(0, 2000), previousResult: task.result.slice(-6000) };
        return writeTask({ ...task, provider: checked.provider, status: 'pending', huddleRetry, resolution: { ...task.resolution, owner: provider, state: 'queued', nextAction: recoveryPlan || reason }, updatedAt: stamp(), version: task.version + 1 },
          { projectKey: projectLockKey({ ...checked, id: task.id }), assigneeId: null, claimHash: null, leaseUntil: null });
      });
    },
    cardAction(id, input = {}, { syncQuestions = true } = {}) {
      object(input);
      const action = choice(input.action, 'card action', ['rerequest', 'delete', 'deny', 'restore']);
      if (syncQuestions) syncHumanRequests();
      const task = taskFor(id);
      if (!Number.isSafeInteger(input.version) || input.version !== task.version) fail('任务已更新，请刷新后重新选择。', 'VERSION_CONFLICT', 409);
      if (task.status === 'running') fail('任务正在执行，结束后才能操作。', 'CONFLICT', 409);
      const relatives = () => db.prepare('SELECT record FROM tasks').all().map(row => JSON.parse(row.record)).filter(child => child.resolutionOf === id || child.reviewOf === id || child.repairOf === id || child.reviewBinding?.rootId === id || child.id === task.resolution?.investigationTaskId);
      if (relatives().some(child => child.status === 'running')) fail('关联排查或审查正在执行，结束后再操作。', 'CONFLICT', 409);
      // Bound questions keep their existing approval, cooldown and delivery rules.
      if (['rerequest', 'deny'].includes(action) && task.humanGate && !['answered', 'resolved'].includes(task.humanGate.state)) {
        const question = requestFor(task.humanGate.requestId);
        if (input.questionHash !== question.questionHash) fail('问题已更新，请刷新后重新选择。', 'VERSION_CONFLICT', 409);
        if (action === 'rerequest') return this.rerequestHumanRequest(question.id, { source: 'office-ui', questionHash: input.questionHash, operationId: input.operationId });
        return this.answerHumanRequest(question.id, { source: 'office-ui', replyAuthor: 'user', questionHash: input.questionHash, userMessageId: input.operationId, decision: 'deny', userAction: 'deny', userReply: '' });
      }
      const outcome = transaction(() => {
        // Recheck inside the write lock: a worker may have claimed the card.
        const current = taskFor(id);
        if (current.version !== input.version || current.status === 'running' || relatives().some(child => child.status === 'running')) fail('任务已更新或正在执行，请刷新。', 'VERSION_CONFLICT', 409);
        let patch;
        if (action === 'delete') {
          if (current.status === 'deleted') fail('任务已经删除。', 'CONFLICT', 409);
          patch = { status: 'deleted', deletion: { at: stamp(), status: current.status, paused: current.paused === true }, paused: true };
        } else if (action === 'restore') {
          if (current.status !== 'deleted') fail('只能恢复已删除任务。', 'CONFLICT', 409);
          // Restore the record, never silently resume execution or remove a denial.
          const openGate = current.humanGate && !['answered', 'resolved'].includes(current.humanGate.state);
          patch = { status: current.deletion.status === 'done' && !(current.reviewPolicy === REVIEW_POLICY && current.reviewState !== 'approved') ? 'done' : 'blocked', paused: openGate ? current.deletion.paused : true, userStopped: current.userStopped || (openGate ? undefined : { previousPaused: current.deletion.paused, reason: 'restored' }), deletion: undefined };
        } else {
          if (!['pending', 'blocked'].includes(current.status)) fail('只有待办或受阻任务可以重新请求或拒绝。', 'CONFLICT', 409);
          if (action === 'deny') patch = { status: 'blocked', paused: true, userStopped: current.userStopped || { previousPaused: resolutionPaused(current), reason: 'denied' } };
          else {
            const resumable = { ...current, paused: current.userStopped?.previousPaused ?? current.paused };
            if (resolutionPaused(resumable)) fail('此任务已另行暂停，请先处理原暂停原因。', 'CONFLICT', 409);
            if (current.status === 'pending') fail('任务已在待办队列，无需重复请求。', 'CONFLICT', 409);
            if (current.repairBinding && !currentRepairRoot(current) || current.reviewBinding && !currentReviewParents(current)) fail('This review follow-up is stale; inspect and explicitly request the original task instead.', 'CONFLICT', 409);
            const needsQuestion = !!humanRequestSpec(resumable);
            patch = { status: needsQuestion ? 'blocked' : 'pending', ...(needsQuestion ? { humanGate: undefined, humanRevision: (current.humanRevision || 0) + 1 } : {}), paused: false, userStopped: undefined, ...(current.huddleRetry ? { huddleRetry: { ...current.huddleRetry, active: false } } : {}) };
          }
        }
        if (['delete', 'deny'].includes(action) && current.reviewPolicy === REVIEW_POLICY && current.reviewState !== 'approved')
          patch = { ...patch, reviewState: 'stale', reviewTaskId: null, reviewRepairTaskId: null };
        if (['delete', 'deny'].includes(action)) for (const child of relatives()) {
          if (['pending', 'blocked'].includes(child.status)) writeTask({ ...child, status: 'blocked', paused: true, version: child.version + 1, updatedAt: stamp() });
          else cancelIntermediateReview(child);
        }
        if (action === 'rerequest' && current.reviewPolicy === REVIEW_POLICY) {
          stopReviewChildren(current);
          patch = { ...patch, ...clearReview, humanRevision: (current.humanRevision || 0) + 1 };
        }
        if (['delete', 'deny'].includes(action) && (current.repairBinding || current.reviewBinding)) invalidateReviewParent(current);
        let changed = { ...current, ...patch };
        if (action === 'rerequest' && boundScopeChanged(changed)) changed = staleReviewFollowup(changed);
        const result = writeTask({ ...changed, cardAction: { action, at: stamp(), source: 'office-ui' }, updatedAt: stamp(), version: current.version + 1 }, { claimHash: null, leaseUntil: null });
        return { task: result, applied: true };
      });
      if (action === 'rerequest' && outcome.task.status === 'blocked') { syncHumanRequests(); outcome.task = taskFor(id); }
      return outcome;
    },
    updateTask(id, patch, { version } = {}) {
      object(patch); recoverExpired();
      return transaction(() => {
        const task = taskFor(id);
        if (reviewRelatives(id).some(child => child.status === 'running')) fail('An associated review or repair is running; wait before editing.', 'CONFLICT', 409);
        if (!['pending', 'blocked'].includes(task.status)) fail('Only pending or blocked tasks can be edited.', 'CONFLICT', 409);
        if (version != null && (!Number.isSafeInteger(version) || version !== task.version)) fail('Task changed. Refresh before editing.', 'VERSION_CONFLICT', 409);
        for (const forbidden of ['id', 'assignee', 'claimToken', 'claimHash', 'source', 'managementRequestId', 'result', 'error']) if (own(patch, forbidden)) fail(`Cannot change ${forbidden}.`);
        const merged = { ...task, ...Object.fromEntries(['title', 'description', 'projectPath', 'provider', 'role', 'priority', 'supportType', 'parked', 'approvalAction'].filter(key => own(patch, key)).map(key => [key, patch[key]])) };
        const checked = normalizeTask(merged);
        const status = checked.approvalAction && checked.approvalAction !== task.approvalAction ? 'blocked' : own(patch, 'status') ? choice(patch.status, 'task status', ['pending', 'blocked', 'done']) : task.humanGate ? 'blocked' : task.status;
        if (status === 'pending' && task.humanGate) fail('Reply to the bound human question before resuming this task.', 'HUMAN_GATE', 409);
        const manual = status === 'done' ? { result: 'Marked done manually by user.', error: '', completionSource: 'manual' } : {};
        if (task.resolution?.investigationTaskId && (status !== 'blocked' || checked.provider !== task.provider || huddleInputHash(checked) !== huddleInputHash(task))) {
          const childRow = rowFor(task.resolution.investigationTaskId), child = childRow && JSON.parse(childRow.record);
          if (child?.status === 'pending') writeTask({ ...child, status: 'blocked', paused: true, error: '排查取消：原任务已由用户更新。', version: child.version + 1 });
        }
        if (task.reviewPolicy === REVIEW_POLICY) stopReviewChildren(task);
        if (task.repairBinding || task.reviewBinding) invalidateReviewParent(task);
        return writeTask({ ...task, ...(task.reviewPolicy === REVIEW_POLICY ? clearReview : {}), grokTriage: undefined, humanRevision: (task.humanRevision || 0) + 1, ...(task.humanGate ? { humanGate: { ...task.humanGate, state: 'stale' } } : {}), ...(checked.provider !== task.provider || huddleInputHash(checked) !== huddleInputHash(task) ? { resolution: undefined } : {}), ...(task.huddleRetry ? { huddleRetry: { ...task.huddleRetry, active: false } } : {}), approvalAction: checked.approvalAction, title: checked.title, description: checked.description, projectPath: checked.projectPath, provider: checked.provider, supportType: checked.supportType, ...(own(checked, 'parked') ? { parked: checked.parked } : {}), role: checked.role, priority: checked.priority, status, ...manual, ...(task.repairBinding || task.reviewBinding ? { reviewBinding: undefined, repairBinding: undefined, repairOf: undefined, repairRound: undefined, reviewDetachedFrom: task.repairOf || task.reviewBinding?.rootId } : {}), updatedAt: stamp(), version: task.version + 1 }, { projectKey: projectLockKey({ ...checked, id: task.id }), claimHash: null, leaseUntil: null });
      });
    },
    claimTask(input, { taskId } = {}) {
      const worker = normalizeWorker(input); recoverExpired();
      return transaction(() => {
        if (maintenanceRow()) return null;
        if (db.prepare("SELECT id FROM tasks WHERE status='running' AND assignee_id=?").get(worker.id)) return null;
        const candidates = taskId ? [taskFor(taskId)] : db.prepare("SELECT record FROM tasks WHERE status='pending'").all().map(row => JSON.parse(row.record)).sort((a, b) => PRIORITIES.indexOf(a.priority) === PRIORITIES.indexOf(b.priority) ? a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id) : ({ high: 0, normal: 1, low: 2 }[a.priority] - { high: 0, normal: 1, low: 2 }[b.priority]));
        for (const task of candidates) {
          if (task.status !== 'pending') continue;
          if (reviewWorkHold(task) || watchHoldReason(task) || resolutionPaused(task) || humanRequestHold(task)) continue;
          if (task.repairBinding && !currentRepairRoot(task) || task.reviewBinding && !currentReviewParents(task)) {
            writeTask({ ...staleReviewFollowup(task), updatedAt: stamp(), version: task.version + 1 }, { claimHash: null, leaseUntil: null });
            continue;
          }
          if (task.repairBinding && worker.provider !== task.repairBinding.author || task.reviewBinding && worker.provider !== task.reviewBinding.reviewer) continue;
          if (task.approvalAction) {
            if (!['codex', 'claude'].includes(worker.provider)) continue;
            // An information reply, old grant or generic UI button cannot execute preparation.
            const reply = task.humanReply;
            const row = reply?.requestId && db.prepare('SELECT record FROM human_requests WHERE id=?').get(reply.requestId);
            const request = row && JSON.parse(row.record);
            if (!request || request.state !== 'answered' || request.answer?.decision !== 'approve'
              || task.humanGate?.state !== 'answered' || task.humanGate.requestId !== request.id
              || request.fingerprint !== humanRequestFingerprint(task)
              || JSON.stringify(request.approvalScope) !== JSON.stringify(preparationScope(task))
              || JSON.stringify(reply) !== JSON.stringify({ requestId: request.id, kind: request.kind, question: request.question, questionHash: request.questionHash, ...request.answer })
              || JSON.stringify(request.answer.authorization?.allowedActions) !== JSON.stringify([PREPARE_ACTION])) continue;
          }
          if ((worker.provider === 'grok-bot') !== (task.provider === 'grok-bot')) continue;
          if (task.status !== 'pending' || task.provider !== 'any' && !worker.providers.includes(task.provider) || task.role !== 'any' && !worker.roles.includes('any') && !worker.roles.includes(task.role)) continue;
          if (task.kind === 'review' && task.reviewOf) {
            const original = rowFor(task.reviewOf), author = original && JSON.parse(original.record).assignee?.provider;
            const actualProvider = task.provider === 'any' ? worker.provider : task.provider;
            if (!author || author === actualProvider || author === worker.provider) continue;
          }
          if (task.kind === 'resolution' && task.resolutionOf) {
            const parentRow = rowFor(task.resolutionOf), parent = parentRow && JSON.parse(parentRow.record);
            if (!parent || parent.status !== 'blocked' || resolutionPaused(parent) || humanRequestHold(parent) || (huddleFingerprint(parent) !== task.resolutionFingerprint || parent.provider !== task.resolutionOriginalProvider)) continue;
          }
          const textOnlyLocal = task.provider === 'local-qwen' && !task.projectPath && !localQwenTaskError(task);
          let project = '';
          if (!textOnlyLocal) {
            try { project = normalizeTaskProject(task.projectPath, true); } catch { continue; }
            if (!project || !worker.projectPaths.includes(project)) continue;
          }
          const projectKey = projectLockKey({ ...task, projectPath: project });
          if (db.prepare("SELECT id FROM tasks WHERE status='running' AND project_key=?").get(projectKey)) continue;
          const claimToken = randomBytes(32).toString('base64url');
          const assignee = { id: worker.id, name: worker.name, provider: task.provider === 'any' ? worker.provider : task.provider, role: task.role === 'any' ? worker.roles.find(value => value !== 'any') || 'Helper' : task.role };
          const claimed = { ...task, humanEpisode: (task.humanEpisode || 0) + 1, projectPath: project, status: 'running', assignee, result: '', error: '', updatedAt: stamp(), version: task.version + 1 };
          writeTask(claimed, { projectKey, assigneeId: worker.id, claimHash: tokenHash(claimToken), leaseUntil: now() + leaseMs });
          const repairRoot = task.repairOf && currentRepairRoot(task);
          if (repairRoot) writeTask({ ...repairRoot, reviewState: 'repairing', updatedAt: stamp(), version: repairRoot.version + 1 });
          if (task.resolutionOf) {
            const parentRow = rowFor(task.resolutionOf), parent = parentRow && JSON.parse(parentRow.record);
            if (parent?.status === 'blocked' && huddleFingerprint(parent) === task.resolutionFingerprint && parent.provider === task.resolutionOriginalProvider)
              writeTask({ ...parent, resolution: { ...parent.resolution, owner: assignee.provider, state: 'investigating', nextAction: '负责人已领取排查任务，正在核实阻塞原因。' }, version: parent.version + 1 });
          }
          return { task: claimed, claimToken };
        }
        return null;
      });
    },
    watchRetryAvailable,
    blockedMeetings() {
      return db.prepare('SELECT record FROM blocked_meetings ORDER BY rowid').all().map(row => JSON.parse(row.record));
    },
    saveBlockedMeeting(record, { reserve = false } = {}) {
      object(record); identity(record.key);
      if (reserve) return db.prepare('INSERT OR IGNORE INTO blocked_meetings(key,record) VALUES(?,?)').run(record.key, JSON.stringify(record)).changes === 1;
      db.prepare('INSERT INTO blocked_meetings(key,record) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET record=excluded.record').run(record.key, JSON.stringify(record));
      return true;
    },
    inheritMeetingDelegates(key, taskId) {
      return transaction(() => {
        if (maintenanceRow()) return false;
        const row = db.prepare('SELECT record FROM blocked_meetings WHERE key=?').get(key);
        if (!row) return false;
        const record = JSON.parse(row.record), task = taskFor(taskId);
        const shared = Object.values(record.resolutions || {}).find(item => item.scope === meetingScope(task) && item.childIds?.length && ['split', 'resumed'].includes(item.status));
        if (task.repairOf || task.repairBinding || task.reviewBinding || record.status !== 'resolved' || !shared || record.resolutions?.[taskId] || !meetingBlocked(task) || blockingKey(task) !== key || !watchRetryAvailable(task)) return false;
        db.prepare('INSERT INTO watch_retries(task_id,fingerprint) VALUES(?,?)').run(task.id, watchFingerprint(task));
        record.resolutions = { ...record.resolutions, [taskId]: { status: 'split', taskId, childIds: shared.childIds, version: task.version, scope: meetingScope(task) } };
        db.prepare('UPDATE blocked_meetings SET record=? WHERE key=?').run(JSON.stringify(record), key);
        return true;
      });
    },
    applyMeetingResolution({ key, taskId, version, votes }) {
      return transaction(() => {
        if (maintenanceRow()) return null;
        const row = db.prepare('SELECT record FROM blocked_meetings WHERE key=?').get(key);
        if (!row) return null;
        const record = JSON.parse(row.record);
        if (record.status !== 'resolved' || record.contextComplete === false || record.resolutions?.[taskId] || !meetingBarrierClear()) return null;
        const save = outcome => {
          record.resolutions = { ...record.resolutions, [taskId]: { ...outcome, version, scope: meetingScope(taskFor(taskId)) } };
          db.prepare('UPDATE blocked_meetings SET record=? WHERE key=?').run(JSON.stringify(record), key);
          return outcome;
        };
        const task = taskFor(taskId), settings = JSON.parse(db.prepare('SELECT record FROM settings WHERE id=1').get().record);
        if (settings.autoPickup === false || !record.agendaCards?.some(card => card.taskId === taskId && card.scope === meetingScope(task)) || !meetingBlocked(task) || blockingKey(task) !== key || !watchRetryAvailable(task)) return null;
        const representative = record.agendaRepresentatives?.find(card => card.scope === meetingScope(task));
        if (!representative) return null;
        const decisions = WATCH_RECIPIENTS.map(provider => parseMeetingDecisions({ decisions: votes?.[provider] || [] }).find(item => item.taskId === representative.taskId));
        if (decisions.some(item => !item?.resolved || item.action === 'wait')) return null;
        const owner = representative.provider === 'any' ? 'claude' : representative.provider;
        if (!WATCH_RECIPIENTS.includes(owner)) return null;
        const plan = decisions[WATCH_RECIPIENTS.indexOf(owner)];
        // Do not infer completion, permissions or process cancellation from a vote.
        if (db.prepare("SELECT id FROM tasks WHERE status='running' AND project_key=?").get(projectLockKey(task))) return null;
        if (plan.action === 'retry') {
          db.prepare('INSERT INTO watch_retries(task_id,fingerprint) VALUES(?,?)').run(task.id, watchFingerprint(task));
          writeTask({ ...task, status: 'pending', updatedAt: stamp(), version: task.version + 1 }, { claimHash: null, leaseUntil: null });
          return save({ status: 'resumed', taskId, childIds: [] });
        }
        // A meeting cannot turn research, independent review, or read-only diagnosis into implementation.
        if (plan.action !== 'split' || task.repairOf || task.repairBinding || task.reviewBinding || (task.kind || 'task') !== 'task') return null;
        const group = record.agendaCards.filter(card => card.scope === meetingScope(task)).map(card => ({ card, task: taskFor(card.taskId) }))
          .filter(({ task: member }) => meetingBlocked(member) && blockingKey(member) === key && meetingScope(member) === meetingScope(task));
        if (group.some(({ card, task: member }) => (member.kind || 'task') !== 'task' || member.repairOf || member.repairBinding || member.reviewBinding || meetingScope(member) !== card.scope || !meetingBlocked(member) || blockingKey(member) !== key || !watchRetryAvailable(member))) return null;
        const scope = group.map(({ task: member }) => `原卡 ${member.id}：\n${member.description}`).join('\n\n');
        const descriptions = plan.subtasks.map(child => `共享阻塞点的会议分工。仅在以下原授权范围内工作，不扩大部署、合并或账户权限。\n\n原卡要求：\n${scope}\n\n本分工：\n${child.description}`);
        if (descriptions.some(description => description.length > 20000)) return save({ status: 'rejected', taskId, childIds: [], reason: '分工继承的授权文本超出长度上限；原卡未变，请人工缩小分工。' });
        const children = plan.subtasks.map((child, index) => normalizeTask({ ...child, projectPath: task.projectPath, priority: task.priority, description: descriptions[index] }, { id: `${representative.taskId}:meeting:${key.slice(0, 12)}:${index + 1}` }));
        if (children.some(child => watchHoldReason(child) || rowFor(child.id))) return null;
        for (const { task: member, card } of group) {
          db.prepare('INSERT INTO watch_retries(task_id,fingerprint) VALUES(?,?)').run(member.id, watchFingerprint(member));
          record.resolutions = { ...record.resolutions, [member.id]: { status: 'split', taskId: member.id, childIds: children.map(child => child.id), version: card.version, scope: card.scope } };
        }
        children.forEach(child => writeTask(child));
        // Keep the original blocked until all delegated work really completes.
        return save({ status: 'split', taskId, childIds: children.map(child => child.id) });
      });
    },
    resumeMeetingParent(key, taskId) {
      return transaction(() => {
        if (maintenanceRow()) return false;
        const row = db.prepare('SELECT record FROM blocked_meetings WHERE key=?').get(key);
        if (!row) return false;
        const record = JSON.parse(row.record), resolution = record.resolutions?.[taskId];
        if (resolution?.status !== 'split' || !resolution.childIds?.length) return false;
        const task = taskFor(taskId), settings = JSON.parse(db.prepare('SELECT record FROM settings WHERE id=1').get().record);
        if (settings.autoPickup === false || task.repairOf || task.repairBinding || task.reviewBinding || resolutionPaused(task) || humanRequestHold(task) || humanRequestSpec(task) || !meetingBarrierClear() || meetingScope(task) !== resolution.scope || !meetingBlocked(task) || blockingKey(task) !== key) return false;
        const children = resolution.childIds.map(id => rowFor(id)).filter(Boolean).map(row => JSON.parse(row.record));
        if (children.length !== resolution.childIds.length) {
          resolution.status = 'needs-human'; resolution.reason = '会议分工卡缺失；请人工核对，不能据此恢复原卡。';
          db.prepare('UPDATE blocked_meetings SET record=? WHERE key=?').run(JSON.stringify(record), key);
          return false;
        }
        if (children.some(child => child.status !== 'done' || watchHoldReason(child) || resolutionPaused(child) || humanRequestHold(child)) || db.prepare("SELECT id FROM tasks WHERE status='running' AND project_key=?").get(projectLockKey(task))) return false;
        const description = `${task.description}\n\n会议分工已完成，请核对这些原卡的结果后完成原任务：${resolution.childIds.join(', ')}`;
        if (description.length > 20000) return false;
        writeTask({ ...task, status: 'pending', description, updatedAt: stamp(), version: task.version + 1 }, { claimHash: null, leaseUntil: null });
        resolution.status = 'resumed';
        db.prepare('UPDATE blocked_meetings SET record=? WHERE key=?').run(JSON.stringify(record), key);
        return true;
      });
    },
    watchReceipt(provider) {
      choice(provider, 'watch recipient', WATCH_RECIPIENTS);
      const row = db.prepare('SELECT record FROM watch_receipts WHERE provider=?').get(provider);
      return row ? JSON.parse(row.record) : null;
    },
    saveWatchReceipt(provider, record) {
      choice(provider, 'watch recipient', WATCH_RECIPIENTS); object(record);
      db.prepare('INSERT INTO watch_receipts(provider,record) VALUES(?,?) ON CONFLICT(provider) DO UPDATE SET record=excluded.record').run(provider, JSON.stringify(record));
    },
    applyWatchDecision({ provider, taskId, version, action }) {
      choice(provider, 'watch recipient', WATCH_RECIPIENTS);
      return transaction(() => {
        if (maintenanceRow()) return false;
        const task = taskFor(taskId);
        const settings = JSON.parse(db.prepare('SELECT record FROM settings WHERE id=1').get().record);
        if (settings.autoPickup === false || task.version !== version || reviewWorkHold(task) || watchHoldReason(task) || resolutionPaused(task) || humanRequestHold(task) || humanRequestSpec(task) || !watchOwners(task).includes(provider)) return false;
        if (['run', 'wait'].includes(action)) {
          if (task.status !== 'pending') return false;
          db.prepare('INSERT INTO watch_provider_choices(task_id,provider,version,action) VALUES(?,?,?,?) ON CONFLICT(task_id,provider) DO UPDATE SET version=excluded.version,action=excluded.action').run(task.id, provider, task.version, action);
          return true;
        }
        if (action !== 'retry' || !['blocked', 'failed'].includes(task.status)) return false;
        // Never alter a running card or requeue into a project with an active claim.
        if (db.prepare("SELECT id FROM tasks WHERE status='running' AND project_key=?").get(projectLockKey(task))) return false;
        const fingerprint = watchFingerprint(task);
        if (!watchRetryAvailable(task)) return false;
        db.prepare('INSERT INTO watch_retries(task_id,fingerprint) VALUES(?,?)').run(task.id, fingerprint);
        writeTask({ ...task, status: 'pending', updatedAt: stamp(), version: task.version + 1 }, { claimHash: null, leaseUntil: null });
        return true;
      });
    },
    heartbeat(id, token) { recoverExpired(); return transaction(() => { const row = claimedRow(id, token); db.prepare('UPDATE tasks SET lease_until=? WHERE id=?').run(now() + leaseMs, row.id); return JSON.parse(row.record); }); },
    // Force-stop a running card that has no live worker in this process (e.g. quota exhausted after a restart).
    stopRunningTask(id, error) {
      return transaction(() => { const row = rowFor(id); if (!row || row.status !== 'running') return null; const task = JSON.parse(row.record);
        return writeTask(reviewInterrupted({ ...task, status: 'blocked', error: text(error, 'Error', 4000), updatedAt: stamp(), version: task.version + 1 }), { claimHash: null, leaseUntil: null }); });
    },
    finishTask(id, token, input = {}) {
      object(input); recoverExpired();
      const status = choice(input.status, 'completion status', ['done', 'blocked'], 'done');
      const result = text(input.result, 'Result', 50000), error = text(input.error, 'Error', 4000);
      return transaction(() => { const row = claimedRow(id, token), task = JSON.parse(row.record);
        // Gemini does research only. Claude work -> Codex review directly; Codex work -> Claude review.
        let finished = { ...task, grokTriage: undefined, status, result, error, ...(status === 'done' ? { completionSource: 'agent' } : {}), updatedAt: stamp(), version: task.version + 1 };
        if (task.resolutionOf) {
          const parentRow = rowFor(task.resolutionOf), parent = parentRow && JSON.parse(parentRow.record);
          if (parent?.status === 'blocked' && huddleFingerprint(parent) === task.resolutionFingerprint && parent.provider === task.resolutionOriginalProvider) {
            const action = status === 'done' && ['resume', 'repair', 'needs_user'].includes(input.unblock?.action) ? input.unblock.action : 'needs_user';
            const clearance = !humanRequestSpec(parent) && action !== 'needs_user' ? action : null;
            const nextAction = typeof input.unblock?.nextAction === 'string' && input.unblock.nextAction.trim() ? input.unblock.nextAction.slice(0, 2000) : (result || error || '排查未完成，Qwen 下轮跟进负责人。').slice(0, 2000);
            writeTask({ ...parent, resolution: { ...parent.resolution, owner: task.assignee.provider, state: clearance ? 'following_up' : 'needs_user',
              finding: result.slice(0, 8000), nextAction, clearance, checkedAt: stamp() }, version: parent.version + 1 });
          }
        }
        if (task.kind === 'review') finished = applyReviewResult(finished);
        else finished = queueIndependentReview(finished);
        if (task.repairOf && status === 'blocked') {
          const root = currentRepairRoot(task);
          if (root) writeTask({ ...root, reviewState: 'blocked', error: 'The linked repair is blocked. Resolve its actual blocker before continuing independent review.', updatedAt: stamp(), version: root.version + 1 });
        }
        return writeTask(finished, { claimHash: null, leaseUntil: null }); });
    },
    upsertRole(input) { const role = roleRecord(input); return transaction(() => saveRole(role)); },
    createInstruction(input) {
      object(input); const createdAt = stamp();
      if (input.requestId !== undefined && (typeof input.requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(input.requestId))) fail('Invalid instruction request ID.');
      const requestId = input.requestId?.toLowerCase();
      const instruction = { id: requestId || randomUUID(), ...(requestId ? { requestId } : {}), text: text(input.text, 'Management instruction', 20000, true), projectPath: normalizeTaskProject(input.projectPath), status: 'pending', summary: '', error: '', createdAt, updatedAt: createdAt };
      return transaction(() => {
        const row = db.prepare('SELECT record FROM instructions WHERE id=?').get(instruction.id);
        if (row) {
          const existing = JSON.parse(row.record);
          if (existing.requestId !== requestId || existing.text !== instruction.text || existing.projectPath !== instruction.projectPath) fail('This request ID belongs to a different instruction.', 'CONFLICT', 409);
          return existing;
        }
        db.prepare('INSERT INTO instructions(id,record) VALUES(?,?)').run(instruction.id, JSON.stringify(instruction)); return instruction;
      });
    },
    updateInstruction(id, patch) {
      object(patch);
      return transaction(() => {
        const { instruction } = instructionFor(id);
        const updated = { ...instruction, updatedAt: stamp() };
        if (own(patch, 'status')) updated.status = choice(patch.status, 'instruction status', ['pending', 'running', 'done', 'blocked']);
        for (const [key, max] of [['summary', 10000], ['error', 4000]]) if (own(patch, key)) updated[key] = text(patch[key], key, max);
        return saveInstruction(updated);
      });
    },
    applyManagementPlan(id, plan) {
      object(plan);
      const summary = text(plan.summary, 'Plan summary', 10000);
      const roles = plan.roles ?? [], tasks = plan.tasks ?? [];
      if (!Array.isArray(roles) || roles.length > 20 || !Array.isArray(tasks) || tasks.length > 100) fail('A plan supports up to 20 management roles and 100 tasks.');
      return transaction(() => {
        const { row, instruction } = instructionFor(id);
        if (row.plan_applied) return { instruction, tasks: db.prepare('SELECT record FROM tasks WHERE management_id=?').all(id).map(item => JSON.parse(item.record)), roles: [], applied: false };
        const normalizedRoles = roles.map(roleRecord);
        const normalizedTasks = tasks.map((task, index) => normalizeTask({ ...object(task), projectPath: task.projectPath || instruction.projectPath }, { id: `${id}:task:${index + 1}`, source: 'grok', managementRequestId: id }));
        normalizedRoles.forEach(saveRole);
        normalizedTasks.forEach(task => writeTask(task));
        const completed = saveInstruction({ ...instruction, status: 'done', summary, error: '', updatedAt: stamp() }, true);
        return { instruction: completed, roles: normalizedRoles, tasks: normalizedTasks, applied: true };
      });
    },
    updateSettings(patch) {
      object(patch);
      if (!own(patch, 'autoPickup') || typeof patch.autoPickup !== 'boolean') fail('autoPickup must be true or false.');
      return transaction(() => { const settings = { autoPickup: patch.autoPickup }; db.prepare('UPDATE settings SET record=? WHERE id=1').run(JSON.stringify(settings)); return settings; });
    },
  };
}
