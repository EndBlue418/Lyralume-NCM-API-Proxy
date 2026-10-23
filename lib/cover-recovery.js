'use strict';
const { normalizeCoverUrl, fetchSong, coverFields } = require('./album-art');
const { fetchThumbnail, coverFailureCode } = require('./cover-thumbnail');
const RETRY_MS = 120000;
function hasThumbnail(data) {
  const t = data?.coverThumbnail;
  return t?.version === 1 && String(t.songId) === String(data.songId) && t.width === 64 && t.height === 64 &&
    t.encoding === 'rgb24-hex-top-down' && typeof t.pixels === 'string' && /^[0-9a-f]{24576}$/.test(t.pixels);
}
function needsCover(data, env, now = Date.now()) {
  return env.FOLIA_COVER_THUMBNAIL !== '0' && /^[1-9]\d{0,11}$/.test(String(data?.songId)) &&
    !hasThumbnail(data) && (!data.coverUrl || !!normalizeCoverUrl(data.coverUrl, 256)) && !(Number(data.coverThumbnailRetryAt) > now);
}
function createCoverRecovery(env, fetchImpl, now = Date.now) {
  const inFlight = new Map();
  async function save(base, fields, store) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const updated = { ...base, ...fields };
      if (Buffer.byteLength(JSON.stringify(updated)) > 500000) return base;
      if (!store.updateCover) { await store.publish(updated); return updated; }
      if (await store.updateCover(base, updated)) return updated;
      const latest = await store.get(base.songId);
      if (!latest || hasThumbnail(latest)) return latest || base;
      base = latest;
    }
    return base;
  }
  return async (data, store) => {
    if (!needsCover(data, env, now())) return data;
    if (inFlight.has(data.songId)) return inFlight.get(data.songId);
    const task = (async () => {
      try {
        if (store.claimCoverRetry && !await store.claimCoverRetry(data.songId)) return data;
        const retryAt = now() + RETRY_MS;
        let fields;
        try {
          const metadata = !data.coverUrl ? coverFields(await fetchSong(data.songId, env, fetchImpl), data.songId) : {};
          const thumbnail = await fetchThumbnail({ id: data.songId, al: { picUrl: metadata.coverUrl || data.coverUrl } }, data.songId, fetchImpl);
          fields = thumbnail ? { ...metadata, coverThumbnail: thumbnail, coverThumbnailState: 'ready', coverThumbnailRetryAt: 0, coverThumbnailError: '' } :
            { coverThumbnailState: 'retry', coverThumbnailRetryAt: retryAt };
        } catch (error) { fields = { coverThumbnailState: 'retry', coverThumbnailRetryAt: retryAt, coverThumbnailError: coverFailureCode(error) }; }
        return await save(data, fields, store);
      } catch { return data; } // Optional recovery never makes cached lyrics unavailable.
    })().finally(() => inFlight.delete(data.songId));
    inFlight.set(data.songId, task); return task;
  };
}
module.exports = { hasThumbnail, needsCover, createCoverRecovery, RETRY_MS };
