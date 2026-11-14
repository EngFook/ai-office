import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTaskStore } from '../server/task-store.mjs';
import { createStoryStudio } from '../server/story-studio.mjs';
import { readStoryStudioConfig, validateStoryStudioConfig } from '../server/story-studio-config.mjs';
const AT = Date.parse('2026-11-13T00:00:00Z'), SIX_HOURS = 21600000;
const runtime = () => ({ started: true, running: [], providers: { gemini: { available: true, authenticated: true, modelSupported: true }, 'local-qwen': { available: true } } });
const research = () => ({ sources: [{ url: 'https://example.org/story', title: 'Public technique source', accessedAt: '2026-11-12' }], ideas: [{ title: '归来以后的守夜', premise: '六份记录回来后，众人决定先检查哪一项矛盾。', technique: '让证据而非叙述直接推动冲突。' }], outline: [{ beat: '守夜人发现记录矛盾。', purpose: '建立局部问题。' }, { beat: '不同的判断带来争执。', purpose: '让同伴承担选择。' }, { beat: '选择留下可核查线索。', purpose: '给下个局部问题留钩子。' }] });
const draft = suffix => `【原创剧情候选 · 待审阅，未写入正式剧本】\n${'你把六份记录放到灯下，陈砚指着有矛盾的一行。谁也没有立刻下定论，他们决定先用观测证明选择。'.repeat(9)}\n${suffix || '候选场景结尾。'}`;
const review = () => ({ verdict: 'revise', feedback: [{ issue: '证据判断过快。', evidence: '谁也没有立刻下定论', suggestion: '加一次具体比对与行动代价。' }] });
async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'story-studio-')), project = path.join(home, 'sample-novel'), researchDir = path.join(home, 'research');
  await mkdir(path.join(project, 'notes'), { recursive: true }); await mkdir(path.join(project, 'src'), { recursive: true });
  await writeFile(path.join(project, 'notes/story-bible.md'), ['序章：港城在一夜之间失去灯光。', '1. 守夜人是谁：未知。', '2. 为什么只有主角记得：未知。', '3. 那座灯塔：未知。', '- 规则：记录不能被改写。', '- 规则：每次选择都有代价。', '向导是救援终端。', '无关的草稿行。'].join('\n'));
  await writeFile(path.join(project, 'notes/outline.md'), 'story.v6\n' + Array.from({ length: 18 }, (_, i) => `## ${1 + Math.floor(i / 6)}.${1 + i % 6}　场景`).join('\n') + '\n### 收束\n你们和六份记录回到岬角，真相尚未揭晓。\n---\n');
  await writeFile(path.join(project, 'src/story-version.txt'), "storyVersion = 'story.v6';");
  const f = { home, project, researchDir, now: AT, services: [], calls: 0, verified: 0, wakes: 0, qwenBusy: false };
  f.store = createTaskStore({ home, researchDir, now: () => f.now, crossReview: false });
  f.config = { version: 1, enabled: true, projectId: 'sample-novel', projectName: 'Sample Novel', sourceRoot: project, projectPath: project, canon: { sources: [
    { path: 'notes/story-bible.md', mode: 'lines', patterns: ['^序章', '^[123]\\. ', '^- 规则', '^向导'], minMatches: 7 },
    { path: 'notes/outline.md', mode: 'lines', join: '\n', heading: '章节目录：\n', patterns: ['^## [123]\\.[1-6][\\s　]'], exactMatches: 18, requireText: 'story.v6' },
    { path: 'notes/outline.md', mode: 'section', heading: '收束：\n', pattern: '### 收束\\s*([\\s\\S]*?)(?:\\n---|$)' },
    { path: 'src/story-version.txt', mode: 'none', versionPattern: "['\"](story\\.v(\\d+))['\"]", minVersion: 6 }] } };
  f.qwen = { runtimeState: () => ({ busy: f.qwenBusy }), writeStory: async () => { f.calls++; return draft(`第${f.calls}次生成`); } };
  f.make = options => { const service = createStoryStudio({ store: f.store, home, config: f.config, runtimeReader: runtime, now: () => f.now, qwenClient: f.qwen, verifySource: async () => { f.verified++; return true; }, onTaskChange: async () => { f.wakes++; }, ...options }); f.services.push(service); return service; };
  f.state = async () => JSON.parse(await readFile(path.join(home, 'story-studio.json'), 'utf8'));
  f.tasks = () => f.store.snapshot().tasks;
  f.finish = async (task, result, options = {}) => {
    const claimed = f.store.claimTask({ id: 'fixture-gemini', provider: 'gemini', roles: ['any'], projectPath: task.projectPath }, { taskId: task.id }); assert.ok(claimed, 'fixture can claim task');
    let text = typeof result === 'string' ? result : JSON.stringify(result);
    if (options.note) {
      const suffix = createHash('sha256').update(task.id).digest('hex').slice(0, 16), file = path.join(researchDir, `2026-11-13-research-${suffix}.md`);
      await writeFile(file, `# ${task.title}\n\n_Gemini research · task ${task.id} · ${new Date(f.now).toISOString()}_\n\n${text}\n`);
      text = `Research note: ${file}\n\n${text}`.slice(0, 6000);
    }
    return f.store.finishTask(task.id, claimed.claimToken, { status: options.status || 'done', result: text, ...(options.error ? { error: options.error } : {}) });
  };
  f.toDraft = async s => { await s.start(); await f.finish(f.tasks()[0], research()); await s.tick(); assert.equal((await f.state()).cycle.stage, 'draft'); };
  t.after(async () => { for (const s of f.services) await s.stop(); f.store.close(); await rm(home, { recursive: true, force: true }); });
  return f;
}

test('configuration is opt-in, project-scoped and fixed to six hours/eight cards', async t => {
  const f = await fixture(t); assert.equal(readStoryStudioConfig(f.home).enabled, false);
  assert.throws(() => validateStoryStudioConfig({ ...f.config, projectId: '../escape' }));
  assert.throws(() => validateStoryStudioConfig({ ...f.config, projectId: undefined }), /projectId/);
  assert.throws(() => validateStoryStudioConfig({ ...f.config, canon: undefined }), /canon/);
  assert.throws(() => validateStoryStudioConfig({ ...f.config, intervalMs: 10 }));
  const s = f.make({ config: { version: 1, enabled: false } }); await s.start(); assert.equal(s.status().phase, 'disabled'); assert.equal(f.tasks().length, 0);
  await writeFile(path.join(f.home, 'story-studio-config.json'), '{'); assert.match(readStoryStudioConfig(f.home).error, /配置无效/);
});

test('full verified cycle persists candidate outside canon, restarts safely, and rotates next focus after six hours', async t => {
  const f = await fixture(t), s = f.make(); const source = await readFile(path.join(f.project, 'notes/story-bible.md'), 'utf8');
  await f.toDraft(s); await s.tick(); assert.equal(f.calls, 1); assert.equal((await f.state()).cycle.stage, 'review');
  await s.tick(); const editorial = f.tasks().find(task => JSON.parse(task.description).stage === 'story_review'); assert.ok(editorial); assert.equal(f.tasks().length, 2);
  await f.finish(editorial, review(), { note: true }); await s.tick(); await s.tick(); assert.equal(s.status().phase, 'ready'); assert.equal(f.calls, 2); assert.equal(s.status().geminiCalls24h, 2);
  assert.equal(await readFile(s.status().lastArtifact, 'utf8'), draft('第2次生成')); assert.ok(s.status().lastArtifact.startsWith(path.join(f.home, 'creative', 'sample-novel')));
  assert.equal(await readFile(path.join(f.project, 'notes/story-bible.md'), 'utf8'), source);
  assert.equal(s.status().lastCompletedAt, new Date(AT).toISOString()); assert.equal(s.status().busy, false);
  await s.stop(); f.now += SIX_HOURS - 1; const resumed = f.make(); await resumed.start(); assert.equal(f.tasks().length, 2);
  f.now++; await resumed.tick(); assert.equal(f.tasks().length, 3);
  const next = f.tasks().find(task => JSON.parse(task.description).goal.includes('冲突：双方各自的理由'));
  assert.ok(next); assert.match(JSON.parse(next.description).goal, /上一轮候选节选/); assert.equal(f.calls, 2);
});

test('pending task survives restart without duplicate cards or waking twice', async t => {
  const f = await fixture(t), first = f.make(); await first.start(); const id = first.status().currentTaskId;
  await first.tick(); await first.stop(); const resumed = f.make(); await resumed.start(); assert.equal(resumed.status().currentTaskId, id); assert.equal(f.tasks().length, 1); assert.equal(f.wakes, 1);
});

test('truncated task summary is read from its bound full research note', async t => {
  const f = await fixture(t), s = f.make(); await s.start(); const data = research(); data.ideas.push(...Array.from({ length: 2 }, () => ({ title: 'Alternate', premise: 'P'.repeat(1450), technique: 'T'.repeat(1450) })));
  assert.ok(JSON.stringify(data).length > 6000); await f.finish(f.tasks()[0], data, { note: true }); await s.tick(); assert.equal((await f.state()).cycle.stage, 'draft'); assert.equal(f.verified, 1);
});

test('SUCCESS and blocked JSON cannot advance a research card merely marked done', async t => {
  for (const result of ['SUCCESS', '{"blocked":true,"reason":"Login needed"}']) {
    const f = await fixture(t), s = f.make(); await s.start(); await f.finish(f.tasks()[0], result); await s.tick(); assert.equal((await f.state()).cycle.stage, 'research'); assert.equal(s.status().phase, 'blocked'); assert.equal(f.calls, 0);
  }
});

test('public source failure is specific, cooled down and does not manufacture a new card', async t => {
  const f = await fixture(t); let verifies = 0; const s = f.make({ verifySource: async () => { verifies++; return false; } });
  await s.start(); await f.finish(f.tasks()[0], research()); await s.tick(); assert.match(s.status().error, /暂不可达/); await s.tick(); assert.equal(verifies, 1); assert.equal(f.tasks().length, 1); assert.equal(f.calls, 0);
  await s.stop(); const resumed = f.make({ verifySource: async () => { verifies++; return false; } }); await resumed.start(); assert.equal(verifies, 1);
});

test('manual completion, deletion and parked research stop the pipeline', async t => {
  for (const update of [{ status: 'done' }, { status: 'deleted' }, { parked: true }]) {
    const f = await fixture(t), s = f.make(); await s.start(); if (update.status === 'deleted') f.store.cardAction(f.tasks()[0].id, { action: 'delete', version: f.tasks()[0].version }); else f.store.updateTask(f.tasks()[0].id, update); await s.tick(); assert.equal(f.calls, 0); assert.equal((await f.state()).cycle.stage, 'research'); assert.ok(['blocked', 'paused'].includes(s.status().phase));
  }
});

test('maintenance, auto-pickup pause and disabled configuration create no cards', async t => {
  const f = await fixture(t), s = f.make(); f.store.updateSettings({ autoPickup: false }); await s.start(); assert.equal(f.tasks().length, 0); assert.equal(s.status().phase, 'paused');
  f.store.updateSettings({ autoPickup: true }); const token = '8ae3773d-e9b1-4ca9-8048-1dd8cdbca4ed'; f.store.acquireMaintenance(token); await s.tick(); assert.equal(f.tasks().length, 0); f.store.releaseMaintenance(token); await s.stop();
  const disabled = f.make({ configuration: { providers: { gemini: { enabled: false }, 'local-qwen': { enabled: true } } } }); await disabled.start(); assert.equal(f.tasks().length, 0); assert.equal(disabled.status().phase, 'paused');
});

test('configuration disable and previously completed card deletion stop Qwen without consuming attempts', async t => {
  const f = await fixture(t), config = { providers: { gemini: { enabled: true }, 'local-qwen': { enabled: true } } }, s = f.make({ configuration: config });
  await f.toDraft(s); config.providers.gemini.enabled = false; await s.tick(); assert.equal(f.calls, 0); assert.equal((await f.state()).cycle.attempts.draft, undefined);
  config.providers.gemini.enabled = true; f.store.cardAction(f.tasks()[0].id, { action: 'delete', version: f.tasks()[0].version }); await s.tick(); assert.equal(f.calls, 0); assert.equal(s.status().phase, 'paused');
});

test('busy and foreground preemption do not use failure budget', async t => {
  const f = await fixture(t), s = f.make(); await f.toDraft(s); f.qwenBusy = true; await s.tick(); assert.equal(f.calls, 0); f.qwenBusy = false;
  f.qwen.writeStory = async () => { throw new Error('Local Qwen yielded to a user task.'); };
  await s.tick(); await s.tick(); assert.equal(s.status().phase, 'waiting'); assert.equal((await f.state()).cycle.attempts.draft, undefined);
  f.qwen.writeStory = async () => draft(); await s.tick(); assert.equal((await f.state()).cycle.stage, 'review');
});

test('two real generation failures are bounded and separated by durable cooldown', async t => {
  const f = await fixture(t), s = f.make(); await f.toDraft(s); let tries = 0; f.qwen.writeStory = async () => { tries++; throw new Error('Model unavailable'); };
  await s.tick(); await s.tick(); assert.equal(tries, 1); await s.stop(); const resumed = f.make(); await resumed.start(); assert.equal(tries, 1);
  f.now += 900000; await resumed.tick(); assert.equal(tries, 2); f.now += 900000; await resumed.tick(); assert.equal(resumed.status().phase, 'blocked'); assert.equal(tries, 2);
});

test('pause during Qwen inference journals result without advancing and resumes without another call', async t => {
  const f = await fixture(t), s = f.make(); await f.toDraft(s); let release; f.qwen.writeStory = async () => { f.calls++; return new Promise(resolve => { release = resolve; }); };
  const pending = s.tick(); await Promise.resolve(); assert.equal(s.status().busy, true); f.store.updateSettings({ autoPickup: false }); release(draft()); await pending;
  assert.equal(s.status().phase, 'paused'); assert.equal((await f.state()).cycle.stage, 'draft'); assert.equal(f.tasks().length, 1);
  f.store.updateSettings({ autoPickup: true }); await s.tick(); assert.equal((await f.state()).cycle.stage, 'review'); assert.equal(f.calls, 1);
});

test('pause during public-source verification prevents stage advancement', async t => {
  const f = await fixture(t); let release; const s = f.make({ verifySource: async () => new Promise(resolve => { release = resolve; }) });
  await s.start(); await f.finish(f.tasks()[0], research()); const pending = s.tick(); await Promise.resolve(); f.store.updateSettings({ autoPickup: false }); release(true); await pending;
  assert.equal(s.status().phase, 'paused'); assert.equal((await f.state()).cycle.stage, 'research'); assert.equal(f.calls, 0);
});

test('changed canon is not silently accepted mid-cycle', async t => {
  const f = await fixture(t), s = f.make(); await f.toDraft(s); await writeFile(path.join(f.project, 'notes/story-bible.md'), 'changed'); await s.tick(); assert.equal(f.calls, 0); assert.equal(s.status().phase, 'blocked');
});

test('unsupported editorial evidence never triggers a revision', async t => {
  const f = await fixture(t), s = f.make(); await f.toDraft(s); await s.tick(); await s.tick(); const r = review(); r.feedback[0].evidence = 'Not in this draft'; await f.finish(f.tasks().find(task => task.status === 'pending'), r); await s.tick(); assert.equal(f.calls, 1); assert.match(s.status().error, /证据/); assert.equal((await f.state()).cycle.stage, 'review');
});

test('eight persisted story cards exhaust only this workflow budget until the rolling window clears', async t => {
  const f = await fixture(t); await writeFile(path.join(f.home, 'story-studio.json'), JSON.stringify({ version: 1, nextCycleAt: new Date(AT).toISOString(), geminiRequests: Array(8).fill(new Date(AT).toISOString()), cycle: null }));
  const s = f.make(); await s.start(); assert.equal(f.tasks().length, 0); assert.match(s.status().reason, /八张/); f.now += 86400001; await s.tick(); assert.equal(f.tasks().length, 1);
});

test('an existing live lock and malformed state fail closed', async t => {
  const f = await fixture(t), first = f.make(); await first.start(); const other = f.make(); await other.start(); assert.equal(other.status().phase, 'unavailable'); assert.equal(f.tasks().length, 1);
  await first.stop(); await writeFile(path.join(f.home, 'story-studio.json'), '{'); const broken = f.make(); await broken.start(); assert.equal(broken.status().phase, 'unavailable'); assert.equal(f.tasks().length, 1);
});

test('durable generation journal recovers after state persistence fails without rerunning the model', async t => {
  const f = await fixture(t), s = f.make(); await f.toDraft(s); const stateFile = path.join(f.home, 'story-studio.json'), backup = `${stateFile}.backup`;
  f.qwen.writeStory = async () => { f.calls++; await rename(stateFile, backup); await mkdir(stateFile); return draft(); };
  await s.tick(); assert.equal(s.status().phase, 'unavailable'); await s.stop(); await rm(stateFile, { recursive: true }); await rename(backup, stateFile);
  const resumed = f.make(); await resumed.start(); assert.equal((await f.state()).cycle.stage, 'review'); assert.equal(f.calls, 1); assert.ok(resumed.status().draftPreview);
});

test('research note outside its bound directory is rejected even with a plausible task id', async t => {
  const f = await fixture(t), s = f.make(); await s.start(); const task = f.tasks()[0], file = path.join(f.home, `other-${createHash('sha256').update(task.id).digest('hex').slice(0, 16)}.md`); await writeFile(file, '{}');
  await f.finish(task, `Research note: ${file}\n\n{}`); await s.tick(); assert.match(s.status().error, /路径或任务绑定/); assert.equal(f.calls, 0);
});

test('bound approval question is preserved and never bypassed by story automation', async t => {
  const f = await fixture(t), s = f.make(); await s.start(); const task = f.tasks()[0];
  await f.finish(task, '', { status: 'blocked', error: 'User approval required: may I obtain a paid source subscription?' });
  f.store.syncHumanRequests(); const before = f.store.snapshot(); assert.ok(before.humanRequests.length);
  await s.tick(); assert.equal(s.status().phase, 'paused'); assert.equal(f.tasks().length, 1); assert.equal(f.calls, 0); assert.deepEqual(f.store.snapshot().humanRequests, before.humanRequests);
});

test('fresh exhausted quota and occupied Gemini defer card creation without claiming real work', async t => {
  const f = await fixture(t); let occupied = true;
  const s = f.make({ runtimeReader: () => ({ ...runtime(), running: occupied ? [{ taskId: 'elsewhere', provider: 'gemini' }] : [] }), quotaReader: () => ({ gemini: { observedAt: f.now, windows: [{ name: 'daily', remainingPercent: 0, usedPercent: 100, resetsAt: f.now + 3600000 }] } }) });
  await s.start(); assert.equal(f.tasks().length, 0); assert.equal(s.status().busy, false); occupied = false; await s.tick(); assert.equal(f.tasks().length, 0); assert.match(s.status().reason, /额度/);
});

test('a card persisted before its link acknowledgement is recovered and counted once', async t => {
  const f = await fixture(t), s = f.make(); await s.start(); await s.stop(); const state = await f.state(); state.cycle.tasks.research.created = false; state.geminiRequests = [];
  await writeFile(path.join(f.home, 'story-studio.json'), JSON.stringify(state)); const resumed = f.make(); await resumed.start(); await resumed.tick(); assert.equal(f.tasks().length, 1); assert.equal(resumed.status().geminiCalls24h, 1); assert.equal(f.wakes, 1);
});

test('shared-slot race with a foreground user is waiting, not a failed generation', async t => {
  const f = await fixture(t), s = f.make(); await f.toDraft(s); f.qwen.writeStory = async () => { throw new Error('Local Qwen concurrency is 1.'); };
  await s.tick(); assert.equal(s.status().phase, 'waiting'); assert.equal((await f.state()).cycle.attempts.draft, undefined);
});

test('source change while Qwen is generating keeps output as a candidate journal without advancing', async t => {
  const f = await fixture(t), s = f.make(); await f.toDraft(s); let release; f.qwen.writeStory = async () => new Promise(resolve => { release = resolve; });
  const pending = s.tick(); await Promise.resolve(); await writeFile(path.join(f.project, 'notes/story-bible.md'), 'changed'); release(draft()); await pending;
  assert.equal((await f.state()).cycle.stage, 'draft'); assert.equal(f.tasks().length, 1); assert.equal(s.status().phase, 'blocked'); assert.equal(s.status().lastArtifact, null);
});

test('canon extraction follows the configured project rules, not built-in file names', async t => {
  const f = await fixture(t); let seen; f.qwen.writeStory = async input => { f.calls++; seen = input; return draft(); };
  const s = f.make(); await f.toDraft(s);
  const c = (await f.state()).cycle;
  assert.ok(c.canon.startsWith('版本：story.v6。'), 'version label from the configured pattern');
  assert.match(c.canon, /序章：港城/); assert.doesNotMatch(c.canon, /无关的草稿行/);
  assert.match(c.canon, /章节目录：\n## 1\.1　场景\n## 1\.2/); assert.match(c.canon, /收束：\n你们和六份记录/);
  assert.deepEqual(c.sourceManifest.map(item => item.relative), ['notes/story-bible.md', 'notes/outline.md', 'src/story-version.txt']);
  assert.ok(f.tasks()[0].title.startsWith('Sample Novel剧情'));
  assert.equal(s.status().projectId, 'sample-novel'); assert.equal(s.status().projectName, 'Sample Novel');
  assert.equal(JSON.parse(f.tasks()[0].description).projectId, 'sample-novel');
  await s.tick(); assert.equal(seen.projectName, 'Sample Novel');
});

test('configured format checks block instead of guessing when the canon drifts', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.project, 'notes/outline.md'), 'story.v6\n## 1.1　场景\n### 收束\n结尾\n');
  const s = f.make(); await s.start(); assert.equal(f.tasks().length, 0); assert.match(String(s.status().error || s.status().reason), /格式已改变/);
  const g = await fixture(t);
  await writeFile(path.join(g.project, 'src/story-version.txt'), "storyVersion = 'story.v5';");
  const old = g.make(); await old.start(); assert.equal(g.tasks().length, 0); assert.match(String(old.status().error || old.status().reason), /版本/);
});

test('project definitions can come from the local project catalog; config keys win', async t => {
  const f = await fixture(t);
  const { canon, projectName, ...minimal } = f.config;
  await writeFile(path.join(f.home, 'story-studio-config.json'), JSON.stringify(minimal));
  await writeFile(path.join(f.home, 'project-catalog.json'), JSON.stringify([{ id: 'sample-novel', name: 'Catalog Novel', path: f.project, storyStudio: { canon, focus: ['只写一个重点'] } }]));
  const resolved = readStoryStudioConfig(f.home);
  assert.equal(resolved.error, undefined); assert.equal(resolved.enabled, true); assert.equal(resolved.projectName, 'Catalog Novel');
  assert.deepEqual(resolved.focus, ['只写一个重点']); assert.equal(resolved.canon.sources.length, 4);
  await writeFile(path.join(f.home, 'story-studio-config.json'), JSON.stringify({ ...minimal, projectName: 'Override' }));
  assert.equal(readStoryStudioConfig(f.home).projectName, 'Override');
  const { readProjectCatalog } = await import('../server/project-catalog.mjs');
  assert.equal(readProjectCatalog(f.home)[0].storyStudio, undefined, 'UI catalog does not carry story rules');
  await writeFile(path.join(f.home, 'project-catalog.json'), JSON.stringify([{ id: 'other', name: 'Other', path: f.project }]));
  assert.match(readStoryStudioConfig(f.home).error, /配置无效/, 'enabled studio without canon rules stays off');
  assert.throws(() => validateStoryStudioConfig({ ...f.config, canon: { sources: [{ path: '../outside.md' }] } }), /relative/);
  assert.throws(() => validateStoryStudioConfig({ ...f.config, canon: { sources: [{ path: 'notes/a.md', mode: 'lines' }] } }), /patterns/);
});
