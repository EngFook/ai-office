import { loadOfficeConfig } from '../server/office-config.mjs';
// Explicit user utility: never print pairing credentials in daemon logs.
import path from 'node:path';
import { mobileLink } from './mobile-config.mjs';
try {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--address-only')) throw new Error('Usage: npm run mobile:link -- [--address-only]');
  console.log(mobileLink({ configPath: path.join(loadOfficeConfig().dataDir, 'mobile-access.json'), addressOnly: args.includes('--address-only') }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
