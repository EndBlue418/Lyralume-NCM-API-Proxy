'use strict';
const { xml2js } = require('xml-js');
const FIELDS = ['tlyric', 'romalrc', 'ytlrc', 'yromalrc'];
const MAX_SECONDARY_BYTES = 120000;
function neteaseSecondary(lyrics) {
  const result = {};
  let bytes = 0;
  for (const field of FIELDS) {
    const candidate = typeof lyrics?.[field] === 'string' ? lyrics[field] : lyrics?.[field]?.lyric;
    const text = typeof candidate === 'string' ? candidate : '';
    const size = Buffer.byteLength(text);
    result[field] = size + bytes <= MAX_SECONDARY_BYTES ? text : '';
    if (result[field]) bytes += size;
  }
  return result;
}
function milliseconds(value) {
  const text = String(value ?? '').trim();
  if (/^\d+(?:\.\d+)?ms$/.test(text)) return Math.round(parseFloat(text));
  if (/^\d+(?:\.\d+)?s?$/.test(text)) return Math.round(parseFloat(text) * 1000);
  if (/^\d+(?::\d{2}){1,2}(?:\.\d+)?$/.test(text)) return Math.round(text.split(':').reduce((sum, part) => sum * 60 + Number(part), 0) * 1000);
  return NaN;
}
const role = node => node.attributes?.['ttm:role'];
function content(node, root = false) {
  if (!root && ['x-bg', 'x-translation', 'x-roman'].includes(role(node))) return '';
  if (node.type === 'text' || node.type === 'cdata') return node.text || node.cdata || '';
  if ((node.name || '').split(':').pop() === 'br') return '\n';
  return (node.elements || []).map(child => content(child)).join('');
}
function ttmlSecondary(xml, songId) {
  if (typeof xml !== 'string' || Buffer.byteLength(xml) > 1500000 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw Error('Unsupported secondary XML');
  const root = xml2js(xml, { compact: false, captureSpacesBetweenElements: true });
  const tracks = new Map();
  let bytes = 0, count = 0;
  function walk(node, window) {
    if (role(node) === 'x-bg') return;
    const attrs = node.attributes || {};
    const start = attrs.begin === undefined ? window?.startMs : milliseconds(attrs.begin);
    const end = attrs.end === undefined ? window?.endMs : milliseconds(attrs.end);
    const current = { startMs: start, endMs: end };
    const kind = role(node) === 'x-translation' ? 'translation' : role(node) === 'x-roman' ? 'romanization' : null;
    if (kind) {
      const text = content(node, true).trim();
      const size = Buffer.byteLength(text);
      if (!text || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > 86400000 || size > 16000 || count >= 2000 || bytes + size > MAX_SECONDARY_BYTES) return;
      const language = typeof attrs['xml:lang'] === 'string' && /^[a-zA-Z0-9-]{1,35}$/.test(attrs['xml:lang']) ? attrs['xml:lang'] : undefined;
      const key = kind + ':' + (language || 'unknown');
      if (!tracks.has(key)) tracks.set(key, { kind, ...(language ? { language } : {}), timing: 'line', lines: [] });
      tracks.get(key).lines.push({ startMs: start, endMs: end, text });
      count++; bytes += size;
      return; // Do not duplicate nested secondary spans or invent per-word timing.
    }
    for (const child of node.elements || []) walk(child, current);
  }
  walk(root, null);
  if (!tracks.size) return undefined;
  const result = { version: 1, songId: String(songId), source: 'amll', tracks: [...tracks.values()] };
  for (const track of result.tracks) track.lines.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  return Buffer.byteLength(JSON.stringify(result)) <= MAX_SECONDARY_BYTES ? result : undefined;
}
function stripSecondary(data) {
  for (const key of [...FIELDS, 'secondaryLyrics']) delete data[key];
}
module.exports = { FIELDS, MAX_SECONDARY_BYTES, neteaseSecondary, ttmlSecondary, stripSecondary };
