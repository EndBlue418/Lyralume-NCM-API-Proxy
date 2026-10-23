'use strict';
const TEST_UPSTREAM_ENV = { NETEASE_API_URL: 'https://ncm.example.test' };
const test = require('node:test');
const assert = require('node:assert/strict');
const { PNG } = require('pngjs');
const { createCoverRecovery, hasThumbnail, RETRY_MS } = require('../lib/cover-recovery');
const { createHandler } = require('../lib/udon-gateway');
const { fetchThumbnail } = require('../lib/cover-thumbnail');
function song(id='1') { return { songId:id, lrc:'original lyrics', secondaryLyricsVersion:1,coverUrl:'https://p3.music.126.net/test.jpg' }; }
function image() { const p=new PNG({width:1,height:1});p.data=Buffer.from([240,80,20,255]);return new Response(PNG.sync.write(p)); }
function storeFor(initial) { let cache=initial;return { get:async()=>cache,publish:async value=>{cache=value;},catalogue:async()=>[cache],current:()=>cache }; }
async function request(handler,query) { let result,status;await handler({method:'GET',query},{setHeader(){},status(n){status=n;return this;},json(data){result=data;}});return {result,status}; }
test('cached missing thumbnail is repaired without refetching lyrics; healthy cover is reused',async()=>{
 let calls=0;const store=storeFor(song());const repair=createCoverRecovery({ ...TEST_UPSTREAM_ENV, },async url=>{calls++;assert(url.includes('music.126.net'));return image();});
 const repaired=await repair(store.current(),store);assert(hasThumbnail(repaired));assert.equal(repaired.lrc,'original lyrics');await repair(repaired,store);assert.equal(calls,1);
});
test('transient image error retries once and uses a longer bounded timeout',async()=>{
 let calls=0;const result=await fetchThumbnail({id:1,al:{picUrl:song().coverUrl}},'1',async(url,options)=>{assert(options.signal);if(++calls===1)throw Error('transient');return image();});assert.equal(calls,2);assert.equal(result.pixels.length,24576);
});
test('failure keeps lyrics and persists cooldown; later request recovers',async()=>{
 let time=1000,calls=0,fail=true;const store=storeFor(song());const repair=createCoverRecovery({ ...TEST_UPSTREAM_ENV, },async()=>{calls++;if(fail)throw Error('offline');return image();},()=>time);
 const failed=await repair(store.current(),store);assert.equal(failed.lrc,'original lyrics');assert.equal(failed.coverThumbnailRetryAt,time+RETRY_MS);await repair(failed,store);assert.equal(calls,3);
 time+=RETRY_MS+1;fail=false;assert(hasThumbnail(await repair(store.current(),store)));assert.equal(calls,4);
});
test('concurrent callers share the same image work and cross-instance retry lease is respected',async()=>{
 let calls=0;const store=storeFor(song());const repair=createCoverRecovery({ ...TEST_UPSTREAM_ENV, },async()=>{calls++;await new Promise(resolve=>setTimeout(resolve,10));return image();});await Promise.all([repair(store.current(),store),repair(store.current(),store)]);assert.equal(calls,1);
 const leased=storeFor(song('2'));leased.claimCoverRetry=async()=>false;await repair(leased.current(),leased);assert.equal(calls,1);
});
test('disabled thumbnail feature and untrusted URLs never fetch',async()=>{
 let calls=0;const fetcher=async()=>{calls++;return image();};const store=storeFor(song());await createCoverRecovery({ ...TEST_UPSTREAM_ENV, FOLIA_COVER_THUMBNAIL:'0'},fetcher)(song(),store);await createCoverRecovery({ ...TEST_UPSTREAM_ENV, },fetcher)({...song(),coverUrl:'https://example.com/x'},store);assert.equal(calls,0);
});
test('catalogue repairs at most two songs while leaving primary timelines intact',async()=>{
 const cache=new Map(['1','2','3'].map(id=>[id,song(id)]));let calls=0;const store={catalogue:async()=>[...cache.values()],publish:async data=>cache.set(data.songId,data)};
 const handler=createHandler({env:{},store,fetchImpl:async()=>{calls++;return image();}});const first=await request(handler,{op:'catalogue'});assert.equal(first.status,200);assert.equal(calls,2);assert.equal(first.result.songs.filter(hasThumbnail).length,2);assert(first.result.songs.every(s=>s.lrc==='original lyrics'));
 const second=await request(handler,{op:'catalogue'});assert.equal(calls,3);assert.equal(second.result.songs.filter(hasThumbnail).length,3);
});
test('compare-and-swap retry merges cover into newer lyrics rather than overwriting them',async()=>{
 const store=storeFor(song());let attempts=0;store.updateCover=async(before,after)=>{if(++attempts===1){await store.publish({...song(),lrc:'new lyrics'});return false;}assert.equal(after.lrc,'new lyrics');await store.publish(after);return true;};
 const repaired=await createCoverRecovery({ ...TEST_UPSTREAM_ENV, },async()=>image())(song(),store);assert.equal(repaired.lrc,'new lyrics');assert(hasThumbnail(repaired));assert.equal(attempts,2);
});
test('malformed or cross-song thumbnails are not accepted; oversized enrichment keeps primary data',async()=>{
 const invalid={...song(),coverThumbnail:{version:1,songId:'2',width:64,height:64,encoding:'rgb24-hex-top-down',pixels:'f'.repeat(24576)}};assert(!hasThumbnail(invalid));const large={...song(),lrc:'x'.repeat(490000)};const store=storeFor(large);const result=await createCoverRecovery({ ...TEST_UPSTREAM_ENV, },async()=>image())(large,store);assert.equal(result.lrc,large.lrc);assert.equal(result.coverThumbnail,undefined);
});

test('image retry uses another trusted CDN node with browser image headers',async()=>{
 const urls=[];const result=await fetchThumbnail({id:1,al:{picUrl:song().coverUrl}},'1',async(url,options)=>{urls.push(url);assert.equal(options.headers.Referer,'https://music.163.com/');if(urls.length<3)return new Response('',{status:403});return image();});
 assert.equal(urls.length,3);assert.equal(new URL(urls[0]).hostname,'p3.music.126.net');assert.equal(new URL(urls[2]).hostname,'p1.music.126.net');assert.equal(result.pixels.length,24576);
});
test('missing cached cover metadata is repaired by identity-checked song metadata',async()=>{
 const original={...song(),coverUrl:''};const store=storeFor(original);let metadataCalls=0;const repair=createCoverRecovery({ ...TEST_UPSTREAM_ENV, },async url=>{if(url.includes('/song/detail')){metadataCalls++;return Response.json({code:200,songs:[{id:1,al:{picUrl:song().coverUrl,name:'Album'}}]});}return image();});
 const repaired=await repair(original,store);assert.equal(metadataCalls,1);assert(hasThumbnail(repaired));assert.equal(repaired.albumName,'Album');assert.equal(repaired.lrc,original.lrc);
});
test('cover failure retains a bounded diagnostic code without upstream details',async()=>{
 const store=storeFor(song());const failed=await createCoverRecovery({ ...TEST_UPSTREAM_ENV, },async()=>new Response('',{status:403}))(song(),store);assert.equal(failed.coverThumbnailError,'http-403');assert.equal(failed.lrc,'original lyrics');
});
