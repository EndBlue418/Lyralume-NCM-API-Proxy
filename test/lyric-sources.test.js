const TEST_UPSTREAM_ENV = { NETEASE_API_URL: 'https://ncm.example.test' };
const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalLyrics } = require('../lib/lyric-schema');
const { parseTtml, parseKaraoke } = require('../lib/lyric-formats');
const { resolveAlternative, candidateMatches } = require('../lib/lyric-providers');
const ttml = '<tt><body><div><p begin="1s" end="3s"><span begin="1s" end="2s">字(原文)</span><span begin="2s" end="3s">尾</span></p></div></body></tt>';
test('structured timeline preserves literal delimiters and original word clocks', () => {
  const data = canonicalLyrics(parseTtml(ttml), '186016', 'amll');
  assert.equal(data.lines[0].text, '字(原文)尾'); assert.equal(data.lines[0].words[1].startMs, 2000);
  const krc = canonicalLyrics(parseKaraoke('[1000,2000]<0,1000,0>字(原文)<1000,1000,0>尾'), '1', 'kugou');
  assert.equal(krc.lines[0].text, '字(原文)尾');
  const qrc = canonicalLyrics(parseKaraoke('[1000,2000]字(原文)(1000,1000)尾(2000,1000)'), '1', 'qq');
  assert.equal(qrc.lines[0].text, '字(原文)尾');
});
test('bad order, nonzero offset, text mismatch and line-only data fail validation', () => {
  const normalized = parseTtml(ttml);
  for (const change of [data => data.offsetMs = 50, data => data.lines[0].words[1].startMs = 900,
    data => data.lines[0].text = 'truncated', data => data.lines[0].words = []]) {
    const data = structuredClone(normalized); change(data); assert.throws(() => canonicalLyrics(data, '1', 'amll'));
  }
});
test('AMLL requires exact NCM mapping; unavailable sources return safe null', async () => {
  const transport = id => async () => ({ ok: true, json: async () => ({ status: 200, data: { ncmMusicIds: [id], format: 'ttml', lyrics: ttml } }) });
  assert.equal((await resolveAlternative(null, '186016', transport('186016'))).source, 'amll');
  assert.equal(await resolveAlternative(null, '186016', transport('99')), null);
  assert.equal(await resolveAlternative(null, '186016', async () => { throw new Error('offline'); }), null);
});
test('XML document declarations and entities are rejected before parsing', () => {
  assert.throws(() => parseTtml('<!DOCTYPE tt [<!ENTITY x "text">]>' + ttml));
});
test('native YRC wins; missing word timing can attach verified AMLL with LRC retained', async () => {
  const { fetchLyrics } = require('../lib/udon-gateway');
  let native = true, amllCalls = 0;
  const fetchImpl = async url => {
    if (url.includes('/song/detail')) return { ok: true, json: async () => ({ songs: [{ id: 1, name: 'Song' }] }) };
    if (url.includes('api.amll.dev')) { amllCalls++; return { ok: true, json: async () => ({ status: 200, data: { ncmMusicIds: ['1'], format: 'ttml', lyrics: ttml } }) }; }
    return { ok: true, json: async () => ({ code: 200, yrc: { lyric: native ? '[1000,1000](1000,1000,0)字' : '' }, lrc: { lyric: '[00:01]備援' } }) };
  };
  const precise = await fetchLyrics('1', TEST_UPSTREAM_ENV, fetchImpl);
  assert(precise.yrc); assert.equal(precise.lyricTimeline, undefined); assert.equal(amllCalls, 0);
  native = false;
  const fallback = await fetchLyrics('1', TEST_UPSTREAM_ENV, fetchImpl);
  assert.equal(fallback.lyricTimeline.source, 'amll'); assert.equal(fallback.lrc, '[00:01]備援');
});
test('runtime source/cover flags also apply to cached catalogue without mutating storage', async () => {
  const { createHandler } = require('../lib/udon-gateway');
  const cached = { songId: '1', lrc: '[00:01]字', coverThumbnail: { version: 1 }, lyricTimeline: { source: 'amll' } };
  const handler = createHandler({ env: { ...TEST_UPSTREAM_ENV, FOLIA_MULTI_SOURCE: '0', FOLIA_COVER_THUMBNAIL: '0' }, store: { catalogue: async () => [cached] } });
  let result;
  await handler({ method: 'GET', query: { op: 'catalogue' } }, { setHeader() {}, status() { return this; }, json(value) { result = value; } });
  assert.equal(result.songs[0].lyricTimeline, undefined); assert.equal(result.songs[0].coverThumbnail, undefined);
  assert.equal(result.songs[0].lrc, cached.lrc); assert(cached.lyricTimeline && cached.coverThumbnail);
});
test('simultaneous uncached requests for the same song share provider work', async () => {
  const { createHandler } = require('../lib/udon-gateway');
  let lyricCalls = 0;
  const handler = createHandler({ env: TEST_UPSTREAM_ENV, store: { append: async () => ['complete', '1'], get: async () => null, publish: async () => {} }, fetchImpl: async url => {
    if (url.includes('/song/detail')) return { ok: true, json: async () => ({ songs: [{ id: 1 }] }) };
    lyricCalls++; return { ok: true, json: async () => ({ code: 200, yrc: { lyric: '[1000,1000](1000,1000,0)字' } }) };
  } });
  const run = async () => {
    let result;
    await handler({ method: 'GET', query: { op: 'part', slot: '0', part: '3', value: '1' } }, { setHeader() {}, status() { return this; }, json(value) { result = value; } });
    return result;
  };
  const results = await Promise.all([run(), run()]);
  assert.equal(lyricCalls, 1); assert(results.every(result => result.songId === '1'));
});
test('Kugou candidate gate rejects alternate versions, unknown duration and wrong artist', () => {
  const song = { name: 'Song', ar: [{ name: 'Artist' }], dt: 180000 };
  const candidate = { SongName: 'Song', Singers: [{ name: 'Artist' }], Duration: 180 };
  assert(candidateMatches(song, candidate));
  for (const replacement of [{ SongName: 'Song (Live)' }, { Duration: 210 }, { Duration: 0 }, { Singers: [{ name: 'Other' }] }]) {
    assert.equal(candidateMatches(song, { ...candidate, ...replacement }), false);
  }
});
test('known downloaded samples validate without punctuation stripping; malformed source falls back', () => {
  const fs = require('node:fs'), path = require('node:path');
  const folder = path.resolve(__dirname, '../../sandbox/lyrics/results');
  if (!fs.existsSync(folder)) return; // Private probe fixtures are not shipped with the API.
  for (const file of ['zh-amll.ttml', 'zh-kugou.txt', 'en-kugou.txt', 'ja-kugou.txt', 'mapped-qq.txt']) {
    const raw = fs.readFileSync(path.join(folder, file), 'utf8');
    const parsed = file.endsWith('ttml') ? parseTtml(raw) : parseKaraoke(raw);
    assert(canonicalLyrics(parsed, '1', 'test').lines.length > 0);
  }
  assert.throws(() => canonicalLyrics(parseTtml(fs.readFileSync(path.join(folder, 'en-amll.ttml'), 'utf8')), '1', 'amll'));
});
