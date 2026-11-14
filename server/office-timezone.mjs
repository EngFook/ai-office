// Office time zone used for daily schedules when a service has no explicit
// setting. Order: the service's own config, the office settings (timeZone in
// the office configuration), AI_OFFICE_TIMEZONE, then the historical default.
export const FALLBACK_OFFICE_TIME_ZONE = 'Asia/Singapore';
export function validTimeZone(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 120) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value.trim() }).format(); return true; } catch { return false; }
}
export function resolveOfficeTimeZone({ configured, env = process.env } = {}) {
  for (const candidate of [configured, env?.AI_OFFICE_TIMEZONE]) if (validTimeZone(candidate)) return candidate.trim();
  return FALLBACK_OFFICE_TIME_ZONE;
}
