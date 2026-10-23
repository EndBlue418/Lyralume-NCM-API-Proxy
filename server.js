'use strict';
const http = require('node:http');
const { createHandler, createStore } = require('./lib/udon-gateway');

async function createApp({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  let redis;
  let store;
  if (env.REDIS_URL) {
    const { createClient } = require('redis');
    redis = createClient({ url: env.REDIS_URL, socket: { connectTimeout: 10000, reconnectStrategy: false } });
    redis.on('error', () => console.error('Redis connection error'));
    await redis.connect();
    store = createStore(command => redis.sendCommand(command.map(String)), env);
  }
  const handlers = new Map([
    ['/api/udon', createHandler({ env, fetchImpl, store })],
    ['/api/cover', require('./lib/album-art').createCoverHandler({ env, fetchImpl })],
    ['/api/proxy', require('./api/proxy')],
    ['/api/source', require('./api/source')]
  ]);
  let active = 0;
  const server = http.createServer(async (req, res) => {
    res.status = code => { res.statusCode = code; return res; };
    res.json = value => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(value)); return res; };
    res.send = value => { res.end(value); return res; };
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (!['GET', 'HEAD'].includes(req.method)) return res.status(405).json({ error: 'Use GET or HEAD' });
    let url;
    try { url = new URL(req.url, 'http://localhost'); }
    catch { return res.status(400).json({ error: 'Invalid URL' }); }
    if (url.pathname === '/healthz') {
      const ok = !redis || redis.isReady;
      return res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'unavailable', storage: redis ? 'local-redis' : 'upstash' });
    }
    const handler = handlers.get(url.pathname);
    if (!handler) return res.status(404).json({ error: 'Not found' });
    if (req.method === 'HEAD' && url.pathname !== '/api/cover') return res.status(405).end();
    if (active >= 4) { res.setHeader('Retry-After', '5'); return res.status(503).json({ error: 'Busy; retry later' }); }
    req.query = Object.create(null);
    for (const [key, value] of url.searchParams) {
      if (Object.hasOwn(req.query, key)) return res.status(400).json({ error: 'Duplicate query parameter' });
      req.query[key] = value;
    }
    active++;
    try { await handler(req, res); }
    catch { if (!res.headersSent && !res.destroyed) res.status(502).json({ error: 'Request failed' }); else res.destroy(); }
    finally { active--; }
  });
  server.headersTimeout = 15000;
  server.requestTimeout = 15000;
  server.setTimeout(90000, socket => socket.destroy());
  server.on('close', () => { if (redis?.isOpen) redis.destroy(); });
  return server;
}

if (require.main === module) {
  createApp().then(server => {
    server.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', () => console.log('NetEase Proxy listening'));
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(1), 10000).unref();
    });
  }).catch(() => { console.error('NetEase Proxy startup failed'); process.exitCode = 1; });
}
module.exports = { createApp };
