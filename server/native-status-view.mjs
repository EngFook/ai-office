// Explicit read-only projection for service-to-service activity polling.
// Keep all present/uncertain agents and a bounded recent ended history. The
// default status endpoint retains the full catalog and historical roster.
const STATUS_FIELDS = ['agents', 'observedAt', 'connected', 'enabled', 'metadataAvailable', 'executionCounts',
  'sourceHealth', 'sourceErrors', 'coverage', 'catalogComplete', 'updatedAt', 'lastEventAt', 'liveAgentCount',
  'hookInstalled', 'eventCount', 'source', 'privacy', 'error'];
const OFFLINE_HISTORY_LIMIT = 20;
const lastActivity = agent => Math.max(...[agent.updatedAt, agent.lastEventAt, agent.executionObservedAt].map(value => {
  const at = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : -Infinity;
}));
export function compactNativeStatus(status) {
  const compact = Object.fromEntries(STATUS_FIELDS.filter(key => Object.hasOwn(status, key)).map(key => [key, status[key]]));
  const agents = Array.isArray(status.agents) ? status.agents : [];
  const offline = agents.filter(agent => agent.status === 'offline');
  const omittedOfflineCount = Math.max(0, offline.length - OFFLINE_HISTORY_LIMIT);
  if (omittedOfflineCount) {
    const recent = offline.slice().sort((a, b) => lastActivity(b) - lastActivity(a) || String(a.id).localeCompare(String(b.id))).slice(0, OFFLINE_HISTORY_LIMIT);
    compact.agents = [...agents.filter(agent => agent.status !== 'offline'), ...recent];
  }
  return { ...compact, totalAgentCount: agents.length, omittedOfflineCount };
}
