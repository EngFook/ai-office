import { parseReviewVerdict } from './review-verdict.js'

const STATES = {
  pending: ['完成待审查', 'Completed · awaiting review'],
  approved: ['审查已通过', 'Review approved'],
  changes_requested: ['审查要求修复', 'Review requires fixes'],
  repairing: ['等待修复完成', 'Awaiting repair completion'],
  blocked: ['审查受阻', 'Review blocked'],
  stale: ['待重新审查', 'Review needs rechecking'],
  superseded: ['已转下一轮修复', 'Moved to the next repair round'],
  unconfirmed: ['审查结论待确认', 'Review verdict unconfirmed'],
}
export function taskReviewStatus(task = {}, tasks = []) {
  if (STATES[task.reviewState]) return { state: task.reviewState, historical: false, completed: task.status === 'done', reviewTaskId: task.reviewTaskId || null }
  const review = task.kind === 'review' ? task : tasks.filter(item => item.kind === 'review' && item.reviewOf === task.id)
    .sort((a,b)=>(Date.parse(b.updatedAt || b.createdAt) || 0)-(Date.parse(a.updatedAt || a.createdAt) || 0))[0]
  if (!review) return null
  const state = review.status === 'done' ? parseReviewVerdict(review.result) || 'unconfirmed'
    : review.status === 'blocked' ? 'blocked' : 'pending'
  return { state, historical: review.status === 'done', completed: task.status === 'done', reviewTaskId: review.id, isReview: task.kind === 'review' }
}
export function taskReviewLabel(review, zh = false) {
  if (!review) return ''
  if (review.isReview && review.state === 'pending') return zh ? '审查待完成' : 'Review awaiting completion'
  if (review.state === 'pending' && !review.completed) return zh ? '等待独立审查' : 'Awaiting independent review'
  if (review.historical && review.state === 'approved') return zh ? '历史审查：通过 · 请核对范围' : 'Past review: approved · verify scope'
  if (review.historical && review.state === 'changes_requested') return zh ? '历史审查：有修复意见' : 'Past review: fix notes'
  return (STATES[review.state] || STATES.unconfirmed)[zh ? 0 : 1]
}
