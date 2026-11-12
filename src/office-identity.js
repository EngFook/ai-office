export function officeIdentity(configuration = {}) {
  const name = typeof configuration?.name === 'string' && configuration.name.trim()
    ? configuration.name.trim() : 'AI Office';
  let timeZone;
  try {
    timeZone = new Intl.DateTimeFormat(undefined, {
      ...(configuration?.timeZone ? { timeZone: configuration.timeZone } : {}),
    }).resolvedOptions().timeZone;
  } catch {
    timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
  return { name, timeZone };
}

export function officeDate(value, { lang = 'en', timeZone, ...options } = {}) {
  if (value === null || value === undefined || value === '') return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en', {
    ...options, timeZone: officeIdentity({ timeZone }).timeZone,
  }).format(date);
}
