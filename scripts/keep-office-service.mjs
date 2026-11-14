#!/usr/bin/env node
// A local service keeper. It never stops an existing listener or edits the board.
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rename, open, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { probeOffice } from './mac-launcher.mjs';

const script = fileURLToPath(import.meta.url);
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
export function keeperConfig(input) {
  const url = new URL(input.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('Use a loopback HTTP office URL.');
  const port = Number(url.port || 80);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Use a local office port between 1024 and 65535.');
  for (const key of ['projectPath', 'nodePath', 'stateDir']) if (typeof input[key] !== 'string' || !path.isAbsolute(input[key])) throw new Error(`Missing absolute ${key}.`);
  const pollMs = input.pollMs ?? 10000, retryMs = input.retryMs ?? 30000;
  if (!Number.isSafeInteger(pollMs) || pollMs < 100 || pollMs > 60000 || !Number.isSafeInteger(retryMs) || retryMs < 1000 || retryMs > 3600000) throw new Error('Invalid keeper poll/retry interval.');
  return { projectPath: input.projectPath, nodePath: input.nodePath, stateDir: input.stateDir, url: url.href, port, pollMs, retryMs,
    ...(typeof input.path === 'string' ? { path: input.path } : {}) };
}

export function keeperFiles(config) {
  // Match the port-level lock scope: changing a config/log directory must not
  // hide a still-starting child from a replacement keeper.
  const prefix = path.join(tmpdir(), `ai-office-keeper-${process.getuid()}`, String(config.port));
  return { lock: `${prefix}.lock`, ledger: `${prefix}.child.json` };
}

export async function createOfficeKeeper(input, { onState = () => {} } = {}) {
  const config = keeperConfig(input), { ledger } = keeperFiles(config);
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(ledger), { recursive: true, mode: 0o700 });
  let stopped = false, timer, pending, child, lastAttempt = 0, state = 'starting';
  const report = value => { if (value !== state) { state = value; onState(value); } };
  async function readChild() {
    try {
      const value = JSON.parse(await readFile(ledger, 'utf8'));
      if (!Number.isSafeInteger(value.pid) || value.pid < 2 || !Number.isFinite(value.startedAt) || value.url !== config.url) throw new Error('Invalid keeper child record.');
      lastAttempt = Math.max(lastAttempt, value.startedAt);
      return value;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async function inspect() {
    const health = await probeOffice(config.url);
    if (health !== 'absent') { report(health === 'ready' ? 'ready' : 'occupied'); return; }
    const previous = await readChild();
    // A keeper may have restarted while its child was still initializing. Even
    // an uncertain/reused PID is a hold, never permission to launch a duplicate.
    if (previous && alive(previous.pid)) { report('starting-or-unconfirmed'); return; }
    if (stopped || Date.now() - lastAttempt < config.retryMs) { report('backoff'); return; }
    const vite = path.join(config.projectPath, 'node_modules/vite/bin/vite.js');
    await access(vite, constants.R_OK); await access(config.nodePath, constants.X_OK);
    lastAttempt = Date.now();
    const log = await open(path.join(config.stateDir, 'keeper-service.log'), 'a', 0o600);
    try {
      child = spawn(config.nodePath, [script, '--child', JSON.stringify(config)], {
        cwd: config.projectPath, detached: true,
        env: { ...process.env, PATH: [path.dirname(config.nodePath), config.path, process.env.PATH].filter(Boolean).join(':') },
        stdio: ['ignore', log.fd, log.fd, 'ipc'],
      });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      // The child cannot import Vite or start any runner until its PID is saved.
      // If the keeper dies first, the waiting child exits on IPC disconnect.
      const temporary = `${ledger}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify({ pid: child.pid, startedAt: lastAttempt, url: config.url }) + '\n', { mode: 0o600 });
      await rename(temporary, ledger);
      if (stopped) { child.disconnect(); child.unref(); return; }
      child.send({ start: true });
      child.once('exit', () => { child = null; report('backoff'); });
      report('spawned');
    } catch (error) { if (child?.connected) child.disconnect(); child?.unref(); child = null; throw error; }
    finally { await log.close(); }
  }
  function tick() {
    if (stopped) return Promise.resolve(state);
    if (!pending) pending = inspect().catch(() => report('check-failed')).finally(() => { pending = null; });
    return pending;
  }
  return {
    tick, status: () => state,
    start() { if (timer || stopped) return; tick(); timer = setInterval(tick, config.pollMs); },
    async stop() { stopped = true; clearInterval(timer); timer = null; await pending; if (child) { if (child.connected) child.disconnect(); child.unref(); } },
  };
}

async function childMain(config) {
  let released = false;
  process.once('disconnect', () => { if (!released) process.exit(0); });
  process.once('message', async message => {
    if (message?.start !== true) return;
    released = true;
    try {
      // Repeat immediately before loading Vite: occupied/starting services are
      // preserved, even when they are not an AI Office health response.
      if (await probeOffice(config.url) !== 'absent') process.exit(0);
      if (process.connected) process.disconnect();
      const vite = path.join(config.projectPath, 'node_modules/vite/bin/vite.js');
      process.argv = [config.nodePath, vite, '--host', '127.0.0.1', '--port', String(config.port), '--strictPort'];
      await import(pathToFileURL(vite).href);
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  try {
    if (process.argv[2] === '--child') await childMain(keeperConfig(JSON.parse(process.argv[3])));
    else {
      const locked = process.argv[2] === '--locked', configFile = path.resolve(process.argv[locked ? 3 : 2] || '');
      const config = keeperConfig(JSON.parse(await readFile(configFile, 'utf8')));
      if (!locked) {
        if (process.platform !== 'darwin' || typeof process.execve !== 'function') throw new Error('The service keeper CLI requires macOS and Node.js 24+.');
        // The kernel lock is held for this keeper's lifetime, across all config
        // paths targeting the same port. A second keeper exits without a spawn.
        const { lock } = keeperFiles(config);
        await mkdir(path.dirname(lock), { recursive: true, mode: 0o700 });
        process.execve('/usr/bin/lockf', ['lockf', '-k', '-t', '0', lock, process.execPath, script, '--locked', configFile], process.env);
      } else {
        const keeper = await createOfficeKeeper(config, { onState: state => console.log(`AI Office keeper: ${state}`) });
        keeper.start();
        const stop = async () => { await keeper.stop(); process.exit(0); };
        process.once('SIGINT', stop); process.once('SIGTERM', stop);
      }
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
