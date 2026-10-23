const TEST_UPSTREAM_ENV = { NETEASE_API_URL: 'https://ncm.example.test' };
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHandler } = require('../lib/udon-gateway');
const { encodeSongId, decodeParts, SLOTS } = require('../lib/udon-protocol');

function memoryStore() {
  const slots = [], cache = new Map();
  return {
    allocate: async head => { if (slots.length === SLOTS) return -1; slots.push({ parts: [head] }); return slots.length - 1; },
    append: async (slot, part, value) => {
      const state = slots[slot];
      if (!state) return ['expired'];
      if (state.parts[part] !== undefined) return state.parts[part] === value ? [state.id ? 'loading' : 'building', state.id] : ['conflict'];
      if (state.parts.length !== part) return ['out_of_order'];
      state.parts.push(value);
      if (state.parts.length < 4) return ['building'];
      state.id = decodeParts(state.parts); return ['complete', state.id];
    },
    get: async id => cache.get(id),
    publish: async value => cache.set(value.songId, value),
    catalogue: async () => [...cache.values()]
  };
}

async function request(handler, query, method = 'GET') {
  let data, code; const headers = {};
  await handler({ method, query }, { setHeader: (k,v) => headers[k]=v, status: value => { code=value; return { json: value => { data=value; }, end: () => {} }; } });
  return { data, code, headers };
}

const fakeFetch = async url => ({ ok: true, json: async () => url.includes('/song/detail') ? { songs: [{ name: 'Test', ar: [{ name: 'Singer' }] }] } : { code: 200, yrc: { lyric: '[1000,500](1000,500,0)甲' }, lrc: { lyric: '[00:01]甲' } } });

test('interleaved callers get only their own song; catalogue shares completed data', async () => {
  const handler = createHandler({ env: TEST_UPSTREAM_ENV, store: memoryStore(), fetchImpl: fakeFetch });
  const ids = ['2093235155', '3384000719']; const encoded = ids.map(encodeSongId);
  const slots = [];
  for (const parts of encoded) slots.push((await request(handler, { op: 'begin', value: String(parts[0]) })).data.slot);
  assert.notEqual(slots[0], slots[1]);
  for (let part = 1; part < 4; part++) for (let caller = 1; caller >= 0; caller--) {
    const result = await request(handler, { op: 'part', slot: String(slots[caller]), part: String(part), value: String(encoded[caller][part]) });
    assert.equal(result.code, 200);
    assert.equal(result.headers['Cache-Control'], 'no-store');
    if (part === 3) { assert.equal(result.data.songId, ids[caller]); assert(result.data.yrc); }
  }
  const catalogue = (await request(handler, { op: 'catalogue' })).data;
  assert.deepEqual(catalogue.songs.map(song => song.songId).sort(), ids.sort());
});

test('reordered and conflicting fragments request restart instead of fetching wrong lyrics', async () => {
  const handler = createHandler({ env: TEST_UPSTREAM_ENV, store: memoryStore(), fetchImpl: fakeFetch });
  const slot = (await request(handler, { op: 'begin', value: '2' })).data.slot;
  let result = await request(handler, { op: 'part', slot: String(slot), part: '2', value: '200' });
  assert.equal(result.data.status, 'restart');
  await request(handler, { op: 'part', slot: String(slot), part: '1', value: '93' });
  result = await request(handler, { op: 'part', slot: String(slot), part: '1', value: '94' });
  assert.equal(result.data.reason, 'conflict');
});

test('busy storage, missing configuration, and upstream failures are explicit', async () => {
  const store = memoryStore(); const handler = createHandler({ env: TEST_UPSTREAM_ENV, store, fetchImpl: fakeFetch });
  for (let i = 0; i < SLOTS; i++) await request(handler, { op: 'begin', value: '0' });
  assert.equal((await request(handler, { op: 'begin', value: '1' })).data.status, 'busy');
  assert.equal((await request(createHandler({ env: {} }), { op: 'begin', value: '1' })).code, 503);
  assert.equal((await request(handler, { op: 'part', slot: '-1', part: '1', value: '1' })).code, 400);
  const failing = createHandler({ env: TEST_UPSTREAM_ENV, store: memoryStore(), fetchImpl: async () => { throw new Error('offline'); } });
  const parts = encodeSongId('2093235155'); const slot = (await request(failing, { op: 'begin', value: String(parts[0]) })).data.slot;
  for (let part = 1; part < 3; part++) await request(failing, { op: 'part', slot: String(slot), part: String(part), value: String(parts[part]) });
  assert.equal((await request(failing, { op: 'part', slot: String(slot), part: '3', value: String(parts[3]) })).code, 502);
});

test('metadata failure still displays available LRC; invalid methods do not mutate state', async () => {
  const fetchImpl = async url => { if (url.includes('/song/detail')) throw new Error('missing'); return { ok: true, json: async () => ({ code: 200, lrc: { lyric: '[00:01]甲' } }) }; };
  const handler = createHandler({ env: TEST_UPSTREAM_ENV, store: memoryStore(), fetchImpl });
  const parts = encodeSongId('2093235155'); const slot = (await request(handler, { op: 'begin', value: String(parts[0]) })).data.slot;
  let result;
  for (let part = 1; part < 4; part++) result = await request(handler, { op: 'part', slot: String(slot), part: String(part), value: String(parts[part]) });
  assert.equal(result.data.yrc, ''); assert.equal(result.data.lrc, '[00:01]甲');
  assert.equal((await request(handler, { op: 'begin', value: '1' }, 'POST')).code, 405);
});
