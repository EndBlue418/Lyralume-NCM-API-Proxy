'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createApp } = require('../server');

test('standalone server keeps Vercel routes, handles preflight and rejects invalid requests', async t => {
  const server = await createApp({ env: {} });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  assert.equal((await fetch(base + '/healthz')).status, 200);
  assert.equal((await fetch(base + '/api/udon', { method: 'OPTIONS' })).status, 204);
  assert.equal((await fetch(base + '/api/udon', { method: 'POST' })).status, 405);
  assert.equal((await fetch(base + '/api/proxy')).status, 400);
  assert.equal((await fetch(base + '/api/cover?id=bad')).status, 400);
  assert.equal((await fetch(base + '/api/proxy?url=a&url=b')).status, 400);
  assert.equal((await fetch(base + '/api/udon?op=catalogue')).status, 503);
  assert.equal((await fetch(base + '/.env')).status, 404);
  const source = await (await fetch(base + '/api/source')).json();
  assert.equal(source.license, 'AGPL-3.0');
  assert(source.files['server.js']);
  assert(!source.files['.env']);
});
