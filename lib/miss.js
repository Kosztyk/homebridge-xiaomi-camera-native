'use strict';
const {sharedKey,encodeMedia,decodeMedia}=require('./crypto');
const {CS2Connection}=require('./cs2');
const {ProtocolError}=require('./errors');
const PAN_TILT_MODELS=new Set(['chuangmi.camera.029a02','chuangmi.camera.046c04','mxiang.camera.c301']);
const OPERATIONS={left:1,right:2,up:3,down:4};
class MissClient {
  static async connect(host,provision,{transport='auto',quality='hd',model='',port=32108,startVideo=true}={}) {
    const key=sharedKey(provision.devicePublic,provision.private),connection=await CS2Connection.connect(host,transport,port);
    const self=new MissClient(); self.key=key; self.connection=connection;
    try {
      await connection.writeCommand(0x100,Buffer.from(JSON.stringify({public_key:provision.public.toString('hex'),sign:provision.signature,uuid:'',support_encrypt:0})));
      const response=await connection.readChannel(0); let auth;
      try { if(response.length<5) throw Error(); auth=JSON.parse(response.subarray(4).toString()); } catch {throw new ProtocolError('Invalid camera authentication response');}
      if(auth?.result!=='success') throw new ProtocolError('Camera rejected the MISS session credentials');
      if(startVideo) await self.startMedia(model,quality);
      self.drainCommands(); return self;
    } catch(e) { connection.close(); throw e; }
  }
  async startMedia(model,quality) {
    let value;
    if(quality==='hd') value=['chuangmi.camera.046c04','chuangmi.camera.72ac1'].includes(model)?3:2;
    else if(quality==='auto'||quality==='sd') value=quality==='auto'?0:1;
    else if(/^[0-5]$/.test(String(quality))) value=Number(quality);
    else throw new ProtocolError('Unsupported Xiaomi video quality');
    this.quality=value; return this.command(0x102,{videoquality:value,enableaudio:0});
  }
  async command(id,params) {
    const h=Buffer.alloc(4);h.writeUInt32BE(id); await this.connection.writeCommand(0x1001,encodeMedia(this.key,Buffer.concat([h,Buffer.from(JSON.stringify(params))])));
  }
  async readVideo(timeout=15000) {
    for(;;) {
      const packet=await this.connection.readChannel(2,timeout);
      if(packet.length<40||packet.readUInt32LE(0)!==packet.length-32) throw new ProtocolError('Invalid Xiaomi media packet length');
      const codec=packet.readUInt32LE(4); if(codec!==4&&codec!==5) continue;
      return {codec,sequence:packet.readUInt32LE(8),flags:packet.readUInt32LE(12),timestampMs:Number(packet.readBigUInt64LE(16)),payload:decodeMedia(this.key,packet.subarray(32))};
    }
  }
  panTilt(direction) {
    if(!Object.hasOwn(OPERATIONS,direction)) throw new ProtocolError('Pan/tilt direction must be left, right, up or down');
    return this.command(0x112,{operation:OPERATIONS[direction]});
  }
  async drainCommands() { try {while(!this.connection.closed&&!this.connection.error) await this.connection.readChannel(0,null);} catch {} }
  close() { this.connection.close(); }
}
module.exports={MissClient,PAN_TILT_MODELS,OPERATIONS};
