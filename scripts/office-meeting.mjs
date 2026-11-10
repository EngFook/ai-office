#!/usr/bin/env node
// Start/end the visual meeting: node scripts/office-meeting.mjs start "topic" claude,codex,gemini,grok | end
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
const file = path.join(import.meta.dirname, '..', 'reports', 'meetings', 'live.json');
mkdirSync(path.dirname(file), { recursive: true });
const [cmd, topic = '', list = 'claude,codex,gemini,grok'] = process.argv.slice(2);
if (cmd === 'start') writeFileSync(file, JSON.stringify({ active: true, topic, attendees: list.split(','), startedAt: Date.now() }));
else if (cmd === 'end') writeFileSync(file, JSON.stringify({ active: false, attendees: [], endedAt: Date.now() }));
else { console.error('usage: start "topic" [providers] | end'); process.exit(1); }
console.log(cmd, 'ok');
