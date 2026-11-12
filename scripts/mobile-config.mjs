import { readFileSync, statSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import path from 'node:path';

export const privateIPv4 = value => /^(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/.test(value) && value.split('.').every(part => Number(part) <= 255);
export function lanAddresses(interfaces = networkInterfaces()) {
  return Object.entries(interfaces).filter(([name]) => !/^(?:utun|tun|tailscale|bridge|vmnet)/.test(name)).flatMap(([, items]) => items || []).filter(item => item.family === 'IPv4' && !item.internal && privateIPv4(item.address)).map(item => item.address);
}

// Validate before saving pairing state or announcing that the gateway is ready.
export function mobileStartOptions({ env = process.env, distDir }) {
  const port = Number(env.AI_OFFICE_MOBILE_PORT || 5174);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('手机端口无效 / Invalid mobile port (1024–65535).');
  let upstream;
  try { upstream = new URL(env.AI_OFFICE_URL || 'http://127.0.0.1:5173'); } catch { throw new Error('AI_OFFICE_URL 必须是本机办公室地址 / Use a loopback HTTP office URL.'); }
  if (upstream.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(upstream.hostname) || upstream.username || upstream.password || upstream.search || upstream.hash || upstream.pathname !== '/') throw new Error('AI_OFFICE_URL 必须是本机办公室地址 / Use a loopback HTTP office URL.');
  try { if (!statSync(path.join(distDir, 'index.html')).isFile()) throw new Error(); }
  catch { throw new Error('手机页面尚未构建，请先运行 npm run build / Build the mobile pages first: npm run build.'); }
  return { port, upstream };
}

export function mobileLink({ configPath, interfaces = networkInterfaces(), addressOnly = false }) {
  let config;
  try { config = JSON.parse(readFileSync(configPath, 'utf8')); }
  catch { throw new Error('手机入口尚未设置或配置无法读取。先运行 npm run build，再运行 npm run mobile / Start the mobile gateway first.'); }
  if (!privateIPv4(config?.host) || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 || typeof config.accessKey !== 'string' || config.accessKey.length < 24) throw new Error('手机配对配置无效，请重新启动手机入口 / Invalid mobile pairing configuration; restart the gateway.');
  if (!lanAddresses(interfaces).includes(config.host)) throw new Error('电脑的 Wi-Fi 地址已经改变或离线，请重新启动 npm run mobile 后再取链接 / LAN address changed or offline; restart the mobile gateway.');
  const address = `http://${config.host}:${config.port}/`;
  return addressOnly ? address : `${address}#key=${encodeURIComponent(config.accessKey)}`;
}
