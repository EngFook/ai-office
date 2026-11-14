#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceDirectories = new Set(['src', 'server', 'scripts', 'test', 'public', 'assets']);
const sourceFiles = new Set(['package.json', 'package-lock.json', 'vite.config.js', 'index.html', 'README.md', '.gitignore', 'CHANGELOG.md', 'LICENSE', 'LICENSE.md', 'LICENSE.txt', 'NOTICE', 'docs/INSTALL.zh-CN.md', 'docs/grok-conversation.md', 'docs/grok-blocked-patrol-routine.txt', 'docs/grok-blocked-patrol.md', 'docs/story-studio.md']);
const excludedPart = /^(?:\.git|\.worktrees?|\.env(?:\..*)?|node_modules|dist|reports|backups?|sessions?|credentials?|data|private)$/i;

export function releasePathAllowed(relative) {
  const parts = relative.split('/');
  if (!relative || path.posix.isAbsolute(relative) || relative.includes('\\') || parts.some(part => !part || part === '.' || part === '..' || excludedPart.test(part))) return false;
  if (relative !== '.gitignore' && parts.some(part => part.startsWith('.'))) return false;
  if (/(?:\.bak.*|\.backup(?:[-.].*)?|\.orig|\.sqlite(?:-wal|-shm)?|\.db|\.log|\.jsonl)$/i.test(relative)) return false;
  if (/(?:^|\/)(?:config\.local|[^/]*(?:credentials?|secrets?|sessions?|access-token)[^/]*)\.json$/i.test(relative)) return false;
  return sourceFiles.has(relative) || sourceDirectories.has(parts[0]);
}

// Checks report a category and path only, never matching values. This heuristic
// rejects generic personal home paths, personal email addresses and obvious tokens.
export function releaseContentIssue(contents) {
  const text = Buffer.isBuffer(contents) ? contents.toString('utf8') : String(contents);
  if (/\b[A-Z0-9._%+-]+@(?:gmail|icloud|outlook|hotmail|yahoo)\.[A-Z]{2,}\b/i.test(text)) return 'personal email address';
  if (/\/(?:Users|home)\/(?!me(?:\/|\b)|user(?:\/|\b)|example(?:\/|\b)|test(?:\/|\b)|…)[A-Za-z0-9_.-]+\//.test(text)) return 'absolute personal home path';
  if (/\b(?:crsr_|sk-(?:proj-)?|xai-)[A-Za-z0-9_-]{20,}\b/.test(text) || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) return 'credential-like value';
  if (/Authorization\s*[:=]\s*['"]?Bearer\s+[A-Za-z0-9_-]{24,}/i.test(text)) return 'authorization credential';
  return null;
}

export function packageOffice({ root = path.resolve(import.meta.dirname, '..'), output } = {}) {
  root = realpathSync(root);
  if (!output) throw new Error('Specify a new output directory with --output.');
  output = path.resolve(output);
  if (existsSync(output)) throw new Error('Output already exists; choose a new directory.');
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd:root, encoding:'utf8', maxBuffer:16 * 1024 * 1024 }).split('\0').filter(Boolean);
  const selected = [...new Set(tracked.filter(releasePathAllowed))].sort();
  for (const required of ['package.json', 'package-lock.json', 'index.html', 'vite.config.js']) {
    if (!selected.includes(required)) throw new Error(`Required tracked source file missing: ${required}`);
  }
  const files = [];
  for (const relative of selected) {
    const filename = path.join(root, relative);
    const stat = lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(filename) !== filename) throw new Error(`Non-regular or linked source rejected: ${relative}`);
    const data = readFileSync(filename);
    const issue = releaseContentIssue(data);
    if (issue) throw new Error(`Release privacy check failed (${issue}): ${relative}`);
    files.push({ relative, data, mode:stat.mode & 0o111 ? 0o755 : 0o644 });
  }
  let revision = null;
  try { revision = execFileSync('git', ['rev-parse', 'HEAD'], {cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim(); } catch {}
  mkdirSync(path.dirname(output), { recursive:true });
  const staging = mkdtempSync(path.join(path.dirname(output), '.office-source-'));
  try {
    for (const file of files) {
      const destination = path.join(staging, file.relative);
      mkdirSync(path.dirname(destination), { recursive:true });
      writeFileSync(destination, file.data, { flag:'wx', mode:file.mode });
    }
    const manifest = { formatVersion:1, sourceRevision:revision, createdAt:new Date().toISOString(),
      provenance:'Snapshot of current contents of individually Git-tracked allowlisted files. May contain uncommitted changes. No Git history or local runtime data is included.',
      privacy:'Heuristic checks passed. Review contents and asset licenses before sharing; this is not a licensing grant or a complete privacy guarantee.',
      files:files.map(({relative,data})=>({path:relative,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')})) };
    writeFileSync(path.join(staging, 'SOURCE-MANIFEST.json'), `${JSON.stringify(manifest,null,2)}\n`, {flag:'wx',mode:0o644});
    renameSync(staging, output);
    return { output, count:files.length, sourceRevision:revision };
  } catch (error) { rmSync(staging,{recursive:true,force:true}); throw error; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--output') throw new Error('Usage: npm run package:source -- --output /path/to/new/source-directory');
    const result = packageOffice({output:args[1]});
    console.log(`Source snapshot ready: ${result.output}\nFiles: ${result.count}. Inspect SOURCE-MANIFEST.json before sharing.`);
  } catch(error) { console.error(error.message); process.exitCode=1; }
}
