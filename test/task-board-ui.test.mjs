import test from 'node:test'
import assert from 'node:assert/strict'
import { filterBoardTasks, taskAgentProvider, taskProjectDisplay, taskProjectKey, taskProjectName, taskProjectPath, taskProjects, taskWaitSummary } from '../src/task-board-ui.js'

test('projects use full folder identity without merging similarly named checkouts', () => {
  const tasks = [
    {projectPath:'/work/Studio'}, {projectPath:'/work/Studio/'},
    {projectPath:'/other/Studio'}, {projectPath:'/work/Studio-feature'},
    {projectPath:'/work/Studio/reports'}, {projectPath:''}, {},
  ]
  const before=JSON.stringify(tasks)
  const projects=taskProjects(tasks)
  assert.equal(projects.length,5)
  assert.deepEqual(projects.find(project=>project.path==='/work/Studio'),{key:'/work/Studio',name:'Studio',count:2,path:'/work/Studio',folders:['/work/Studio']})
  assert.equal(projects.filter(project=>project.name==='Studio').length,2)
  assert.deepEqual(projects.at(-1),{key:'',name:'Needs project folder',count:2,path:'',folders:['']})
  assert.equal(taskProjectName('/work/Studio/reports'),'reports')
  assert.equal(taskProjectName('/work/constructor'),'constructor')
  assert.equal(taskProjectName('/work/__proto__'),'__proto__')
  assert.equal(taskProjectName('  '),'Needs project folder')
  assert.equal(taskProjectKey('/work/Studio-feature'),'/work/Studio-feature')
  assert.equal(taskProjectPath('/'),'/')
  assert.equal(taskProjectPath('  '),'')
  assert.deepEqual(taskProjects([]),[])
  assert.equal(JSON.stringify(tasks),before)
})

test('project filtering isolates every status and composes with agent filters', () => {
  const tasks = ['pending', 'running', 'blocked', 'done'].flatMap(status => [
    { id: `game-${status}`, status, projectPath: '/work/game', provider: 'any', assignee: { provider: 'codex' } },
    { id: `office-${status}`, status, projectPath: '/work/ai-office', provider: 'claude' },
  ])
  tasks.push({ id: 'missing', provider: 'any' }, { id: 'worktree', projectPath: '/tmp/game-codex-4', provider: 'codex' }, { id: 'other', projectPath: '/other/game', provider: 'codex' })
  assert.equal(filterBoardTasks(tasks).length, 11)
  assert.deepEqual(filterBoardTasks(tasks, { projectPath: '/work/game/' }).map(task => task.id), ['game-pending', 'game-running', 'game-blocked', 'game-done'])
  assert.deepEqual(filterBoardTasks(tasks, { projectPath: '/work/ai-office' }).map(task => task.id), ['office-pending', 'office-running', 'office-blocked', 'office-done'])
  assert.equal(filterBoardTasks(tasks, { projectPath: '/work/game', provider: 'codex' }).length, 4)
  assert.equal(filterBoardTasks(tasks, { projectPath: '/work/game', provider: 'claude' }).length, 0)
  assert.equal(filterBoardTasks(tasks, { projectPath: '/work/game', provider: 'any' }).length, 4)
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

test('explicit project catalog groups declared worktrees and keeps only owner-approved projects',()=>{
 const catalog=[{id:'game',name:'Game',path:'/work/game',folders:['/tmp/game-lane']},{id:'office',name:'Office',path:'/work/office',folders:['/tmp/office-review']}];
 const tasks=[{id:'main',projectPath:'/work/game',status:'pending'},{id:'lane',projectPath:'/tmp/game-lane/reports',status:'blocked'},{id:'office',projectPath:'/tmp/office-review',status:'pending'},{id:'unknown',projectPath:'/unrelated',status:'done'},{id:'prefix',projectPath:'/tmp/game-lane-other',status:'done'}];
 const before=JSON.stringify(tasks);
 const projects=taskProjects(tasks,catalog);assert.equal(projects.length,2);assert.equal(projects[0].count,2);assert.equal(projects[1].count,1);
 assert.deepEqual(filterBoardTasks(tasks,{projectPath:'/work/game',catalog}).map(t=>t.id),['main','lane']);
 assert.deepEqual(filterBoardTasks(tasks,{projectPath:'/work/game',catalog,status:'blocked'}).map(t=>t.id),['lane']);
 assert.equal(JSON.stringify(tasks),before);
 assert.equal(taskProjects([],catalog).length,2);
});

const textOnlyQwen = { provider: 'local-qwen', supportType: 'log-triage', role: 'Helper', title: 'Triage supplied output', description: 'Test failed: expected 2, got 1', projectPath: '' }

test('valid text-only Qwen cards and details never require a project folder', () => {
  for (const status of ['pending', 'running', 'blocked', 'done']) {
    assert.deepEqual(taskProjectDisplay({ ...textOnlyQwen, status }), {
      textOnly: true, needsProject: false, name: 'Text-only assistance', detail: 'Text-only assistance',
    })
  }
  assert.equal(taskWaitSummary({ ...textOnlyQwen, status: 'pending' }).wait, 'Waiting for pickup')
  assert.equal(taskWaitSummary(textOnlyQwen, { reason: 'Local Qwen is offline' }).next, 'Check Ollama and installed model')
  assert.equal(taskWaitSummary(textOnlyQwen, { autoPickup: false }).next, 'Turn on auto pickup')
  assert.equal(taskWaitSummary(textOnlyQwen, { reason: 'Add a project folder before pickup' }).wait, 'Waiting for pickup')
})

test('missing-folder coding and invalid Qwen requests retain actionable warnings', () => {
  for (const override of [{ provider: 'codex' }, { provider: 'any', assignee: { provider: 'local-qwen' } }, { supportType: 'write-code' }, { description: '' }, { kind: 'review' }, { role: 'Tester' }]) {
    const task = { ...textOnlyQwen, ...override }
    assert.deepEqual(taskProjectDisplay(task), { textOnly: false, needsProject: true, name: 'Needs project folder', detail: 'Needs project folder before pickup' })
    assert.equal(taskWaitSummary(task).next, 'Edit request')
  }
  assert.deepEqual(taskProjectDisplay({ ...textOnlyQwen, projectPath: '/work/office/' }), { textOnly: false, needsProject: false, name: 'office', detail: '/work/office' })
  assert.equal(taskWaitSummary({ ...textOnlyQwen, projectPath: '/missing' }, { reason: 'The project folder does not exist' }).wait, 'Project folder needed')
})

test('folderless text assistance groups stay selectable without a misleading missing-folder label', () => {
  const textTasks = [{ ...textOnlyQwen, id: 'qwen', status: 'done' }]
  assert.equal(taskProjects(textTasks)[0].name, 'Text-only assistance')
  const mixed = [...textTasks, { id: 'coding', provider: 'codex', projectPath: '' }]
  assert.equal(taskProjects(mixed)[0].name, 'No project folder')
  assert.deepEqual(filterBoardTasks(mixed, { projectPath: '' }).map(task => task.id), ['qwen', 'coding'])
})
