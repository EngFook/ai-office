// Explicit user utility: never print pairing credentials in daemon logs.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
const config = JSON.parse(readFileSync(path.join(homedir(), '.ai-office/mobile-access.json'), 'utf8'));
console.log(`http://${config.host}:${config.port}/#key=${encodeURIComponent(config.accessKey)}`);
