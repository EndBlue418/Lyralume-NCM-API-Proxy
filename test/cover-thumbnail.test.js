const TEST_UPSTREAM_ENV = { NETEASE_API_URL: 'https://ncm.example.test' };
const test = require('node:test');
const assert = require('node:assert/strict');
const { PNG } = require('pngjs');
const jpeg = require('jpeg-js');
const { encodeThumbnail, fetchThumbnail } = require('../lib/cover-thumbnail');
const { fetchLyrics } = require('../lib/udon-gateway');
function image() {
  const png = new PNG({ width: 2, height: 2 });
  png.data = Buffer.from([255,0,0,255, 0,255,0,255, 0,0,255,255, 255,255,255,255]);
  return png;
}
test('PNG transport preserves top-down corners, exact shape and song identity', () => {
  const data = encodeThumbnail(PNG.sync.write(image()), '186016');
  assert.equal(data.pixels.length, 64*64*6); assert.equal(data.songId, '186016');
  assert.equal(data.version, 1); assert.equal(data.encoding, 'rgb24-hex-top-down');
  assert.equal(data.pixels.slice(0, 6), 'ff0000'); assert.equal(data.pixels.slice(63*6,64*6), '00ff00');
  assert.equal(data.pixels.slice(63*64*6,63*64*6+6), '0000ff');
});
test('JPEG decoding is bounded and malformed/oversized images are rejected', () => {
  assert.equal(encodeThumbnail(jpeg.encode(image(), 90).data, '1').pixels.length, 24576);
  assert.throws(() => encodeThumbnail(Buffer.from('<html>error</html>'), '1'));
  const png = PNG.sync.write(new PNG({ width: 257, height: 1 }));
  assert.throws(() => encodeThumbnail(png, '1'), /dimensions/);
});
test('thumbnail fetch whitelists metadata and rejects cross-song metadata without fetching', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response(PNG.sync.write(image())); };
  assert.equal(await fetchThumbnail({ id: 2, al: { picUrl: 'https://p3.music.126.net/test.png' } }, '1', fetchImpl), null);
  assert.equal(await fetchThumbnail({ al: { picUrl: 'https://example.com/test.png' } }, '1', fetchImpl), null);
  assert.equal(calls, 0);
  const result = await fetchThumbnail({ id: 1, al: { picUrl: 'https://p3.music.126.net/test.png' } }, '1', fetchImpl);
  assert.equal(result.songId, '1'); assert.equal(calls, 1);
});
test('lyrics remain available on image failure and attach thumbnail on success', async () => {
  let failImage = false;
  const fetchImpl = async url => {
    if (url.includes('/song/detail')) return { ok: true, json: async () => ({ songs: [{ id: 1, al: { picUrl: 'https://p3.music.126.net/test.png' } }] }) };
    if (url.includes('/lyric')) return { ok: true, json: async () => ({ code: 200, lrc: { lyric: '[00:01]甲' } }) };
    if (failImage) throw new Error('offline');
    return new Response(PNG.sync.write(image()));
  };
  assert.equal((await fetchLyrics('1', TEST_UPSTREAM_ENV, fetchImpl)).coverThumbnail.songId, '1');
  failImage = true;
  const failed = await fetchLyrics('1', TEST_UPSTREAM_ENV, fetchImpl);
  assert.equal(failed.coverThumbnail, undefined); assert.equal(failed.lrc, '[00:01]甲');
});
