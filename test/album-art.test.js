const TEST_UPSTREAM_ENV = { NETEASE_API_URL: 'https://ncm.example.test' };
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCoverHandler, imageInfo, normalizeCoverUrl } = require('../lib/album-art');
const { createHandler, fetchLyrics } = require('../lib/udon-gateway');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPVcAAAAASUVORK5CYII=', 'base64');
async function call(handler, query = { id: '186016' }, method = 'GET') {
  const result = { headers: {} };
  const res = { setHeader: (key, value) => { result.headers[key.toLowerCase()] = value; }, status(code) { result.status = code; return this; },
    json(data) { result.json = data; }, send(bytes) { result.bytes = bytes; }, end() { result.ended = true; } };
  await handler({ query, method }, res);
  return result;
}
function transport({ metadataFailure = false, noCover = false, wrongSong = false, imageBytes = png, imageStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/song/detail')) {
      if (metadataFailure) throw new Error('upstream unavailable');
      const id = new URL(url).searchParams.get('ids');
      return { ok: true, json: async () => ({ code: 200, songs: [{ id: wrongSong ? 99 : Number(id), name: 'Song ' + id, ar: [{ name: 'Artist' }],
        al: { name: 'Album', picUrl: noCover ? '' : 'https://p3.music.126.net/album-' + id + '.jpg' } }] }) };
    }
    if (url.includes('/lyric')) return { ok: true, json: async () => ({ code: 200, lrc: { lyric: '[00:01]甲' } }) };
    return new Response(imageBytes, { status: imageStatus, headers: { 'Content-Type': 'image/png' } });
  };
  return { env: TEST_UPSTREAM_ENV, fetchImpl, calls };
}

test('cover returns direct image bytes, headers and bounded dimensions', async () => {
  const mock = transport();
  const result = await call(createCoverHandler(mock));
  assert.equal(result.status, 200); assert.deepEqual(result.bytes, png);
  assert.equal(result.headers['content-type'], 'image/png');
  assert.equal(result.headers['x-cover-song-id'], '186016');
  assert.equal(result.headers['x-cover-width'], '1');
  assert.equal(result.headers.location, undefined);
  assert.match(result.headers['cache-control'], /public/);
  assert.match(mock.calls[1].url, /param=512y512/);
  assert.equal(mock.calls[1].options.redirect, 'error');
});
test('invalid or repeated query values and unsupported sizes do not contact upstream', async () => {
  const mock = transport(), handler = createCoverHandler(mock);
  for (const query of [{ id: '0' }, { id: '01' }, { id: '-1' }, { id: ['1', '2'] }, { id: '1234567890123' }, { id: '1', size: '2048' }, { id: '1', size: '512x512' }]) {
    const result = await call(handler, query); assert.equal(result.status, 400); assert.equal(result.bytes, undefined);
  }
  assert.equal(mock.calls.length, 0);
});
test('OPTIONS, HEAD and unsupported methods preserve binary API semantics', async () => {
  const mock = transport(), handler = createCoverHandler(mock);
  assert.equal((await call(handler, {}, 'OPTIONS')).status, 204);
  assert.equal((await call(handler, {}, 'POST')).status, 405);
  const head = await call(handler, { id: '1' }, 'HEAD');
  assert.equal(head.status, 200); assert.equal(head.bytes, undefined); assert.equal(head.headers['content-length'], String(png.length));
});
test('two players select their own song identities, and same-song requests coalesce', async () => {
  const mock = transport(), handler = createCoverHandler(mock);
  const results = await Promise.all([call(handler, { id: '186016' }), call(handler, { id: '1406633327' }), call(handler, { id: '186016' })]);
  assert.deepEqual(results.map(r => r.headers['x-cover-song-id']), ['186016', '1406633327', '186016']);
  assert.equal(mock.calls.filter(c => c.url.includes('/song/detail')).length, 2);
  assert.equal(mock.calls.filter(c => c.url.includes('music.126.net')).length, 2);
});
test('different sizes stay independent', async () => {
  const mock = transport(), handler = createCoverHandler(mock);
  const results = await Promise.all([call(handler, { id: '186016', size: '256' }), call(handler, { id: '186016', size: '1024' })]);
  assert(results.every(r => r.status === 200));
  assert(mock.calls.some(c => c.url.endsWith('param=256y256')));
  assert(mock.calls.some(c => c.url.endsWith('param=1024y1024')));
});
test('missing cover returns uncached 404; metadata failure remains retryable', async () => {
  const absent = await call(createCoverHandler(transport({ noCover: true })));
  assert.equal(absent.status, 404); assert.equal(absent.headers['cache-control'], 'no-store');
  const failure = await call(createCoverHandler(transport({ metadataFailure: true })));
  assert.equal(failure.status, 502); assert.equal(failure.headers['cache-control'], 'no-store');
});
test('mismatched metadata never downloads another song cover', async () => {
  const mock = transport({ wrongSong: true });
  assert.equal((await call(createCoverHandler(mock))).status, 502);
  assert.equal(mock.calls.length, 1);
});
test('HTML, redirects and oversized image dimensions are rejected', async () => {
  assert.equal((await call(createCoverHandler(transport({ imageBytes: Buffer.from('<html>error</html>') })))).status, 502);
  assert.equal((await call(createCoverHandler(transport({ imageStatus: 302 })))).status, 502);
  const huge = Buffer.from(png); huge.writeUInt32BE(4096, 16);
  assert.equal((await call(createCoverHandler(transport({ imageBytes: huge })))).status, 502);
});
test('body size is bounded even without Content-Length', async () => {
  const result = await call(createCoverHandler(transport({ imageBytes: Buffer.alloc(4 * 1024 * 1024 + 1) })));
  assert.equal(result.status, 502); assert.equal(result.bytes, undefined);
});
test('untrusted URLs are rejected rather than proxied; HTTP NetEase URLs become HTTPS', () => {
  for (const url of ['http://127.0.0.1/a.jpg', 'https://p3.music.126.net.evil.test/a.jpg', 'https://user:pass@p3.music.126.net/a.jpg', 'https://p3.music.126.net:8080/a.jpg', 'file:///etc/passwd']) assert.equal(normalizeCoverUrl(url), '');
  assert.equal(normalizeCoverUrl('http://p3.music.126.net/a.jpg'), 'https://p3.music.126.net/a.jpg?param=512y512');
});
test('cover fields are additive and metadata failure does not break lyrics', async () => {
  const normal = await fetchLyrics('186016', TEST_UPSTREAM_ENV, transport().fetchImpl);
  assert.equal(normal.lrc, '[00:01]甲'); assert.equal(normal.coverPath, '/api/cover?id=186016&size=512');
  assert.equal(normal.albumName, 'Album'); assert.match(normal.coverUrl, /^https:/);
  const fallback = await fetchLyrics('186016', TEST_UPSTREAM_ENV, transport({ metadataFailure: true }).fetchImpl);
  assert.equal(fallback.lrc, '[00:01]甲'); assert.equal(fallback.coverUrl, '');
});
test('old cached catalogue gains a cover path without fetching metadata or losing lyrics', async () => {
  const original = { songId: '186016', name: 'Old', artist: 'Artist', yrc: '', lrc: '[00:01]甲' };
  const store = { catalogue: async () => [original] };
  const result = await call(createHandler({ env: TEST_UPSTREAM_ENV, store, fetchImpl: async () => { throw new Error('Unexpected fetch'); } }), { op: 'catalogue' });
  assert.equal(result.status, 200); assert.equal(result.json.songs[0].lrc, original.lrc);
  assert.equal(result.json.songs[0].coverPath, '/api/cover?id=186016&size=512');
  assert.equal(original.coverPath, undefined);
});
