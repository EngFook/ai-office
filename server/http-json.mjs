import { gzip } from 'node:zlib';
import { promisify } from 'node:util';

const compress = promisify(gzip);
const MIN_COMPRESS_BYTES = 2048;

// Negotiate explicitly: an omitted header or gzip;q=0 must remain unencoded.
export function acceptsGzip(header) {
  if (typeof header !== 'string' || !header.trim()) return false;
  const qualities = new Map();
  for (const item of header.toLowerCase().split(',')) {
    const [name, ...parameters] = item.trim().split(';').map(value => value.trim());
    const quality = parameters.find(value => /^q\s*=/.test(value));
    const value = quality === undefined ? 1 : Number(quality.replace(/^q\s*=\s*/, ''));
    qualities.set(name, Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0);
  }
  const gzipQuality = qualities.get('gzip') ?? qualities.get('*') ?? 0;
  const identityQuality = qualities.get('identity') ?? (qualities.get('*') === 0 ? 0 : 1);
  return gzipQuality > 0 && gzipQuality >= identityQuality;
}

// Keep the entire snapshot, including task history and approval/version data.
// Compression runs off the event loop and does not cache live state.
export function sendJson(request, response, value, status = 200) {
  if (response.destroyed || response.writableEnded) return;
  const body = Buffer.from(JSON.stringify(value));
  const vary = String(response.getHeader?.('Vary') || '').split(',').map(value => value.trim()).filter(Boolean);
  if (!vary.some(value => value === '*' || value.toLowerCase() === 'accept-encoding')) vary.push('Accept-Encoding');
  response.setHeader('Vary', vary.join(', '));
  const finish = (contents, encoded = false) => {
    if (response.destroyed || response.writableEnded) return;
    response.statusCode = status;
    if (encoded) response.setHeader('Content-Encoding', 'gzip');
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Content-Length', contents.length);
    response.end(contents);
  };
  if (request.method === 'GET' && status === 200 && body.length >= MIN_COMPRESS_BYTES && acceptsGzip(request.headers?.['accept-encoding'])) {
    return compress(body, { level: 4 }).then(encoded => encoded.length < body.length ? finish(encoded, true) : finish(body), () => finish(body));
  }
  return finish(body);
}
