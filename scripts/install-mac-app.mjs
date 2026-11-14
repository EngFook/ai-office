#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, copyFileSync, existsSync, renameSync, rmSync, realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// The shortcut is local to this installation; no account or runtime data is bundled.
const args = process.argv.slice(2), positional = [];
let url = 'http://127.0.0.1:5173/', launchAgent;
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === '--url' && args[index + 1]) url = args[++index];
  else if (arg === '--launch-agent' && args[index + 1]) launchAgent = args[++index];
  else if (arg.startsWith('--')) throw new Error('Unknown option: ' + arg);
  else positional.push(arg);
}
const [projectArgument = process.cwd(), destinationArgument = path.join(os.homedir(), 'Applications', 'AI Office.app')] = positional;
if (process.platform !== 'darwin' || positional.length > 2) throw new Error('用法：npm run app:install -- [项目路径] [目标.app] [--url http://127.0.0.1:端口/] [--launch-agent 已登记服务名称]（仅 macOS）');
const parsedURL = new URL(url);
if (parsedURL.protocol !== 'http:' || parsedURL.hostname !== '127.0.0.1' || parsedURL.pathname !== '/' || parsedURL.search || parsedURL.hash || parsedURL.username || parsedURL.password) throw new Error('办公室地址必须是 http://127.0.0.1:端口/。');
if (launchAgent && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(launchAgent)) throw new Error('无效的本机后台服务名称。');
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('需要 Node.js 24 或更新版本。');
const projectPath = realpathSync(projectArgument);
if (!existsSync(path.join(projectPath, 'node_modules/vite/bin/vite.js')) || !existsSync(path.join(projectPath, 'server/office-services.mjs'))) throw new Error('目标不是已安装依赖的 AI Office 项目。');
const destination = path.resolve(destinationArgument);
if (!destination.endsWith('.app')) throw new Error('目标必须以 .app 结尾。');
if (existsSync(destination)) throw new Error(`已存在 ${destination}；为避免覆盖，先手动移走旧版 app。`);
mkdirSync(path.dirname(destination), { recursive: true });
const staging = mkdtempSync(path.join(path.dirname(destination), '.ai-office-install-'));
const app = path.join(staging, 'AI Office.app');
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
try {
  // Paths come from the installed bundle at runtime, so moving the app is safe.
  const source = `on run\n  set resourcesPath to (POSIX path of (path to me)) & "Contents/Resources/"\n  try\n    do shell script quoted form of (resourcesPath & "launch.sh")\n  on error messageText\n    display dialog messageText with title "AI Office 无法打开" buttons {"好"} default button "好" with icon caution\n  end try\nend run\n`;
  const sourcePath = path.join(staging, 'launcher.applescript');
  writeFileSync(sourcePath, source);
  execFileSync('/usr/bin/osacompile', ['-o', app, sourcePath]);
  const resources = path.join(app, 'Contents/Resources');
  const config = { projectPath, nodePath: process.execPath, path: [process.env.PATH, path.join(os.homedir(), '.local/bin'), path.join(os.homedir(), '.npm-global/bin'), path.join(os.homedir(), '.bun/bin')].filter(Boolean).join(':'), url, ...(launchAgent ? { launchAgent } : {}), stateDir: path.join(os.homedir(), 'Library/Application Support/AI Office') };
  copyFileSync(fileURLToPath(new URL('./mac-launcher.mjs', import.meta.url)), path.join(resources, 'mac-launcher.mjs'));
  writeFileSync(path.join(resources, 'config.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  // Finder has no interactive shell PATH. Prefer the install-time Node and then
  // conventional GUI-safe locations, including later nvm upgrades.
  writeFileSync(path.join(resources, 'launch.sh'), `#!/bin/zsh\nset -eu\nresources="\${0:A:h}"\nfor runtime in ${shellQuote(process.execPath)} /opt/homebrew/bin/node /usr/local/bin/node "$HOME"/.nvm/versions/node/*/bin/node(NOn); do\n  if [[ -x "$runtime" ]] && "$runtime" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' 2>/dev/null; then\n    exec "$runtime" "$resources/mac-launcher.mjs" "$resources/config.json"\n  fi\ndone\nprint -u2 '找不到 Node.js 24 或更新版本，请安装 Node 后重装 AI Office app。'\nexit 1\n`, { mode: 0o755 });
  const plist = path.join(app, 'Contents/Info.plist');
  for (const [key, type, value] of [['CFBundleIdentifier', 'string', 'local.ai-office.launcher'], ['CFBundleName', 'string', 'AI Office'], ['CFBundleDisplayName', 'string', 'AI Office'], ['CFBundleShortVersionString', 'string', '1.0'], ['NSHighResolutionCapable', 'bool', 'true']]) {
    try { execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist], { stdio: 'ignore' }); }
    catch { execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} ${type} ${value}`, plist]); }
  }
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', app], { stdio: 'pipe' });
  renameSync(app, destination);
  console.log(`已安装：${destination}\n办公室：${config.url}\n服务日志：${config.stateDir}/service.log\n可将 AI Office.app 拖到 Dock，以后点一下打开。`);
} finally { rmSync(staging, { recursive: true, force: true }); }
