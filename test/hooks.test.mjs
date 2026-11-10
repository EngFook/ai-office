import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { connectClaude, HOOK_EVENTS } from '../scripts/connect-claude.mjs';

async function fixture(t) {
  // Include apostrophes and spaces to exercise the installed shell command.
  const root = await mkdtemp(path.join(tmpdir(), "ai-office's hooks "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const claudeDir = path.join(root, '.claude');
  const pluginRoot = path.join(root, 'plugin');
  await mkdir(path.join(claudeDir, 'plugins'), { recursive: true });
  await mkdir(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
  const names = ['router', ...Array.from({ length: 76 }, (_, index) => `topic-${index + 1}`)];
  const directories = [];
  for (const name of names) {
    const directory = name === 'router' ? './router' : `./skills/engine/${name}`;
    directories.push(directory);
    const location = path.join(pluginRoot, directory);
    await mkdir(location, { recursive: true });
    await writeFile(path.join(location, 'SKILL.md'), `---\nname: ${name}\ndescription: >\n  Use for ${name} game development.\n  Write and debug ${name} code.\n---\n# ${name}\nFollow this skill.\n`);
  }
  await writeFile(path.join(pluginRoot, '.claude-plugin', 'marketplace.json'), JSON.stringify({ plugins: [{ name: 'gamedev', skills: directories }] }));
  await writeFile(path.join(claudeDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'gamedev@awesome-gamedev-agent-skills': [{ scope: 'user', installPath: pluginRoot, version: 'fixture' }] } }));
  const originalSettings = {
    enabledPlugins: { 'gamedev@awesome-gamedev-agent-skills': true, 'other@plugin': true },
    permissions: { allow: ['Read'] },
    model: 'existing-model',
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'existing command', timeout: 13 }] }],
      Stop: [{ hooks: [{ type: 'prompt', prompt: 'existing stop rule' }] }],
      OtherFutureEvent: [{ hooks: [{ type: 'command', command: 'future command' }] }],
    },
  };
  const settingsText = `${JSON.stringify(originalSettings, null, 4)}\n`;
  await writeFile(path.join(claudeDir, 'settings.json'), settingsText);
  await mkdir(path.join(claudeDir, 'agents'));
  await writeFile(path.join(claudeDir, 'agents', 'my-agent.md'), 'My own agent stays exactly as written.\n');
  return { root, claudeDir, pluginRoot, originalSettings, settingsText };
}

async function recordedEvents(directory) {
  const names = (await readdir(directory)).filter(name => name.endsWith('.json'));
  return Promise.all(names.map(async name => ({ name, data: JSON.parse(await readFile(path.join(directory, name), 'utf8')) })));
}

test('installer preserves settings and unrelated agents, backs up first, and creates 76 specialists plus router idempotently', async t => {
  const fixture_ = await fixture(t);
  const { claudeDir, originalSettings, settingsText } = fixture_;
  const first = await connectClaude({ claudeDir });
  assert.equal(first.specialists, 76);
  assert.equal(first.changedFiles, 79);
  assert.equal(await readFile(path.join(first.backupDirectory, 'settings.json'), 'utf8'), settingsText);
  const saved = JSON.parse(await readFile(path.join(claudeDir, 'settings.json'), 'utf8'));
  assert.deepEqual(saved.enabledPlugins, originalSettings.enabledPlugins);
  assert.deepEqual(saved.permissions, originalSettings.permissions);
  assert.equal(saved.model, originalSettings.model);
  assert.deepEqual(saved.hooks.PreToolUse[0], originalSettings.hooks.PreToolUse[0]);
  assert.deepEqual(saved.hooks.Stop[0], originalSettings.hooks.Stop[0]);
  assert.deepEqual(saved.hooks.OtherFutureEvent, originalSettings.hooks.OtherFutureEvent);
  for (const event of HOOK_EVENTS) {
    const observer = saved.hooks[event].flatMap(group => group.hooks).filter(hook => hook.command?.endsWith(' --ai-office-managed'));
    assert.equal(observer.length, 1, `${event} has one observer`);
    assert.ok(observer[0].command.includes(process.execPath));
    assert.equal(observer[0].async, undefined, 'lifecycle writes complete in event order');
  }
  const agentNames = (await readdir(path.join(claudeDir, 'agents'))).filter(name => name.startsWith('ai-office-'));
  assert.equal(agentNames.length, 77);
  const topic = await readFile(path.join(claudeDir, 'agents', 'ai-office-topic-1.md'), 'utf8');
  assert.match(topic, /skills:\n  - "gamedev:topic-1"/);
  assert.doesNotMatch(topic.split('---')[1], /^(?:tools|model|permissionMode):/m);
  const router = await readFile(path.join(claudeDir, 'agents', 'ai-office-gamedev-router.md'), 'utf8');
  assert.match(router, /skills:\n  - "gamedev:router"/);
  for (let index = 1; index <= 76; index++) assert.ok(router.includes(`gamedev:topic-${index}\``));
  assert.equal(await readFile(path.join(claudeDir, 'agents', 'my-agent.md'), 'utf8'), 'My own agent stays exactly as written.\n');
  const second = await connectClaude({ claudeDir });
  assert.equal(second.changedFiles, 0);
  assert.equal(second.backupDirectory, null);
  assert.equal((await readdir(path.join(claudeDir, 'ai-office', 'backups'))).length, 1);
});

test('installer refuses unrelated agent collisions and symlink targets before changing settings', async t => {
  const { claudeDir, settingsText } = await fixture(t);
  const collision = path.join(claudeDir, 'agents', 'ai-office-topic-1.md');
  await writeFile(collision, 'This filename belongs to the user.');
  await assert.rejects(connectClaude({ claudeDir }), /unrelated file/);
  assert.equal(await readFile(path.join(claudeDir, 'settings.json'), 'utf8'), settingsText);
  assert.equal(await readFile(collision, 'utf8'), 'This filename belongs to the user.');
  await rm(collision);
  await symlink(path.join(claudeDir, 'settings.json'), collision);
  await assert.rejects(connectClaude({ claudeDir }), /non-regular file/);
  assert.equal(await readFile(path.join(claudeDir, 'settings.json'), 'utf8'), settingsText);
});

test('installed hook records lifecycle metadata without prompts, arguments, results or transcript paths', async t => {
  const { claudeDir } = await fixture(t);
  const result = await connectClaude({ claudeDir });
  const settings = JSON.parse(await readFile(path.join(claudeDir, 'settings.json'), 'utf8'));
  const command = settings.hooks.PreToolUse.at(-1).hooks[0].command;
  const input = {
    hook_event_name: 'PreToolUse', session_id: 'session-123', agent_id: 'agent-789', agent_type: 'ai-office-topic-1', cwd: '/project/with space',
    tool_name: 'Skill', tool_input: { skill: 'gamedev:topic-1', args: 'secret-tool-arguments' },
    prompt: 'secret-user-prompt', transcript_path: '/secret/transcript.jsonl', agent_transcript_path: '/secret/subagent.jsonl',
    tool_response: 'secret-tool-result', last_assistant_message: 'secret-model-output', message: 'secret-notification-text',
    pid: 999999, timestamp: 'spoofed', notification_type: 'ignored-outside-notification',
  };
  const execution = spawnSync('/bin/sh', ['-c', command], { input: JSON.stringify(input), encoding: 'utf8', timeout: 2000 });
  assert.equal(execution.status, 0);
  assert.equal(execution.stdout, '');
  assert.equal(execution.stderr, '');
  const [{ name, data }] = await recordedEvents(result.eventsDirectory);
  assert.deepEqual(Object.keys(data).sort(), ['agentId', 'agentType', 'cwd', 'event', 'sessionId', 'skill', 'timestamp', 'tool'].sort());
  assert.equal(data.event, 'PreToolUse');
  assert.equal(data.sessionId, input.session_id);
  assert.equal(data.agentId, input.agent_id);
  assert.equal(data.agentType, input.agent_type);
  assert.equal(data.skill, 'gamedev:topic-1');
  assert.ok(Number.isFinite(Date.parse(data.timestamp)));
  assert.ok(!JSON.stringify(data).includes('secret'));
  assert.equal((await stat(path.join(result.eventsDirectory, name))).mode & 0o777, 0o600);
  assert.equal((await stat(result.eventsDirectory)).mode & 0o777, 0o700);
  assert.equal((await readdir(result.eventsDirectory)).filter(file => file.endsWith('.tmp')).length, 0);
});

test('hook drops invalid and oversized input, sanitizes optional fields and gives notifications their type', async t => {
  const { claudeDir } = await fixture(t);
  const result = await connectClaude({ claudeDir });
  const run = input => spawnSync(process.execPath, [result.hookPath], { input, encoding: 'utf8', timeout: 2000 });
  for (const input of ['not json', '[]', JSON.stringify({ hook_event_name: 'Unknown', session_id: 'session' }), JSON.stringify({ hook_event_name: 'Stop', session_id: 'bad\nidentifier' }), ' '.repeat(1024 * 1024 + 1)]) {
    const output = run(input);
    assert.equal(output.status, 0);
    assert.equal(output.stdout, '');
    assert.equal(output.stderr, '');
  }
  assert.equal((await recordedEvents(result.eventsDirectory)).length, 0);
  for (const notification of ['idle_prompt', 'permission_prompt']) {
    assert.equal(run(JSON.stringify({ hook_event_name: 'Notification', session_id: 'session', notification_type: notification, tool_name: 'Bash', tool_input: { skill: 'must-not-record', command: 'private' }, cwd: 'relative/path', agent_type: 'bad\nname' })).status, 0);
  }
  const events = await recordedEvents(result.eventsDirectory);
  assert.equal(events.length, 2);
  assert.equal(new Set(events.map(event => event.name)).size, 2);
  assert.deepEqual(events.map(event => event.data.notificationType).sort(), ['idle_prompt', 'permission_prompt']);
  for (const { data } of events) {
    assert.equal(data.skill, undefined);
    assert.equal(data.cwd, undefined);
    assert.equal(data.agentType, undefined);
    assert.equal(data.pid, undefined, 'observer shell PID is never reported as Claude');
  }
  assert.equal(run(JSON.stringify({ hook_event_name: 'StopFailure', session_id: 'session', error: 'secret-auth-error', error_details: 'secret-provider-message', last_assistant_message: 'secret-output' })).status, 0);
  const failure = (await recordedEvents(result.eventsDirectory)).find(event => event.data.event === 'StopFailure');
  assert.ok(failure);
  assert.deepEqual(Object.keys(failure.data).sort(), ['event', 'sessionId', 'timestamp']);
  assert.ok(!JSON.stringify(failure.data).includes('secret'));
});
