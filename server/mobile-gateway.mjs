import http from 'node:http';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const equal = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json' };
const LOGIN = `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI Office 手機入口</title><style>body{font:16px system-ui;background:#f5f3ff;color:#28213d;margin:0;display:grid;min-height:100dvh;place-items:center}main{box-sizing:border-box;width:min(92vw,420px);background:white;border-radius:22px;padding:28px;box-shadow:0 16px 60px #31235518}h1{font-size:26px}input,button{box-sizing:border-box;width:100%;padding:14px;margin-top:12px;border:1px solid #d7d2e3;border-radius:10px;font:inherit}button{background:#6650bd;color:white;cursor:pointer}p{line-height:1.6;color:#6b647c}#error{color:#a43246}</style><main><h1>AI Office</h1><p>手機與 Mac 連接同一個 Wi-Fi。輸入存取碼，或使用 Mac 提供的完整手機連結。</p><form><label for="key">存取碼</label><input id="key" type="password" autocomplete="current-password" required><button>進入辦公室</button></form><p id="error" role="alert"></p></main><script>
const form=document.querySelector('form'),key=document.querySelector('#key'),error=document.querySelector('#error');
async function enter(){form.querySelector('button').disabled=true;error.textContent='';try{const response=await fetch('/mobile/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:key.value})});if(!response.ok)throw Error(response.status===429?'嘗試次數過多，請稍後重試。':'存取碼不正確，請使用最新手機連結。');location.replace('/');}catch(e){error.textContent=e.message;form.querySelector('button').disabled=false}}
form.onsubmit=e=>{e.preventDefault();enter()};const fragment=new URLSearchParams(location.hash.slice(1));if(fragment.has('key')){key.value=fragment.get('key');history.replaceState(null,'','/');enter()}
</script></html>`;

// The phone acts as the user, never as a worker, relay bot or credential manager.
export function mobileRouteAllowed(method, pathname) {
  if (['GET', 'HEAD'].includes(method)) return ['/api/office/board', '/api/office/human-requests', '/api/office/work-reports', '/api/grok/status', '/api/claude/status', '/api/codex/status', '/api/usage'].includes(pathname);
  if (method === 'PATCH') return pathname === '/api/office/settings' || /^\/api\/office\/tasks\/[^/]+$/.test(pathname);
  if (method !== 'POST') return false;
  return ['/api/office/tasks', '/api/office/tasks/card-actions', '/api/office/instructions'].includes(pathname)
    || /^\/api\/office\/human-requests\/[^/]+\/(?:respond|rerequest)$/.test(pathname)
    || /^\/api\/office\/instructions\/[^/]+\/retry$/.test(pathname);
}

export function createMobileGateway({ host, port = 5174, accessKey, distDir, upstreamPort = 5173, localName = 'Mac-Studio.local', now = Date.now }) {
  if (!host || typeof accessKey !== 'string' || accessKey.length < 24) throw new Error('A bind address and a strong access key are required.');
  const sessions = new Map(), attempts = new Map();
  const sessionTTL = 7 * 86400000;
  const allowedHosts = new Set([`${host}:${port}`, `${localName.toLowerCase()}:${port}`]);
  const server = http.createServer(async (request, response) => {
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Cache-Control', 'no-store');
    const send = (status, value, type = 'application/json; charset=utf-8') => { response.writeHead(status, { 'Content-Type': type }); response.end(type.startsWith('application/json') ? JSON.stringify(value) : value); };
    try {
      const authority = (request.headers.host || '').toLowerCase();
      if (!allowedHosts.has(authority)) return send(403, { error: 'Unknown mobile host.' });
      const origin = `http://${authority}`;
      if (request.headers.origin && request.headers.origin !== origin) return send(403, { error: 'Cross-origin access denied.' });
      if (request.headers['sec-fetch-site'] === 'cross-site' && !['GET', 'HEAD'].includes(request.method)) return send(403, { error: 'Cross-site mutation denied.' });
      if (!request.url?.startsWith('/') || request.url.startsWith('//')) return send(400, { error: 'Invalid URL.' });
      const url = new URL(request.url, origin);
      if (url.pathname === '/mobile/login' && request.method === 'POST') {
        if (request.headers.origin !== origin || !/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) return send(403, { error: 'Same-origin JSON login required.' });
        const address = request.socket.remoteAddress;
        for (const [key, value] of attempts) if (value.until < now()) attempts.delete(key);
        const attempt = attempts.get(address) || { count: 0, until: now() + 60000 };
        if (attempt.count >= 10 || attempts.size > 1000) return send(429, { error: 'Try again later.' });
        attempt.count++; attempts.set(address, attempt);
        let size = 0, body = '';
        for await (const chunk of request) { size += chunk.length; if (size > 2048) return send(413, { error: 'Login too large.' }); body += chunk; }
        let input; try { input = JSON.parse(body); } catch { return send(400, { error: 'Invalid JSON.' }); }
        if (!equal(input?.key, accessKey)) return send(401, { error: 'Invalid access key.' });
        attempts.delete(address);
        for (const [id, expires] of sessions) if (expires < now()) sessions.delete(id);
        if (sessions.size >= 50) sessions.delete(sessions.keys().next().value);
        const id = randomBytes(32).toString('base64url'); sessions.set(id, now() + sessionTTL);
        response.setHeader('Set-Cookie', `office_mobile=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionTTL / 1000}`);
        return send(200, { connected: true });
      }
      const cookie = /(?:^|;\s*)office_mobile=([^;]+)/.exec(request.headers.cookie || '')?.[1];
      if (!cookie || !(sessions.get(cookie) > now())) {
        if (url.pathname === '/' && ['GET', 'HEAD'].includes(request.method)) return send(200, request.method === 'HEAD' ? '' : LOGIN, 'text/html; charset=utf-8');
        return send(401, { error: '請先從手機入口登入辦公室。' });
      }
      if (url.pathname.startsWith('/api/')) {
        if (!mobileRouteAllowed(request.method, url.pathname)) return send(404, { error: '此接口僅供 Mac 本機使用。' });
        if (!['GET', 'HEAD', 'POST', 'PATCH'].includes(request.method)) return send(405, { error: 'Method not allowed.' });
        if (!['GET', 'HEAD'].includes(request.method) && request.headers.origin !== origin) return send(403, { error: 'Same-origin mutation required.' });
        // Keep the upstream loopback-only. Rewrite only after authenticated origin checks;
        // the office's own CSRF token is still required for every write.
        const headers = { host: `127.0.0.1:${upstreamPort}`, origin: `http://127.0.0.1:${upstreamPort}`, 'sec-fetch-site': 'same-origin' };
        for (const name of ['content-type', 'content-length', 'accept', 'x-office-token']) if (request.headers[name]) headers[name] = request.headers[name];
        const upstream = http.request({ host: '127.0.0.1', port: upstreamPort, path: url.pathname + url.search, method: request.method, headers, timeout: 45000 }, incoming => {
          response.writeHead(incoming.statusCode, { 'Content-Type': incoming.headers['content-type'] || 'application/json' }); incoming.pipe(response);
        });
        upstream.on('timeout', () => upstream.destroy());
        upstream.on('error', () => { if (!response.headersSent) send(502, { error: 'Mac 上的辦公室服務暫時未回應，請稍後重試。' }); else response.destroy(); });
        request.on('aborted', () => upstream.destroy());
        response.on('close', () => { if (!response.writableFinished) upstream.destroy(); });
        request.pipe(upstream); return;
      }
      if (!['GET', 'HEAD'].includes(request.method)) return send(405, { error: 'Method not allowed.' });
      const root = await realpath(distDir);
      const filename = path.resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
      if (!filename.startsWith(root + path.sep)) return send(404, { error: 'Not found.' });
      let resolved, info;
      try { resolved = await realpath(filename); info = await stat(resolved); } catch { return send(404, { error: 'Not found.' }); }
      if (!resolved.startsWith(root + path.sep) || !info.isFile()) return send(404, { error: 'Not found.' });
      response.writeHead(200, { 'Content-Type': MIME[path.extname(resolved)] || 'application/octet-stream', 'Content-Length': info.size });
      if (request.method === 'HEAD') return response.end();
      const stream = createReadStream(resolved); stream.on('error', () => response.destroy()); stream.pipe(response);
    } catch { if (!response.headersSent) send(500, { error: '手機入口暫時不可用。' }); else response.destroy(); }
  });
  server.once('listening', () => {
    const actualPort = server.address().port;
    allowedHosts.clear(); allowedHosts.add(`${host}:${actualPort}`); allowedHosts.add(`${localName.toLowerCase()}:${actualPort}`);
  });
  server.requestTimeout = 50000;
  server.headersTimeout = 15000;
  return server;
}
