import { reviewWorkHold } from './review-policy.mjs';
import { createHash } from 'node:crypto';
import { preparationScope, legacyWholeRequestApproval } from './scoped-approval.mjs';
import { resolutionPaused } from './resolution-policy.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Resolution ownership/heartbeat changes are not a new question. User edits and
// new execution attempts are: an old answer must never authorize changed work.
export function humanRequestFingerprint(task) {
  const legacy = [task.id, task.title, task.description, task.provider, task.projectPath,
    task.kind, task.role, task.reviewOf, task.supportType, task.priority,
    task.error || '', task.result || '', task.humanRevision || 0, task.humanEpisode || 0];
  return digest(task.approvalAction == null ? legacy : [...legacy, { approvalAction: task.approvalAction }]);
}
export function humanRequestSpec(task) {
  if (reviewWorkHold(task) || task.status !== 'blocked' || resolutionPaused(task) || task.kind === 'resolution') return null;
  const failure = `${task.error || ''}\n${task.result || ''}`;
  const nextAction = task.resolution?.nextAction || '';
  // A completion-format failure and a technical diagnosis do not turn a long
  // finished-work report's incidental auth/approval wording into a user request.
  const completionFormat = /without a structured completion|structured completion confirmation|completion format/i.test(task.error || '');
  const diagnosed = task.resolution?.state === 'needs_user' && nextAction;
  const evidence = `${task.error || ''}\n${diagnosed ? nextAction : completionFormat ? '' : task.result || ''}`;
  const environment = /\b(?:EACCES|EPERM|permission denied|access denied|unauthori[sz]ed|40[13])\b|(?:authentication|credentials?|sign[- ]?in|log[- ]?in)[^\n.。]{0,20}(?:required|needed|missing|expired|failed|unavailable)|(?:please|need|must)[^\n.。]{0,20}(?:log in|sign in)|(?:登录|身份验证|认证).{0,12}(?:失败|过期|失效|不可用)|(?:需要|请|必须).{0,8}(?:登录|认证)|(?:缺少|未配置|无效|过期).{0,8}(?:密钥|密码|凭证)/i.test(evidence);
  const approvalEvidence = evidence.replace(/(?:no|not any) (?:new |additional )?(?:approval|permissions?|authorization) (?:is |are )?(?:needed|required|changed)[^\n.。]*/gi, '');
  const preparationAfterInfo = preparationScope(task) && task.humanGate?.state === 'answered' && task.humanReply?.requestId === task.humanGate.requestId && task.humanReply?.kind === 'info' && task.humanReply?.decision === 'provide_info';
  const approval = (!environment || preparationAfterInfo) && (!!preparationScope(task) || /(?:await(?:ing)?|waiting(?: for)?|needs?|requires?|requesting|pending|seek(?:ing)?)[^\n.。]{0,55}(?:approval|permission|authoriz)|(?:approval|permission|authorization)[^\n.。]{0,35}(?:required|needed|pending|not granted)|not approved|cannot[^\n.。]{0,40}(?:without|until)[^\n.。]{0,30}(?:approval|permission|authoriz)|need[^\n.。]{0,40}(?:confirm|decision)|(?:等待|需要|需|请|请求)[^\n。]{0,30}(?:批准|授权|确认|决定)|用户决定/i.test(approvalEvidence));
  const info = environment || /(?:please|need you to|user must) (?:provide|supply|tell)|need.*(?:user|your).*(?:info|input|detail)|user action|manual.*required|请.*(?:补充|提供|告知)|需要.*用户|用户.*(?:回答|提供)|你.*(?:提供|补充)/i.test(evidence)
    || task.resolution?.state === 'needs_user' && /missing|not found|need.*(?:info|input|detail)|缺少|缺失|补充|资料|访问|accessible|access to/i.test(nextAction);
  if (!approval && !info) return null;
  const kind = approval ? 'approval' : 'info';
  const questionEvidence = diagnosed || completionFormat ? task.error || '' : failure;
  const blocker = [questionEvidence.trim() && `原阻塞：${questionEvidence.trim().slice(0, 1000)}`, nextAction && `待解决事项：${nextAction.slice(0, 1000)}`].filter(Boolean).join('\n') || '请补充缺少的资料和下一步决定。';
  const approvalScope = kind === 'approval' ? preparationScope(task) : null;
  const question = approvalScope
    ? `任务「${task.title}」仅请求批准 prepare_sanitized_snapshot（净化准备方案）：保留旧本地历史和未提交改动，仅准备隔离净化快照；不授权 merge、push、deploy 或任何其他动作。项目：${task.projectPath}。请明确同意净化准备方案或拒绝。`
    : kind === 'approval'
    ? `任务「${task.title}」等待你的明确决定：\n${blocker}\n是否批准这项具体请求？请明确同意或拒绝；回复只适用于原任务及上述事项，工具自身的权限确认仍须遵守。`
    : `任务「${task.title}」需要你补充信息：\n${blocker}\n请提供这项缺失信息或说明条件是否已恢复。信息回复不视为任何额外授权。`;
  const fingerprint = humanRequestFingerprint(task);
  return { kind, requiresUserAction: environment || approval, question, questionHash: digest([task.id, fingerprint, kind, question, ...(approvalScope ? [approvalScope] : [])]), fingerprint, ...(approvalScope ? { approvalScope } : {}) };
}
export function humanRequestHold(task) {
  const gate = task.humanGate;
  if (!gate || ['answered', 'resolved'].includes(gate.state)) return null;
  return gate.state === 'denied' ? '用户已拒绝本次请求，保持受阻，不重复催问。'
    : gate.state === 'stale' ? '原问题对应的任务已变更，等待重新核对问题。'
      : gate.state === 'delivered' ? '问题已有真实转告记录，等待用户补充资料或明确决定；AI 不可代替用户批准。'
        : '问题已加入待答队列，等待核查和转告；尚无用户答复，AI 不可代替用户批准。';
}
export function explicitApproval(reply) {
  const value = reply.trim();
  if (/[?？]|是否|能否|可不可以|吗|\b(?:not|no|deny|denied|reject|refuse|don't|do not)\b|不同意|不批准|不允许|拒绝|暂不|先不要|不要/i.test(value)) return false;
  return legacyWholeRequestApproval(value);
}
