import test from 'node:test'
import assert from 'node:assert/strict'
import { filterBoardTasks, taskAgentProvider, taskProjectKey, taskProjectName, taskProjectPath, taskProjects, taskWaitSummary } from '../src/task-board-ui.js'

test('projects fold checkouts, worktrees and subfolders into 退界 and AI-Office; other folders stay separate by full path', () => {
  const drive = '/workspace/example/Library/CloudStorage/x/My Drive/Project'
  const tasks = [
    { projectPath: '/workspace/example/Developer/walkalone' }, { projectPath: '/workspace/example/Developer/walkalone/' },
    { projectPath: `${drive}/Walkalone` }, { projectPath: `${drive}/Walkalone` }, { projectPath: `${drive}/Walkalone` },
    { projectPath: '/workspace/example/Developer/walkalone-codex-28' }, { projectPath: '/private/tmp/walkalone-kanjie-map' },
    { projectPath: `${drive}/ai-office` }, { projectPath: `${drive}/ai-office/reports/research` },
    { projectPath: '/private/tmp/aio-studio-3d' }, { projectPath: '/private/tmp/aio-studio-3d' }, { projectPath: '/private/tmp/aio-studio-3d' },
    { projectPath: '/private/tmp/aio-new-worktree-tomorrow' },
    { projectPath: '/work/Review' }, { projectPath: '/other/Review' }, { projectPath: '/work/walkalonely' },
    { projectPath: '' }, {},
  ]
  const before = JSON.stringify(tasks)
  const projects = taskProjects(tasks)
  assert.deepEqual(projects.map(project => project.name), ['退界', 'AI-Office', 'Review', 'Review', 'walkalonely', 'Needs project folder'])
  const game = projects.find(project => project.name === '退界')
  assert.equal(game.count, 7)
  assert.equal(game.key, 'project:walkalone')
  // Main checkout is preferred over busier worktrees as the default folder for new requests.
  assert.equal(game.path, `${drive}/Walkalone`)
  assert.equal(game.folders.length, 4)
  const office = projects.find(project => project.name === 'AI-Office')
  assert.equal(office.count, 6)
  assert.equal(office.path, `${drive}/ai-office`)
  assert.equal(office.folders[0], `${drive}/ai-office`)
  assert.deepEqual(projects.at(-1), { key: '', name: 'Needs project folder', count: 2, path: '', folders: [''] })
  assert.equal(taskProjectName('/work/walkalone/'), '退界')
  assert.equal(taskProjectName('/private/tmp/aio-anything'), 'AI-Office')
  assert.equal(taskProjectName(`${drive}/ai-office/reports/research`), 'AI-Office')
  assert.equal(taskProjectKey('/workspace/example/Developer/walkalone-land9-20261102_2347'), 'project:walkalone')
  assert.equal(taskProjectKey('/work/Review/'), '/work/Review')
  assert.equal(taskProjectName('/work/Review'), 'Review')
  assert.equal(taskProjectName('/work/constructor'), 'constructor')
  assert.equal(taskProjectName('/work/__proto__'), '__proto__')
  assert.equal(taskProjectName('  '), 'Needs project folder')
  assert.equal(taskProjectPath('/'), '/')
  assert.equal(taskProjectPath('  '), '')
  assert.deepEqual(taskProjects([]), [])
  assert.equal(JSON.stringify(tasks), before)
})

test('project filtering isolates every status and composes with agent filters', () => {
  const tasks = ['pending', 'running', 'blocked', 'done'].flatMap(status => [
    { id: `game-${status}`, status, projectPath: '/work/walkalone', provider: 'any', assignee: { provider: 'codex' } },
    { id: `office-${status}`, status, projectPath: '/work/ai-office', provider: 'claude' },
  ])
  tasks.push({ id: 'missing', provider: 'any' }, { id: 'worktree', projectPath: '/tmp/walkalone-codex-4', provider: 'codex' }, { id: 'other', projectPath: '/other/game', provider: 'codex' })
  assert.equal(filterBoardTasks(tasks).length, 11)
  assert.deepEqual(filterBoardTasks(tasks, { projectPath: '/work/walkalone/' }).map(task => task.id), ['game-pending', 'game-running', 'game-blocked', 'game-done', 'worktree'])
  assert.deepEqual(filterBoardTasks(tasks, { projectPath: '/private/tmp/aio-x' }).map(task => task.id), ['office-pending', 'office-running', 'office-blocked', 'office-done'])
  assert.equal(filterBoardTasks(tasks, { projectPath: '/work/walkalone', provider: 'codex' }).length, 5)
  assert.equal(filterBoardTasks(tasks, { projectPath: '/work/walkalone', provider: 'claude' }).length, 0)
  assert.equal(filterBoardTasks(tasks, { projectPath: '/work/walkalone', provider: 'any' }).length, 4)
  assert.deepEqual(filterBoardTasks(tasks, { projectPath: '' }).map(task => task.id), ['missing'])
  assert.deepEqual(filterBoardTasks(tasks, { projectPath: '/other/game/' }).map(task => task.id), ['other'])
  assert.deepEqual(filterBoardTasks(tasks, { projectPath: '/deleted' }), [])
})

test('waiting summary identifies the responsible agent and next step without exposing long output', () => {
  const task = { provider: 'any', projectPath: '/project', status: 'pending' }
  assert.deepEqual(taskWaitSummary(task, { reason: 'Codex is below 5% weekly quota; it only does release sign-off now. Waiting.' }), {
    owner: 'Codex', wait: 'Waiting for quota', next: 'Retry after reset', provider: 'codex', customOwner: false,
  })
  const login = taskWaitSummary({ ...task, provider: 'gemini' }, { reason: 'Sign in to Gemini before task pickup.' })
  assert.equal(login.owner, 'Gemini')
  assert.equal(login.wait, 'Sign-in needed')
  assert.equal(login.next, 'Open agent to continue')
})

test('project and manual-pickup waits point to an actionable owner', () => {
  assert.equal(taskWaitSummary({ status: 'pending', provider: 'claude' }).owner, 'You')
  assert.equal(taskWaitSummary({ status: 'pending', projectPath: '/project' }, { autoPickup: false }).next, 'Turn on auto pickup')
  assert.equal(taskWaitSummary({ status: 'pending', projectPath: '/missing' }, { reason: 'The project folder does not exist or cannot be opened.' }).next, 'Edit request')
})

test('blocked requests preserve full task data and identify assigned agents before preferences', () => {
  const task = { status: 'blocked', provider: 'claude', assignee: { name: 'Reviewer', provider: 'codex' }, projectPath: '/project', error: 'Custom output' }
  const before = JSON.stringify(task)
  const summary = taskWaitSummary(task, { reason: task.error })
  assert.equal(summary.owner, 'Reviewer')
  assert.equal(summary.provider, 'codex')
  assert.equal(summary.customOwner, true)
  assert.equal(summary.next, 'Open details, then retry')
  assert.equal(JSON.stringify(task), before)
  assert.equal(taskAgentProvider({ provider: 'any', assignee: 'gemini-research-2' }), 'gemini')
})
