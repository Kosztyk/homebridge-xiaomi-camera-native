'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {MissClient}=require('../lib/miss');
const {DataChannel}=require('../lib/cs2');
const {fixture,peer}=require('./helpers');
const {delay}=require('../lib/async');
for(const transport of ['udp','tcp'])test(`Node MISS interoperates with original Python peer over ${transport.toUpperCase()}`,{timeout:20000},async t=>{
  const f=fixture(4);t.after(()=>f.close());const p=await peer(transport,4,f.file);t.after(()=>p.close());
  const client=await MissClient.connect('127.0.0.1',p.provisioning,{port:p.ready.port,transport,model:'chuangmi.camera.046c04'});t.after(()=>client.close());
  for(let i=0;i<8;i++){const packet=await client.readVideo();assert.equal(packet.codec,4);assert.equal(packet.sequence,i);assert.ok(packet.payload.equals(f.frames[i]));}
  await client.panTilt('left');await client.panTilt('up');await client.panTilt('right');await client.panTilt('down');await delay(1100);
  const stats=await p.stats();assert.equal(stats.authentications,1);assert.equal(stats.mediaStarts,1);assert.equal(stats.quality,3);assert.deepEqual(stats.operations,[1,3,2,4]);assert.ok(stats.pings>=1);
});
test('control-only session sends one motor command without starting video',{timeout:15000},async t=>{
  const f=fixture(4);t.after(()=>f.close());const p=await peer('udp',4,f.file);t.after(()=>p.close());
  const c=await MissClient.connect('127.0.0.1',p.provisioning,{port:p.ready.port,startVideo:false});t.after(()=>c.close());await c.panTilt('left');
  const stats=await p.stats();assert.equal(stats.mediaStarts,0);assert.deepEqual(stats.operations,[1]);
});
test('UDP reassembly handles wraparound, duplicates and reordering',async()=>{
  const c=new DataChannel();c.expected=65535;const data=Buffer.from([0,0,0,4,10,20,30,40]);
  assert.equal(c.feedSequence(0,data.subarray(4)),true);assert.equal(c.feedSequence(65535,data.subarray(0,4)),true);assert.deepEqual(await c.queue.shift(100),Buffer.from([10,20,30,40]));assert.equal(c.feedSequence(65535,data.subarray(0,4)),true);assert.equal(c.queue.items.length,0);assert.equal(c.expected,1);
});
test('invalid frame lengths and out-of-window sequences are bounded',()=>{
  const c=new DataChannel();assert.throws(()=>c.feed(Buffer.from([255,255,255,255])));assert.equal(new DataChannel().feedSequence(1000,Buffer.from([1])),false);
});
