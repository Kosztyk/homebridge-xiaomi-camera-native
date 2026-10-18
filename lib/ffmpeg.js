'use strict';
const {spawn}=require('node:child_process');
const {existsSync}=require('node:fs');
const {ProtocolError}=require('./errors');
function ffmpegPath(configured) {
  if(configured) return configured;
  try {const bundled=require('ffmpeg-for-homebridge');if(typeof bundled==='string'&&existsSync(bundled))return bundled;}catch{}
  return 'ffmpeg';
}
async function checkFFmpeg(binary) {
  return new Promise((resolve,reject)=>{
    const child=spawn(binary,['-hide_banner','-encoders'],{stdio:['ignore','pipe','ignore']});let out='';
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new ProtocolError('FFmpeg did not respond'));},10000);
    child.stdout.on('data',d=>{if(out.length<512000)out+=d;});
    child.once('error',()=>{clearTimeout(timer);reject(new ProtocolError('FFmpeg was not found; install ffmpeg or configure its path'));});
    child.once('close',code=>{clearTimeout(timer);if(code!==0||!out.includes('libx264'))reject(new ProtocolError('FFmpeg must include the libx264 encoder'));else resolve();});
  });
}
function scaleFilter(width,height) {
  return `scale=w='min(iw,${width})':h='min(ih,${height})':force_original_aspect_ratio=decrease:force_divisible_by=2`;
}
function inputArgs(source) {return ['-hide_banner','-loglevel','error','-nostdin','-fflags','+genpts+discardcorrupt','-flags','low_delay','-rw_timeout','15000000','-analyzeduration','500000','-probesize','65536','-f','mpegts','-i',source];}
function captureSnapshot(binary,source,width,height,onChild) {
  return new Promise((resolve,reject)=>{
    const child=spawn(binary,[...inputArgs(source),'-map','0:v:0','-an','-sn','-dn','-vf',scaleFilter(width,height),'-frames:v','1','-q:v','3','-f','image2pipe','-vcodec','mjpeg','pipe:1'],{stdio:['ignore','pipe','ignore']});
    onChild?.(child);const chunks=[];let bytes=0,finished=false;
    const done=(error,data)=>{if(finished)return;finished=true;clearTimeout(timer);if(error)reject(error);else resolve(data);};
    const timer=setTimeout(()=>{child.kill('SIGKILL');done(new ProtocolError('Camera snapshot timed out; check camera connectivity'));},12500);
    child.stdout.on('data',data=>{bytes+=data.length;if(bytes>8*1024*1024){child.kill('SIGKILL');done(new ProtocolError('Camera snapshot exceeded its size limit'));}else chunks.push(data);});
    child.once('error',()=>done(new ProtocolError('Could not start FFmpeg for the camera snapshot')));
    child.once('close',code=>{const data=Buffer.concat(chunks);if(code!==0||data.length<4||data[0]!==255||data[1]!==216)done(new ProtocolError('FFmpeg could not decode a camera snapshot'));else done(null,data);});
  });
}
function streamArgs(source,info,video,options={}) {
  const width=Math.max(160,Math.min(video.width||1280,options.maxWidth||1280));
  const height=Math.max(120,Math.min(video.height||720,options.maxHeight||720));
  const fps=Math.max(1,Math.min(video.fps||20,options.maxFPS||20));
  const bitrate=Math.max(64,Math.min(video.max_bit_rate||1000,options.maxBitrate||1500));
  const address=info.ipv6?`[${info.address}]`:info.address;
  const suite='AES_CM_128_HMAC_SHA1_80';
  return [...inputArgs(source),'-map','0:v:0','-an','-sn','-dn','-vf',scaleFilter(width,height),
    '-c:v','libx264','-preset','ultrafast','-tune','zerolatency','-pix_fmt','yuv420p','-profile:v',['baseline','main','high'][video.profile]||'baseline',
    '-level:v',['3.1','3.2','4.0'][video.level]||'3.1','-r',String(fps),'-g',String(fps*2),'-keyint_min',String(fps),'-bf','0',
    '-b:v',`${bitrate}k`,'-maxrate',`${bitrate}k`,'-bufsize',`${bitrate*2}k`,'-threads',String(options.encoderThreads||2),
    '-payload_type',String(video.pt),'-ssrc',String(info.ssrc),'-f','rtp','-srtp_out_suite',suite,'-srtp_out_params',info.key.toString('base64'),
    `srtp://${address}:${info.videoPort}?rtcpport=${info.videoPort}&pkt_size=${Math.max(188,Math.min(video.mtu||1316,1316))}`,
    '-progress','pipe:1','-nostats'];
}
module.exports={ffmpegPath,checkFFmpeg,captureSnapshot,streamArgs,inputArgs,scaleFilter};
