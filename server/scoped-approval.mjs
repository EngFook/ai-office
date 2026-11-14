// Deliberately finite grammar: unrecognized clauses never grant permission.
export const PREPARE_ACTION = 'prepare_sanitized_snapshot';
export function preparationScope(task) {
  return task.approvalAction === PREPARE_ACTION
    ? { version: 1, action: PREPARE_ACTION, projectPath: task.projectPath } : null;
}
export function parsePreparationApproval(reply) {
  if (typeof reply !== 'string' || /[?？\n\r]|["“”‘’`]|是否|能否|吗/.test(reply)) return null;
  const clauses = reply.trim().replace(/[。.!！]$/, '').split(/[，,；;]/).map(value => value.trim());
  if (!clauses.length || clauses.some(value => !value)) return null;
  let approved = false;
  const deniedActions = [];
  for (const clause of clauses) {
    if (/^(?:(?:我)?(?:同意|批准|允许)(?:净化准备方案|准备净化快照)|(?:I (?:approve|authorize)|Approve) (?:the )?(?:sanitized snapshot preparation(?: plan)?|prepare_sanitized_snapshot))$/i.test(clause)) {
      if (approved) return null;
      approved = true;
    } else if (/^(?:保留旧本地历史和未提交改动|preserve old local history and uncommitted changes)$/i.test(clause)) {
      // An explicit preservation condition, retained with the verbatim reply.
    } else {
      const denied = /^(?:(?:我)?(?:不批准|不同意|不允许|暂不批准|暂不允许)(最终合并|合并|推送|部署)|I (?:do not approve|do not authorize|deny) (?:the )?(final merge|merge|push|deploy))$/i.exec(clause);
      if (!denied) return null;
      const action = ({ 最终合并: 'merge', 合并: 'merge', 推送: 'push', 部署: 'deploy', 'final merge': 'merge' })[denied[1] || denied[2].toLowerCase()] || denied[2].toLowerCase();
      deniedActions.push(action);
    }
  }
  return approved ? { allowedActions: [PREPARE_ACTION], deniedActions: [...new Set(deniedActions)], clauses } : null;
}

// A legacy question has no machine-readable sub-action. Accept only an exact
// whole-question answer; free-form partial/conditional permission must stay held.
export function legacyWholeRequestApproval(reply) {
  if (typeof reply !== 'string') return false;
  const value = reply.trim().replace(/[。.!！]$/, '');
  return /^(?:yes|approve|approved|I approve|I agree|I authorize|go ahead|yes, approve the specific request|同意|批准|允许|可以|确认|好|好的|同意，仅批准当前事项)$/i.test(value);
}
