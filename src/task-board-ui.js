const providerNames = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini', grok: 'Grok', 'grok-bot': 'Grok Bot', 'local-qwen': 'Local Qwen' }

// Known projects own every folder whose path contains a matching segment, so the main
// checkout, its worktrees (walkalone-*, /tmp/aio-*) and subfolders (reports/research)
// share one board. Any other folder stays its own project, keyed by its full path.
const knownProjects = [
  { key: 'project:walkalone', name: '退界', root: 'walkalone', match: /^walkalone(?:[-_.].*)?$/i },
  { key: 'project:ai-office', name: 'AI-Office', root: 'ai-office', match: /^(?:ai-office(?:[-_.].*)?|aio(?:[-_.].*)?)$/i },
]
export function taskProjectPath(path) {
  const value = String(path || '').trim()
  return value.replace(/\/+$/, '') || (value.startsWith('/') ? '/' : '')
}
function knownProject(path) {
  const segments = taskProjectPath(path).split(/[\\/]/).filter(Boolean)
  // The deepest matching folder wins, e.g. a walkalone checkout inside an aio-* scratch folder.
  for (let index = segments.length - 1; index >= 0; index--) {
    const project = knownProjects.find(item => item.match.test(segments[index]))
    if (project) return { project, isRoot: index === segments.length - 1 && segments[index].toLowerCase() === project.root }
  }
  return null
}
export function taskProjectKey(path) {
  return knownProject(path)?.project.key ?? taskProjectPath(path)
}
export function taskProjectName(path) {
  const known = knownProject(path)
  if (known) return known.project.name
  const normalized = taskProjectPath(path)
  return normalized.split(/[\\/]/).filter(Boolean).pop() || (normalized ? '/' : 'Needs project folder')
}

const knownRank = key => { const index = knownProjects.findIndex(project => project.key === key); return index < 0 ? knownProjects.length : index }
// path is the project's main folder (most used root checkout), used as the default for new requests.
export function taskProjects(tasks) {
  const projects = new Map()
  for (const task of tasks) {
    const folder = taskProjectPath(task.projectPath)
    const key = taskProjectKey(folder)
    if (!projects.has(key)) projects.set(key, { key, name: taskProjectName(folder), count: 0, folders: new Map() })
    const project = projects.get(key)
    project.count++
    project.folders.set(folder, (project.folders.get(folder) || 0) + 1)
  }
  return [...projects.values()].map(({ folders, ...project }) => {
    const ranked = [...folders].sort(([pathA, countA], [pathB, countB]) =>
      Number(!!knownProject(pathB)?.isRoot) - Number(!!knownProject(pathA)?.isRoot) || countB - countA || pathA.localeCompare(pathB))
    return { ...project, path: ranked[0][0], folders: ranked.map(([path]) => path) }
  }).sort((a, b) => Number(!a.path) - Number(!b.path) || knownRank(a.key) - knownRank(b.key) || a.name.localeCompare(b.name, 'zh-Hans') || a.path.localeCompare(b.path))
}

export function filterBoardTasks(tasks, { projectPath = null, provider = 'all', status = 'all' } = {}) {
  const projectKey = projectPath === null ? null : taskProjectKey(projectPath)
  return tasks.filter(task => (status === 'all' || task.status === status) && (projectKey === null || taskProjectKey(task.projectPath) === projectKey) &&
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
  if (!task.projectPath || /project (?:folder|path).*(?:exist|absolute|folder|opened)|Add a project folder/i.test(full)) return own('Project folder needed', 'Edit request', 'You')
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
