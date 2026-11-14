import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// Task IDs that must be done before Qwen's watch or daily work reports start.
// They are install-specific, so the source ships none: configure them with
// AI_OFFICE_QWEN_WATCH_PREREQUISITES / AI_OFFICE_WORK_REPORT_PREREQUISITES
// (comma-separated) or <AI_OFFICE_HOME>/qwen-prerequisites.json
// ({"watch":["task-id"],"workReports":["task-id"]}). Environment wins.
// An invalid value is ignored with a warning (the value itself is never logged) and
// no gate applies, so a typo cannot silently stall the watch or daily reports forever.
export const QWEN_PREREQUISITE_ENV = Object.freeze({ watch: 'AI_OFFICE_QWEN_WATCH_PREREQUISITES', workReports: 'AI_OFFICE_WORK_REPORT_PREREQUISITES' });
const ID = /^[A-Za-z0-9:._-]{1,200}$/;
function ids(value) {
  const list = Array.isArray(value) ? value : String(value).split(',').map(item => item.trim()).filter(Boolean);
  if (list.length > 50 || list.some(id => typeof id !== 'string' || !ID.test(id))) throw new Error('Invalid prerequisite task id');
  return [...new Set(list)];
}
const warned = new Set();
function warnInvalid(source, warn) {
  // Report where the bad value is, never the value itself; once per source.
  if (warned.has(source)) return; warned.add(source);
  try { warn(`[ai-office] Ignoring invalid Qwen prerequisite configuration in ${source}; no prerequisite gate is applied.`); } catch {}
}
export function readQwenPrerequisites(kind, { home = process.env.AI_OFFICE_HOME || path.join(homedir(), '.ai-office'), env = process.env, warn = console.warn } = {}) {
  if (!Object.hasOwn(QWEN_PREREQUISITE_ENV, kind)) throw new Error('Unknown prerequisite kind');
  const variable = QWEN_PREREQUISITE_ENV[kind];
  if (typeof env?.[variable] === 'string' && env[variable].trim()) {
    try { return ids(env[variable]); } catch { warnInvalid(variable, warn); return []; }
  }
  try {
    const file = path.join(home, 'qwen-prerequisites.json'), stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 20000) throw new Error('Invalid prerequisite file');
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid prerequisite file');
    return value[kind] !== undefined ? ids(value[kind]) : [];
  } catch (error) { if (error?.code !== 'ENOENT') warnInvalid('qwen-prerequisites.json', warn); return []; }
}
