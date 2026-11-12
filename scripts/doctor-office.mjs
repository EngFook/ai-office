#!/usr/bin/env node
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOfficeConfig } from '../server/office-config.mjs';

export function findExecutable(command, { env = process.env, cwd = process.cwd(), platform = process.platform } = {}) {
  if (!command) return false;
  const extensions = platform === 'win32' ? ['', ...(env.PATHEXT || '.EXE;.CMD;.BAT').split(';')] : [''];
  const bases = path.isAbsolute(command) || /[/\\]/.test(command) ? [path.resolve(cwd, command)] : (env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, command));
  return bases.some(base => extensions.some(ext => { try { const file=base+ext; accessSync(file, constants.X_OK); return statSync(file).isFile(); } catch { return false; } }));
}

// Read-only diagnosis: no login files, provider execution, model calls or writes.
export function diagnoseOffice({ env = process.env, home = homedir(), cwd = process.cwd(), root = path.resolve(import.meta.dirname, '..'), nodeVersion = process.versions.node, executable = findExecutable } = {}) {
  const checks = [];
  const add = (id, status, message, next = '') => checks.push({ id, status, message, next });
  add('node', Number(nodeVersion.split('.')[0]) >= 24 ? 'ok' : 'error', `Node.js ${nodeVersion}`, 'Requires Node.js 24+ / 需要 Node.js 24+');
  add('dependencies', existsSync(path.join(root, 'node_modules/vite/package.json')) ? 'ok' : 'error', 'Application dependencies / 应用依赖', 'npm ci');
  let config;
  try { config = loadOfficeConfig({ env, home, cwd }); }
  catch { add('configuration', 'error', 'Configuration cannot be loaded / 配置无效，未更改', 'Check local JSON; npm run setup -- --help'); return { ok:false, checks }; }
  add('configuration', config.configured ? 'ok' : 'action', config.configured ? 'Configuration saved / 已有本机配置' : 'First-time setup / 尚未设置', config.configured ? '' : 'npm run setup');
  add('mode', config.mode === 'enabled' ? 'ok' : 'action', `Execution / 执行模式: ${config.mode}`, config.mode === 'enabled' ? '' : 'Browse safely now; to execute, run npm run setup -- --overwrite and choose enabled. / 可先浏览，要执行任务再设为 enabled。');
  try { if (!statSync(config.workspace).isDirectory()) throw new Error(); accessSync(config.workspace, constants.R_OK | constants.W_OK); add('workspace', 'ok', 'Workspace exists and is writable / 工作目录可读写'); }
  catch { add('workspace', 'error', 'Workspace is missing or not writable / 工作目录不存在或不可写', 'Choose an existing project folder with npm run setup -- --overwrite'); }
  let dataParent=config.dataDir;
  while (!existsSync(dataParent) && path.dirname(dataParent)!==dataParent) dataParent=path.dirname(dataParent);
  try { if (!statSync(dataParent).isDirectory()) throw new Error(); accessSync(dataParent,constants.W_OK); add('data','ok','Private data directory can be written / 私人数据目录可写'); }
  catch { add('data','error','Data directory is not writable / 数据目录不可写','Choose another data directory in setup'); }
  const enabled=Object.entries(config.providers).filter(([,item])=>item.enabled);
  if (!enabled.length) add('providers','action','No AI enabled / 尚未启用 AI','Run setup when ready. An empty office is expected; no fake agents are shown.');
  for(const [id, provider] of enabled) {
    if(['claude','codex','gemini'].includes(id)) {
      const found=executable(provider.command,{env,cwd});
      add(`provider:${id}`,found?'ok':'error',`${id}: ${found?'CLI found; login is not verified / 命令存在，登录待验证':'CLI missing / 找不到命令'}`,found?'Check provider readiness in the task board / 查看任务板登录状态':(id==='gemini'?'Install the compatible Antigravity agy interface; other Gemini CLIs are not interchangeable.':'Install the official CLI, then select its executable in setup'));
    } else if(id==='local-qwen') add('provider:local-qwen',config.ollama.model?'action':'error',config.ollama.model?'Local model selected; availability not verified / 已选择模型，运行状态待验证':'No explicit local model selected / 未选择本地模型','Start Ollama, use ollama list, then choose an installed model in setup. No model is downloaded automatically.');
    else add('provider:grok-bot','action','External Bot needs a real connection / 外部 Bot 需要连接','Office → Dispatch → View setup / 办公室 → 调度 → 查看设置');
    if(['claude','codex'].includes(id)) {
      const reviewer=config.reviewerFor[id];
      if(!reviewer || !config.providers[reviewer]?.enabled) add(`reviewer:${id}`,'action',`${id}: independent reviewer not enabled / 独立审查员未启用`,'Enable the other coding provider for reviewed code tasks. The author cannot review itself.');
    }
  }
  add('scope','info','Local app; mobile localhost points to the phone / 本机应用，手机的 127.0.0.1 指向手机自身','For phone access use the documented paired mobile gateway; do not expose the server publicly.');
  return { ok:!checks.some(check=>check.status==='error'), checks };
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2);
  if(args.some(arg=>arg!=='--json')) { console.error('Usage: npm run doctor -- [--json]'); process.exitCode=1; }
  else { const report=diagnoseOffice(); console.log(args.includes('--json')?JSON.stringify(report,null,2):report.checks.map(check=>`[${check.status.toUpperCase()}] ${check.message}${check.status!=='ok'&&check.next?`\n  → ${check.next}`:''}`).join('\n')); process.exitCode=report.ok?0:1; }
}
