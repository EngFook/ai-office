export function humanRequestNeedsUser(request) {
  return !!request && ['pending', 'delivered'].includes(request.state) &&
    (request.state === 'delivered' || request.kind === 'approval' || request.requiresUserAction === true || request.triage?.outcome === 'needs_user')
}

export function humanRequestGroups(requests = [], tasks = []) {
  const byId = new Map(tasks.map(task => [task.id, task]))
  const current = requests.filter(request => ['pending', 'delivered', 'denied'].includes(request.state) &&
    byId.get(request.taskId)?.status === 'blocked' && byId.get(request.taskId)?.humanGate?.requestId === request.id)
  return {
    needsUser: current.filter(humanRequestNeedsUser),
    grokCheck: current.filter(request => request.state !== 'denied' && !humanRequestNeedsUser(request)),
    denied: current.filter(request => request.state === 'denied'),
  }
}

export function openHumanRequests(requests) {
  return (Array.isArray(requests) ? requests : []).filter(request => request && ['pending', 'delivered'].includes(request.state));
}

export function humanRelayStateLabel(state, zh = true) {
  return ({ pending: zh ? 'Grok 先核实处理 · 尚未确认送达' : 'Grok investigates first · delivery not confirmed',
    delivered: zh ? 'Grok 已确认转告，等待你的回复' : 'Grok confirmed delivery · awaiting your reply',
    resolved: zh ? 'Grok 已核实资料，交回负责人执行' : 'Grok verified the information · returned to owner',
    answered: zh ? '已收到回复' : 'Reply received',
    denied: zh ? '已拒绝' : 'Declined',
    stale: zh ? '任务已变化，原问题已失效' : 'Task changed · question expired',
  })[state] || (zh ? '状态未知' : 'Unknown status');
}

export function questionActionPayload(request, action, reply = '', projectPath = '', zh = true) {
  const value = reply.trim(), base = { questionHash: request.questionHash }
  if (action === 'rerequest') return base
  const decision = action === 'restored' ? 'provide_info' : action
  if (!['provide_info', 'approve', 'deny'].includes(decision) || request.kind === 'info' && decision === 'approve' || request.kind === 'approval' && decision === 'provide_info') throw new Error(zh ? '请选择与问题对应的操作。' : 'Choose an action matching this question.')
  const userReply = request.approvalScope ? reply : value
  if (action === 'approve' && request.approvalScope && !value) throw new Error(zh ? '批准准备工作前，请明确填写“同意净化准备方案”。拒绝可直接点击。' : 'To approve preparation, type “I approve sanitized snapshot preparation”. You can decline without entering text.')
  if (action === 'provide_info' && !userReply) throw new Error(zh ? '请先填写要补充的资料。' : 'Enter the missing information first.')
  if (projectPath.trim() && (decision !== 'provide_info' || !projectPath.trim().startsWith('/') || !userReply.includes(projectPath.trim()))) throw new Error(zh ? '请填写已有目录的完整路径，并在回复中明确写出同一路径。' : 'Use an existing absolute directory and include that exact path in your reply.')
  return { ...base, decision, userAction: action, userReply, ...(projectPath.trim() ? { projectPath: projectPath.trim() } : {}) }
}

export function questionErrorMessage(message = '', zh = true) {
  if (!zh) return message || 'Could not save. Your draft is preserved.'
  if (/Scoped approval requires an explicit affirmative/i.test(message)) return '未执行批准。请填写“同意净化准备方案”；可补充“保留旧本地历史和未提交改动，不批准最终合并”。其他条件需要先修改任务并重新确认。'
  if (/partial or conditional legacy|explicit action binding/i.test(message)) return '未执行批准。这项问题尚未单独绑定你填写的条件；请先修改任务范围并重新生成问题，再作决定。'
  if (/binding|changed|no longer|unanswered question/i.test(message)) return '问题已更新或已处理。请打开最新问题后重试；当前输入不会丢失。'
  if (/project.*(?:unavailable|exist|folder)|replacement folder/i.test(message)) return '原项目目录仍不可用。请恢复原目录，或在回复和“新目录”栏填写同一个已有目录的完整路径。'
  if (/five re-requests/i.test(message)) return '这个问题已重新请求五次。请直接补充新资料或作出决定，避免重复打扰。'
  if (/one minute|cooldown/i.test(message)) return '已请求核查，请等一分钟再试。'
  if (/explicit affirmative/i.test(message)) return '你的文字含有拒绝或疑问，未执行批准。请明确决定，或选择拒绝。'
  return '未能确认保存成功。输入已保留，请刷新任务状态后再试。'
}
