'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const path=require('node:path'),dgram=require('node:dgram'),fs=require('node:fs');
const {spawn,spawnSync}=require('node:child_process');
const {fixture,peer}=require('./helpers');
const {CameraSession,SourceServer}=require('../lib/session');
const {StreamingDelegate}=require('../lib/streaming');
const {delay}=require('../lib/async');
const {HomebridgeAPI}=require(path.join(path.dirname(process.env.HOMEBRIDGE_TEST_ENTRY||require.resolve('homebridge')),'api.js'));
const logger={info(){},warn(){},error(){},debug(){}};
const call=(fn,...args)=>new Promise((resolve,reject)=>fn(...args,(e,result)=>e?reject(e):resolve(result)));
async function setup(t,codec=5,size='320x180'){
  const f=fixture(codec,size);t.after(()=>f.close());const p=await peer('tcp',codec,f.file);t.after(()=>p.close());
  const options={port:p.ready.port,transport:'tcp',idleTimeout:0.1,maxWidth:1280,maxHeight:720,maxFPS:20,snapshotCacheSeconds:10};
  const session=new CameraSession({provision:async()=>p.provisioning},{did:'test',model:'chuangmi.camera.046c04',host:'127.0.0.1',name:'Test Camera'},options,logger);t.after(()=>session.close());
  const server=new SourceServer(new Map([['test',session]]));await server.start();t.after(()=>server.close());
  const api=new HomebridgeAPI(),delegate=new StreamingDelegate(api.hap,session,server.source('test'),'ffmpeg',options,logger);t.after(()=>delegate.close());
  return {f,p,session,server,delegate,api};
}
test('real H.265 camera produces JPEG snapshots and shares its connection with PTZ',{timeout:20000},async t=>{
  const {p,session,delegate}=await setup(t);const [one,two]=await Promise.all([call(delegate.handleSnapshotRequest.bind(delegate),{width:640,height:360}),call(delegate.handleSnapshotRequest.bind(delegate),{width:640,height:360})]);
  assert.equal(one[0],255);assert.equal(one[1],216);assert.ok(one.equals(two));await session.panTilt('right');
  const stats=await p.stats();assert.equal(stats.authentications,1);assert.equal(stats.mediaStarts,1);assert.deepEqual(stats.operations,[2]);
  const probe=spawnSync('ffprobe',['-v','error','-show_streams','-of','json','pipe:0'],{input:one,timeout:5000});assert.equal(probe.status,0);const s=JSON.parse(probe.stdout).streams[0];assert.equal(s.codec_name,'mjpeg');assert.equal(s.width,320);assert.equal(s.height,180);
  await delay(400);assert.equal(session.client,null);
});
test('HomeKit receives decryptable H.264 SRTP converted from a H.265 camera',{timeout:30000},async t=>{
  const {f,delegate}=await setup(t,5,'1920x1080');const portSocket=dgram.createSocket('udp4');await new Promise(r=>portSocket.bind(0,'127.0.0.1',r));const port=portSocket.address().port;portSocket.close();
  const key=Buffer.alloc(16,7),salt=Buffer.alloc(14,8),combined=Buffer.concat([key,salt]).toString('base64');
  const file=path.join(f.root,'receiver.sdp');
  fs.writeFileSync(file,`v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=Test\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\nm=video ${port} RTP/SAVP 99\r\na=rtpmap:99 H264/90000\r\na=fmtp:99 packetization-mode=1\r\na=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${combined}\r\n`);
  const receiver=spawn('ffmpeg',['-hide_banner','-v','error','-protocol_whitelist','file,udp,rtp,crypto','-analyzeduration','500000','-probesize','65536','-i',file,'-frames:v','5','-an','-f','image2pipe','-vcodec','mjpeg','pipe:1'],{stdio:['ignore','pipe','pipe']});t.after(()=>receiver.kill('SIGKILL'));
  const chunks=[];let stderr='';receiver.stdout.on('data',d=>chunks.push(d));receiver.stderr.on('data',d=>stderr+=d);
  const ended=new Promise(resolve=>receiver.once('close',code=>resolve(code)));await delay(300);
  const prepared=await call(delegate.prepareStream.bind(delegate),{sessionID:'srtp-test',targetAddress:'127.0.0.1',addressVersion:'ipv4',video:{port,srtpCryptoSuite:0,srtp_key:key,srtp_salt:salt}});
  assert.ok(prepared.video.port>0);
  await call(delegate.handleStreamRequest.bind(delegate),{sessionID:'srtp-test',type:'start',video:{width:1280,height:720,fps:20,pt:99,max_bit_rate:500,profile:0,level:0,mtu:1316,rtcp_interval:5}});
  let deadline;const code=await Promise.race([ended,new Promise(resolve=>{deadline=setTimeout(()=>resolve(-99),12000);})]);clearTimeout(deadline);assert.equal(code,0,stderr);const output=Buffer.concat(chunks);assert.ok(output.length>1000);assert.equal(output[0],255);assert.equal(output[1],216);
  const probe=spawnSync('ffprobe',['-v','error','-show_streams','-of','json','pipe:0'],{input:output,timeout:5000});assert.equal(probe.status,0);const decoded=JSON.parse(probe.stdout).streams[0];assert.equal(decoded.width,1280);assert.equal(decoded.height,720);
  await call(delegate.handleStreamRequest.bind(delegate),{sessionID:'srtp-test',type:'stop'});assert.equal(delegate.streams.size,0);
});
test('local media endpoint requires its secret and GET method',{timeout:10000},async t=>{
  const {server}=await setup(t,4);const wrong=await fetch(`http://127.0.0.1:${server.port}/wrong/test`);assert.equal(wrong.status,404);const post=await fetch(server.source('test'),{method:'POST'});assert.equal(post.status,404);
});
