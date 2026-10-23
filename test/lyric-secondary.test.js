'use strict';
const TEST_UPSTREAM_ENV = { NETEASE_API_URL: 'https://ncm.example.test' };
const test = require('node:test');
const assert = require('node:assert/strict');
const { neteaseSecondary, ttmlSecondary } = require('../lib/lyric-secondary');
const { fetchLyrics, createHandler } = require('../lib/udon-gateway');
const { resolveAlternative } = require('../lib/lyric-providers');
const { canonicalLyrics } = require('../lib/lyric-schema');
const { parseTtml } = require('../lib/lyric-formats');
const primary = '[1000,1000](1000,1000,0)主';
const env = { ...TEST_UPSTREAM_ENV, FOLIA_MULTI_SOURCE: '0', FOLIA_COVER_THUMBNAIL: '0' };
const raw = { code: 200, yrc: { lyric: primary }, lrc: { lyric: '[00:01]主' }, tlyric: { lyric: '[00:01.025]譯\n[00:03]另一列' }, romalrc: { lyric: '[00:01.100]roma' }, ytlrc: { lyric: '[00:01]譯' }, yromalrc: { lyric: '[00:01]roma' } };
const fetcher = lyrics => async url => ({ ok: true, json: async () => url.includes('/song/detail') ? { songs: [{ id: 1, name: 'Synthetic' }] } : lyrics });
const xml = '<tt xml:lang="ja"><body><div><p begin="1s" end="3s"><span begin="1s" end="3s">主</span><span ttm:role="x-translation" xml:lang="zh-Hant">譯<br/>第二列</span><span ttm:role="x-roman">roma</span><span ttm:role="x-bg"><span ttm:role="x-translation">伴唱譯</span></span></p></div></body></tt>';
async function response(handler, query) {
  let result, code;
  await handler({ method: 'GET', query }, { setHeader() {}, status(value) { code = value; return this; }, json(value) { result = value; } });
  return { code, result };
}
test('secondary NetEase fields preserve exact text and timestamps without changing primary priority', async () => {
  const value = await fetchLyrics('1', env, fetcher(raw));
  assert.equal(value.yrc, primary); assert.equal(value.lrc, raw.lrc.lyric);
  for (const field of ['tlyric', 'romalrc', 'ytlrc', 'yromalrc']) assert.equal(value[field], raw[field].lyric);
  assert.equal(value.secondaryLyricsVersion, 1); assert.equal(value.lyricTimeline, undefined);
});
test('missing, malformed and oversized secondary values cannot fail primary lyrics', async () => {
  const value = neteaseSecondary({ tlyric: { lyric: 12 }, romalrc: [], ytlrc: 'a'.repeat(120001), yromalrc: '[00:01]roma' });
  assert.deepEqual(value, { tlyric: '', romalrc: '', ytlrc: '', yromalrc: '[00:01]roma' });
  assert.equal((await fetchLyrics('1', env, fetcher({ ...raw, tlyric: { lyric: 'a'.repeat(200000) } }))).yrc, primary);
});
test('fallback lyric endpoint does not discard secondary fields from lyric/new', async () => {
  const result = await fetchLyrics('1', env, async url => ({ ok: true, json: async () => url.includes('/song/detail') ? { songs: [] } : url.includes('/lyric/new') ? { code: 200, tlyric: raw.tlyric } : { code: 200, lrc: raw.lrc } }));
  assert.equal(result.tlyric, raw.tlyric.lyric); assert.equal(result.lrc, raw.lrc.lyric);
});
test('response byte cap removes optional secondary text before sacrificing valid primary lyrics', async () => {
  const lrc = '[00:01]' + 'a'.repeat(410000);
  const result = await fetchLyrics('1', env, fetcher({ code: 200, lrc: { lyric: lrc }, tlyric: 'b'.repeat(110000) }));
  assert.equal(result.lrc, lrc); assert.equal(result.tlyric, undefined); assert.equal(result.secondaryLyricsVersion, 1);
});
test('TTML secondary tracks preserve role, explicit language, source and inherited line window', () => {
  const result = ttmlSecondary(xml, '1');
  assert.equal(result.source, 'amll'); assert.equal(result.songId, '1'); assert.equal(result.version, 1);
  assert.equal(result.tracks.length, 2);
  assert.deepEqual(result.tracks[0], { kind: 'translation', language: 'zh-Hant', timing: 'line', lines: [{ startMs: 1000, endMs: 3000, text: '譯\n第二列' }] });
  assert.equal(result.tracks[1].language, undefined); // Do not label a translation with the primary language.
  assert.equal(result.tracks[1].kind, 'romanization'); assert.equal(result.tracks[1].lines[0].words, undefined);
  assert.deepEqual(canonicalLyrics(parseTtml(xml), '1', 'amll').lines[0].text, '主');
});
test('secondary parsing rejects unsafe XML, skips invalid windows and never fabricates missing clocks', () => {
  assert.throws(() => ttmlSecondary('<!DOCTYPE tt>' + xml, '1'));
  assert.equal(ttmlSecondary('<tt><span ttm:role="x-roman">untimed</span></tt>', '1'), undefined);
  const value = ttmlSecondary(xml.replace('ttm:role="x-roman"', 'ttm:role="x-roman" begin="bad"'), '1');
  assert.equal(value.tracks.length, 1);
});
test('AMLL sidecar appears only on exact song mapping and does not alter primary word timeline', async () => {
  const fetchImpl = id => async () => ({ ok: true, json: async () => ({ status: 200, data: { ncmMusicIds: [id], format: 'ttml', lyrics: xml } }) });
  const result = await resolveAlternative(null, '1', fetchImpl('1'));
  assert.equal(result.lines[0].text, '主'); assert.equal(result.secondaryLyrics.tracks.length, 2);
  assert.equal(await resolveAlternative(null, '1', fetchImpl('2')), null);
});
test('gateway moves AMLL sidecar outside unchanged v1 primary timeline', async () => {
  const result = await fetchLyrics('1', { FOLIA_COVER_THUMBNAIL: '0' }, async url => ({ ok: true, json: async () => url.includes('api.amll.dev') ? { status: 200, data: { ncmMusicIds: ['1'], format: 'ttml', lyrics: xml } } : url.includes('/song/detail') ? { songs: [{ id: 1 }] } : { code: 200, lrc: raw.lrc } }));
  assert.equal(result.lyricTimeline.secondaryLyrics, undefined); assert.equal(result.lyricTimeline.lines[0].text, '主');
  assert.equal(result.secondaryLyrics.songId, '1'); assert.equal(result.tlyric, '');
});
test('old cached songs refresh once on request; current cache does not trigger extra provider work', async () => {
  let cached = { songId: '1', lrc: '[00:01]old' }, calls = 0;
  const handler = createHandler({ env: TEST_UPSTREAM_ENV, env, store: { append: async () => ['complete', '1'], get: async () => cached, publish: async value => { cached = value; } }, fetchImpl: async url => { calls++; return fetcher(raw)(url); } });
  const query = { op: 'part', slot: '0', part: '3', value: '1' };
  const first = await response(handler, query); assert.equal(first.result.tlyric, raw.tlyric.lyric);
  const fetched = calls; await response(handler, query); assert.equal(calls, fetched);
});
test('old cached lyrics survive failed upgrade; catalogue is lazy and never refetches every song', async () => {
  const cached = { songId: '1', lrc: '[00:01]old' }; let calls = 0;
  const handler = createHandler({ env: TEST_UPSTREAM_ENV, env, store: { append: async () => ['complete', '1'], get: async () => cached, publish: async () => {}, catalogue: async () => [cached] }, fetchImpl: async () => { calls++; throw Error('offline'); } });
  assert.equal((await response(handler, { op: 'catalogue' })).result.songs[0].lrc, cached.lrc); assert.equal(calls, 0);
  const result = await response(handler, { op: 'part', slot: '0', part: '3', value: '1' });
  assert.equal(result.code, 200); assert.equal(result.result.lrc, cached.lrc); assert.equal(cached.secondaryLyricsVersion, undefined);
});
test('output flag hides cached secondary fields without mutating stored data', async () => {
  const cached = { songId: '1', tlyric: 'translation', romalrc: 'roma', secondaryLyrics: { source: 'amll' }, lrc: 'primary', secondaryLyricsVersion: 1 };
  const handler = createHandler({ env: { ...TEST_UPSTREAM_ENV, FOLIA_SECONDARY_LYRICS: '0' }, store: { catalogue: async () => [cached] } });
  const result = (await response(handler, { op: 'catalogue' })).result.songs[0];
  assert.equal(result.tlyric, undefined); assert.equal(result.secondaryLyrics, undefined); assert.equal(result.lrc, 'primary'); assert(cached.tlyric);
});
test('multi-source flag removes AMLL secondary sidecar but preserves native NetEase translations', async () => {
  const cached = { songId: '1', tlyric: 'native', secondaryLyrics: { source: 'amll' } };
  const result = (await response(createHandler({ env: { ...TEST_UPSTREAM_ENV, FOLIA_MULTI_SOURCE: '0' }, store: { catalogue: async () => [cached] } }), { op: 'catalogue' })).result.songs[0];
  assert.equal(result.tlyric, 'native'); assert.equal(result.secondaryLyrics, undefined); assert(cached.secondaryLyrics);
});
