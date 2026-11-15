// Project selection is explicit. An empty folder is intentional text-only work;
// only an absent selection uses the configured default workspace.
export function requestProjectPath(projectPath, configuration = {}) {
  return projectPath === null || projectPath === undefined ? configuration.workspace || '' : projectPath
}

export function requestProviderOptions(state = {}, current = 'any') {
  const configured = new Map((state.configuration?.providers || []).map(provider => [provider.id, provider.enabled]))
  const names = { any: 'Any available agent', claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini research (read-only)', 'local-qwen': 'Local Qwen (preliminary only)', 'grok-bot': 'Grok Bot' }
  return Object.entries(names).map(([id, label]) => {
    // Keep disabled providers visible so an old request never changes owner just
    // because its provider was disabled. Availability/login do not prevent drafts.
    const runtime = state.runtime?.providers?.[id]
    const disabled = id !== 'any' && (configured.has(id) ? configured.get(id) !== true : runtime?.disabled === true || runtime?.enabled === false)
    return { id, label, disabled: disabled && id !== current, configuredDisabled: disabled }
  })
}
