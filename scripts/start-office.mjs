#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOfficeConfig } from '../server/office-config.mjs';

export function startOptions(args = []) {
  let port = 5173, open = true;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--no-open') open = false;
    else if (args[i] === '--port' && /^\d+$/.test(args[i + 1] || '')) port = Number(args[++i]);
    else throw new Error('用法 / Usage: npm start -- [--no-open] [--port 5173]');
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口范围 / Port range: 1024–65535');
  return { port, open };
}

export async function startOffice(args = process.argv.slice(2)) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('需要 Node.js 24+ / Node.js 24+ required. Install it, then run npm ci.');
  const options = startOptions(args);
  const root = path.resolve(import.meta.dirname, '..');
  const configuration = loadOfficeConfig({ cwd: root });
  let createServer;
  try { ({ createServer } = await import('vite')); }
  catch { throw new Error('依赖尚未安装，请先运行 npm ci / Run npm ci first.'); }
  const server = await createServer({ root, server: { host: '127.0.0.1', port: options.port, strictPort: true, open: false } });
  try { await server.listen(); }
  catch (error) {
    await server.close();
    if (error.code === 'EADDRINUSE' || /already in use/.test(error.message)) throw new Error(`端口 ${options.port} 已被占用 / Port in use. 停止旧办公室，或用独立数据目录及 npm start -- --port 5174。不要对同一数据目录同时启动两个办公室。`);
    throw error;
  }
  console.log(`\nAI Office: http://127.0.0.1:${options.port}/\n模式 / Mode: ${configuration.mode}`);
  console.log(configuration.configured ? '配置修改后请重启 / Restart after changing setup.' : '首次使用：可先浏览办公室，然后 npm run setup 连接自己的 AI。\nFirst visit: explore the office, then run npm run setup to connect your AI.');
  console.log('保持此窗口运行；Ctrl+C 停止 / Keep this terminal open; Ctrl+C to stop.\n遇到问题 / Troubleshooting: npm run doctor');
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await server.close(); process.exitCode = 0; };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  server.httpServer?.once('close', () => { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); });
  if (options.open) server.openBrowser();
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startOffice().catch(error => { console.error(error.message); process.exitCode = 1; });
}
