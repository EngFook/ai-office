import { loadOfficeConfig } from '../server/office-config.mjs';
import { mkdirSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
if (process.platform !== 'darwin') throw new Error('This installer is for the office Mac.');
const repo = path.resolve(import.meta.dirname, '..');
if (!existsSync(path.join(repo, 'dist/index.html'))) throw new Error('Run npm run build first.');
const configuration = loadOfficeConfig();
const label = 'local.ai-office.mobile', domain = `gui/${process.getuid()}`;
const agents = path.join(homedir(), 'Library/LaunchAgents'), home = configuration.dataDir;
mkdirSync(agents, { recursive: true }); mkdirSync(home, { recursive: true, mode: 0o700 });
const log = path.join(home, 'mobile-gateway.log');
if (!existsSync(log)) writeFileSync(log, '', { mode: 0o600 });
chmodSync(log, 0o600);
const xml = value => String(value).replace(/[<>&"']/g, c => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;', '"':'&quot;', "'":'&apos;' }[c]));
const environment = { AI_OFFICE_CONFIG: configuration.configPath, AI_OFFICE_HOME: configuration.dataDir, AI_OFFICE_URL: process.env.AI_OFFICE_URL || 'http://127.0.0.1:5173', AI_OFFICE_MOBILE_PORT: process.env.AI_OFFICE_MOBILE_PORT || '5174' };
const environmentXml = Object.entries(environment).map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join('');
const plist = path.join(agents, `${label}.plist`);
writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(path.join(repo,'scripts/mobile-office.mjs'))}</string></array>
<key>EnvironmentVariables</key><dict>${environmentXml}</dict>
<key>WorkingDirectory</key><string>${xml(repo)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer>
<key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string></dict></plist>`, { mode: 0o600 });
chmodSync(plist, 0o600);
spawnSync('launchctl', ['bootout', `${domain}/${label}`], { stdio: 'ignore' });
const result = spawnSync('launchctl', ['bootstrap', domain, plist], { stdio: 'inherit' });
if (result.status !== 0) throw new Error('Could not start the mobile gateway LaunchAgent.');
console.log('Mobile gateway startup enabled. Use npm run mobile:link for the private phone link.');
