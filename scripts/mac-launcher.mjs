import { spawn, execFile } from 'node:child_process';
import { mkdir, readFile, open, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

function officeURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('办公室地址必须是 http://127.0.0.1:端口/。');
  }
  return url;
}

async function portOccupied(url) {
  return new Promise(resolve => {
    const socket = net.connect({ host: url.hostname, port: Number(url.port || 80) });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(1000, () => finish(true));
    socket.once('connect', () => finish(true));
    socket.once('error', error => finish(error.code !== 'ECONNREFUSED'));
  });
}

export async function probeOffice(value) {
  const url = officeURL(value);
  try {
    const response = await fetch(new URL('/api/office/board', url), { headers: { Origin: url.origin, Accept: 'application/json' }, signal: AbortSignal.timeout(1200), redirect: 'error' });
    if (response.ok) {
      const board = await response.json();
      if (Array.isArray(board.tasks) && board.settings && board.runtime && (board.runtime.started === true || ['enabled', 'disabled', 'read-only'].includes(board.configuration?.mode))) return 'ready';
    }
  } catch {}
  return await portOccupied(url) ? 'occupied' : 'absent';
}

async function startService({ projectPath, nodePath, url, stateDir, path: configPath, launchAgent }) {
  if (launchAgent) {
    if (process.platform !== 'darwin' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(launchAgent)) throw new Error('无效的本机后台服务名称 / Invalid local service label.');
    // Reuse the registered service without stopping it or spawning a second
    // runner. A missing registration must be repaired by its owner.
    await new Promise((resolve, reject) => execFile('/bin/launchctl', ['kickstart', `gui/${process.getuid()}/${launchAgent}`], error => error ? reject(new Error('已登记的办公室服务无法启动，请检查本机后台服务设置 / The registered office service could not start.')) : resolve()));
    return null;
  }
  const vite = path.join(projectPath, 'node_modules', 'vite', 'bin', 'vite.js');
  await access(vite, constants.R_OK).catch(() => { throw new Error('项目依赖不存在，请先在 AI Office 项目中运行 npm ci。'); });
  await access(nodePath, constants.X_OK);
  const log = await open(path.join(stateDir, 'service.log'), 'a', 0o600);
  try {
    const child = spawn(nodePath, [vite, '--host', '127.0.0.1', '--port', officeURL(url).port || '80', '--strictPort'], {
      cwd: projectPath,
      env: { ...process.env, PATH: [path.dirname(nodePath), configPath, process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean).join(':') },
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    return child;
  } finally { await log.close(); }
}

// macOS lockf holds a kernel lock. Keep the inode (-k): no stale PID files,
// deletion races or inherited locks after the launcher is force-quit.
export async function ensureOffice(config, { timeoutMs = 45000 } = {}) {
  officeURL(config.url);
  if (await probeOffice(config.url) === 'ready') return { started: false, url: config.url };
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const args = ['-k', '-t', String(Math.ceil(timeoutMs / 1000)), path.join(config.stateDir, 'startup.lock'),
    process.execPath, fileURLToPath(import.meta.url), '--ensure-locked', JSON.stringify(config), String(timeoutMs)];
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/lockf', args, { maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(error.code === 75 ? '另一个窗口正在启动办公室，请稍后再试。' : stderr.trim() || '办公室启动失败，请检查项目路径。'));
      else { try { resolve(JSON.parse(stdout)); } catch { reject(new Error('办公室启动器返回了无效结果。')); } }
    });
  });
}

async function ensureLocked(config, timeoutMs) {
  const { url, stateDir } = config;
  const current = await probeOffice(url);
  if (current === 'ready') return { started: false, url };
  if (current === 'occupied') throw new Error('办公室端口已被占用，或办公室尚未就绪。请稍后重试；现有服务没有被停止。');
  const deadline = Date.now() + timeoutMs;
  const child = await startService(config);
  let exited = false;
  child?.once('exit', () => { exited = true; });
  while (Date.now() < deadline) {
    if (await probeOffice(url) === 'ready') return { started: true, url };
    if (exited) throw new Error(`办公室启动失败，请查看 ${path.join(stateDir, 'service.log')}。`);
    await delay(200);
  }
  throw new Error(`办公室启动等待超时，请查看 ${path.join(stateDir, 'service.log')}；服务可能仍在启动，请稍后再点一次。`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] === '--ensure-locked') {
      console.log(JSON.stringify(await ensureLocked(JSON.parse(process.argv[3]), Number(process.argv[4]))));
    } else {
      const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
      config.nodePath = process.execPath;
      await ensureOffice(config);
      await new Promise((resolve, reject) => execFile('/usr/bin/open', [config.url], error => error ? reject(error) : resolve()));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
