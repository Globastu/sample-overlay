// Minimal dev server (no dependencies)
// - Serves static files from ./public at http://localhost:3000
// - Optionally proxies demo BFF endpoints to a real backend (if UPSTREAM_BFF_BASE is set)
//     GET  /api/bff/demo/catalog?merchantId=...
//     POST /api/bff/demo/purchase
//
// Env:
// - PORT (default 3000)
// - WIDGET_OVERLAY_KEY (optional). If set, requests must send header x-overlay-key with this value.
// - UPSTREAM_BFF_BASE (optional). If set, proxy /api/bff/* to this base; otherwise returns empty offers and 501 for purchase.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const REQUIRED_KEY = process.env.WIDGET_OVERLAY_KEY || '';
const UPSTREAM_BFF_BASE = process.env.UPSTREAM_BFF_BASE || '';

function sendJson(res, status, body, extraHeaders = {}) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-overlay-key',
    ...extraHeaders,
  };
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'application/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.ico': return 'image/x-icon';
    default: return 'application/octet-stream';
  }
}

function serveStatic(req, res, urlObj) {
  let pathname = decodeURIComponent(urlObj.pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.stat(filePath, (err, stat) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    if (stat.isDirectory()) {
      const idx = path.join(filePath, 'index.html');
      fs.stat(idx, (e2, s2) => {
        if (e2 || !s2.isFile()) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('Not Found');
        }
        streamFile(idx, res);
      });
    } else {
      streamFile(filePath, res);
    }
  });
}

function proxyJson(targetUrl, method, headers, body) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(targetUrl);
      const mod = u.protocol === 'https:' ? https : http;
      const opts = {
        method,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: {
          'content-type': headers['content-type'] || 'application/json',
          'x-overlay-key': headers['x-overlay-key'] || headers['X-Overlay-Key'] || headers['x-Overlay-key'] || undefined,
        },
      };
      const r = mod.request(opts, (up) => {
        let chunks = '';
        up.setEncoding('utf8');
        up.on('data', (d) => { chunks += d; });
        up.on('end', () => {
          try {
            const json = chunks ? JSON.parse(chunks) : {};
            resolve({ status: up.statusCode || 200, json });
          } catch (e) { reject(e); }
        });
      });
      r.on('error', reject);
      if (body) r.write(typeof body === 'string' ? body : JSON.stringify(body));
      r.end();
    } catch (e) { reject(e); }
  });
}

function streamFile(filePath, res) {
  const ct = contentTypeFor(filePath);
  res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'no-cache' });
  fs.createReadStream(filePath).pipe(res);
}

function checkKey(req) {
  if (!REQUIRED_KEY) return true;
  const got = req.headers['x-overlay-key'];
  return got && String(got) === REQUIRED_KEY;
}

function handleCatalog(req, res, urlObj) {
  if (req.method === 'OPTIONS') return handleOptions(req, res);
  if (!checkKey(req)) return sendJson(res, 401, { error: 'UNAUTHORISED' });
  const merchantId = urlObj.searchParams.get('merchantId');
  if (UPSTREAM_BFF_BASE) {
    const target = new URL('/api/bff/demo/catalog', UPSTREAM_BFF_BASE);
    target.searchParams.set('merchantId', merchantId || '');
    return proxyJson(String(target), 'GET', req.headers)
      .then(({ status, json }) => sendJson(res, status, json))
      .catch(() => sendJson(res, 502, { error: 'UPSTREAM_ERROR' }));
  }
  // No upstream configured: return empty catalog so the widget shows no active offers
  return sendJson(res, 200, { merchantId, offers: [] });
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (chunk) => { buf += chunk; if (buf.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(JSON.parse(buf || '{}')); }
      catch { reject(new Error('BAD_JSON')); }
    });
    req.on('error', reject);
  });
}

function handlePurchase(req, res) {
  if (req.method === 'OPTIONS') return handleOptions(req, res);
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  if (!checkKey(req)) return sendJson(res, 401, { error: 'UNAUTHORISED' });
  if (UPSTREAM_BFF_BASE) {
    // pass-through to upstream
    parseJsonBody(req).then((body) => {
      const target = new URL('/api/bff/demo/purchase', UPSTREAM_BFF_BASE);
      return proxyJson(String(target), 'POST', req.headers, body)
        .then(({ status, json }) => sendJson(res, status, json))
        .catch(() => sendJson(res, 502, { error: 'UPSTREAM_ERROR' }));
    }).catch((err) => {
      if (err && err.message === 'BAD_JSON') return sendJson(res, 400, { error: 'BAD_JSON' });
      return sendJson(res, 500, { error: 'SERVER_ERROR' });
    });
    return;
  }
  // No upstream configured: indicate not implemented
  return sendJson(res, 501, { error: 'NO_UPSTREAM' });
}

function handleOptions(req, res) {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-overlay-key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end();
}

// No local order/code generation anymore; real BFF should produce these

const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  if (urlObj.pathname === '/api/bff/demo/catalog') return handleCatalog(req, res, urlObj);
  if (urlObj.pathname === '/api/bff/demo/purchase') return handlePurchase(req, res);
  if (req.method === 'OPTIONS') return handleOptions(req, res);
  return serveStatic(req, res, urlObj);
});

server.listen(PORT, () => {
  console.log(`Dev server running at http://localhost:${PORT}`);
  console.log(`Static root: ${PUBLIC_DIR}`);
});
