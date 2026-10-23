const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../lib/udon-gateway');

test('persistent cache retains 100 recent requests and bounds catalogue payload', {
  skip: !process.env.LYRALUME_TEST_REDIS_BINARY, timeout: 20000
}, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lyralume-cache-test-'));
  const socket = path.join(dir, 'redis.sock');
  const proc = spawn(process.env.LYRALUME_TEST_REDIS_BINARY,
    ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const { createClient } = require('redis');
  const client = createClient({ socket: { path: socket, reconnectStrategy: false } });
  client.on('error', () => {});
  try {
    await new Promise((resolve, reject) => {
      let output = '';
      proc.stdout.on('data', chunk => { output += chunk; if (output.includes('ready to accept connections')) resolve(); });
      proc.once('error', reject);
      proc.once('exit', code => reject(new Error('Redis exited: ' + code)));
    });
    await client.connect();
    const command = args => client.sendCommand(args.map(String));
    const store = createStore(command, { LYRALUME_CACHE_MAX_SONGS: '100' });
    for (let i = 0; i < 100; i++) await store.publish({ songId: String(i), lrc: 'song-' + i });
    assert.equal(await client.ttl('netease:udon:v1:song:0'), -1);
    await store.get('0');
    await store.catalogue(); // Polling must not promote song 1 over explicitly requested song 0.
    await store.publish({ songId: '100', lrc: 'new' });
    assert.equal(await store.get('1'), null);
    assert.equal((await store.get('0')).lrc, 'song-0');
    assert.equal(await client.zCard('netease:udon:v1:catalogue'), 100);
    assert.equal((await client.keys('netease:udon:v1:song:*')).length, 100);
    const before = await store.get('0'), after = { ...before, coverThumbnailState: 'ready' };
    assert.equal(await store.updateCover(before, after), true);
    assert.equal(await client.ttl('netease:udon:v1:song:0'), -1);
    assert.equal(await store.updateCover(before, after), false);
    await Promise.all(Array.from({ length: 40 }, (_, i) => store.publish({ songId: String(i + 200), lrc: 'x'.repeat(100000) })));
    const catalogue = await store.catalogue();
    assert(catalogue.reduce((sum, song) => sum + Buffer.byteLength(JSON.stringify(song)), 0) <= 3000000);
    assert.equal(await client.zCard('netease:udon:v1:catalogue'), 100);
    assert.equal((await client.keys('netease:udon:v1:song:*')).length, 100);
    assert.throws(() => createStore(command, { LYRALUME_CACHE_MAX_SONGS: '0' }));
  } finally {
    if (client.isOpen) client.destroy();
    const exited = once(proc, 'exit');
    proc.kill('SIGTERM');
    await exited;
    await rm(dir, { recursive: true, force: true });
  }
});
