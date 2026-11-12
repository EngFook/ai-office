import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { packageOffice, releasePathAllowed, releaseContentIssue } from '../scripts/package-office.mjs';

function fixture() {
  const temp=mkdtempSync(path.join(tmpdir(),'office-package-'));
  const root=path.join(temp,'repo');mkdirSync(root);
  const write=(name,body)=>{mkdirSync(path.dirname(path.join(root,name)),{recursive:true});writeFileSync(path.join(root,name),body);};
  for (const name of ['package.json','package-lock.json','index.html','vite.config.js']) write(name,'{}');
  execFileSync('git',['init','-q'],{cwd:root});
  return {temp,root,write,track:()=>execFileSync('git',['add','--all'],{cwd:root}),output:path.join(temp,'release')};
}

test('release copies only tracked source and attribution, retaining hashes but no private history/state',()=>{
  const f=fixture();
  try {
    f.write('src/app.js','export const version=1;');
    f.write('assets/example/License.txt','Synthetic asset attribution');
    f.write('.gitignore','node_modules/\ndist/\n');
    f.write('CHANGELOG.md','# Changes\nSynthetic release note');
    for(const name of ['reports/private.md','.env','AGENTS.md','src/backups/old.js','src/state.sqlite','server/private/session.json','src/.codex/config.json','src/config.local.json','test/session-records.json','src/old.js.bak-1','test/old.jsonl']) f.write(name,'private');
    f.track();f.write('src/untracked.js','never share');
    const result=packageOffice(f);
    assert.equal(result.count,8);
    assert.equal(existsSync(path.join(f.output,'.git')),false);
    assert.equal(existsSync(path.join(f.output,'src/untracked.js')),false);
    for(const name of ['reports','.env','AGENTS.md','src/backups','src/state.sqlite','server/private','src/.codex','src/config.local.json','test/session-records.json','src/old.js.bak-1','test/old.jsonl']) assert.equal(existsSync(path.join(f.output,name)),false,name);
    assert.equal(readFileSync(path.join(f.output,'.gitignore'),'utf8'),'node_modules/\ndist/\n');
    assert.match(readFileSync(path.join(f.output,'CHANGELOG.md'),'utf8'),/Synthetic release note/);
    const manifest=JSON.parse(readFileSync(path.join(f.output,'SOURCE-MANIFEST.json'),'utf8'));
    assert.match(manifest.provenance,/uncommitted/);
    assert.equal(manifest.files.find(file=>file.path==='src/app.js').sha256,createHash('sha256').update('export const version=1;').digest('hex'));
    assert.throws(()=>packageOffice(f),/already exists/);
  } finally {rmSync(f.temp,{recursive:true,force:true});}
});

test('privacy rejection never copies source or includes secret value in errors',()=>{
  const f=fixture();
  try {
    const secret=['crsr','_','a'.repeat(32)].join('');f.write('src/config.js',`const token='${secret}'`);f.track();
    assert.throws(()=>packageOffice(f),error=>error.message.includes('credential-like')&&!error.message.includes(secret));
    assert.equal(existsSync(f.output),false);
    assert.equal(releaseContentIssue(['/Users','person42','work'].join('/')),'absolute personal home path');
    assert.equal(releaseContentIssue(['person42','gmail.com'].join('@')),'personal email address');
    assert.equal(releaseContentIssue("const exampleName = 'sample-user'"),null);
    assert.equal(releaseContentIssue(['/home','person42','project'].join('/')),'absolute personal home path');
    assert.equal(releaseContentIssue('const url="http://127.0.0.1:11434"'),null);
  } finally {rmSync(f.temp,{recursive:true,force:true});}
});

test('linked files and traversal are rejected',()=>{
  assert.equal(releasePathAllowed('src/../private.txt'),false);
  assert.equal(releasePathAllowed('/src/example.js'),false);
  assert.equal(releasePathAllowed('src\\private.txt'),false);
  const f=fixture();
  try {
    f.write('src/app.js','safe');symlinkSync('../package.json',path.join(f.root,'src/link.json'));f.track();
    assert.throws(()=>packageOffice(f),/linked source rejected/);
    assert.equal(existsSync(f.output),false);
  } finally {rmSync(f.temp,{recursive:true,force:true});}
});


test('public feature documents are explicitly included without operational evidence or a docs glob',()=>{
  const f=fixture();
  const documents=['docs/grok-blocked-patrol-routine.txt','docs/grok-blocked-patrol.md','docs/walkalone-story-studio.md'];
  const excluded=['docs/office-coordination-20261112.md','docs/private-evidence.md','reports/review.md','AGENTS.md'];
  try {
    for(const name of documents) f.write(name,`Public instructions for ${name}`);
    for(const name of excluded) f.write(name,'Local operational evidence');
    f.track();
    const result=packageOffice(f);
    assert.equal(result.count,7);
    const manifest=JSON.parse(readFileSync(path.join(f.output,'SOURCE-MANIFEST.json'),'utf8'));
    for(const name of documents) {
      assert.equal(releasePathAllowed(name),true);
      assert.equal(readFileSync(path.join(f.output,name),'utf8'),`Public instructions for ${name}`);
      assert.ok(manifest.files.some(file=>file.path===name));
    }
    for(const name of excluded) {
      assert.equal(releasePathAllowed(name),false);
      assert.equal(existsSync(path.join(f.output,name)),false);
    }
  } finally {rmSync(f.temp,{recursive:true,force:true});}
});

test('newly allowed documentation retains the same content privacy gate',()=>{
  const f=fixture();
  try {
    const secret=['crsr','_','b'.repeat(32)].join('');
    f.write('docs/grok-blocked-patrol.md',`Authorization: Bearer ${secret}`);f.track();
    assert.throws(()=>packageOffice(f),error=>error.message.includes('credential-like')&&error.message.includes('docs/grok-blocked-patrol.md')&&!error.message.includes(secret));
    assert.equal(existsSync(f.output),false);
  } finally {rmSync(f.temp,{recursive:true,force:true});}
});
