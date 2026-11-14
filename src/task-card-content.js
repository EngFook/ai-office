// Preview only: original instructions, evidence and payloads remain in details.
export function compactTaskText(value, fallback = '', limit = 160) {
  if (value == null || value === '') return fallback
  if (typeof value === 'object') {
    const text = ['summary', 'message', 'reason', 'nextAction', 'title'].map(key => value[key]).find(item => typeof item === 'string' && item.trim())
    return text ? compactTaskText(text, fallback, limit) : fallback
  }
  const source = String(value).trim()
  if (/^[\[{]/.test(source)) {
    try { return compactTaskText(JSON.parse(source), fallback, limit) } catch { /* Bracketed prose such as [WIP] remains readable below. */ }
  }
  const text = source.replace(/```[\s\S]*?(?:```|$)/g, '').replace(/\s+/g, ' ').trim()
  return text ? (text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text) : fallback
}
