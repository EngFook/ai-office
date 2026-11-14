import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync, lstatSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const PROVIDER_IDS = Object.freeze(['claude', 'codex', 'gemini', 'local-qwen', 'grok-bot']);
export const EXECUTION_MODES = Object.freeze(['disabled', 'read-only', 'enabled']);
const commands = { claude: 'claude', codex: 'codex', gemini: 'agy', 'local-qwen': null, 'grok-bot': null };
const fail = message => { throw new Error(`办公室配置：${message}`); };
const object = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} 必须是对象。`);
  return value;
};
function keys(value, allowed, label) {
  object(value, label);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${label} 含不支持的字段；密钥和密码请放在环境变量中。`);
}
function text(value, label, { empty = false, max = 4096 } = {}) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail(`${label} 必须是有效文字。`);
  return value.trim();
}
function resolveDirectory(value, label, base, home) {
  const input = text(value, label);
  if (input === '~') return path.resolve(home);
  return path.resolve(base, input.startsWith('~/') ? path.join(home, input.slice(2)) : input);
}

/** Pure validation/normalization. Never creates folders, contacts providers, or reads credentials. */
export function validateOfficeConfig(input = {}, { home = homedir(), cwd = process.cwd(), baseDir = cwd } = {}) {
  keys(input, ['version', 'dataDir', 'workspace', 'mode', 'title', 'timeZone', 'providers', 'reviewerFor', 'ollama', 'pausedTaskIds', 'routing'], '配置');
  if (input.version !== undefined && input.version !== 1) fail('不支持此配置版本。');
  const mode = input.mode ?? 'disabled';
  if (!EXECUTION_MODES.includes(mode)) fail('mode 必须是 disabled、read-only 或 enabled。');
  const title = text(input.title ?? 'AI Office', 'title', { max: 120 });
  const timeZone = text(input.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC', 'timeZone', { max: 120 });
  try { new Intl.DateTimeFormat('en', { timeZone }).format(); } catch { fail('timeZone 必须是有效时区，例如 Asia/Shanghai。'); }
  const entries = input.providers ?? {};
  keys(entries, PROVIDER_IDS, 'providers');
  const providers = Object.fromEntries(PROVIDER_IDS.map(id => {
    const provider = entries[id] ?? {};
    keys(provider, ['enabled', 'command', 'model', 'concurrency'], `providers.${id}`);
    if (provider.enabled !== undefined && typeof provider.enabled !== 'boolean') fail(`${id}.enabled 必须是布尔值。`);
    const command = provider.command === null ? null : text(provider.command ?? commands[id] ?? '', `${id}.command`, { empty: true });
    const model = text(provider.model ?? '', `${id}.model`, { empty: true, max: 240 });
    const concurrency = provider.concurrency ?? 1;
    const maxConcurrency = id === 'local-qwen' || id === 'grok-bot' ? 1 : 8;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > maxConcurrency) fail(`${id}.concurrency 必须是 1 到 ${maxConcurrency} 的整数。`);
    if (provider.enabled && ['claude', 'codex', 'gemini'].includes(id) && !command) fail(`${id} 启用时必须配置 command。`);
    return [id, { enabled: provider.enabled ?? false, command: command || null, model, concurrency }];
  }));
  const reviewerFor = { claude: 'codex', codex: 'claude', ...input.reviewerFor };
  keys(reviewerFor, PROVIDER_IDS, 'reviewerFor');
  for (const [author, reviewer] of Object.entries(reviewerFor)) {
    if (!['claude', 'codex'].includes(reviewer)) fail('reviewerFor 必须指向支持独立代码审查的 Claude 或 Codex。');
    if (author === reviewer) fail('独立审查员不能与作者相同。');
  }
  const ollamaInput = input.ollama ?? {};
  keys(ollamaInput, ['url', 'model'], 'ollama');
  let url;
  try { url = new URL(ollamaInput.url ?? 'http://127.0.0.1:11434'); } catch { fail('ollama.url 必须是有效的 HTTP 地址。'); }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) fail('ollama.url 默认只允许本机 loopback 地址。');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') fail('ollama.url 仅支持无凭据、无查询参数和路径的 HTTP/HTTPS 服务地址。');
  const routing = { workProviders: ['claude', 'codex'], balanceProvider: null, ...input.routing };
  keys(routing, ['workProviders', 'balanceProvider'], 'routing');
  if (!Array.isArray(routing.workProviders) || !routing.workProviders.length || routing.workProviders.some(id => !['claude', 'codex'].includes(id)) || (routing.balanceProvider !== null && !['claude', 'codex'].includes(routing.balanceProvider))) fail('routing 必须指定 Claude/Codex 开发者，balanceProvider 可为 null。');
  const pausedTaskIds = input.pausedTaskIds ?? [];
  if (!Array.isArray(pausedTaskIds) || pausedTaskIds.length > 2000 || pausedTaskIds.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_.:@/-]{1,240}$/.test(id))) fail('pausedTaskIds 必须是任务 ID 数组。');
  return {
    pausedTaskIds: [...new Set(pausedTaskIds)], routing: { ...routing, workProviders: [...new Set(routing.workProviders)] },
    version: 1,
    dataDir: resolveDirectory(input.dataDir ?? path.join(home, '.ai-office'), 'dataDir', baseDir, home),
    workspace: resolveDirectory(input.workspace ?? cwd, 'workspace', baseDir, home),
    mode, title, timeZone, providers, reviewerFor: { ...reviewerFor },
    ollama: { url: url.href.replace(/\/$/, ''), model: text(ollamaInput.model || providers['local-qwen'].model, 'ollama.model', { empty: true, max: 200 }) },
  };
}

export function officeConfigPath({ env = process.env, home = homedir(), cwd = process.cwd(), configPath } = {}) {
  const root = env.AI_OFFICE_HOME ? resolveDirectory(env.AI_OFFICE_HOME, 'AI_OFFICE_HOME', cwd, home) : path.join(home, '.ai-office');
  return resolveDirectory(configPath ?? env.AI_OFFICE_CONFIG ?? path.join(root, 'config.json'), '配置路径', cwd, home);
}

/** Old AI_OFFICE_HOME remains authoritative. An existing board does not enable execution. */
export function loadOfficeConfig(options = {}) {
  const { env = process.env, home = homedir(), cwd = process.cwd() } = options;
  const configPath = officeConfigPath({ ...options, env, home, cwd });
  let raw = {};
  let configured = false;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'));
    configured = true;
  } catch (error) {
    if (error.code !== 'ENOENT') fail('无法读取配置，请检查 JSON 格式和文件权限。');
  }
  // Reject invalid file settings even if an environment override would mask them.
  const config = validateOfficeConfig(raw, { home, cwd, baseDir: path.dirname(configPath) });
  if (env.AI_OFFICE_HOME) config.dataDir = resolveDirectory(env.AI_OFFICE_HOME, 'AI_OFFICE_HOME', cwd, home);
  if (env.AI_OFFICE_WORKSPACE) config.workspace = resolveDirectory(env.AI_OFFICE_WORKSPACE, 'AI_OFFICE_WORKSPACE', cwd, home);
  if (env.AI_OFFICE_MODE) {
    if (!EXECUTION_MODES.includes(env.AI_OFFICE_MODE)) fail('AI_OFFICE_MODE 必须是 disabled、read-only 或 enabled。');
    config.mode = env.AI_OFFICE_MODE;
  }
  return { ...config, configPath, configured };
}

export function publicOfficeConfig(config = loadOfficeConfig()) {
  return { name: config.title, timeZone: config.timeZone, mode: config.mode, configured: config.configured,
    workspace: config.workspace, providers: PROVIDER_IDS.map(id => ({ id, enabled: config.providers[id].enabled })),
    setupCommand: 'npm run setup' };
}

/** Exclusive creation by default; replacement is opt-in and retains an exclusive backup. */
export function writeOfficeConfig(input, { overwrite = false, ...options } = {}) {
  const { home = homedir(), cwd = process.cwd(), env = process.env } = options;
  const configPath = officeConfigPath({ ...options, env, home, cwd });
  const config = validateOfficeConfig(input, { home, cwd, baseDir: path.dirname(configPath) });
  if (existsSync(configPath)) {
    if (!overwrite) fail('配置已存在，未改动。需要覆盖时请明确使用 --overwrite。');
    if (!lstatSync(configPath).isFile() || lstatSync(configPath).isSymbolicLink()) fail('拒绝覆盖非普通配置文件。');
  }
  mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const contents = `${JSON.stringify(config, null, 2)}\n`;
  let backupPath = null;
  if (!overwrite || !existsSync(configPath)) {
    writeFileSync(configPath, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } else {
    backupPath = `${configPath}.backup-${Date.now()}-${randomUUID()}`;
    writeFileSync(backupPath, readFileSync(configPath), { mode: 0o600, flag: 'wx' });
    const temporary = `${configPath}.tmp-${randomUUID()}`;
    try {
      writeFileSync(temporary, contents, { mode: 0o600, flag: 'wx' });
      renameSync(temporary, configPath);
    } finally { try { unlinkSync(temporary); } catch {} }
  }
  chmodSync(configPath, 0o600);
  return { ...config, configPath, configured: true, backupPath };
}
