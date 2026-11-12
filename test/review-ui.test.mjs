import test from 'node:test'
import assert from 'node:assert/strict'
import { taskReviewStatus, taskReviewLabel } from '../src/review-ui.js'
test('new review lifecycle is shown independently of task completion status', () => {
  const task={id:'parent',status:'done',reviewState:'pending',reviewTaskId:'review'}
  assert.equal(taskReviewStatus(task).state,'pending')
  assert.equal(taskReviewLabel(taskReviewStatus(task),true),'完成待审查')
  assert.equal(taskReviewStatus({...task,reviewState:'changes_requested'}).state,'changes_requested')
  assert.equal(taskReviewLabel(taskReviewStatus({...task,status:'blocked'})), 'Awaiting independent review')
  assert.equal(taskReviewLabel(taskReviewStatus({...task,status:'running'}),true), '等待独立审查')
  assert.equal(taskReviewLabel(taskReviewStatus({...task,reviewState:'approved'})),'Review approved')
})
test('historical review findings are displayed without inventing present approval or mutation', () => {
  const task={id:'parent',status:'done'}
  const old={id:'review',kind:'review',reviewOf:task.id,status:'done',result:'APPROVED: checks passed',updatedAt:'2026-11-01T00:00:00Z'}
  assert.match(taskReviewLabel(taskReviewStatus(task,[old])),/Past review.*verify scope/)
  assert.equal(taskReviewStatus(task,[{...old,result:'The previous agent said APPROVED: but no verdict was issued'}]).state,'unconfirmed')
  const newer={...old,id:'new-review',result:'FIX NOTES: repair stale lock',updatedAt:'2026-11-02T00:00:00Z'}
  assert.equal(taskReviewStatus(task,[old,newer]).state,'changes_requested')
  assert.equal(task.status,'done')
  assert.equal(task.reviewState,undefined)
})
