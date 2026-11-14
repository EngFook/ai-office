import { localQwenTaskError } from '../server/local-qwen-policy.mjs'

const providerNames = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini', grok: 'Grok', 'grok-bot': 'Grok Bot', 'local-qwen': 'Local Qwen' }

// Without an owner catalog, folders remain independent. An explicit catalog
// groups approved aliases for display only; execution paths stay unchanged.
export function taskProjectPath(path) {
  const value = String(path || '').trim()
  return value.replace(/\/+$/, '') || (value.startsWith('/') ? '/' : '')
}
function catalogProject(folder, catalog = []) {
  return catalog.flatMap(project => [project.path, ...(project.folders || [])].filter(Boolean).map(root => ({ project, root:taskProjectPath(root) })))
    .filter(({root}) => folder === root || folder.startsWith(`${root}/`)).sort((a,b)=>b.root.length-a.root.length)[0]?.project
}
export function taskProjectKey(path, catalog = []) { const folder=taskProjectPath(path); return catalogProject(folder,catalog)?.path || folder }
export function taskProjectName(path) {
  const normalized = taskProjectPath(path)
  return normalized.split(/[\\/]/).filter(Boolean).pop() || (normalized ? '/' : 'Needs project folder')
}
// Use the same supplied-text rules as pickup; a missing folder alone is not a blocker.
export function taskProjectDisplay(task = {}) {
  const path = taskProjectPath(task.projectPath)
  const textOnly = !path && task.provider === 'local-qwen' && !localQwenTaskError(task)
  return {
    textOnly, needsProject: !path && !textOnly,
    name: textOnly ? 'Text-only assistance' : taskProjectName(path),
    detail: textOnly ? 'Text-only assistance' : path || 'Needs project folder before pickup',
  }
}
export function taskProjects(tasks, catalog = []) {
  if (catalog.length) return catalog.map(project => {
    const matched=tasks.filter(task=>catalogProject(taskProjectPath(task.projectPath),catalog)?.id===project.id)
    return { key:project.path, path:project.path, name:project.name, count:matched.length, folders:[...new Set([project.path,...matched.map(task=>taskProjectPath(task.projectPath))])] }
  })
  const projects = new Map()
  for (const task of tasks) {
    const folder = taskProjectPath(task.projectPath)
    if (!projects.has(folder)) projects.set(folder, { key:folder, name:taskProjectName(folder), count:0, path:folder, folders:[folder] })
    projects.get(folder).count++
  }
  const withoutFolder = tasks.filter(task => !taskProjectPath(task.projectPath))
  if (withoutFolder.some(task => taskProjectDisplay(task).textOnly)) {
    projects.get('').name = withoutFolder.every(task => taskProjectDisplay(task).textOnly) ? 'Text-only assistance' : 'No project folder'
  }
  return [...projects.values()].sort((a,b)=>Number(!a.path)-Number(!b.path) || a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
}

export function filterBoardTasks(tasks, { projectPath = null, provider = 'all', status = 'all', catalog = [] } = {}) {
  const projectKey = projectPath === null ? null : taskProjectKey(projectPath,catalog)
  return tasks.filter(task => (status === 'all' || task.status === status) && (projectKey === null || taskProjectKey(task.projectPath,catalog) === projectKey) &&
    (provider === 'all' || task.provider === provider || provider !== 'any' && task.assignee?.provider === provider))
}

export function taskAgentProvider(task, reason = '') {
  const assigned = task.assignee
  if (assigned && typeof assigned === 'object' && providerNames[assigned.provider]) return assigned.provider
  const identity = typeof assigned === 'string' ? assigned : assigned?.agentId || assigned?.workerId || assigned?.id || ''
  const matched = String(identity).match(/^(grok-bot|local-qwen|claude|codex|gemini|grok)(?:[-_:]|$)/i)
  if (matched) return matched[1].toLowerCase()
  if (providerNames[task.provider]) return task.provider
  const mentioned = String(reason).match(/\b(Codex|Claude(?: Code)?|Gemini|Grok(?: Bot)?)\b/i)?.[1]?.toLowerCase()
  return mentioned?.startsWith('claude') ? 'claude' : mentioned === 'grok bot' ? 'grok-bot' : mentioned || null
}

// Classify only the presentation of server reasons; eligibility and routing remain server-owned.
export function taskWaitSummary(task, { reason = '', autoPickup = true } = {}) {
  const full = typeof reason === 'string' ? reason : JSON.stringify(reason || '')
  const provider = taskAgentProvider(task, full)
  const assigned = task.assignee
  const assignedName = typeof assigned === 'string' ? assigned : assigned?.name || assigned?.label
  const agent = assignedName || providerNames[provider] || 'Any agent'
  const own = (wait, next, owner = agent) => ({ owner, wait, next, provider, customOwner: Boolean(assignedName && owner === assignedName) })
  const project = taskProjectDisplay(task)
  if (project.needsProject || !project.textOnly && /project (?:folder|path).*(?:exist|absolute|folder|opened)|Add a project folder/i.test(full)) return own('Project folder needed', 'Edit request', 'You')
  if (provider === 'local-qwen' && /offline|not installed|failed|unavailable/i.test(full)) return own('Agent unavailable', 'Check Ollama and installed model');
  if (/sign.?in|log.?in|authenticat/i.test(full)) return own('Sign-in needed', 'Open agent to continue')
  if (/quota|weekly|below (?:5|20)%/i.test(full)) return own('Waiting for quota', 'Retry after reset')
  if (/not found|unavailable|could not be checked/i.test(full)) return own('Agent unavailable', 'Open agent to check')
  if (/already working in this project/i.test(full)) return own('Project is busy', 'Wait for current request', 'Project agent')
  if (/matching role|project claim/i.test(full)) return own('Waiting for role or project', 'Check role and project')
  if (/owned by Codex|Re-create this as/i.test(full)) return own('Codex review needed', 'Edit agent preference', 'Codex')
  if (task.status === 'blocked') return own('Request needs attention', 'Open details, then retry')
  if (provider === 'grok-bot') return own('Waiting for Grok Bot to claim', 'Ask Grok Bot to claim this request')
  if (!autoPickup) return own('Auto pickup is off', 'Turn on auto pickup', 'You')
  if (/finish|research desk/i.test(full)) return own('Waiting for an available agent', 'Pickup when ready')
  return own('Waiting for pickup', 'Pickup when ready')
}

export function containDialogFocus(event) {
  if (event.key !== 'Tab') return
  const items = [...event.currentTarget.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]')].filter(item => item.getClientRects().length > 0)
  const first = items[0], last = items.at(-1)
  if (!first) { event.preventDefault(); event.currentTarget.focus(); return }
  if (event.shiftKey && (document.activeElement === first || !event.currentTarget.contains(document.activeElement))) { event.preventDefault(); last.focus() }
  if (!event.shiftKey && (document.activeElement === last || !event.currentTarget.contains(document.activeElement))) { event.preventDefault(); first.focus() }
}
