'use strict';
const { PNG } = require('pngjs');
const jpeg = require('jpeg-js');
const { normalizeCoverUrl, imageInfo, boundedBytes } = require('./album-art');
const SIZE = 64;

// Deliberately low-resolution background transport through the existing identity-checked JSON.
// No mutable global image slots and no runtime VRCUrl construction are required.
function encodeThumbnail(bytes, songId) {
  const info = imageInfo(bytes);
  if (info.width < 1 || info.height < 1 || info.width > 256 || info.height > 256) throw new Error('Thumbnail input dimensions exceeded');
  const decoded = info.type === 'image/png' ? PNG.sync.read(bytes, { checkCRC: true }) :
    jpeg.decode(bytes, { useTArray: true, maxResolutionInMP: 1, maxMemoryUsageInMB: 32 });
  if (decoded.width !== info.width || decoded.height !== info.height) throw new Error('Decoded size mismatch');
  const rgb = Buffer.alloc(SIZE * SIZE * 3);
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const x0 = Math.floor(x * decoded.width / SIZE), x1 = Math.max(x0 + 1, Math.floor((x + 1) * decoded.width / SIZE));
    const y0 = Math.floor(y * decoded.height / SIZE), y1 = Math.max(y0 + 1, Math.floor((y + 1) * decoded.height / SIZE));
    let r = 0, g = 0, b = 0, n = 0;
    for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) {
      const i = (sy * decoded.width + sx) * 4, alpha = decoded.data[i + 3] / 255;
      r += decoded.data[i] * alpha; g += decoded.data[i + 1] * alpha; b += decoded.data[i + 2] * alpha; n++;
    }
    const i = (y * SIZE + x) * 3;
    rgb[i] = Math.round(r / n); rgb[i + 1] = Math.round(g / n); rgb[i + 2] = Math.round(b / n);
  }
  return { version: 1, songId: String(songId), width: SIZE, height: SIZE, encoding: 'rgb24-hex-top-down', pixels: rgb.toString('hex') };
}
async function fetchThumbnail(song, songId, fetchImpl) {
  const url = normalizeCoverUrl((song?.al || song?.album)?.picUrl, 256);
  if (!url || (song?.id !== undefined && String(song.id) !== String(songId))) return null;
  let lastError;
  const alternate = new URL(url); alternate.hostname = alternate.hostname === 'p1.music.126.net' ? 'p2.music.126.net' : 'p1.music.126.net';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetchImpl(attempt < 2 ? url : alternate.toString(), { redirect: 'error', signal: AbortSignal.timeout(5000), headers: {
        'Referer': 'https://music.163.com/', 'User-Agent': 'Mozilla/5.0', 'Accept': 'image/png,image/jpeg,*/*;q=0.8'
      } });
      if (!response.ok || response.status >= 300) throw new Error('Thumbnail HTTP ' + response.status);
      return encodeThumbnail(await boundedBytes(response), songId);
    } catch (error) { lastError = error; }
  }
  throw lastError;
}
function coverFailureCode(error) {
  const http = /^Thumbnail HTTP (\d{3})$/.exec(error?.message || '');
  return http ? 'http-' + http[1] : /timeout|abort/i.test(error?.name || '') ? 'timeout' : /dimensions|size|JPEG|PNG|image/i.test(error?.message || '') ? 'decode' : 'network';
}
module.exports = { SIZE, encodeThumbnail, fetchThumbnail, coverFailureCode };
