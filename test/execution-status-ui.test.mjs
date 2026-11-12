import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSharedRoster, withTaskWorkers } from '../src/unified-office.js';

test('shared status renders running and recorded-unconfirmed counts separately while keeping unconfirmed activity behind its disclosure', async () => {
  const { createServer } = await import('vite');
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false, ws: false } });
  try {
    const { RoomDetails } = await server.ssrLoadModule('/src/OfficeNavigation.jsx');
    const { AgentStatusPanel, SharedConnections } = await server.ssrLoadModule('/src/ClaudeConnection.jsx');
    const claude = { connected: true, agents: [{ id: 'claude:child', sessionId: 'claude', status: 'working', observed: true, executionState: 'unconfirmed', observationSource: 'claude-lifecycle-hooks' }] };
    const codex = { connected: true, agents: [{ id: 'codex-child', sessionId: 'codex-child', status: 'working', observed: true, executionState: 'working' }, { id: 'detected', status: 'idle', observed: false, executionState: 'unconfirmed' }] };
    const roster = buildSharedRoster({ claude, codex });
    const html = renderToStaticMarkup(React.createElement(AgentStatusPanel, { agents: roster, provider: 'Shared studio' }));
    assert.equal((html.match(/class="shared-agent-row is-running"/g) || []).length, 1);
    assert.match(html, /1 (?:运行|running) · 2 (?:状态待确认|unconfirmed)/);
    assert.match(html, /Status unconfirmed|状态待确认|Unconfirmed/);
    assert.match(html, /aria-expanded="false"[^>]*>(?:状态待确认|Unconfirmed) \(2\)/);
    assert.doesNotMatch(html, /Locate agent Claude Code/);
    assert.doesNotMatch(html, /2 running|2 运行中/);
    const connections = renderToStaticMarkup(React.createElement(SharedConnections, { claude, codex }));
    assert.match(connections, /recorded active|活动记录/);
    assert.doesNotMatch(connections, /1 idle/);
    const disconnected = withTaskWorkers({ connected: false, error: 'Native source offline', metadataAvailable: false, agents: [] }, { started: true, running: [{ taskId: 'task', provider: 'codex', workerId: 'real-runner' }], agents: [{ id: 'real-runner', taskId: 'task', provider: 'Codex', status: 'working', observed: true, agentType: 'office-task-runner' }] }, 'Codex');
    const fallback = renderToStaticMarkup(React.createElement(SharedConnections, { codex: disconnected }));
    assert.match(fallback, /Native source offline · task activity available|原生来源中断 · 任务执行可见/);
    assert.match(fallback, /1 running/);
    const notConnected = renderToStaticMarkup(React.createElement(SharedConnections, { codex: { ...disconnected, error: null, metadataAvailable: true } }));
    assert.match(notConnected, /Native source not connected · task activity available|原生来源未连接 · 任务执行可见/);
    assert.doesNotMatch(notConnected.match(/<strong>Codex<\/strong>[\s\S]*?<\/span>/)?.[0] || '', />Not connected<\/span>/);

    const offline = renderToStaticMarkup(React.createElement(SharedConnections, { codex: { ...disconnected, agents: [] } }));
    assert.doesNotMatch(offline, /Native source offline · task activity available|原生来源中断 · 任务执行可见/);

    const room = renderToStaticMarkup(React.createElement(RoomDetails, { agents: roster, focus: 'department-0' }));
    assert.match(room, /0 (?:running|运行中)/);
    assert.match(room, /1 (?:activity records · unconfirmed|活动待确认)/);
    assert.doesNotMatch(room, /1 working|1 running|1 运行中/);
  } finally { await server.close(); }
});


test('Claude and Codex workspace totals use the same explicit execution evidence as the office', async () => {
  const { createServer } = await import('vite');
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false, ws: false } });
  try {
    const { ClaudeWorkspaceView } = await server.ssrLoadModule('/src/ClaudeWorkspace.jsx');
    const { CodexWorkspaceView } = await server.ssrLoadModule('/src/CodexWorkspace.jsx');
    const agents = [
      { id: 'actual', sessionId: 's', observed: true, status: 'working', executionState: 'working', isSubagent: true },
      { id: 'alias', sessionId: 's', observed: true, status: 'running', executionState: 'running', isSubagent: true },
      { id: 'historical', sessionId: 's', observed: true, status: 'working', executionState: 'unconfirmed' },
      { id: 'missing', sessionId: 's', observed: true, status: 'working' },
      { id: 'not-observed', sessionId: 's', observed: false, status: 'working', executionState: 'working' },
      { id: 'idle-unconfirmed', sessionId: 's', observed: true, status: 'idle', executionState: 'unconfirmed' },
      { id: 'idle', sessionId: 's', observed: true, status: 'idle', executionState: 'idle' },
      { id: 'waiting', sessionId: 's', observed: true, status: 'waiting', executionState: 'waiting' },
    ];
    for (const View of [ClaudeWorkspaceView, CodexWorkspaceView]) {
      const html = renderToStaticMarkup(React.createElement(View, { data: { agents, metadataAvailable: true }, lang: 'zh' }));
      assert.match(html, /运行中 2/);
      assert.match(html, /等待 1/);
      assert.match(html, /空闲 1/);
      assert.match(html, /待确认 4/);
      assert.equal((html.match(/class="cw-state cw-running"/g) || []).length, 2);
      assert.doesNotMatch(html, /最后记录运行/);
    }
    for (const lang of ['zh', 'en']) {
      const partial = renderToStaticMarkup(React.createElement(CodexWorkspaceView, { data: { agents, metadataAvailable: true, catalogComplete: false, sourceHealth: { missingThreadRecords: 1 } }, lang }));
      assert.match(partial, /1 个会话身份尚未同步|1 session identities have not synced/);
      assert.match(partial, /运行中 2|Running 2/);
      assert.equal((partial.match(/class="cw-state cw-running"/g) || []).length, 2);
    }
    const { AgentStatusPanel } = await server.ssrLoadModule('/src/ClaudeConnection.jsx');
    const onlyUnknown = buildSharedRoster({ claude: { connected: true, agents: [agents[2]] } });
    const uncertain = renderToStaticMarkup(React.createElement(AgentStatusPanel, { agents: onlyUnknown, provider: 'Shared studio' }));
    assert.match(uncertain, /No confirmed running agents|暂无已确认运行的代理/);
    assert.doesNotMatch(uncertain, /No agents running right now/);
  } finally { await server.close(); }
});


test('StopFailure is labeled interrupted without inventing a user question or changing waiting counts', async () => {
  const { createServer } = await import('vite');
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { claudeAgentStatus, claudeWorkerGroups } = await import('../src/claude-office.js');
  const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false, ws: false } });
  try {
    const { AgentActivity } = await server.ssrLoadModule('/src/ClaudeConnection.jsx');
    const { ClaudeAgentPanel } = await server.ssrLoadModule('/src/ClaudeWorkspace.jsx');
    const worker = { id: 'session:child', observed: true, status: 'waiting', executionState: 'waiting', lastEvent: 'StopFailure', observationSource: 'claude-lifecycle-hooks', activityPhase: 'waiting', isSubagent: true };
    const [agent] = buildSharedRoster({ claude: { connected: true, agents: [worker] } });
    assert.deepEqual(claudeAgentStatus(agent, 'zh'), { id: 'waiting', label: '执行中断' });
    assert.equal(claudeWorkerGroups([agent]).waiting.length, 1);
    const details = renderToStaticMarkup(React.createElement(AgentActivity, { agent }));
    assert.match(details, /执行中断|Execution interrupted/);
    assert.match(details, /尚未提供具体失败原因|no specific failure reason was provided/);
    assert.doesNotMatch(details, /Waiting for input/);
    for (const lang of ['zh', 'en']) {
      const panel = renderToStaticMarkup(React.createElement(ClaudeAgentPanel, { agent: worker, lang }));
      assert.match(panel, /cw-waiting/);
      assert.match(panel, /执行中断|Execution interrupted/);
      assert.match(panel, /尚未提供具体失败原因|no specific failure reason was provided/);
      assert.doesNotMatch(panel, /Waiting for input|需要你的资料|quota|rate.limit/i);
    }
    const normal = renderToStaticMarkup(React.createElement(AgentActivity, { agent: { ...agent, runtimeAgents: [{ ...worker, lastEvent: 'Notification' }] } }));
    assert.match(normal, /Waiting for input/);
    assert.doesNotMatch(normal, /Execution interrupted|执行中断/);
    const stale = renderToStaticMarkup(React.createElement(ClaudeAgentPanel, { agent: worker, stale: true, lang: 'zh' }));
    assert.match(stale, /状态待确认/);
    assert.doesNotMatch(stale, /cw-waiting/);
  } finally { await server.close(); }
});


test('Grok unblocking room counts only matching Grok workers and exposes blocked-task and dispatch entry points', async () => {
  const { createServer } = await import('vite');
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false, ws: false } });
  try {
    const { RoomDetails } = await server.ssrLoadModule('/src/OfficeNavigation.jsx');
    const worker = (id, agentRole, status = 'working', executionState = status) => ({ id, agentRole, status, executionState, observed: true, isSubagent: true });
    const roster = buildSharedRoster({
      grok: { connected: true, agents: [worker('triage', 'Blocker Triage'), worker('recovery', 'Unblocking Coordinator'), worker('recorded', 'Information Follow-up', 'working', 'unconfirmed'), worker('waiting', 'Recovery Verification', 'waiting'), worker('manager', 'Manager'), worker('legacy-reviewer', 'Code Reviewer')] },
      claude: { connected: true, agents: [worker('claude-triage', 'Blocker Triage'), worker('designer', 'Game Designer')] },
      codex: { connected: true, agents: [worker('codex-recovery', 'Recovery Coordination'), worker('code-reviewer', 'Code Reviewer')] },
    });
    const props = { agents: roster, focus: 'department-3', onBlockedTasks() {}, onManagement() {} };
    const html = renderToStaticMarkup(React.createElement(RoomDetails, props));
    assert.match(html, /Grok Unblocking|Grok 解阻/);
    assert.match(html, /Team total, including overflow desks|团队总计/);
    assert.match(html, /2 (?:running|运行中)/);
    assert.match(html, /1 (?:unconfirmed|状态待确认)/);
    assert.match(html, /Open blocked tasks|打开受阻任务/);
    assert.match(html, /Dispatch via Grok|(?:通过|交由) Grok 调度/);
    assert.doesNotMatch(html, /Specialist Reviewers|专项审查员/);
    const waitingOnly = roster.filter(agent => ['waiting', 'recorded'].includes(agent.runtimeAgents[0].id));
    const waiting = renderToStaticMarkup(React.createElement(RoomDetails, { ...props, agents: waitingOnly }));
    assert.match(waiting, /0 (?:running|运行中)/);
    assert.match(waiting, /1 (?:unconfirmed|状态待确认)/);
  } finally { await server.close(); }
});
