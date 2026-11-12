import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createOfficeKeeper, keeperConfig, keeperFiles } from '../scripts/keep-office-service.mjs';

const script = fileURLToPath(new URL('../scripts/keep-office-service.mjs', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}/`; }
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'office-keeper-'));
  const reservation = createServer(); const url = await listen(reservation); await new Promise(resolve => reservation.close(resolve));
  const config = { url, stateDir: path.join(root, 'state'), projectPath: root, nodePath: process.execPath, pollMs: 100, retryMs: 1000 };
  const processes = [], configFile = path.join(root, 'config.json');
  const f = { root, config, configFile, processes, ownsLedger: false };
  t.after(async () => {
    for (const child of processes) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
    await sleep(120);
    // Only this fixture's recorded fake-Vite children may be terminated. The
    // shared ledger could describe a reused PID or another service.
    const ownedPids = new Set((await starts(f)).map(record => record.pid));
    for (const pid of ownedPids) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    try {
      const ledger = keeperFiles(keeperConfig(config)).ledger, record = JSON.parse(await readFile(ledger, 'utf8'));
      if (ownedPids.has(record.pid) || f.ownsLedger && record.pid === process.pid) await rm(ledger, { force: true });
    } catch {}
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(configFile, JSON.stringify(config));
  return f;
}
async function installFake(f, startupDelay = 0) {
  const folder = path.join(f.root, 'node_modules/vite/bin'); await mkdir(folder, { recursive: true });
  await writeFile(path.join(f.root, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(folder, 'vite.js'), `import {createServer} from 'node:http';import {appendFileSync} from 'node:fs';\nappendFileSync('starts.jsonl',JSON.stringify({pid:process.pid,args:process.argv.slice(2)})+'\\n');\nsetTimeout(()=>createServer((req,res)=>{if(req.headers.origin!=='http://'+req.headers.host){res.writeHead(403);res.end('{}');return;}res.setHeader('Content-Type','application/json');res.end(JSON.stringify({tasks:[],settings:{},runtime:{started:true}}));}).listen(Number(process.argv[process.argv.indexOf('--port')+1]),'127.0.0.1'),${startupDelay});`);
}
const starts = f => readFile(path.join(f.root, 'starts.jsonl'), 'utf8').then(value => value.trim().split('\n').filter(Boolean).map(JSON.parse)).catch(() => []);
function launch(f) { const child = spawn(process.execPath, [script, f.configFile], { detached: true, stdio: 'ignore' }); f.processes.push(child); return child; }
async function waitFor(check, timeout = 8000) { const end = Date.now() + timeout; while(Date.now()<end) { if(await check())return; await sleep(50); } throw new Error('Fixture did not reach expected state.'); }

for (const healthy of [true, false]) test(`existing ${healthy ? 'office' : 'unrelated listener'} is preserved without launching a runner`, async t => {
  const f=await fixture(t);
  const server=createServer((req,res)=>{res.setHeader('Content-Type',healthy?'application/json':'text/html');res.end(healthy?JSON.stringify({tasks:[],settings:{},runtime:{started:true}}):'<h1>Another service</h1>');});
  f.config.url=await listen(server); t.after(()=>server.close());
  const keeper=await createOfficeKeeper(f.config);t.after(()=>keeper.stop());await keeper.tick();
  assert.equal(keeper.status(),healthy?'ready':'occupied');
  await assert.rejects(readFile(keeperFiles(keeperConfig(f.config)).ledger),{code:'ENOENT'});
});

test('uncertain surviving child is held instead of starting a duplicate', async t => {
  const f=await fixture(t);await mkdir(path.dirname(keeperFiles(keeperConfig(f.config)).ledger),{recursive:true,mode:0o700});
  await writeFile(keeperFiles(keeperConfig(f.config)).ledger,JSON.stringify({pid:process.pid,startedAt:Date.now()-60000,url:f.config.url}),{flag:'wx'});f.ownsLedger=true;
  const keeper=await createOfficeKeeper(f.config);t.after(()=>keeper.stop());await keeper.tick();assert.equal(keeper.status(),'starting-or-unconfirmed');
});

test('two keepers cold-start one strict-port child, back off after exit and reuse it after keeper restart', { skip: process.platform!=='darwin' }, async t => {
  const f=await fixture(t);await installFake(f);launch(f);launch(f);
  await waitFor(async()=> (await starts(f)).length===1);
  const first=(await starts(f))[0];assert.ok(first.args.includes('--strictPort'));assert.equal(first.args[first.args.indexOf('--host')+1],'127.0.0.1');
  await sleep(300);assert.equal((await starts(f)).length,1);
  process.kill(first.pid,'SIGTERM');await sleep(150);assert.equal((await starts(f)).length,1,'restart is rate-limited');
  await waitFor(async()=> (await starts(f)).length===2);
  for(const child of f.processes){try{process.kill(-child.pid,'SIGTERM');}catch{}}
  await sleep(180);launch(f);await sleep(350);assert.equal((await starts(f)).length,2,'existing detached child is reused');
});

test('keeper restart with a different state directory during cold initialization does not launch a second child', { skip: process.platform!=='darwin' }, async t => {
  const f=await fixture(t);await installFake(f,1200);const owner=launch(f);
  await waitFor(async()=> (await starts(f)).length===1);process.kill(-owner.pid,'SIGKILL');await sleep(150);
  f.config.stateDir=path.join(f.root,'replacement-state');await writeFile(f.configFile,JSON.stringify(f.config));launch(f);
  await sleep(1700);assert.equal((await starts(f)).length,1);
});

test('service config rejects remote destinations and nonabsolute paths',()=>{
  const config={url:'http://127.0.0.1:5173/',projectPath:'/project',nodePath:'/node',stateDir:'/state'};
  assert.equal(keeperConfig(config).port,5173);
  for(const url of ['https://127.0.0.1:5173/','http://example.com/','http://user:password@127.0.0.1:5173/','http://127.0.0.1:5173/path'])assert.throws(()=>keeperConfig({...config,url}));
  assert.throws(()=>keeperConfig({...config,stateDir:'relative'}));
  for(const value of [Infinity,NaN,-1,'10000'])assert.throws(()=>keeperConfig({...config,pollMs:value}));
});
