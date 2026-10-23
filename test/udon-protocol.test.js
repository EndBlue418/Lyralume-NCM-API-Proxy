'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { BASE, PARTS, SLOTS, encodeSongId, decodeParts, prebuiltUrls, partIndex } = require('../lib/udon-protocol');

test('arbitrary song ID is sent using only prebuilt URLs', () => {
  const tables = prebuiltUrls('https://example.vercel.app');
  for (const id of ['1', '2093235155', '3384000719', '999999999999']) {
    const parts = encodeSongId(id);
    const transmitted = [Number(new URL(tables.begin[parts[0]]).searchParams.get('value'))];
    for (let i = 1; i < PARTS; i++) {
      const url = new URL(tables.parts[partIndex(7, i, parts[i])]);
      assert.equal(url.searchParams.get('slot'), '7');
      assert.equal(url.searchParams.get('part'), String(i));
      transmitted.push(Number(url.searchParams.get('value')));
    }
    assert.equal(decodeParts(transmitted), id);
  }
  assert.equal(tables.begin.length, BASE);
  assert.equal(tables.parts.length, SLOTS * (PARTS - 1) * BASE);
});

test('two simultaneous requests use distinct slots and never share parts', () => {
  const ids = ['2093235155', '3384000719'];
  const data = ids.map(encodeSongId);
  const received = [[data[0][0]], [data[1][0]]];
  for (let i = 1; i < PARTS; i++) {
    for (let slot = 1; slot >= 0; slot--) received[slot].push(data[slot][i]);
  }
  assert.deepEqual(received.map(decodeParts), ids);
});

test('invalid and oversized inputs fail before sending', () => {
  for (const value of ['', '0', '-1', '12x', '1000000000000']) assert.throws(() => encodeSongId(value));
  assert.throws(() => decodeParts([1, 2]));
  assert.throws(() => decodeParts([0, 0, 0, 0]));
  assert.throws(() => partIndex(SLOTS, 1, 0));
});

test('every static URL index is unique and reversible', () => {
  const seen = new Set();
  for (let part = 1; part < PARTS; part++) for (let slot = 0; slot < SLOTS; slot++) for (let value = 0; value < BASE; value++) {
    const index = partIndex(slot, part, value);
    assert(!seen.has(index)); seen.add(index);
    assert.equal(index % BASE, value);
    assert.equal(Math.floor(index / BASE) % SLOTS, slot);
    assert.equal(Math.floor(index / BASE / SLOTS) + 1, part);
  }
  assert.equal(seen.size, 48000);
});
