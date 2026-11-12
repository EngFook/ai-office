// Explicit capabilities let a local view expose only the user's allowed controls,
// without implying it runs a second worker service or can manage credentials.
export function officeCapability(state, name) {
  if (Object.hasOwn(state?.capabilities || {}, name)) return state.capabilities[name] === true
  return !state?.configuration || state.configuration.mode === 'enabled'
}
