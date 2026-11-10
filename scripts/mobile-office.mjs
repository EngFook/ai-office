import { networkInterfaces, homedir } from 'node:os';
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { createMobileGateway } from '../server/mobile-gateway.mjs';

const privateIPv4 = value => /^10\./.test(value) || /^192\.168\./.test(value) || /^172\.(?:1[6-9]|2\d|3[01])\./.test(value);
const lanAddress = () => Object.entries(networkInterfaces()).filter(([name]) => !/^(?:utun|tun|tailscale|bridge|vmnet)/.test(name)).flatMap(([, items]) => items).find(item => item.family === 'IPv4' && !item.internal && privateIPv4(item.address))?.address;
const host = lanAddress();
if (!host) { console.error('AI Office mobile: waiting for a private Wi-Fi/LAN address.'); process.exit(1); }
const home = path.join(homedir(), '.ai-office');
mkdirSync(home, { recursive: true, mode: 0o700 });
const configPath = path.join(home, 'mobile-access.json');
let config;
try { config = JSON.parse(readFileSync(configPath, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; config = { accessKey: randomBytes(24).toString('base64url') }; }
if (typeof config.accessKey !== 'string' || config.accessKey.length < 24) throw new Error('Invalid mobile access configuration.');
const port = 5174;
writeFileSync(configPath, JSON.stringify({ ...config, host, port }, null, 2) + '\n', { mode: 0o600 }); chmodSync(configPath, 0o600);
const gateway = createMobileGateway({ host, port, accessKey: config.accessKey, distDir: path.resolve(import.meta.dirname, '..', 'dist') });
gateway.listen(port, host, () => console.log(`AI Office mobile ready: http://${host}:${port}/ (authentication required)`));
gateway.on('error', error => { console.error('Mobile gateway could not listen:', error.code); process.exit(1); });
const monitor = setInterval(() => { if (lanAddress() !== host) process.exit(0); }, 30000);
function stop() { clearInterval(monitor); gateway.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); }
process.on('SIGTERM', stop); process.on('SIGINT', stop);
