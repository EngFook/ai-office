import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { claudeBridge, discoverSkills, readClaudeStatus, reconstructAgents, sanitizeEvent } from '../server/claude-bridge.mjs';

const skills = [{ id: 'gamedev:game-ai', name: 'game-ai', category: 'disciplines' }];
const event = (name, timestamp, extra = {}) => ({ event: name, sessionId: 'session-1', timestamp, ...extra });

test('tracks simultaneous agents, keeps work active during model thinking, and isolates stops', () => {
  const events = [event('UserPromptSubmit', 1000), event('SubagentStart', 2000, { agentId: 'a', agentType: 'ai-office-game-ai' }), event('SubagentStart', 3000, { agentId: 'b', agentType: 'Explore' }), event('PreToolUse', 4000, { agentId: 'a', tool: 'Read' }), event('PostToolUse', 5000, { agentId: 'a', tool: 'Read' }), event('Stop', 6000)];
  const agents = reconstructAgents(events, skills);
  assert.equal(agents.find(agent => agent.id === 'session-1:main').status, 'idle');
  assert.equal(agents.find(agent => agent.id === 'session-1:a').status, 'working');
  assert.equal(agents.find(agent => agent.id === 'session-1:a').skillId, 'gamedev:game-ai');
  assert.equal(agents.find(agent => agent.id === 'session-1:a').tool, null);
  assert.equal(agents.find(agent => agent.id === 'session-1:b').status, 'working');
  const stopped = reconstructAgents([...events, event('SubagentStop', 7000, { agentId: 'a' })], skills);
  assert.equal(stopped.find(agent => agent.id === 'session-1:a').status, 'idle');
  assert.equal(stopped.find(agent => agent.id === 'session-1:a').skillId, null);
  assert.equal(stopped.find(agent => agent.id === 'session-1:b').status, 'working');
});

test('stopped children ignore late tool metadata until an explicit SubagentStart resumes them', () => {
  const events = [event('SubagentStart', 1000, { agentId: 'child', agentType: 'ai-office-game-ai' }), event('PostToolUse', 2000, { agentId: 'child', tool: 'Read' }), event('SubagentStop', 3000, { agentId: 'child' }), event('PostToolUse', 4000, { agentId: 'child', tool: 'Bash' }), event('PreToolUse', 5000, { agentId: 'child', tool: 'Write' }), event('SubagentStart', 5500, { agentId: 'sibling', agentType: 'Explore' })];
  const stopped = reconstructAgents(events, skills);
  const child = stopped.find(agent => agent.id === 'session-1:child');
  assert.equal(child.status, 'idle');
  assert.equal(child.lastEvent, 'SubagentStop');
  assert.equal(child.updatedAt, '1970-01-01T00:00:03.000Z');
  assert.equal(child.lastTool, 'Read');
  assert.equal(stopped.find(agent => agent.id === 'session-1:sibling').status, 'working');
  const resumed = reconstructAgents([...events, event('SubagentStart', 6000, { agentId: 'child', agentType: 'ai-office-game-ai' }), event('PreToolUse', 7000, { agentId: 'child', tool: 'Edit' })], skills).find(agent => agent.id === 'session-1:child');
  assert.equal(resumed.status, 'working');
  assert.equal(resumed.skillId, 'gamedev:game-ai');
  assert.equal(resumed.tool, 'Edit');
  assert.equal(resumed.lastTool, 'Edit');
});

test('retains last tool lifecycle metadata after success, failure and stop without arguments', () => {
  const events = [event('PreToolUse', 1000, { tool: 'Read', tool_input: { file_path: '/private/file' } })];
  const [running] = reconstructAgents(events);
  assert.equal(running.tool, 'Read');
  assert.equal(running.lastTool, 'Read');
  assert.equal(running.lastToolOutcome, 'running');
  assert.equal(running.lastToolAt, '1970-01-01T00:00:01.000Z');
  events.push(event('PostToolUse', 2000, { tool: 'Read' }));
  const [succeeded] = reconstructAgents(events);
  assert.equal(succeeded.tool, null);
  assert.equal(succeeded.lastTool, 'Read');
  assert.equal(succeeded.lastToolOutcome, 'succeeded');
  assert.equal(succeeded.lastToolAt, '1970-01-01T00:00:02.000Z');
  events.push(event('PreToolUse', 3000, { tool: 'Bash' }), event('PostToolUseFailure', 4000, { tool: 'Bash', error: 'private error' }), event('Stop', 5000));
  const [stopped] = reconstructAgents(events);
  assert.equal(stopped.status, 'idle');
  assert.equal(stopped.tool, null);
  assert.equal(stopped.lastTool, 'Bash');
  assert.equal(stopped.lastToolOutcome, 'failed');
  assert.equal(stopped.lastToolAt, '1970-01-01T00:00:04.000Z');
  assert.ok(!JSON.stringify(stopped).includes('private'));
});

test('skill tool context persists until stop; notification waiting clears on activity', () => {
  const events = [event('PreToolUse', 1000, { tool: 'Skill', skill: 'gamedev:game-ai' }), event('PostToolUse', 2000, { tool: 'Skill' }), event('Notification', 3000, { notificationType: 'permission_prompt' })];
  const [waiting] = reconstructAgents(events, skills);
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.skillId, 'gamedev:game-ai');
  const [working] = reconstructAgents([...events, event('PreToolUse', 4000, { tool: 'Bash' })], skills);
  assert.equal(working.status, 'working');
  assert.equal(working.skillId, 'gamedev:game-ai');
  const [idle] = reconstructAgents([...events, event('Stop', 5000)], skills);
  assert.equal(idle.status, 'idle');
  assert.equal(idle.skillId, null);
});

test('main sessions launched with a specialist agent map to their skill while working', () => {
  const agents = reconstructAgents([event('SessionStart', 1000, { agentType: 'ai-office-game-ai', agentId: 'primary' }), event('UserPromptSubmit', 2000, { agentId: 'primary' }), event('PreToolUse', 3000, { agentId: 'primary', tool: 'Read' })], skills);
  assert.equal(agents.length, 1);
  assert.equal(agents[0].id, 'session-1:main');
  assert.equal(agents[0].skillId, 'gamedev:game-ai');
  assert.equal(agents[0].status, 'working');
  assert.equal(agents[0].isSubagent, false);
});

test('StopFailure ends main agent work without retaining API error details or stopping independent subagents', () => {
  const events = [event('PreToolUse', 1000, { tool: 'Skill', skill: 'gamedev:game-ai' }), event('SubagentStart', 2000, { agentId: 'child', agentType: 'Explore' }), event('StopFailure', 3000, { error: 'rate_limit', error_details: 'private API error', last_assistant_message: 'private output' })];
  const agents = reconstructAgents(events, skills);
  const main = agents.find(agent => agent.id === 'session-1:main');
  assert.equal(main.status, 'waiting');
  assert.equal(main.skillId, null);
  assert.equal(main.tool, null);
  assert.equal(main.lastEvent, 'StopFailure');
  assert.equal(agents.find(agent => agent.id === 'session-1:child').status, 'working');
  assert.ok(!JSON.stringify(agents).includes('private'));
  assert.ok(!JSON.stringify(sanitizeEvent(events[2])).includes('rate_limit'));
});

test('session end clears all agents; resumed session does not revive old subagents', () => {
  const events = [event('SessionStart', 1000), event('SubagentStart', 2000, { agentId: 'a', agentType: 'ai-office-game-ai' }), event('SessionEnd', 3000)];
  assert.ok(reconstructAgents(events, skills).every(agent => agent.status === 'offline' && agent.skillId === null));
  const resumed = reconstructAgents([...events, event('SessionStart', 4000)], skills);
  assert.equal(resumed.find(agent => agent.id.endsWith(':main')).status, 'idle');
  assert.equal(resumed.find(agent => agent.id.endsWith(':a')).status, 'offline');
  assert.equal(reconstructAgents([event('UserPromptSubmit', 1000, { pid: 321 })], [], { isProcessAlive: () => false })[0].status, 'offline');
  assert.ok(reconstructAgents([...events, event('PostToolUse', 3500, { agentId: 'a', tool: 'Read' })], skills).every(agent => agent.status === 'offline'));
  assert.equal(reconstructAgents([event('SessionEnd', 1000)], skills)[0].status, 'offline');
});

test('sanitizes metadata and paths without retaining prompts, transcripts or tool arguments', () => {
  const clean = sanitizeEvent({ hook_event_name: 'PreToolUse', session_id: 'good-id', timestamp: 1000, cwd: '/tmp/one/../project', tool_name: 'Bash', tool_input: { command: 'secret' }, prompt: 'private', transcript_path: '/private/transcript', last_assistant_message: 'private' });
  assert.equal(clean.cwd, '/tmp/project');
  assert.ok(!JSON.stringify(clean).includes('private'));
  assert.ok(!JSON.stringify(clean).includes('secret'));
  assert.equal(sanitizeEvent(event('Stop', 1000, { cwd: '/tmp/\nsecret' })).cwd, '');
  assert.equal(sanitizeEvent(event('Stop', 1000, { cwd: '../../private' })).cwd, '');
  assert.equal(sanitizeEvent(event('Stop', 1000, { sessionId: '../bad' })), null);
  assert.equal(sanitizeEvent(event('Stop', 1e30)), null);
});

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'ai-office-bridge-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, 'plugins'), { recursive: true });
  const install = path.join(home, 'plugins', 'cache', 'gamedev', 'version-one');
  await mkdir(path.join(install, 'skills', 'disciplines', 'game-ai'), { recursive: true });
  await mkdir(path.join(install, 'router'), { recursive: true });
  await writeFile(path.join(install, 'skills', 'disciplines', 'game-ai', 'SKILL.md'), '---\nname: game-ai\ndescription: >\n  First description line\n  and second line.\n---\n# Private body omitted\n');
  await writeFile(path.join(install, 'router', 'SKILL.md'), '---\nname: router\ndescription: "Choose the right skill"\n---\n');
  await writeFile(path.join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'gamedev@awesome-gamedev-agent-skills': [{ installPath: install, lastUpdated: '2026-01-01' }] } }));
  await mkdir(path.join(home, 'ai-office', 'events'), { recursive: true });
  return home;
}

test('discovers real plugin catalog with stable IDs, folded descriptions, categories and router', async t => {
  const home = await fixture(t);
  const catalog = await discoverSkills(home);
  assert.equal(catalog.length, 2);
  assert.equal(catalog[0].id, 'gamedev:game-ai');
  assert.equal(catalog[0].description, 'First description line and second line.');
  assert.equal(catalog[0].category, 'disciplines');
  assert.equal(catalog[1].id, 'gamedev:router');
  assert.equal(catalog[1].category, 'router');
  assert.equal(reconstructAgents([event('SubagentStart', 1000, { agentId: 'router', agentType: 'ai-office-gamedev-router' })], catalog)[0].skillId, 'gamedev:router');
});

test('default catalog and status honor CLAUDE_CONFIG_DIR', async t => {
  const home = await fixture(t);
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = home;
  t.after(() => {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  });
  assert.equal((await discoverSkills()).length, 2);
  const status = await readClaudeStatus();
  assert.equal(status.skills.length, 2);
  assert.equal(status.topicSkillCount, 1);
});

test('session metadata PID clears crashed main and child agents when hook events lack a PID', async t => {
  const home = await fixture(t);
  const inbox = path.join(home, 'ai-office', 'events');
  await mkdir(path.join(home, 'sessions'));
  await writeFile(path.join(home, 'sessions', 'crashed.json'), JSON.stringify({ sessionId: 'session-1', pid: 998, cwd: '/tmp/project', startedAt: 1000 }));
  await writeFile(path.join(inbox, 'main.json'), JSON.stringify(event('UserPromptSubmit', 2000)));
  await writeFile(path.join(inbox, 'child.json'), JSON.stringify(event('SubagentStart', 3000, { agentId: 'a', agentType: 'ai-office-game-ai' })));
  const dead = await readClaudeStatus({ claudeHome: home, isProcessAlive: () => false });
  assert.equal(dead.connected, false);
  assert.equal(dead.liveAgentCount, 0);
  assert.equal(dead.agents.length, 2);
  assert.ok(dead.agents.every(agent => agent.status === 'offline' && agent.skillId === null));
  assert.ok(dead.agents.every(agent => !Object.hasOwn(agent, 'pid')));
  const alive = await readClaudeStatus({ claudeHome: home, isProcessAlive: () => true });
  assert.ok(alive.agents.every(agent => agent.status === 'working'));
  await writeFile(path.join(inbox, 'unknown.json'), JSON.stringify(event('UserPromptSubmit', 4000, { sessionId: 'no-pid-evidence' })));
  const unknown = await readClaudeStatus({ claudeHome: home, isProcessAlive: () => false });
  assert.equal(unknown.agents.find(agent => agent.sessionId === 'no-pid-evidence').status, 'working');
});

test('status reads only event JSON files, ignores partial files and symlinks, discovers live session metadata', async t => {
  const home = await fixture(t);
  const inbox = path.join(home, 'ai-office', 'events');
  await Promise.all([
    writeFile(path.join(inbox, 'one.json'), JSON.stringify(event('UserPromptSubmit', 1000, { pid: 101 }))),
    writeFile(path.join(inbox, 'partial.tmp'), '{'),
    writeFile(path.join(inbox, 'invalid.json'), '{'),
    writeFile(path.join(home, 'secret.json'), JSON.stringify(event('SessionStart', 2000, { sessionId: 'secret' }))),
    mkdir(path.join(home, 'sessions')),
  ]);
  await symlink(path.join(home, 'secret.json'), path.join(inbox, 'link.json'));
  await writeFile(path.join(home, 'sessions', 'live.json'), JSON.stringify({ sessionId: 'existing', pid: 102, cwd: '/tmp/project', startedAt: 2000, transcript_path: '/secret', status: 'working' }));
  await writeFile(path.join(home, 'sessions', 'dead.json'), JSON.stringify({ sessionId: 'dead', pid: 999, startedAt: 2000 }));
  const status = await readClaudeStatus({ claudeHome: home, isProcessAlive: pid => pid !== 999 });
  assert.equal(status.eventCount, 1);
  assert.equal(status.connected, true);
  assert.equal(status.liveAgentCount, 2);
  assert.equal(status.topicSkillCount, 1);
  assert.equal(status.hookInstalled, false);
  assert.equal(status.agents.find(agent => agent.sessionId === 'existing').status, 'idle');
  assert.equal(status.agents.find(agent => agent.sessionId === 'existing').observed, false);
  assert.ok(!JSON.stringify(status).includes('secret'));
  assert.equal(status.lastEventAt, '1970-01-01T00:00:01.000Z');
  await writeFile(path.join(inbox, 'end.json'), JSON.stringify(event('SessionEnd', 3000, { sessionId: 'existing' })));
  const ended = await readClaudeStatus({ claudeHome: home, isProcessAlive: pid => pid !== 999 });
  assert.equal(ended.agents.find(agent => agent.sessionId === 'existing').status, 'offline');
});

test('hookInstalled requires the hook script and complete enabled lifecycle registration', async t => {
  const home = await fixture(t);
  const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'Stop', 'StopFailure', 'SessionEnd', 'SubagentStart', 'SubagentStop'];
  const hooks = Object.fromEntries(events.map(name => [name, [{ hooks: [{ type: 'command', command: `node ${home}/ai-office/hook.mjs` }] }]]));
  await writeFile(path.join(home, 'settings.json'), JSON.stringify({ hooks }));
  assert.equal((await readClaudeStatus({ claudeHome: home })).hookInstalled, false);
  await writeFile(path.join(home, 'ai-office', 'hook.mjs'), '// fixture');
  assert.equal((await readClaudeStatus({ claudeHome: home })).hookInstalled, true);
  await writeFile(path.join(home, 'settings.json'), JSON.stringify({ hooks, disableAllHooks: true }));
  assert.equal((await readClaudeStatus({ claudeHome: home })).hookInstalled, false);
});

test('API rejects remote hosts, cross-origin requests and writes, serves local read-only requests', async t => {
  const home = await fixture(t);
  let middleware;
  claudeBridge({ claudeHome: home }).configureServer({ middlewares: { use: handler => { middleware = handler; } } });
  async function request(extra = {}) {
    let body;
    const response = { statusCode: 200, setHeader() {}, end(value) { body = value; } };
    await middleware({ url: '/api/claude/status', method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:5173' }, ...extra }, response, () => assert.fail('Expected API handler'));
    return { status: response.statusCode, body: JSON.parse(body) };
  }
  assert.equal((await request()).status, 200);
  assert.equal((await request({ method: 'POST' })).status, 405);
  assert.equal((await request({ socket: { remoteAddress: '192.168.1.10' } })).status, 403);
  assert.equal((await request({ headers: { host: '127.0.0.1:5173', origin: 'https://evil.example' } })).status, 403);
  assert.equal((await request({ headers: { host: '127.0.0.1:5173', origin: 'https://127.0.0.1:5173' } })).status, 403);
  assert.equal((await request({ headers: { host: 'evil.example' } })).status, 403);
  assert.equal((await request({ headers: { host: '127.0.0.1:5173', 'sec-fetch-site': 'cross-site' } })).status, 403);
});
