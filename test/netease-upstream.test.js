'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { upstreams, neteaseJson } = require('../lib/netease-upstream');
const env = { NETEASE_API_URL: 'http://127.0.0.1:3001/', NETEASE_API_FALLBACK_URLS: 'https://backup.example/,http://127.0.0.1:3001' };

test('ordered upstream list removes duplicates and requires an explicitly configured primary', () => {
  assert.deepEqual(upstreams(env), ['http://127.0.0.1:3001', 'https://backup.example']);
  assert.throws(() => upstreams({}), error => error.statusCode === 503 && /NETEASE_API_URL/.test(error.message));
});

test('healthy primary response makes no backup request', async () => {
  const calls = [];
  const data = await neteaseJson('/song/detail?ids=1', env, async (url, options) => {
    calls.push(url); assert(options.signal); assert.equal(options.redirect, 'error');
    return { ok: true, json: async () => ({ code: 200, songs: [{ id: 1 }] }) };
  });
  assert.equal(data.songs[0].id, 1);
  assert.deepEqual(calls, ['http://127.0.0.1:3001/song/detail?ids=1']);
});

for (const problem of ['network', 'http', 'json', 'code'])
  test(problem + ' failure uses backup, and next request tries primary again', async () => {
    const calls = [];
    let requests = 0;
    const fetch = async url => {
      calls.push(url);
      if (requests++ === 0) {
        if (problem === 'network') throw Error('offline');
        if (problem === 'http') return { ok: false };
        if (problem === 'json') return { ok: true, json: async () => { throw Error('invalid'); } };
        return { ok: true, json: async () => ({ code: 503 }) };
      }
      return { ok: true, json: async () => ({ code: 200 }) };
    };
    await neteaseJson('/lyric/new?id=1', env, fetch);
    await neteaseJson('/lyric/new?id=1', env, fetch);
    assert.deepEqual(calls, ['http://127.0.0.1:3001/lyric/new?id=1', 'https://backup.example/lyric/new?id=1', 'http://127.0.0.1:3001/lyric/new?id=1']);
  });

test('exhausted upstreams fail with 502 and do not loop', async () => {
  let calls = 0;
  await assert.rejects(neteaseJson('/lyric?id=1', env, async () => { calls++; throw Error('private failure'); }),
    error => error.statusCode === 502 && error.message === 'NetEase API unavailable');
  assert.equal(calls, 2);
});
