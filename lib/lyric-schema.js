'use strict';
const { validate } = require('./lyric-formats');
function canonicalLyrics(normalized, songId, source) {
  if (!normalized || normalized.offsetMs || normalized.lines?.length > 2000) throw new Error('Unsupported timing/line count');
  let characters = 0, words = 0;
  for (const line of normalized.lines || []) {
    if (typeof line.text !== 'string' || !Array.isArray(line.words) || !line.words.length) throw new Error('Word timing required');
    characters += line.text.length; words += line.words.length;
    if (line.words.map(word => word.text).join('') !== line.text) throw new Error('Word text mismatch');
    for (const item of [line, ...line.words]) {
      if (!Number.isSafeInteger(item.startMs) || !Number.isSafeInteger(item.endMs) || item.endMs > 86400000 || typeof item.text !== 'string') throw new Error('Invalid timeline value');
    }
  }
  if (characters > 100000 || words > 20000 || validate(normalized).issues.length) throw new Error('Timeline validation failed');
  const envelope = { version: 1, songId: String(songId), source, timing: 'word', lines: normalized.lines };
  if (Buffer.byteLength(JSON.stringify(envelope)) > 350000) throw new Error('Timeline payload exceeded');
  return envelope;
}
module.exports = { canonicalLyrics };
