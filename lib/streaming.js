'use strict';
const dgram=require('node:dgram');
const net=require('node:net');
const {spawn}=require('node:child_process');
const {captureSnapshot,streamArgs}=require('./ffmpeg');
const {ProtocolError,safeError}=require('./errors');
class StreamingDelegate {
  constructor(hap,session,source,binary,options,log) {
    this.hap=hap;this.session=session;this.source=source;this.binary=binary;this.options=options;this.log=log;
    this.streams=new Map();this.snapshots=new Map();this.snapshotChildren=new Set();this.closed=false;
    this.controller=new hap.CameraController({cameraStreamCount:Math.min(2,options.maxStreams||2),delegate:this,
      streamingOptions:{supportedCryptoSuites:[hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],video:{codec:{profiles:[hap.H264Profile.BASELINE,hap.H264Profile.MAIN,hap.H264Profile.HIGH],levels:[hap.H264Level.LEVEL3_1,hap.H264Level.LEVEL3_2,hap.H264Level.LEVEL4_0]},
        resolutions:[[320,180,15],[320,240,15],[480,270,15],[640,360,20],[640,480,20],[1280,720,20]]
          .filter(([w,h])=>w<=(options.maxWidth||1280)&&h<=(options.maxHeight||720))
          .map(([w,h,f])=>[w,h,Math.min(f,options.maxFPS||20)])}}});
  }
  handleSnapshotRequest(request,callback) {
    if(this.closed){callback(new Error('Camera is shutting down'));return;}
    const width=Math.max(160,Math.min(request.width||640,this.options.maxWidth||1280)),height=Math.max(120,Math.min(request.height||360,this.options.maxHeight||720));
    const key=`${width}x${height}`;let entry=this.snapshots.get(key);
    if(!entry||Date.now()-entry.at>(this.options.snapshotCacheSeconds??10)*1000) {
      const promise=captureSnapshot(this.binary,this.source,width,height,child=>{this.snapshotChildren.add(child);child.once('close',()=>this.snapshotChildren.delete(child));});
      entry={at:Date.now(),promise};this.snapshots.set(key,entry);
      if(this.snapshots.size>8)this.snapshots.delete(this.snapshots.keys().next().value);
      promise.catch(()=>{if(this.snapshots.get(key)?.promise===promise)this.snapshots.delete(key);});
    }
    entry.promise.then(data=>callback(undefined,data),error=>callback(new Error(safeError(error))));
  }
  prepareStream(request,callback) {
    this.prepare(request).then(response=>callback(undefined,response),e=>callback(new Error(safeError(e))));
  }
  async prepare(request) {
    if(this.closed)throw new ProtocolError('Camera is shutting down');
    if(!net.isIP(request.targetAddress)||request.video.srtpCryptoSuite!==0||request.video.srtp_key?.length!==16||request.video.srtp_salt?.length!==14)throw new ProtocolError('Unsupported HomeKit stream parameters');
    this.stop(request.sessionID);
    if(this.streams.size>=(this.options.maxStreams||2))throw new ProtocolError('Camera has reached its viewer limit');
    const socket=dgram.createSocket(request.addressVersion==='ipv6'?'udp6':'udp4');
    const info={address:request.targetAddress,ipv6:request.addressVersion==='ipv6',videoPort:request.video.port,key:Buffer.concat([request.video.srtp_key,request.video.srtp_salt]),ssrc:this.hap.CameraController.generateSynchronisationSource(),socket};
    this.streams.set(request.sessionID,info);
    socket.on('error',()=>{this.log.warn(`${this.session.device.name}: HomeKit RTCP socket failed`);this.forceStop(request.sessionID);});
    try {
      await new Promise((resolve,reject)=>{socket.once('error',reject);socket.bind(0,info.ipv6?'::':'0.0.0.0',resolve);});
      if(this.closed||this.streams.get(request.sessionID)!==info)throw new ProtocolError('HomeKit stream was cancelled');
      info.returnPort=socket.address().port;
      socket.on('message',(_data,peer)=>{if(peer.address===info.address)this.armWatchdog(request.sessionID,info);});
      info.preparedTimeout=setTimeout(()=>this.stop(request.sessionID),30000);info.preparedTimeout.unref();
      return {video:{port:info.returnPort,ssrc:info.ssrc,srtp_key:request.video.srtp_key,srtp_salt:request.video.srtp_salt}};
    } catch(e) {this.stop(request.sessionID);throw e;}
  }
  handleStreamRequest(request,callback) {
    if(request.type==='stop'){this.stop(request.sessionID);callback();return;}
    const info=this.streams.get(request.sessionID);
    if(!info){callback(new Error('HomeKit camera session was not prepared'));return;}
    if(request.type==='start') {
      info.video={...request.video};this.start(request.sessionID,info,callback);
    } else if(request.type==='reconfigure') {
      info.video={...info.video,...request.video};this.killEncoder(info);this.start(request.sessionID,info,callback);
    } else callback(new Error('Unsupported HomeKit streaming request'));
  }
  armWatchdog(id,info) {
    if(this.streams.get(id)!==info)return;
    clearTimeout(info.watchdog);const timeout=Math.max(30000,Math.min((info.video?.rtcp_interval||5)*5000,300000));
    info.watchdog=setTimeout(()=>this.forceStop(id),timeout);info.watchdog.unref();
  }
  start(id,info,callback) {
    clearTimeout(info.preparedTimeout);let settled=false;
    const done=error=>{if(settled)return;settled=true;clearTimeout(info.startTimeout);info.startCallback=null;callback(error);};
    info.startCallback=done;this.armWatchdog(id,info);
    const child=spawn(this.binary,streamArgs(this.source,info,info.video,this.options),{stdio:['ignore','pipe','pipe']});info.child=child;
    // Never print FFmpeg arguments or stderr: they can contain SRTP keys or source secrets.
    child.stderr.resume();let progress='';
    info.startTimeout=setTimeout(()=>{done(new Error('Camera did not produce video in time'));this.forceStop(id);},18000);info.startTimeout.unref();
    child.stdout.on('data',chunk=>{
      progress=(progress+chunk.toString()).slice(-8192);
      if(/(?:^|\n)frame=\s*[1-9]\d*/.test(progress))done();
    });
    child.once('error',()=>{done(new Error('FFmpeg could not start the HomeKit camera stream'));if(this.streams.get(id)?.child===child)this.forceStop(id);});
    child.once('close',()=>{
      if(info.child!==child)return;
      done(new Error('FFmpeg stopped before the camera stream was ready'));this.forceStop(id);
    });
  }
  killEncoder(info) {
    clearTimeout(info.startTimeout);
    if(info.startCallback)info.startCallback(new Error('HomeKit camera stream was stopped'));
    const child=info.child;info.child=null;
    if(child) {
      child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),2000);timer.unref();child.once('close',()=>clearTimeout(timer));
    }
  }
  stop(id) {
    const info=this.streams.get(id);if(!info)return;
    this.streams.delete(id);clearTimeout(info.preparedTimeout);clearTimeout(info.watchdog);this.killEncoder(info);
    try{info.socket.close();}catch{}
    info.key.fill(0);
  }
  forceStop(id) {if(!this.streams.has(id))return;this.stop(id);try{this.controller.forceStopStreamingSession(id);}catch{}}
  close() {this.closed=true;for(const id of [...this.streams.keys()])this.stop(id);for(const c of this.snapshotChildren)c.kill('SIGKILL');this.snapshots.clear();}
}
module.exports={StreamingDelegate};
