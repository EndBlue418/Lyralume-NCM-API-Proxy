'use strict';
const { BASE, PARTS, SLOTS, LEASE_SECONDS, ALLOCATE_LUA, APPEND_LUA } = require('./udon-protocol');
const { coverFields, coverPath } = require('./album-art');
const { fetchThumbnail, coverFailureCode } = require('./cover-thumbnail');
const { needsCover, createCoverRecovery } = require('./cover-recovery');
const { resolveAlternative } = require('./lyric-providers');
const { neteaseSecondary, stripSecondary } = require('./lyric-secondary');
const { neteaseJson } = require('./netease-upstream');
const PREFIX = 'netease:udon:v1:';

function createRedis(env, fetchImpl) {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  if (!url || !token) throw Object.assign(new Error('Redis storage has not been configured'), { statusCode: 503 });
  return async command => {
    const response = await fetchImpl(url.replace(/\/$/, ''), {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command), signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error('Storage request failed');
    const data = await response.json();
    if (data.error) throw new Error('Storage command failed');
    return data.result;
  };
}

function createStore(command, env = {}) {
  const store = {
    allocate: head => command(['EVAL', ALLOCATE_LUA, 1, PREFIX + 'slot:', SLOTS, head, LEASE_SECONDS]),
    append: (slot, part, value) => command(['EVAL', APPEND_LUA, 1, PREFIX + 'slot:' + slot, part, value, PARTS]),
    get: async id => { const raw = await command(['GET', PREFIX + 'song:' + id]); return raw ? JSON.parse(raw) : null; },
    claimCoverRetry: async id => !!await command(['SET', PREFIX + 'cover-retry:' + id, '1', 'NX', 'EX', 120]),
    // Compare-and-swap preserves concurrent lyric updates and the original cache expiry.
    updateCover: async (before, after) => Number(await command(['EVAL',
      "if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end; redis.call('SET',KEYS[1],ARGV[2],'XX','KEEPTTL'); return 1",
      1, PREFIX + 'song:' + before.songId, JSON.stringify(before), JSON.stringify(after)])) === 1,
    publish: async data => {
      const now = Date.now();
      await command(['SET', PREFIX + 'song:' + data.songId, JSON.stringify(data), 'EX', 3600]);
      await command(['ZADD', PREFIX + 'catalogue', now, data.songId]);
      await command(['ZREMRANGEBYRANK', PREFIX + 'catalogue', 0, -33]);
      await command(['ZREMRANGEBYSCORE', PREFIX + 'catalogue', '-inf', now - 3600000]);
    },
    catalogue: async () => {
      const ids = await command(['ZREVRANGE', PREFIX + 'catalogue', 0, 31]);
      if (!ids.length) return [];
      const values = await command(['MGET', ...ids.map(id => PREFIX + 'song:' + id)]);
      const songs = [];
      let bytes = 0;
      for (const raw of values) {
        if (!raw || bytes + Buffer.byteLength(raw) > 3000000) continue;
        bytes += Buffer.byteLength(raw); songs.push(JSON.parse(raw));
      }
      return songs;
    }
  };
  if (env.LYRALUME_CACHE_MAX_SONGS !== undefined) {
    const limit = Number(env.LYRALUME_CACHE_MAX_SONGS);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid LYRALUME_CACHE_MAX_SONGS');
    Object.assign(store, require('./song-cache').createSongCache(command, limit));
  }
  return store;
}

function readLyric(value) { return typeof value === 'string' ? value : value?.lyric || ''; }

async function fetchLyrics(songId, env, fetchImpl) {
  const json = path => neteaseJson(path, env, fetchImpl, 20000);
  const responses = await Promise.allSettled([json('/lyric/new?id=' + songId), json('/song/detail?ids=' + songId)]);
  let lyrics = responses[0].status === 'fulfilled' ? responses[0].value : null;
  const originalSecondary = neteaseSecondary(lyrics);
  let lyricFailure;
  if (!lyrics || (!readLyric(lyrics.yrc) && !readLyric(lyrics.lrc))) {
    try { lyrics = await json('/lyric?id=' + songId); } catch (error) { lyrics = {}; lyricFailure = error; }
  }
  const candidate = responses[1].status === 'fulfilled' ? responses[1].value.songs?.[0] : null;
  const song = candidate && (candidate.id === undefined || String(candidate.id) === String(songId)) ? candidate : null;
  const secondary = neteaseSecondary(lyrics);
  for (const key of Object.keys(secondary)) if (!secondary[key]) secondary[key] = originalSecondary[key];
  const data = {
    success: true, status: 'ready', songId,
    name: song?.name || '網易雲音樂', artist: (song?.ar || song?.artists || []).map(a => a.name).join(' / '),
    ...coverFields(song, songId),
    yrc: readLyric(lyrics.yrc), lrc: readLyric(lyrics.lrc) || readLyric(lyrics.lyric),
    ...neteaseSecondary(secondary),
    secondaryLyricsVersion: 1
  };
  // Optional visual enrichment must not turn a valid lyric response into an error.
  await Promise.allSettled([
    (async () => {
      if (env.FOLIA_COVER_THUMBNAIL === '0') return;
      try { const thumbnail = await fetchThumbnail(song, songId, fetchImpl); if (thumbnail) { data.coverThumbnail = thumbnail; data.coverThumbnailState = 'ready'; } }
      catch (error) { data.coverThumbnailState = 'retry'; data.coverThumbnailRetryAt = Date.now() + 120000; data.coverThumbnailError = coverFailureCode(error); }
    })(),
    (async () => {
      if (data.yrc || env.FOLIA_MULTI_SOURCE === '0') return;
      const timeline = await resolveAlternative(song, songId, fetchImpl, { enableKugou: env.FOLIA_KUGOU === '1' });
      if (timeline) {
        const { secondaryLyrics, ...primary } = timeline;
        data.lyricTimeline = primary;
        if (secondaryLyrics) data.secondaryLyrics = secondaryLyrics;
      }
    })()
  ]);
  if (lyricFailure && !data.yrc && !data.lrc && !data.lyricTimeline) throw lyricFailure;
  // Secondary text must never displace a previously valid primary timeline or cover.
  if (Buffer.byteLength(JSON.stringify(data)) > 500000) stripSecondary(data);
  if (Buffer.byteLength(JSON.stringify(data)) > 500000) delete data.coverThumbnail;
  if (Buffer.byteLength(JSON.stringify(data)) > 500000) delete data.lyricTimeline;
  if (Buffer.byteLength(JSON.stringify(data)) > 500000) throw new Error('Lyric response is too large');
  return data;
}

function integer(value, max) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw Object.assign(new Error('Invalid numeric parameter'), { statusCode: 400 });
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number >= max) throw Object.assign(new Error('Numeric parameter out of range'), { statusCode: 400 });
  return number;
}

function createHandler({ env = process.env, fetchImpl = globalThis.fetch, store: injectedStore } = {}) {
  const inFlight = new Map();
  const recoverCover = createCoverRecovery(env, fetchImpl);
  const forClient = data => {
    const result = withCoverPath(data);
    if (env.FOLIA_MULTI_SOURCE === '0' || (result.lyricTimeline?.source === 'kugou' && env.FOLIA_KUGOU !== '1')) delete result.lyricTimeline;
    if (env.FOLIA_COVER_THUMBNAIL === '0') delete result.coverThumbnail;
    if (env.FOLIA_SECONDARY_LYRICS === '0') stripSecondary(result);
    else if (env.FOLIA_MULTI_SOURCE === '0') delete result.secondaryLyrics;
    return result;
  };
  return async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
    res.setHeader('Link', '</api/source>; rel="source"');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'GET') return res.status(405).json({ status: 'error', error: 'Use GET' });
    try {
      const store = injectedStore || createStore(createRedis(env, fetchImpl), env);
      // Old cache entries immediately receive a deterministic image endpoint without refetching every song.
      if (req.query.op === 'catalogue') {
        const songs = await store.catalogue();
        const selected = songs.filter(song => needsCover(song, env)).sort((a,b) => (a.coverThumbnailRetryAt || 0) - (b.coverThumbnailRetryAt || 0)).slice(0, 2);
        const repaired = await Promise.all(selected.map(song => recoverCover(song, store)));
        const replacements = new Map(repaired.map(song => [song.songId, song]));
        // Keep the original catalogue payload limit after adding image data.
        let bytes = 0;
        const output = songs.map(song => forClient(replacements.get(song.songId) || song)).filter(song => {
          const size = Buffer.byteLength(JSON.stringify(song)); if (bytes + size > 3000000) return false; bytes += size; return true;
        });
        return res.status(200).json({ status: 'catalogue', songs: output });
      }
      if (req.query.op === 'begin') {
        const slot = Number(await store.allocate(integer(req.query.value, BASE)));
        if (slot < 0) return res.status(200).json({ status: 'busy' });
        return res.status(200).json({ status: 'building', slot, nextPart: 1 });
      }
      if (req.query.op !== 'part') return res.status(400).json({ status: 'error', error: 'Unknown operation' });
      const slot = integer(req.query.slot, SLOTS);
      const part = integer(req.query.part, PARTS);
      if (!part) return res.status(400).json({ status: 'error', error: 'Part must be positive' });
      const value = integer(req.query.value, BASE);
      const [state, songId] = await store.append(slot, part, value);
      if (state === 'building') return res.status(200).json({ status: 'building', slot, nextPart: part + 1 });
      if (!['complete', 'loading'].includes(state)) return res.status(200).json({ status: 'restart', reason: state });
      let data = await store.get(songId);
      let refreshed = false;
      if (!data || !Number.isInteger(data.secondaryLyricsVersion) || data.secondaryLyricsVersion < 1) {
        if (!inFlight.has(songId)) inFlight.set(songId, fetchLyrics(songId, env, fetchImpl).finally(() => inFlight.delete(songId)));
        try { data = await inFlight.get(songId); refreshed = true; }
        catch (error) { if (!data) throw error; } // Keep usable old cached lyrics during an upstream outage.
      }
      if (refreshed) await store.publish(data);
      data = await recoverCover(data, store);
      return res.status(200).json(forClient(data));
    } catch (error) {
      return res.status(error.statusCode || 502).json({ status: 'error', error: error.statusCode === 503 ? error.message : 'Lyric transfer failed' });
    }
  };
}

function withCoverPath(data) {
  try { return { ...data, coverPath: coverPath(String(data.songId)) }; }
  catch { return data; } // Optional cover enrichment must not break an older catalogue entry.
}
module.exports = { createHandler, createRedis, createStore, fetchLyrics };
