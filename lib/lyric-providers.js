'use strict';
const { createHash } = require('node:crypto');
const { qrcDecrypt } = require('./qrc-decrypt');
const { inflateSync } = require('node:zlib');
const { parseTtml, parseKaraoke } = require('./lyric-formats');
const { canonicalLyrics } = require('./lyric-schema');
const { ttmlSecondary } = require('./lyric-secondary');
const md5 = value => createHash('md5').update(value).digest('hex');
const normalize = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
const inflate = data => inflateSync(data, { maxOutputLength: 1024 * 1024 }).toString('utf8');
async function boundedJson(fetchImpl, url, options = {}) {
  const response = await fetchImpl(url, { ...options, signal: options.signal || AbortSignal.timeout(2500), redirect: 'error' });
  if (!response.ok) throw new Error('Provider HTTP error');
  // Byte limit applies before JSON/XML parsing. Native fetch streams are bounded as they arrive.
  if (!response.body) return response.json(); // Injected unit-test transports.
  let size = 0; const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 1500000) throw new Error('Provider payload exceeded');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function candidateMatches(song, candidate) {
  const targetArtists = (song.ar || song.artists || []).map(artist => normalize(artist.name));
  const artists = (candidate.Singers || []).map(artist => normalize(artist.name));
  const duration = Number(song.dt || song.duration), candidateDuration = Number(candidate.Duration) * 1000;
  // Conservative recording identity: exact normalized title, same artist set and known close duration.
  return normalize(song.name) !== '' && normalize(song.name) === normalize(candidate.SongName) &&
    targetArtists.length > 0 && targetArtists.length === artists.length && targetArtists.every(artist => artists.includes(artist)) &&
    duration > 0 && candidateDuration > 0 && Math.abs(duration - candidateDuration) <= 2000 &&
    !/live|remix|伴奏|翻唱|现场|現場/i.test(candidate.SongName || '');
}
async function kugou(fetchImpl, url, params, module, signal) {
  const ms = Date.now(), mid = md5(String(ms)), query = { ...params, appid: '3116', clientver: '11070' };
  if (module !== 'Lyric') Object.assign(query, { userid: '0', token: '', clienttime: Math.floor(ms / 1000), iscorrection: '1', uuid: '-', mid, dfid: '-', platform: 'AndroidFilter' });
  const seed = 'LnT6xpN3khm36zse0QzvmgTZ3waWdRSA';
  query.signature = md5(seed + Object.keys(query).sort().map(key => key + '=' + query[key]).join('') + seed);
  const target = new URL(url);
  for (const [key, value] of Object.entries(query)) target.searchParams.set(key, String(value));
  const data = await boundedJson(fetchImpl, target.toString(), { signal, headers: { 'User-Agent': `Android14-1070-11070-201-0-${module}-wifi`, 'KG-Rec': '1', 'KG-RC': '1', 'KG-CLIENTTIMEMS': String(ms), mid, ...(module === 'SearchSong' ? { 'x-router': 'complexsearch.kugou.com' } : {}) } });
  if (data.error_code !== undefined && ![0, 200].includes(data.error_code)) throw new Error('Kugou rejected request');
  return data;
}
async function fromKugou(song, id, fetchImpl, signal) {
  const artist = (song.ar || song.artists || []).map(item => item.name).join(' ');
  const search = await kugou(fetchImpl, 'https://complexsearch.kugou.com/v2/search/song', { keyword: song.name + ' ' + artist, pagesize: 5, page: 1, sorttype: '0' }, 'SearchSong', signal);
  const matching = (search.data?.lists || []).filter(candidate => candidateMatches(song, candidate));
  // Distinct equally plausible recordings remain ambiguous; do not select the first search result.
  const hashes = new Set(matching.map(candidate => candidate.FileHash));
  if (hashes.size !== 1) return null;
  const selected = matching[0];
  const searchLyrics = await kugou(fetchImpl, 'https://lyrics.kugou.com/v1/search', { duration: selected.Duration * 1000, hash: selected.FileHash, keyword: artist + ' - ' + song.name, lrctxt: '1', man: 'no' }, 'Lyric', signal);
  const candidate = searchLyrics.candidates?.[0];
  if (!candidate) return null;
  const download = await kugou(fetchImpl, 'https://lyrics.kugou.com/download', { accesskey: candidate.accesskey, charset: 'utf8', client: 'mobi', fmt: 'krc', id: candidate.id, ver: '1' }, 'Lyric', signal);
  const bytes = Buffer.from(download.content || '', 'base64');
  if (bytes.subarray(0, 4).toString() !== 'krc1') throw new Error('Expected KRC content');
  const key = [64,71,97,119,94,50,116,71,81,54,49,45,206,210,110,105];
  const decoded = Buffer.from(bytes.subarray(4));
  for (let i = 0; i < decoded.length; i++) decoded[i] ^= key[i % key.length];
  return canonicalLyrics(parseKaraoke(inflate(decoded)), id, 'kugou');
}
async function fromQq(metadata, id, fetchImpl, signal) {
  const qqId = (metadata?.qqMusicIds || []).find(value => /^[1-9]\d{0,10}$/.test(String(value)));
  if (!qqId) return null; // QQ search is unreliable; use only an explicit cross-platform ID mapping.
  const b64 = value => Buffer.from(value || '').toString('base64');
  const response = await boundedJson(fetchImpl, 'https://u.y.qq.com/cgi-bin/musicu.fcg', { signal, method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'tmeLoginType=-1;', 'User-Agent': 'okhttp/3.14.9' }, body: JSON.stringify({
    comm: { ct: 11, cv: '1003006', v: '1003006', os_ver: '15', phonetype: '24122RKC7C', tmeAppID: 'qqmusiclight', nettype: 'NETWORK_WIFI', udid: '0', uid: '0' },
    request: { module: 'music.musichallSong.PlayLyricInfo', method: 'GetPlayLyricInfo', param: { albumName: '', crypt: 1, ct: 19, cv: 2111, interval: 0, lrc_t: 0, qrc: 1, qrc_t: 0, roma: 1, roma_t: 0, singerName: b64((metadata.artistNames || []).join(', ')), songID: Number(qqId), songName: b64(metadata.musicNames?.[0]), trans: 1, trans_t: 0, type: 0 } }
  }) });
  if (response.code !== 0 || response.request?.code !== 0) throw new Error('QQ rejected request');
  const encrypted = response.request.data?.lyric;
  if (typeof encrypted !== 'string' || !/^(?:[a-f\d]{16})+$/i.test(encrypted)) return null;
  return canonicalLyrics(parseKaraoke(await qrcDecrypt(encrypted)), id, 'qq');
}
async function resolveAlternative(song, id, fetchImpl, { enableKugou = false } = {}) {
  const deadline = AbortSignal.timeout(7000);
  let metadata = null;
  try {
    const response = await boundedJson(fetchImpl, 'https://api.amll.dev/v1/lyrics/get?ncmMusicId=' + id, { signal: deadline, headers: { 'User-Agent': 'FoliaVRChat/0.2 (lyric-fallback)' } });
    if (response.status === 200 && response.data?.ncmMusicIds?.map(String).includes(String(id))) {
      metadata = response.data;
      if (metadata.format === 'ttml' && typeof metadata.lyrics === 'string') {
        try {
          const timeline = canonicalLyrics(parseTtml(metadata.lyrics), id, 'amll');
          try { const secondary = ttmlSecondary(metadata.lyrics, id); if (secondary) timeline.secondaryLyrics = secondary; } catch {}
          return timeline;
        } catch {}
      }
    }
  } catch {}
  if (metadata && !deadline.aborted) { try { const result = await fromQq(metadata, id, fetchImpl, deadline); if (result) return result; } catch {} }
  // Kugou search is opt-in until representative version-matching checks have been reviewed.
  if (enableKugou && song && !deadline.aborted) { try { return await fromKugou(song, id, fetchImpl, deadline); } catch {} }
  return null;
}
module.exports = { resolveAlternative, candidateMatches, fromKugou, fromQq };
