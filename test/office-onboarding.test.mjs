import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {diagnoseOffice,findExecutable} from '../scripts/doctor-office.mjs';
import {startOptions} from '../scripts/start-office.mjs';

function fixture(t){const root=mkdtempSync(path.join(tmpdir(),'office-first-run-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return {root,home:root,cwd:root,env:{},nodeVersion:'24.0.0'};}
test('fresh diagnosis explains setup and missing dependencies without creating state',t=>{
  const options=fixture(t);const before=readdirSync(options.root);
  const result=diagnoseOffice(options);
  assert.equal(result.ok,false);
  assert.ok(result.checks.some(c=>c.id==='configuration'&&c.next==='npm run setup'));
  assert.ok(result.checks.some(c=>c.id==='dependencies'&&c.next==='npm ci'));
  assert.deepEqual(readdirSync(options.root),before);
});
test('diagnosis distinguishes disabled reviewers, missing executables and unverified login',t=>{
  const options=fixture(t);mkdirSync(path.join(options.root,'.ai-office'));
  writeFileSync(path.join(options.root,'.ai-office/config.json'),JSON.stringify({mode:'enabled',providers:{claude:{enabled:true},codex:{enabled:false}}}));
  const result=diagnoseOffice({...options,executable:()=>false});
  assert.ok(result.checks.some(c=>c.id==='provider:claude'&&c.status==='error'));
  assert.ok(result.checks.some(c=>c.id==='reviewer:claude'&&c.status==='action'));
  const found=diagnoseOffice({...options,executable:()=>true});
  assert.match(found.checks.find(c=>c.id==='provider:claude').message,/login is not verified/);
});
test('diagnostic does not echo malformed configuration or run shell commands',t=>{
  const options=fixture(t);mkdirSync(path.join(options.root,'.ai-office'));
  writeFileSync(path.join(options.root,'.ai-office/config.json'),'PRIVATE_TOKEN invalid JSON');
  assert.equal(JSON.stringify(diagnoseOffice(options)).includes('PRIVATE_TOKEN'),false);
  assert.equal(findExecutable('missing; echo unsafe',options),false);
});
test('launcher rejects invalid ports and extra options before starting anything',()=>{
  assert.deepEqual(startOptions([]),{port:5173,open:true});
  assert.deepEqual(startOptions(['--no-open','--port','5189']),{port:5189,open:false});
  for(const args of [['--port','0'],['--port','65536'],['--port','bad'],['--host','0.0.0.0']])assert.throws(()=>startOptions(args));
});
