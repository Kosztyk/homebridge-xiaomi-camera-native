'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {MpegTsMuxer,crc32Mpeg}=require('../lib/media');
const {fixture}=require('./helpers');
test('MPEG CRC agrees with published check value',()=>assert.equal(crc32Mpeg(Buffer.from('123456789')),0x0376e6e7));
for(const codec of [4,5])test(`${codec===4?'H.264':'H.265'} MPEG-TS decodes in real FFmpeg with monotonic timestamps`,{timeout:20000},t=>{
  const f=fixture(codec);t.after(()=>f.close());const mux=new MpegTsMuxer(),outputs=[];
  f.frames.forEach((payload,i)=>{const r=mux.feed({codec,timestampMs:[1000,1000,900,900000000,0][i%5],payload});if(r)outputs.push(r.data);});
  const data=Buffer.concat(outputs);assert.equal(data.length%188,0);for(let i=0;i<data.length;i+=188)assert.equal(data[i],0x47);
  const probe=spawnSync('ffprobe',['-v','error','-show_streams','-show_packets','-of','json','pipe:0'],{input:data,timeout:10000});assert.equal(probe.status,0,probe.stderr.toString());
  const info=JSON.parse(probe.stdout);assert.equal(info.streams[0].codec_name,codec===4?'h264':'hevc');assert.equal(info.streams[0].width,320);
  const pts=info.packets.filter(p=>p.pts).map(p=>Number(p.pts));assert.ok(pts.length>=35);assert.ok(pts.every((p,i)=>i===0||p>pts[i-1]));
  const decode=spawnSync('ffmpeg',['-v','error','-i','pipe:0','-f','null','-'],{input:data,timeout:10000});assert.equal(decode.status,0);assert.equal(decode.stderr.toString(),'');
});
