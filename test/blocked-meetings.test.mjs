import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTaskStore } from '../server/task-store.mjs';
import { createBlockedMeetings } from '../server/blocked-meetings.mjs';
import { blockingKey, parseMeetingDecisions } from '../server/blocked-meeting-policy.mjs';
import { createMeetingRoom } from '../server/meeting-room.mjs';
import { createWatchRecipients } from '../server/watch-recipients.mjs';

const providers = ['claude', 'codex', 'gemini'];
const vote = (task, extra = {}) => ({ taskId: task.id, resolved: false, evidence: '需要核对前置条件。', action: 'wait', ...extra });
const report = time => ({ checkedAt: new Date(time).toISOString(), phase: 'attention' });
async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'blocked-meeting-test-'));
  let time = Date.parse('2026-11-03T06:00:00Z');
  const store = createTaskStore({ home, crossReview: false, researchDir: path.join(home, 'research'), now: () => time });
  t.after(async () => { store.close(); await rm(home, { recursive: true, force: true }); });
  const create = (input = {}) => { const card = store.createTask({ title: 'Original authorized work', description: 'Do only original work. Do not deploy.', provider: 'codex', projectPath: home, ...input }); return store.updateTask(card.id, { status: 'blocked' }); };
  const file = path.join(home, 'live.json'), room = createMeetingRoom(file);
  const meetings = options => createBlockedMeetings({ store, room, now: () => time, ...options });
  return { home, store, create, file, room, meetings, now: () => time, advance: (ms = 600000) => { time += ms; } };
}

test('blocked agenda summons every AI concurrently, uses visual meeting, saves concrete notes, and excludes all parked forms', async t => {
  const f = await fixture(t), card = f.create();
  const parked = [f.create({ parked: true }), f.create({ title: '[parked] Hold' }), f.create({ description: '[用户暂停] wait' })];
  const calls = [], signals = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const meeting = f.meetings({ decide: async (provider, prompt, options) => {
    calls.push(provider); signals.push(options.signal);
    const page = JSON.parse(prompt.split('\n').at(-1)).agenda;
    assert.deepEqual(page.map(task => task.taskId), [card.id]);
    assert.equal(options.progressOnly, true); assert.equal(options.meeting, true);
    if (calls.length === 3) release();
    assert.equal(JSON.parse(await readFile(f.file)).active, true);
    await gate; return [vote(card)];
  } });
  await meeting.receive();
  assert.deepEqual(calls.sort(), providers); assert.ok(signals.every(signal => !signal.aborted));
  assert.equal(JSON.parse(await readFile(f.file)).active, false);
  assert.equal(meeting.status()[0].status, 'unresolved');
  assert.equal(meeting.status()[0].replies.codex.decisions[0].evidence, '需要核对前置条件。');
  assert.ok(parked.every(task => f.store.snapshot().tasks.find(t => t.id === task.id).status === 'blocked'));
});

test('only parked cards, failed cards and management instructions do not trigger blocked meetings', async t => {
  const f = await fixture(t); f.create({ parked: true });
  let calls = 0;
  await f.meetings({ decide: async () => { calls++; return []; } }).receive();
  assert.equal(calls, 0); assert.equal(f.store.blockedMeetings().length, 0);
});

test('same blocking point survives restarts, metadata changes, dynamic timestamps, and sibling cards without repeated meetings', async t => {
  const f = await fixture(t), card = f.create();
  let calls = 0;
  const options = { decide: async () => { calls++; return [vote(card)]; } };
  await f.meetings(options).receive();
  f.advance(); f.store.updateTask(card.id, { priority: 'high' });
  f.create({ title: card.title });
  await f.meetings(options).receive();
  assert.equal(calls, 3); assert.equal(f.store.blockedMeetings().length, 1);
  assert.equal(f.store.blockedMeetings()[0].taskIds.length, 2);
  assert.equal(blockingKey({ projectPath: 'p', error: 'offline 2026-11-03T06:00:00Z session_id=abc' }), blockingKey({ projectPath: 'p', error: 'offline 2026-11-03T07:00:00Z session_id=xyz' }));
  f.create({ title: 'Different blocking point' });
  await f.meetings({ decide: async () => { calls++; return []; } }).receive();
  assert.equal(calls, 6);
});

test('a meeting consumes the same durable ten-minute budget as work reminders and prevents automatic blocked retries', async t => {
  const f = await fixture(t), card = f.create();
  let calls = 0;
  f.store.saveWatchReceipt('gemini', { patrolAt: new Date(f.now()).toISOString() });
  const meeting = f.meetings({ decide: async () => { calls++; return [vote(card)]; } });
  const recipients = createWatchRecipients({ store: f.store, meetings: meeting, now: f.now, decide: async () => { assert.fail('No duplicate self-check.'); }, canRun: () => true });
  await recipients.receive(report(f.now())); assert.equal(calls, 0);
  f.advance(); await recipients.receive(report(f.now())); assert.equal(calls, 3);
  f.advance(); await recipients.receive(report(f.now())); assert.equal(calls, 3);
  assert.equal(f.store.snapshot().tasks.find(t => t.id === card.id).status, 'blocked');
  assert.ok(providers.every(provider => Date.parse(f.store.watchReceipt(provider).patrolAt) === f.now() - 600000));
});

test('unanimous verified resolution retries the original once without creating cards', async t => {
  const f = await fixture(t), card = f.create();
  let kicks = 0;
  const meeting = f.meetings({ onTaskChange: () => { kicks++; }, decide: async () => [vote(card, { resolved: true, action: 'retry', evidence: 'Prerequisite was confirmed done.' })] });
  await meeting.receive();
  assert.equal(kicks, 1); assert.equal(f.store.snapshot().tasks.length, 1);
  const retried = f.store.snapshot().tasks[0]; assert.equal(retried.status, 'pending');
  assert.equal(meeting.status()[0].resolutions[card.id].status, 'resumed');
  f.store.updateTask(card.id, { status: 'blocked' }); f.advance(); await meeting.receive();
  assert.equal(kicks, 1); assert.equal(f.store.snapshot().tasks[0].status, 'blocked');
});

test('all blockers must be resolved before any task is redistributed', async t => {
  const f = await fixture(t), ready = f.create(), waiting = f.create({ title: 'Another issue' });
  const meeting = f.meetings({ decide: async () => [vote(ready, { resolved: true, action: 'retry' }), vote(waiting)] });
  await meeting.receive();
  assert.ok(f.store.snapshot().tasks.every(task => task.status === 'blocked'));
  f.store.updateTask(waiting.id, { status: 'done' }); f.advance(); await meeting.receive();
  assert.equal(f.store.snapshot().tasks.find(task => task.id === ready.id).status, 'pending');
});

test('busy owner defers an approved plan until it can run, without more consultations', async t => {
  const f = await fixture(t), card = f.create();
  let idle = false, calls = 0;
  const meeting = f.meetings({ canRun: () => idle, decide: async () => { calls++; return [vote(card, { resolved: true, action: 'retry' })]; } });
  await meeting.receive(); assert.equal(f.store.snapshot().tasks[0].status, 'blocked');
  idle = true; f.advance(); await meeting.receive();
  assert.equal(calls, 3); assert.equal(f.store.snapshot().tasks[0].status, 'pending');
});

test('unavailable recipient and disagreement leave original untouched and never open the same meeting again', async t => {
  const f = await fixture(t), card = f.create(); let calls = 0;
  const meeting = f.meetings({ decide: async provider => { calls++; if (provider === 'gemini') throw new Error('needs login'); return [vote(card, { resolved: true, action: 'retry' })]; } });
  await meeting.receive(); f.advance(); await f.meetings({ decide: async () => { assert.fail('No paid repeat.'); } }).receive();
  assert.equal(calls, 3); assert.equal(f.store.snapshot().tasks[0].status, 'blocked');
  assert.equal(meeting.status()[0].replies.gemini.status, 'unavailable');
});

test('late answers cannot change parked, edited or globally paused cards', async t => {
  for (const mode of ['parked', 'edit', 'pause']) {
    const f = await fixture(t), card = f.create();
    const before = f.store.snapshot().tasks.length;
    const meeting = f.meetings({ decide: async provider => {
      if (provider === 'codex') {
        if (mode === 'pause') f.store.updateSettings({ autoPickup: false });
        else f.store.updateTask(card.id, mode === 'parked' ? { parked: true } : { description: 'Changed authorization' });
      }
      return [vote(card, { resolved: true, action: 'retry' })];
    } });
    await meeting.receive();
    assert.equal(f.store.snapshot().tasks[0].status, 'blocked'); assert.equal(f.store.snapshot().tasks.length, before);
  }
});

test('owner split is atomic, inherits authorization, waits for real child completion and does not re-discuss', async t => {
  const f = await fixture(t), card = f.create(); let calls = 0;
  const meeting = f.meetings({ decide: async provider => { calls++; return [vote(card, { resolved: true, action: provider === 'codex' ? 'split' : 'retry',
    subtasks: provider === 'codex' ? [{ title: 'Independent implementation', description: 'Implement original requirement', provider: 'claude' }, { title: 'Research dependency', description: 'Research only original requirement', provider: 'gemini' }] : [] })]; } });
  await meeting.receive();
  const children = f.store.snapshot().tasks.filter(task => task.id !== card.id);
  assert.equal(children.length, 2); assert.ok(children.every(child => child.description.includes('Do not deploy.')));
  assert.equal(f.store.snapshot().tasks.find(task => task.id === card.id).status, 'blocked');
  f.store.updateTask(children[0].id, { status: 'done' }); f.advance(); await meeting.receive();
  assert.equal(f.store.snapshot().tasks.find(task => task.id === card.id).status, 'blocked');
  f.store.updateTask(children[1].id, { status: 'done' }); f.advance(); await meeting.receive();
  assert.equal(f.store.snapshot().tasks.find(task => task.id === card.id).status, 'pending'); assert.equal(calls, 3);
});

test('manual meeting is preserved; stopping aborts all discussions and cannot apply late plans', async t => {
  const f = await fixture(t), card = f.create();
  await writeFile(f.file, JSON.stringify({ active: true, topic: 'Human meeting' }));
  let calls = 0;
  const meeting = f.meetings({ decide: async (_provider, _prompt, { signal }) => {
    calls++; await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    return [vote(card, { resolved: true, action: 'retry' })];
  } });
  await meeting.receive(); assert.equal(calls, 0); assert.equal(JSON.parse(await readFile(f.file)).topic, 'Human meeting');
  await writeFile(f.file, JSON.stringify({ active: false }));
  const active = meeting.receive();
  while (calls < 3) await new Promise(resolve => setImmediate(resolve));
  await meeting.stop(); await active;
  assert.equal(f.store.snapshot().tasks[0].status, 'blocked'); assert.equal(JSON.parse(await readFile(f.file)).active, false);
});

test('restart records an interrupted consultation and returns its owned room without reopening', async t => {
  const f = await fixture(t), card = f.create(), key = blockingKey(card);
  f.store.saveBlockedMeeting({ key, taskIds: [card.id], status: 'discussing', meetingId: 'old' });
  f.room.start('old', 'Interrupted meeting', providers, f.now());
  const meeting = f.meetings({ decide: async () => assert.fail('Do not repeat interrupted meeting.') });
  await meeting.receive(); assert.equal(meeting.status()[0].status, 'interrupted');
  assert.equal(JSON.parse(await readFile(f.file)).active, false);
});

test('invalid decisions, duplicate cards, unbounded plans and arbitrary providers are rejected', () => {
  const valid = vote({ id: 'a' });
  for (const decisions of [[{ ...valid, action: 'run' }], [valid, valid], [{ ...valid, evidence: '' }], [{ ...valid, action: 'split', subtasks: [{ title: 'Do it', description: 'Do original work', provider: 'grok' }] }]]) assert.throws(() => parseMeetingDecisions({ decisions }));
});

test('shared blocker retries every authorized sibling, including a later identical card, without a new meeting', async t => {
  const f = await fixture(t), first = f.create(), second = f.create(); let calls = 0;
  const meeting = f.meetings({ decide: async (_provider, prompt) => {
    calls++; const group = JSON.parse(prompt.split('\n').at(-1)).agenda[0];
    assert.equal(group.relatedTasks.length, 2);
    return [vote({ id: group.taskId }, { resolved: true, action: 'retry' })];
  } });
  await meeting.receive();
  assert.ok(f.store.snapshot().tasks.every(task => task.status === 'pending'));
  const later = f.create(); f.advance(); await meeting.receive();
  assert.equal(f.store.snapshot().tasks.find(task => task.id === later.id).status, 'pending');
  assert.equal(calls, 3); assert.equal(meeting.status()[0].taskIds.length, 3);
  assert.ok([first, second, later].every(task => meeting.status()[0].resolutions[task.id].status === 'resumed'));
});

test('priority edits preserve approved authorization; changing description needs a fresh consultation', async t => {
  const f = await fixture(t), card = f.create(); let idle = false, calls = 0;
  const meeting = f.meetings({ canRun: () => idle, decide: async () => { calls++; return [vote(card, { resolved: true, action: 'retry' })]; } });
  await meeting.receive(); f.store.updateTask(card.id, { priority: 'high' });
  idle = true; await meeting.receive(); assert.equal(f.store.snapshot().tasks[0].status, 'pending');
  f.store.updateTask(card.id, { status: 'blocked', description: 'Materially different authorization' });
  f.advance(); await meeting.receive();
  assert.equal(calls, 6); assert.equal(f.store.snapshot().tasks[0].status, 'pending');
});

test('shared split creates one delegate set and resumes every parent, including a later duplicate', async t => {
  const f = await fixture(t), first = f.create(), second = f.create(); let calls = 0;
  const meeting = f.meetings({ decide: async (_provider, prompt) => {
    calls++; const representative = JSON.parse(prompt.split('\n').at(-1)).agenda[0];
    return [vote({ id: representative.taskId }, { resolved: true, action: 'split', subtasks: [{ title: 'Shared original implementation', description: 'Implement both identical original requirements once', provider: 'claude' }] })];
  } });
  await meeting.receive();
  const child = f.store.snapshot().tasks.find(task => ![first.id, second.id].includes(task.id));
  assert.equal(f.store.snapshot().tasks.length, 3);
  assert.ok(child.description.includes(first.id) && child.description.includes(second.id));
  f.store.updateTask(first.id, { priority: 'high' });
  const later = f.create(); f.advance(); await meeting.receive();
  assert.equal(f.store.snapshot().tasks.length, 4);
  assert.equal(meeting.status()[0].resolutions[later.id].status, 'split');
  f.store.updateTask(child.id, { status: 'done' }); f.advance(); await meeting.receive();
  assert.ok([first, second, later].every(card => f.store.snapshot().tasks.find(task => task.id === card.id).status === 'pending'));
  assert.equal(calls, 3);
});

test('completed delegates cannot resume parents while any other blocker remains unresolved', async t => {
  const f = await fixture(t), parent = f.create();
  const meeting = f.meetings({ decide: async (_provider, prompt) => JSON.parse(prompt.split('\n').at(-1)).agenda.map(item => vote({ id: item.taskId }, item.taskId === parent.id ? { resolved: true, action: 'split', subtasks: [{ title: 'Original work', description: 'Original scope only', provider: 'claude' }] } : {})) });
  await meeting.receive();
  const child = f.store.snapshot().tasks.find(task => task.id !== parent.id);
  f.store.updateTask(child.id, { status: 'done' }); const other = f.create({ title: 'Unresolved dependency' });
  f.advance(); await meeting.receive();
  assert.equal(f.store.snapshot().tasks.find(task => task.id === parent.id).status, 'blocked');
  f.store.updateTask(other.id, { status: 'done' }); await meeting.receive();
  assert.equal(f.store.snapshot().tasks.find(task => task.id === parent.id).status, 'pending');
});

test('corrupt room state cannot suppress ordinary work reminders or touch blocked cards', async t => {
  const f = await fixture(t), card = f.create();
  const pending = f.store.createTask({ title: 'Independent pending card', provider: 'claude', projectPath: f.home });
  await writeFile(f.file, 'invalid JSON'); let calls = 0;
  const meeting = f.meetings({ decide: async () => assert.fail('Room unavailable.') });
  const recipients = createWatchRecipients({ store: f.store, meetings: meeting, now: f.now, decide: async provider => {
    calls++; assert.equal(provider, 'claude'); return [{ taskId: pending.id, action: 'run' }];
  } });
  await recipients.receive(report(f.now()));
  assert.equal(calls, 1); assert.equal(f.store.snapshot().tasks.find(task => task.id === card.id).status, 'blocked');
});

test('oversized inherited authorization rejects a split visibly and creates no partial tasks', async t => {
  const f = await fixture(t), card = f.create({ description: 'a'.repeat(19000) });
  const meeting = f.meetings({ decide: async () => [vote(card, { resolved: true, action: 'split', subtasks: [{ title: 'Scope work', description: 'b'.repeat(2000), provider: 'claude' }] })] });
  await meeting.receive();
  assert.equal(f.store.snapshot().tasks.length, 1); assert.equal(f.store.snapshot().tasks[0].status, 'blocked');
  const resolution = meeting.status()[0].resolutions[card.id];
  assert.equal(resolution.status, 'rejected'); assert.match(resolution.reason, /长度上限/);
});

test('parking one shared parent while a split waits cannot freeze the remaining authorized parent', async t => {
  const f = await fixture(t), first = f.create(), second = f.create(); let ready = false;
  const meeting = f.meetings({ canRun: () => ready, decide: async (_provider, prompt) => JSON.parse(prompt.split('\n').at(-1)).agenda.map(item => vote({ id: item.taskId }, { resolved: true, action: 'split', subtasks: [{ title: 'Original shared work', description: 'Original scope only', provider: 'claude' }] })) });
  await meeting.receive(); f.store.updateTask(second.id, { parked: true }); ready = true;
  await meeting.receive();
  const children = f.store.snapshot().tasks.filter(task => ![first.id, second.id].includes(task.id));
  assert.equal(children.length, 1); assert.ok(!children[0].description.includes(second.id));
  assert.equal(f.store.snapshot().tasks.find(task => task.id === second.id).status, 'blocked');
  assert.ok(!meeting.status()[0].resolutions[second.id]);
});

test('the same concrete blocker across different scopes is consulted once; new scope decisions are not inherited', async t => {
  const f = await fixture(t);
  const fail = title => {
    const card = f.store.createTask({ title, description: `Only ${title}`, provider: 'codex', projectPath: f.home });
    const claim = f.store.claimTask({ id: 'worker', provider: 'codex', projectPath: f.home }, { taskId: card.id });
    return f.store.finishTask(card.id, claim.claimToken, { status: 'blocked', error: 'Shared dependency offline' });
  };
  const first = fail('Menu icon'); let calls = 0;
  const meeting = f.meetings({ decide: async () => { calls++; return [vote(first)]; } });
  await meeting.receive(); const second = fail('Inventory icon'); f.advance(); await meeting.receive();
  assert.equal(calls, 3); assert.equal(f.store.blockedMeetings().length, 1);
  assert.equal(meeting.holds(second), true);
  assert.equal(f.store.snapshot().tasks.find(task => task.id === second.id).status, 'blocked');
});

test('different scopes present at the same meeting require separate decisions before applying either', async t => {
  const f = await fixture(t), cards = [];
  for (const title of ['Menu icon', 'Inventory icon']) {
    const task = f.store.createTask({ title, provider: 'codex', projectPath: f.home });
    const claim = f.store.claimTask({ id: 'worker', provider: 'codex', projectPath: f.home }, { taskId: task.id });
    cards.push(f.store.finishTask(task.id, claim.claimToken, { status: 'blocked', error: 'Shared dependency offline' }));
  }
  const meeting = f.meetings({ decide: async (_provider, prompt) => {
    const page = JSON.parse(prompt.split('\n').at(-1)).agenda; assert.equal(page.length, 2);
    return page.map(item => vote({ id: item.taskId }, { resolved: true, action: 'retry' }));
  } });
  await meeting.receive(); assert.equal(meeting.status().length, 1);
  assert.ok(cards.every(card => f.store.snapshot().tasks.find(task => task.id === card.id).status === 'pending'));
});

test('several late duplicate parents keep all inherited resolutions and share one delegate set', async t => {
  const f = await fixture(t), first = f.create();
  const meeting = f.meetings({ decide: async () => [vote(first, { resolved: true, action: 'split', subtasks: [{ title: 'Shared work', description: 'Original scope', provider: 'claude' }] })] });
  await meeting.receive(); const child = f.store.snapshot().tasks.find(task => task.id !== first.id);
  const late = [f.create(), f.create(), f.create()]; f.advance(); await meeting.receive();
  assert.ok(late.every(card => meeting.status()[0].resolutions[card.id]?.status === 'split'));
  f.store.updateTask(child.id, { status: 'done' }); await meeting.receive();
  assert.ok(late.every(card => f.store.snapshot().tasks.find(task => task.id === card.id).status === 'pending'));
});

test('a reblocked previously resumed card prevents unrelated redistribution until explicitly handled', async t => {
  const f = await fixture(t), first = f.create();
  const meeting = f.meetings({ decide: async (_provider, prompt) => JSON.parse(prompt.split('\n').at(-1)).agenda.map(task => vote({ id: task.taskId }, { resolved: true, action: 'retry' })) });
  await meeting.receive(); f.store.updateTask(first.id, { status: 'blocked' });
  const second = f.create({ title: 'Unrelated task' }); f.advance(); await meeting.receive();
  assert.ok(f.store.snapshot().tasks.every(task => task.status === 'blocked'));
  f.store.updateTask(first.id, { status: 'done' }); await meeting.receive();
  assert.equal(f.store.snapshot().tasks.find(task => task.id === second.id).status, 'pending');
});

test('resolved shared blocker permits a new scope owner self-check without reusing scope authorization or another meeting', async t => {
  const f = await fixture(t);
  const fail = title => {
    const card = f.store.createTask({ title, description: `Only ${title}`, provider: 'codex', projectPath: f.home });
    const claim = f.store.claimTask({ id: 'worker', provider: 'codex', projectPath: f.home }, { taskId: card.id });
    return f.store.finishTask(card.id, claim.claimToken, { status: 'blocked', error: 'Shared dependency offline' });
  };
  const first = fail('First scope'); let meetings = 0, selfChecks = 0;
  const meeting = f.meetings({ decide: async () => { meetings++; return [vote(first, { resolved: true, action: 'retry' })]; } });
  await meeting.receive(); const second = fail('Second scope'); f.advance();
  const recipients = createWatchRecipients({ store: f.store, meetings: meeting, now: f.now, decide: async (provider, prompt) => {
    selfChecks++; assert.equal(provider, 'codex');
    const scoped = JSON.parse(prompt.split('\n').at(-1)).board.find(task => task.taskId === second.id);
    assert.equal(scoped.blockedMeeting.scopePreviouslyAssessed, false);
    return [{ taskId: second.id, action: 'retry' }];
  } });
  await recipients.receive(report(f.now()));
  assert.equal(meetings, 3); assert.equal(selfChecks, 1);
  assert.equal(f.store.snapshot().tasks.find(task => task.id === second.id).status, 'pending');
});

test('multiple new scopes of a resolved blocker can receive their own self-checks without mutual starvation', async t => {
  const f = await fixture(t);
  const fail = title => {
    const card = f.store.createTask({ title, provider: 'codex', projectPath: f.home });
    const claim = f.store.claimTask({ id: 'worker', provider: 'codex', projectPath: f.home }, { taskId: card.id });
    return f.store.finishTask(card.id, claim.claimToken, { status: 'blocked', error: 'Shared dependency offline' });
  };
  const original = fail('Original'); let meetingCalls = 0;
  const meeting = f.meetings({ decide: async () => { meetingCalls++; return [vote(original, { resolved: true, action: 'retry' })]; } });
  await meeting.receive(); f.store.updateTask(original.id, { status: 'done' });
  const fresh = [fail('New scope A'), fail('New scope B')]; f.advance();
  let inspections = 0;
  const recipients = createWatchRecipients({ store: f.store, meetings: meeting, now: f.now, decide: async () => {
    inspections++; return fresh.map(card => ({ taskId: card.id, action: 'retry' }));
  } });
  await recipients.receive(report(f.now()));
  assert.equal(meetingCalls, 3); assert.equal(inspections, 1);
  assert.ok(fresh.every(card => f.store.snapshot().tasks.find(task => task.id === card.id).status === 'pending'));
});

test('explicitly unparked siblings inherit the existing delegate set before or after its completion', async t => {
  for (const afterCompletion of [false, true]) {
    const f = await fixture(t), first = f.create(), second = f.create(); let ready = false, calls = 0;
    const meeting = f.meetings({ canRun: () => ready, decide: async (_provider, prompt) => {
      calls++; return JSON.parse(prompt.split('\n').at(-1)).agenda.map(task => vote({ id: task.taskId }, { resolved: true, action: 'split', subtasks: [{ title: 'Shared work', description: 'Original scope only', provider: 'claude' }] }));
    } });
    await meeting.receive(); f.store.updateTask(second.id, { parked: true }); ready = true;
    await meeting.receive();
    const child = f.store.snapshot().tasks.find(task => ![first.id, second.id].includes(task.id));
    if (afterCompletion) { f.store.updateTask(child.id, { status: 'done' }); await meeting.receive(); }
    f.store.updateTask(second.id, { parked: false }); await meeting.receive();
    assert.equal(f.store.snapshot().tasks.length, 3);
    assert.ok(meeting.status()[0].resolutions[second.id]);
    if (!afterCompletion) { f.store.updateTask(child.id, { status: 'done' }); await meeting.receive(); }
    assert.equal(f.store.snapshot().tasks.find(task => task.id === second.id).status, 'pending'); assert.equal(calls, 3);
  }
});


test('maintenance defers a late unanimous meeting resolution until release without repeating the meeting', async t => {
  const f = await fixture(t), card = f.create();
  const owner = 'e27c435d-9f78-4be3-a1f7-6989a02b3a04'; let calls = 0;
  const meeting = f.meetings({ canRun: () => true, decide: async () => {
    if (++calls === 1) f.store.acquireMaintenance(owner);
    return [vote(card, { resolved: true, evidence: 'Fixture dependency verified', action: 'retry' })];
  } });
  await meeting.receive();
  assert.equal(calls, 3);
  assert.equal(f.store.snapshot().tasks.find(item => item.id === card.id).status, 'blocked');
  f.store.releaseMaintenance(owner);
  await meeting.receive();
  assert.equal(calls, 3);
  assert.equal(f.store.snapshot().tasks.find(item => item.id === card.id).status, 'pending');
});


test('maintenance preserves uncalled meeting agendas and delivery budget until release', async t => {
  const f = await fixture(t), card = f.create(); let calls = 0;
  const meeting = f.meetings({ decide: async () => { calls++; return [vote(card)]; } });
  const owner = 'c0310167-053f-4c26-869d-e15d2f0bb64a'; f.store.acquireMaintenance(owner);
  assert.equal(await meeting.receive(), false);
  assert.equal(calls, 0); assert.deepEqual(f.store.blockedMeetings(), []);
  assert.ok(providers.every(provider => f.store.watchReceipt(provider) === null));
  f.store.releaseMaintenance(owner);
  await meeting.receive(); assert.equal(calls, 3);
  assert.equal(f.store.blockedMeetings()[0].status, 'unresolved');
});
