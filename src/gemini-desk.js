export const GEMINI_RESEARCH_TYPES = Object.freeze({
  'official-docs': ['Official documentation', '官方文档查证'],
  'error-research': ['Error research', '报错资料研究'],
  'options-comparison': ['Compare options', '方案资料对比'],
  'fact-check': ['Fact check', '事实与时效核对'],
  'reference-search': ['Find references', '参考资料查找'],
  'research-brief': ['Research brief', '专题研究简报'],
});
const PROMPTS = {
  'official-docs': ['Which API, library or product needs checking? Include the exact version, questions and any official URLs.', '要查证哪个 API、库或产品？请填写准确版本、具体问题及已有官方链接。'],
  'error-research': ['Paste the actual error, versions, environment and failed attempts. Ask for sourced explanations and diagnostic options; implementation goes to the task owner.', '粘贴实际报错、版本、环境和已尝试的方法。查找有来源的解释和排查选项；实现交给任务负责人。'],
  'options-comparison': ['Name the options, decision criteria and constraints. Request current primary sources, trade-offs and unresolved questions.', '列出候选方案、比较标准和约束；需要当前一手来源、取舍及尚未查明的问题。'],
  'fact-check': ['Paste the exact claims to verify, their dates, original sources and what decision they inform.', '粘贴待核对的具体说法、日期、原始来源及其影响的决策。'],
  'reference-search': ['Describe the references needed, intended use and relevant license or format requirements.', '说明所需参考资料、使用目的，以及相关许可或格式要求。'],
  'research-brief': ['State the topic, precise questions, project context, relevant dates and required evidence.', '填写研究主题、明确问题、项目背景、相关日期及所需证据。'],
};
export function geminiResearchDraft(type, lang = 'en') {
  if (!Object.hasOwn(GEMINI_RESEARCH_TYPES, type)) return null;
  return { provider: 'gemini', role: 'Helper', title: GEMINI_RESEARCH_TYPES[type][lang === 'zh' ? 1 : 0], description: '' };
}
export function geminiSourcePrompt(type, lang = 'en') {
  return (PROMPTS[type] || PROMPTS['research-brief'])[lang === 'zh' ? 1 : 0];
}
export function geminiReadiness(provider, stale = false) {
  if (stale || !provider) return 'unknown';
  if (provider.disabled === true || provider.enabled === false || provider.authState === 'disabled') return 'disabled';
  if (provider.authState === 'unavailable' || provider.available === false) return 'unavailable';
  if (provider.authState === 'needs-login' || provider.needsLogin === true) return 'needs-login';
  if (provider.modelSupported === false) return 'model-unavailable';
  if (provider.available === true && provider.authenticated === true && (!provider.authState || provider.authState === 'ready')) return 'ready';
  return 'unknown';
}
export function geminiTaskCounts(tasks = [], running = []) {
  const geminiTasks = tasks.filter(task => task.provider === 'gemini' || task.assignee?.provider === 'gemini');
  const observed = new Set(running.filter(job => job.provider === 'gemini' && job.finished !== true && (!job.status || ['working', 'running'].includes(job.status))).map(job => job.taskId));
  return { running: geminiTasks.filter(task => task.status === 'running' && observed.has(task.id)).length,
    pending: geminiTasks.filter(task => task.status === 'pending').length,
    blocked: geminiTasks.filter(task => task.status === 'blocked').length };
}
