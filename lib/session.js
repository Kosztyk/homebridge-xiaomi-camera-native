'use strict';
const http=require('node:http');
const {randomBytes}=require('node:crypto');
const {Mutex}=require('./async');
const {validIPv4}=require('./cs2');
const {MissClient,PAN_TILT_MODELS}=require('./miss');
const {MpegTsMuxer}=require('./media');
const {ProtocolError,TransportError,AuthenticationError,safeError}=require('./errors');
class CameraSession {
  constructor(cloud,device,options={},log={debug(){},warn(){}},addressResolver) {
    this.cloud=cloud;this.device=device;this.options=options;this.log=log;this.lifecycle=new Mutex();this.consumers=new Set();
    this.closed=false;this.gop=[];this.gopBytes=0;this.frames=0;this.reconnects=0;this.status='idle';this.mediaStarted=false;
    this.addressResolver=addressResolver;
    this.host=(options.autoUpdateIp!==false&&addressResolver?.knownAddress(device))||options.host||device.host||'';
    this.addressUpdates=0;
  }
  async *addressCandidates() {
    const automatic=this.options.autoUpdateIp!==false;
    const first=automatic?this.host||this.options.host||this.device.host:this.options.host||this.host||this.device.host;
    if(validIPv4(first))yield first;
    if(!automatic)return;
    if(validIPv4(this.options.host)&&this.options.host!==first)yield this.options.host;
    if(validIPv4(this.device.host)&&this.device.host!==first)yield this.device.host;
    if(this.addressResolver){const host=await this.addressResolver.cloudAddress(this.device);if(host)yield host;}
  }
  async connectClient(startVideo) {
    if(this.closed) throw new TransportError('Camera session is shut down');
    if(this.client&&!this.client.connection.closed&&!this.client.connection.error) {
      if(startVideo&&!this.mediaStarted) {await this.client.startMedia(this.device.model,this.quality());this.mediaStarted=true;}
      return this.client;
    }
    this.client?.close();this.client=null;this.mediaStarted=false;
    const attempted=new Set();let lastError=new TransportError('No current camera IPv4 address was discovered');
    for await(const host of this.addressCandidates()) {
      if(this.closed)throw new TransportError('Camera session is shut down');
      if(attempted.has(host))continue;attempted.add(host);
      // Account/provisioning failures are not evidence of a changed IP.
      const provision=await this.cloud.provision(this.device);
      if(this.closed)throw new TransportError('Camera session is shut down');
      let client;
      try {client=await MissClient.connect(host,provision,{transport:this.options.transport||'auto',quality:this.quality(),model:this.device.model,port:this.options.port||32108,startVideo});}
      catch(error){if(error instanceof ProtocolError||error instanceof TransportError){lastError=error;continue;}throw error;}
      if(this.closed){client.close();throw new TransportError('Camera session is shut down');}
      const changed=this.host!==host;this.host=host;this.device.host=host;
      if(changed){this.addressUpdates++;this.log.debug(`${this.device.name}: recovered camera LAN address`);}
      if(this.options.autoUpdateIp!==false&&this.addressResolver) {
        try{if(changed||this.addressResolver.knownAddress(this.device)!==host)await this.addressResolver.confirm(this.device,host);}
        catch{this.log.warn(`${this.device.name}: could not save the working camera IP`);}
      }
      if(this.closed){client.close();throw new TransportError('Camera session is shut down');}
      this.client=client;this.mediaStarted=startVideo;this.transport=client.connection.protocol;return client;
    }
    throw lastError;
  }
  quality() {return this.options.quality||(this.device.model==='mxiang.camera.c301'?'auto':'hd');}
  subscribe(write,end=()=>{}) {
    if(this.closed) throw new TransportError('Camera session is shut down');
    clearTimeout(this.idleTimer);this.idleTimer=null;
    const subscriber={write,end};this.consumers.add(subscriber);
    if(this.gop.length&&Date.now()-this.gopAt<5000) {
      try{write(Buffer.concat(this.gop));}catch(e){this.consumers.delete(subscriber);throw e;}
    }
    this.ensureRunning();let unsubscribed=false;
    return ()=>{
      if(unsubscribed) return;unsubscribed=true;this.consumers.delete(subscriber);
      if(!this.consumers.size&&!this.closed) {
        this.idleTimer=setTimeout(()=>{
          this.idleTimer=null;this.wakeRetry?.();
          this.lifecycle.run(()=>{if(!this.consumers.size) {this.client?.close();this.client=null;this.mediaStarted=false;this.clearGop();this.status='idle';}}).catch(()=>{});
        },(this.options.idleTimeout??15)*1000);this.idleTimer.unref();
      }
    };
  }
  ensureRunning() {
    if(this.runner||this.closed) return;
    this.runner=this.run().catch(e=>this.finish(e)).finally(()=>{
      this.runner=null;
      if(this.consumers.size&&!this.closed) this.ensureRunning();
    });
  }
  clearGop() {this.gop=[];this.gopBytes=0;}
  publish(result) {
    if(result.keyframe) {this.clearGop();this.gopAt=Date.now();}
    if((result.keyframe||this.gop.length)&&this.gopBytes+result.data.length<=6*1024*1024) {this.gop.push(result.data);this.gopBytes+=result.data.length;}
    else this.clearGop();
    for(const s of [...this.consumers]) {
      try {s.write(result.data);} catch(e) {this.consumers.delete(s);s.end(e);}
    }
  }
  finish(error) {
    for(const s of [...this.consumers]) {this.consumers.delete(s);try{s.end(error);}catch{}}
    this.status=this.closed?'closed':'error';this.clearGop();
  }
  async run() {
    const muxer=new MpegTsMuxer();let failures=0;
    while(!this.closed&&(this.consumers.size||this.idleTimer)) {
      let retryDelay=0;
      try {
        this.status='connecting';const client=await this.lifecycle.run(()=>this.connectClient(true));this.status='streaming';
        while(!this.closed&&this.client===client&&(this.consumers.size||this.idleTimer)) {
          const packet=await client.readVideo();const result=muxer.feed(packet);if(!result) continue;
          this.codec=packet.codec===4?'H.264':'H.265';this.frames++;failures=0;this.publish(result);
        }
      } catch(e) {
        if(this.closed||(!this.consumers.size&&!this.idleTimer)) break;
        this.status='reconnecting';this.reconnects++;this.clearGop();muxer.restart();
        const automatic=this.options.autoUpdateIp!==false&&!!this.addressResolver;
        if((++failures>3&&!automatic)||e instanceof AuthenticationError) {this.log.warn(`${this.device.name}: ${safeError(e)}`);this.finish(e);break;}
        this.log.debug(`${this.device.name}: reconnecting camera (attempt ${failures}): ${safeError(e)}`);
        retryDelay=automatic?Math.min(30000,500*2**Math.min(failures-1,6)):Math.min(3000,failures*500);
      } finally {
        await this.lifecycle.run(()=>{this.client?.close();this.client=null;this.mediaStarted=false;});
      }
      if(retryDelay)await this.waitForRetry(retryDelay);
    }
  }
  waitForRetry(ms) {
    if(this.closed||(!this.consumers.size&&!this.idleTimer))return Promise.resolve();
    return new Promise(resolve=>{
      const done=()=>{clearTimeout(timer);this.wakeRetry=null;resolve();};
      const timer=setTimeout(done,ms);this.wakeRetry=done;
    });
  }
  async panTilt(direction) {
    if(!PAN_TILT_MODELS.has(this.device.model)&&this.options.panTilt!==true) throw new ProtocolError('Pan/tilt is not enabled for this camera model');
    if(this.motorBusy) throw new ProtocolError('A camera movement is already in progress');
    this.motorBusy=true;
    try {
      await this.lifecycle.run(async()=>{
        const client=await this.connectClient(false);
        try {await client.panTilt(direction);}
        finally {if(!this.consumers.size&&!this.mediaStarted) {client.close();if(this.client===client)this.client=null;}}
      });
    } finally {this.motorBusy=false;}
  }
  async close() {
    this.closed=true;clearTimeout(this.idleTimer);this.idleTimer=null;this.wakeRetry?.();
    this.client?.close();this.finish(new TransportError('Homebridge is shutting down'));
    await this.lifecycle.run(()=>{this.client?.close();this.client=null;});
    await this.runner;this.status='closed';
  }
}
class SourceServer {
  constructor(sessions) {this.sessions=sessions;this.token=randomBytes(24).toString('hex');this.sockets=new Set();}
  async start() {
    this.server=http.createServer((req,res)=>{
      const match=req.url?.match(/^\/([a-f0-9]{48})\/([^/?]+)$/);
      if(req.method!=='GET'||!match||match[1]!==this.token) {res.writeHead(404);res.end();return;}
      let id;try{id=decodeURIComponent(match[2]);}catch{res.writeHead(400);res.end();return;}
      const session=this.sessions.get(id);if(!session) {res.writeHead(404);res.end();return;}
      res.writeHead(200,{'Content-Type':'video/mp2t','Cache-Control':'no-store','Connection':'close'});res.flushHeaders();
      let release;
      res.once('close',()=>release?.());
      try {
        release=session.subscribe(data=>{
          if(res.destroyed) throw new TransportError('Media consumer disconnected');
          if(res.writableLength>4*1024*1024) {res.destroy();throw new TransportError('Media consumer is too slow');}
          res.write(data);
        },()=>res.destroy());
        if(res.destroyed) release();
      } catch {res.destroy();}
    });
    this.server.on('connection',socket=>{this.sockets.add(socket);socket.once('close',()=>this.sockets.delete(socket));});
    await new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(0,'127.0.0.1',resolve);});
    this.port=this.server.address().port;
  }
  source(did) {return `http://127.0.0.1:${this.port}/${this.token}/${encodeURIComponent(did)}`;}
  async close() {for(const s of this.sockets)s.destroy();if(this.server)await new Promise(resolve=>this.server.close(resolve));}
}
module.exports={CameraSession,SourceServer};
