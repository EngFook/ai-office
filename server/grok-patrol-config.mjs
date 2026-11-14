import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const GROK_PATROL_INTERVAL_MS = 10 * 60 * 1000;
export function readGrokPatrolConfig(home = process.env.AI_OFFICE_HOME || path.join(homedir(), '.ai-office')) {
  const disabled = { enabled: false, intervalMs: GROK_PATROL_INTERVAL_MS };
  try {
    const raw = readFileSync(path.join(home, 'grok-blocked-patrol-config.json'), 'utf8');
    if (Buffer.byteLength(raw) > 2048) throw new Error();
    const value = JSON.parse(raw);
    if (!value || Array.isArray(value) || typeof value !== 'object' || value.version !== 1 || typeof value.enabled !== 'boolean' ||
      Object.keys(value).some(key => !['version', 'enabled', 'intervalMs'].includes(key)) || value.intervalMs !== GROK_PATROL_INTERVAL_MS) throw new Error();
    return { enabled: value.enabled, intervalMs: GROK_PATROL_INTERVAL_MS };
  } catch (error) {
    return error.code === 'ENOENT' ? disabled : { ...disabled, error: 'Grok 巡检配置无效；已停止自动巡检，请修复本机配置。' };
  }
}
