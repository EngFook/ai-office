import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { ensureOffice, probeOffice } from '../scripts/mac-launcher.mjs';

const run = promisify(execFile);
const launcherModule = new URL('../scripts/mac-launcher.mjs', import.meta.url).href;
const office = { tasks: [], settings: { autoPickup: true }, runtime: { started: true } };
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}/`; }

test('已有办公室直接复用，不依赖项目路径或创建启动目录，不写任务板', async t => {
  const requests = [];
  const server = createServer((req, res) => { requests.push([req.method, req.url, req.headers.origin]); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(office)); });
  const url = await listen(server);
  t.after(() => server.close());
  assert.deepEqual(await ensureOffice({ url, projectPath: '/missing', stateDir: '/missing', nodePath: '/missing' }), { started: false, url });
  assert.deepEqual(requests, [['GET', '/api/office/board', new URL(url).origin]]);
});

test('端口有其他网页时拒绝启动和打开，原服务仍可访问', { skip: process.platform !== 'darwin' }, async t => {
  const server = createServer((req, res) => res.end('<html>another app</html>'));
  const url = await listen(server);
  t.after(() => server.close());
  const root = await mkdtemp(path.join(os.tmpdir(), 'ai-office-occupied-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(ensureOffice({ url, stateDir: root }), /端口已被占用/);
  assert.equal(await (await fetch(url)).text(), '<html>another app</html>');
});

test('冷启动跨进程只启动一次，等待真实就绪；启动服务在调用进程退出后仍运行', { skip: process.platform !== 'darwin' }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "AI Office 空格 ' 测试-"));
  const reservation = createServer();
  const url = await listen(reservation);
  await new Promise(resolve => reservation.close(resolve));
  const config = { url, stateDir: path.join(root, 'state'), projectPath: root, nodePath: process.execPath, path: path.join(root, 'custom cli') };
  const viteDir = path.join(root, 'node_modules/vite/bin');
  await mkdir(viteDir, { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(viteDir, 'vite.js'), `import {createServer} from 'node:http';import {appendFileSync,writeFileSync} from 'node:fs';\nappendFileSync('starts.txt','start\\n');writeFileSync('service.pid',String(process.pid));\nwriteFileSync('service-path.txt',process.env.PATH);let ready=false;setTimeout(()=>ready=true,400);createServer((req,res)=>{if(!ready){res.writeHead(503);res.end('starting');return;}res.setHeader('Content-Type','application/json');res.end(${JSON.stringify(JSON.stringify(office))})}).listen(Number(process.argv[process.argv.indexOf('--port')+1]),'127.0.0.1');`);
  t.after(async () => {
    const pid = Number(await readFile(path.join(root, 'service.pid'), 'utf8').catch(() => 0));
    if (pid) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    await rm(root, { recursive: true, force: true });
  });
  // Recover a lock left by an app that was force-quit.
  await mkdir(config.stateDir, { recursive: true });
  await writeFile(path.join(config.stateDir, 'startup.lock'), 'left by a force-quit launcher');
  const code = `import {ensureOffice} from ${JSON.stringify(launcherModule)}; console.log(JSON.stringify(await ensureOffice(JSON.parse(process.argv[1]))));`;
  const results = await Promise.all([1, 2, 3].map(() => run(process.execPath, ['--input-type=module', '-e', code, JSON.stringify(config)])));
  assert.equal(results.filter(result => JSON.parse(result.stdout).started).length, 1);
  assert.equal(await readFile(path.join(root, 'starts.txt'), 'utf8'), 'start\n');
  assert.ok((await readFile(path.join(root, 'service-path.txt'), 'utf8')).split(':').includes(config.path));
  assert.equal(await probeOffice(url), 'ready');
  await run('/usr/bin/lockf', ['-k', '-t', '0', path.join(config.stateDir, 'startup.lock'), '/usr/bin/true']);
  assert.equal((await ensureOffice(config)).started, false);
});

test('缺少依赖时中文报错并释放启动锁；不绑定非本机地址', { skip: process.platform !== 'darwin' }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ai-office-missing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = createServer(); const url = await listen(server); await new Promise(resolve => server.close(resolve));
  const config = { url, stateDir: root, projectPath: root, nodePath: process.execPath };
  await assert.rejects(ensureOffice(config), /项目依赖不存在/);
  await run('/usr/bin/lockf', ['-k', '-t', '0', path.join(root, 'startup.lock'), '/usr/bin/true']);
  await assert.rejects(probeOffice('http://example.com/'), /127.0.0.1/);
});


test('只读连接视图及未设置的新安装可打开，不会要求启动另一个执行器', async t => {
  let mode = 'read-only';
  const server = createServer((req, res) => {
    if (req.headers.origin !== `http://${req.headers.host}`) { res.writeHead(403); res.end('{}'); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ tasks: [], settings: { autoPickup: false }, runtime: { started: false }, configuration: { mode } }));
  });
  const url = await listen(server); t.after(() => server.close());
  for (mode of ['read-only', 'disabled', 'enabled']) {
    assert.deepEqual(await ensureOffice({ url, projectPath: '/missing', stateDir: '/missing', nodePath: '/missing', launchAgent: 'unregistered-service' }), { started: false, url });
  }
});

test('missing registered service cannot fall through to launching an independent runner', { skip: process.platform !== 'darwin' }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'office-launch-agent-')); t.after(() => rm(root, { recursive: true, force: true }));
  const reservation = createServer(); const url = await listen(reservation); await new Promise(resolve => reservation.close(resolve));
  await assert.rejects(ensureOffice({ url, stateDir: root, projectPath: root, nodePath: process.execPath, launchAgent: 'local.ai-office.test-service-does-not-exist' }), /registered office service could not start/);
});
