'use strict';

const { neteaseJson } = require('./netease-upstream');
const ALLOWED_SIZES = new Set(['256', '512', '1024']);
const MAX_BYTES = 4 * 1024 * 1024;

function failure(message, statusCode) { return Object.assign(new Error(message), { statusCode }); }
function songId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,11}$/.test(value)) throw failure('Invalid song ID', 400);
  return value;
}
function imageSize(value = '512') {
  if (typeof value !== 'string' || !ALLOWED_SIZES.has(value)) throw failure('Size must be 256, 512 or 1024', 400);
  return Number(value);
}
function coverPath(id, size = 512) { return '/api/cover?id=' + songId(id) + '&size=' + imageSize(String(size)); }

// Only metadata-selected NetEase image hosts are eligible. Never accepts a caller-supplied upstream URL.
function normalizeCoverUrl(value, size = 512) {
  if (!value || typeof value !== 'string') return '';
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port || !/^p\d+c?\.music\.126\.net$/i.test(url.hostname)) return '';
    url.protocol = 'https:'; url.hash = ''; url.search = '';
    url.searchParams.set('param', imageSize(String(size)) + 'y' + imageSize(String(size)));
    return url.toString();
  } catch { return ''; }
}
function coverFields(song, id) {
  const album = song?.al || song?.album;
  return { albumName: typeof album?.name === 'string' ? album.name : '',
    coverUrl: normalizeCoverUrl(album?.picUrl), coverPath: coverPath(id) };
}
async function fetchSong(id, env, fetchImpl) {
  const data = await neteaseJson('/song/detail?ids=' + songId(id), env, fetchImpl, 10000);
  const song = data.songs?.[0];
  if (!song) throw failure('Song not found', 404);
  // Refuse an upstream response for another song, even when the HTTP request succeeded.
  if (song.id !== undefined && String(song.id) !== id) throw failure('Song identity mismatch', 502);
  return song;
}
async function boundedBytes(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BYTES) throw failure('Cover is too large', 502);
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.byteLength;
    if (length > MAX_BYTES) throw failure('Cover is too large', 502);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, length);
}
// Read dimensions from the bytes rather than trusting a Content-Type header or CDN size query.
function imageInfo(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.toString('ascii', 12, 16) === 'IHDR') {
    return { type: 'image/png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 3 < bytes.length) {
      if (bytes[offset++] !== 255) throw failure('Invalid JPEG', 502);
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && length >= 8) {
        return { type: 'image/jpeg', width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
      }
      offset += length;
    }
  }
  throw failure('Unsupported or invalid cover image', 502);
}
async function loadCover(id, size, env, fetchImpl) {
  const song = await fetchSong(id, env, fetchImpl);
  const url = normalizeCoverUrl((song.al || song.album)?.picUrl, size);
  if (!url) throw failure('No supported album cover', 404);
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!response.ok || response.status >= 300) throw failure('Cover download failed', 502);
  const bytes = await boundedBytes(response);
  const info = imageInfo(bytes);
  if (info.width < 1 || info.height < 1 || info.width > size || info.height > size) throw failure('Cover exceeds requested dimensions', 502);
  return { bytes, ...info };
}
function createCoverHandler({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const inFlight = new Map();
  return async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (!['GET', 'HEAD'].includes(req.method)) return res.status(405).json({ error: 'Use GET or HEAD' });
    try {
      const id = songId(req.query.id), size = imageSize(req.query.size);
      const key = id + ':' + size;
      if (!inFlight.has(key)) {
        const promise = loadCover(id, size, env, fetchImpl).finally(() => inFlight.delete(key));
        inFlight.set(key, promise);
      }
      const image = await inFlight.get(key);
      res.setHeader('Content-Type', image.type);
      res.setHeader('Content-Length', String(image.bytes.length));
      res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=3600');
      res.setHeader('X-Cover-Song-Id', id);
      res.setHeader('X-Cover-Width', String(image.width)); res.setHeader('X-Cover-Height', String(image.height));
      if (req.method === 'HEAD') return res.status(200).end();
      return res.status(200).send(image.bytes);
    } catch (error) {
      const status = error.statusCode || 502;
      return res.status(status).json({ error: status < 500 ? error.message : 'Cover temporarily unavailable' });
    }
  };
}
module.exports = { songId, imageSize, coverPath, normalizeCoverUrl, coverFields, fetchSong, imageInfo, boundedBytes, createCoverHandler };
