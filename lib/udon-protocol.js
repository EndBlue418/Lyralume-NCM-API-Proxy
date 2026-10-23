'use strict';

// Every URL used by Udon is generated in Unity's editor. Runtime only selects
// an existing VRCUrl. Base 1000 supports all IDs up to twelve decimal digits.
const BASE = 1000;
const PARTS = 4;
const SLOTS = 16;
const LEASE_SECONDS = 120;

function encodeSongId(songId) {
  if (!/^[1-9]\d{0,11}$/.test(String(songId))) throw new Error('Invalid song ID');
  const padded = String(songId).padStart(PARTS * 3, '0');
  return Array.from({ length: PARTS }, (_, i) => Number(padded.slice(i * 3, i * 3 + 3)));
}

function decodeParts(parts) {
  if (parts.length !== PARTS || parts.some(value => !Number.isInteger(value) || value < 0 || value >= BASE)) {
    throw new Error('Incomplete or invalid parts');
  }
  const id = parts.map(value => String(value).padStart(3, '0')).join('').replace(/^0+/, '');
  if (!id) throw new Error('Invalid song ID');
  return id;
}

function prebuiltUrls(origin) {
  const begin = Array.from({ length: BASE }, (_, head) => `${origin}/api/udon?op=begin&value=${head}`);
  const parts = Array.from({ length: SLOTS * (PARTS - 1) * BASE }, (_, index) => {
    const value = index % BASE;
    const slot = Math.floor(index / BASE) % SLOTS;
    const part = Math.floor(index / BASE / SLOTS) + 1;
    return `${origin}/api/udon?op=part&slot=${slot}&part=${part}&value=${value}`;
  });
  return { begin, parts };
}

function partIndex(slot, part, value) {
  if (!Number.isInteger(slot) || slot < 0 || slot >= SLOTS || !Number.isInteger(part) || part < 1 || part >= PARTS ||
      !Number.isInteger(value) || value < 0 || value >= BASE) throw new Error('Invalid part URL index');
  return ((part - 1) * SLOTS + slot) * BASE + value;
}

// These scripts run atomically in Redis, so concurrent Vercel invocations cannot
// overwrite another allocated slot or combine fragments from different leases.
const ALLOCATE_LUA = `
for i=0,tonumber(ARGV[1])-1 do
  local key=KEYS[1]..i
  if redis.call('EXISTS',key)==0 then
    redis.call('HSET',key,'head',ARGV[2],'next',1,'status','building')
    redis.call('EXPIRE',key,ARGV[3])
    return i
  end
end
return -1`;

const APPEND_LUA = `
local key=KEYS[1]
if redis.call('EXISTS',key)==0 then return {'expired'} end
local status=redis.call('HGET',key,'status')
local part=tonumber(ARGV[1])
local field='part'..part
local old=redis.call('HGET',key,field)
if old then
  if old~=ARGV[2] then return {'conflict'} end
  return {status,redis.call('HGET',key,'songId') or ''}
end
if status~='building' or tonumber(redis.call('HGET',key,'next'))~=part then
  return {'out_of_order'}
end
redis.call('HSET',key,field,ARGV[2],'next',part+1)
if part<tonumber(ARGV[3])-1 then return {'building'} end
local id=string.format('%03d',tonumber(redis.call('HGET',key,'head')))
for i=1,tonumber(ARGV[3])-1 do
  id=id..string.format('%03d',tonumber(redis.call('HGET',key,'part'..i)))
end
id=string.gsub(id,'^0+','')
if id=='' then return {'invalid'} end
redis.call('HSET',key,'status','loading','songId',id)
return {'complete',id}`;

module.exports = { BASE, PARTS, SLOTS, LEASE_SECONDS, encodeSongId, decodeParts, prebuiltUrls, partIndex, ALLOCATE_LUA, APPEND_LUA };
