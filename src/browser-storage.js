// Private browsing, embedded browsers and storage quotas can deny access. The
// task board remains server-backed and must not disappear with local notes.
export function browserStorage(host = globalThis) {
  try { return host.localStorage || null } catch { return null }
}
export function readBrowserValue(key, fallback, storage = browserStorage()) {
  try { return JSON.parse(storage?.getItem(key) ?? 'null') ?? fallback } catch { return fallback }
}
export function writeBrowserValue(key, value, storage = browserStorage()) {
  try {
    if (!storage) return false
    storage.setItem(key, JSON.stringify(value))
    return true
  } catch { return false }
}
export function localNoteRecords(value) {
  return Array.isArray(value) ? value.filter(record => record && typeof record === 'object' && !Array.isArray(record)) : []
}
