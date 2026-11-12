import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mobileStartOptions, mobileLink, lanAddresses } from '../scripts/mobile-config.mjs';

const interfaces = { en0: [{ family: 'IPv4', internal: false, address: '192.168.1.4' }], utun0: [{ family: 'IPv4', internal: false, address: '10.0.0.2' }] };
const fixture = t => { const dir = mkdtempSync(path.join(tmpdir(), 'office-mobile-config-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
test('mobile start checks build, port and loopback upstream before announcing readiness', t => {
  const dir = fixture(t);
  assert.throws(() => mobileStartOptions({ env: {}, distDir: dir }), /npm run build/);
  writeFileSync(path.join(dir, 'index.html'), 'fixture');
  const options = mobileStartOptions({ env: { AI_OFFICE_URL: 'http://127.0.0.1:5186' }, distDir: dir });
  assert.equal(options.upstream.port, '5186'); assert.equal(options.port, 5174);
  for (const url of ['https://public.example', 'http://127.0.0.1:5186/path', 'not a URL', 'http://secret@localhost:5173']) assert.throws(() => mobileStartOptions({ env: { AI_OFFICE_URL: url }, distDir: dir }), /loopback/);
  assert.throws(() => mobileStartOptions({ env: { AI_OFFICE_MOBILE_PORT: '0' }, distDir: dir }), /port/);
});
test('mobile link discovers only the saved active LAN endpoint and offers a credential-free address', t => {
  const configPath = path.join(fixture(t), 'mobile-access.json');
  assert.throws(() => mobileLink({ configPath, interfaces }), /Start the mobile gateway/);
  const config = { host: '192.168.1.4', port: 5174, accessKey: 'fixture-only-pairing-secret-32' };
  writeFileSync(configPath, JSON.stringify(config));
  assert.deepEqual(lanAddresses(interfaces), ['192.168.1.4']);
  assert.equal(mobileLink({ configPath, interfaces, addressOnly: true }), 'http://192.168.1.4:5174/');
  assert.equal(mobileLink({ configPath, interfaces }), 'http://192.168.1.4:5174/#key=fixture-only-pairing-secret-32');
  assert.throws(() => mobileLink({ configPath, interfaces: {} }), /LAN address changed/);
  writeFileSync(configPath, JSON.stringify({ ...config, host: '192.168.1.999' }));
  assert.throws(() => mobileLink({ configPath, interfaces }), /Invalid mobile pairing/);
});
