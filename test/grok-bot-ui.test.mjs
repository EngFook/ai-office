import test from 'node:test'
import assert from 'node:assert/strict'
import { filterBoardTasks, taskAgentProvider, taskWaitSummary } from '../src/task-board-ui.js'

test('Grok Bot filter keeps task states and exact project paths separate from management', () => {
  const tasks = ['pending', 'running', 'blocked', 'done'].map(status => ({ id: status, status, provider: 'grok-bot', projectPath: '/tmp/aio-bot-board' }))
  tasks.push({ id: 'management', provider: 'grok', projectPath: '/work/ai-office' }, { id: 'claude', provider: 'claude', projectPath: '/work/ai-office' }, { id: 'other-project', provider: 'grok-bot', projectPath: '/work/other' })
  assert.deepEqual(filterBoardTasks(tasks, { provider: 'grok-bot', projectPath: '/tmp/aio-bot-board' }).map(task => task.id), ['pending', 'running', 'blocked', 'done'])
})

test('Grok Bot identity is not collapsed into Grok management', () => {
  assert.equal(taskAgentProvider({ provider: 'grok-bot' }), 'grok-bot')
  assert.equal(taskAgentProvider({ provider: 'any', assignee: 'grok-bot-main' }), 'grok-bot')
  assert.equal(taskAgentProvider({ provider: 'any', assignee: { id: 'grok-bot-main' } }), 'grok-bot')
  assert.equal(taskAgentProvider({ provider: 'any' }, 'Waiting for Grok Bot to claim'), 'grok-bot')
  assert.equal(taskAgentProvider({ provider: 'grok' }), 'grok')
})

test('Grok Bot pending request requires explicit claim regardless of auto pickup', () => {
  const task = { provider: 'grok-bot', status: 'pending', projectPath: '/work/ai-office' }
  for (const autoPickup of [true, false]) {
    assert.deepEqual(taskWaitSummary(task, { autoPickup }), {
      owner: 'Grok Bot', wait: 'Waiting for Grok Bot to claim', next: 'Ask Grok Bot to claim this request', provider: 'grok-bot', customOwner: false,
    })
  }
  assert.equal(taskWaitSummary({ ...task, projectPath: '' }).next, 'Edit request')
  assert.equal(taskWaitSummary({ ...task, status: 'blocked' }, { reason: 'External task lease expired.' }).next, 'Open details, then retry')
})
