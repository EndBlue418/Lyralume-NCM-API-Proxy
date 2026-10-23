'use strict';
// Persistent, bounded LRU for self-hosted Redis. Catalogue polling never touches recency.
const PREFIX = 'netease:udon:v1:';
const TRIM = `
local excess=redis.call('ZCARD',KEYS[2])-tonumber(ARGV[3])
if excess>0 then
  local old=redis.call('ZRANGE',KEYS[2],0,excess-1)
  for _,id in ipairs(old) do
    redis.call('DEL',ARGV[4]..id)
    redis.call('ZREM',KEYS[2],id)
  end
end`;
const TOUCH = `
local raw=redis.call('GET',KEYS[1])
if raw then
  redis.call('PERSIST',KEYS[1])
  redis.call('ZADD',KEYS[2],redis.call('INCR',KEYS[3]),ARGV[1])
end
${TRIM}
return raw`;
const PUBLISH = `
redis.call('SET',KEYS[1],ARGV[2])
redis.call('ZADD',KEYS[2],redis.call('INCR',KEYS[3]),ARGV[1])
${TRIM}
return 1`;

function createSongCache(command, limit) {
  const keys = id => [PREFIX + 'song:' + id, PREFIX + 'catalogue', PREFIX + 'cache-clock'];
  return {
    get: async id => {
      const raw = await command(['EVAL', TOUCH, 3, ...keys(id), id, '', limit, PREFIX + 'song:']);
      return raw ? JSON.parse(raw) : null;
    },
    publish: data => command(['EVAL', PUBLISH, 3, ...keys(data.songId),
      data.songId, JSON.stringify(data), limit, PREFIX + 'song:']),
    catalogue: async () => {
      const ids = await command(['ZREVRANGE', PREFIX + 'catalogue', 0, limit - 1]);
      if (!ids.length) return [];
      const values = await command(['MGET', ...ids.map(id => PREFIX + 'song:' + id)]);
      const songs = [];
      let bytes = 0;
      for (const raw of values) {
        if (!raw || bytes + Buffer.byteLength(raw) > 3000000) continue;
        bytes += Buffer.byteLength(raw);
        songs.push(JSON.parse(raw));
      }
      return songs;
    }
  };
}
module.exports = { createSongCache };
