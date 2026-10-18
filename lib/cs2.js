'use strict';
// Direct CS2 LAN transport; ported from the supplied integration (see NOTICE).
const dgram=require('node:dgram');
const net=require('node:net');
const {AsyncQueue,Mutex}=require('./async');
const {ProtocolError,TransportError}=require('./errors');
const MAGIC=0xf1,DRW=0xd0,ACK=0xd1,MAX_MESSAGE=8*1024*1024;
function message(kind,payload=Buffer.alloc(0)) {
  if(payload.length>65535) throw new ProtocolError('CS2 datagram is too large');
  const header=Buffer.alloc(4); header[0]=MAGIC; header[1]=kind; header.writeUInt16BE(payload.length,2); return Buffer.concat([header,payload]);
}
function marshalCommand(seq,command,payload) {
  const h=Buffer.alloc(12); h[0]=ACK; h.writeUInt16BE(seq,2); h.writeUInt32BE(payload.length+4,4); h.writeUInt32BE(command,8); return message(DRW,Buffer.concat([h,payload]));
}
function validIPv4(host) {
  return net.isIPv4(host) && host!=='0.0.0.0' && host!=='255.255.255.255' && Number(host.split('.')[0])<224;
}
class DataChannel {
  constructor(window=256,limit=128) { this.expected=0; this.window=window; this.pending=new Map(); this.pendingBytes=0; this.buffer=Buffer.alloc(0); this.queue=new AsyncQueue(limit); }
  feed(data) {
    if(this.buffer.length+data.length>MAX_MESSAGE+4) throw new ProtocolError('CS2 reassembly buffer limit exceeded');
    this.buffer=Buffer.concat([this.buffer,data]);
    while(this.buffer.length>=4) {
      const size=this.buffer.readUInt32BE(0);
      if(size<1||size>MAX_MESSAGE) throw new ProtocolError('Invalid CS2 message length');
      if(this.buffer.length<size+4) return;
      this.queue.push(Buffer.from(this.buffer.subarray(4,size+4))); this.buffer=this.buffer.subarray(size+4);
    }
  }
  feedSequence(seq,data) {
    const diff=((seq-this.expected+32768)&65535)-32768;
    if(diff<0) return true;
    if(diff>0) {
      if(diff>this.window) return false;
      if(!this.pending.has(seq)) {
        if(this.pending.size>=this.window||this.pendingBytes+data.length>MAX_MESSAGE) return false;
        this.pending.set(seq,Buffer.from(data)); this.pendingBytes+=data.length;
      }
      return true;
    }
    for(;;) {
      this.feed(data); this.expected=(this.expected+1)&65535;
      data=this.pending.get(this.expected);
      if(!data) return true;
      this.pending.delete(this.expected); this.pendingBytes-=data.length;
    }
  }
  close(error) { this.queue.close(error); this.buffer=Buffer.alloc(0); this.pending.clear(); this.pendingBytes=0; }
}
class CS2Connection {
  constructor() {
    this.protocol='cs2+udp'; this.channels=new Map([[0,new DataChannel(64,16)],[2,new DataChannel()]]);
    this.sequence=0; this.commands=new Mutex(); this.closed=false; this.error=null; this.remote=null;
    this.discovery=new AsyncQueue(128); this.tcpBuffer=Buffer.alloc(0);
  }
  static async connect(host,transport='auto',port=32108,timeout=8000) {
    if(!validIPv4(host)) throw new ProtocolError('Configure the camera local IPv4 address in plugin settings');
    if(!['auto','udp','tcp'].includes(transport)) throw new ProtocolError('Invalid CS2 transport');
    const self=new CS2Connection(); self.remote={address:host,port};
    self.udp=dgram.createSocket('udp4');
    self.udp.on('error',()=>self.fail(new TransportError('Camera UDP socket failed')));
    self.udp.on('message',(data,addr)=>{
      if(addr.address!==host||data.length<4||data[0]!==MAGIC||data.readUInt16BE(2)!==data.length-4) return;
      try {
        if(!self.ready) self.discovery.push({data,addr});
        else if(self.protocol==='cs2+udp'&&addr.port===self.remote.port) self.handle(data);
      } catch(e) { self.fail(e); }
    });
    try {
      await new Promise((resolve,reject)=>{ self.udp.once('listening',resolve); self.udp.once('error',reject); self.udp.bind(0,'0.0.0.0'); });
      const punch=await self.exchange(message(0x30),new Set([0x41]),timeout);
      const ready=await self.exchange(punch,new Set(transport==='auto'?[0x42,0x43]:[transport==='tcp'?0x43:0x42]),timeout);
      if(ready[1]===0x43) {
        self.protocol='cs2+tcp'; self.udp.close(); self.udp=null;
        self.tcp=net.createConnection(self.remote.port,host);
        self.tcp.on('error',()=>self.fail(new TransportError('Camera TCP socket failed')));
        self.tcp.on('close',()=>{ if(!self.closed) self.fail(new TransportError('Camera TCP connection ended')); });
        self.tcp.on('data',data=>{ try { self.receiveTCP(data); } catch(e) { self.fail(e); } });
        await new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>{ self.tcp.destroy(); reject(new TransportError('Camera TCP connection timed out')); },timeout);
          self.tcp.once('connect',()=>{ clearTimeout(timer); self.tcp.setNoDelay(true); resolve(); });
          self.tcp.once('error',()=>{ clearTimeout(timer); reject(new TransportError('Camera TCP connection failed')); });
        });
      }
      self.ready=true;
      self.keepalive=setInterval(()=>{ try { self.send(message(0xe0)); } catch(e) { self.fail(e); } },1000);
      self.keepalive.unref(); return self;
    } catch(e) { self.close(); throw e; }
  }
  async exchange(packet,accepted,timeout) {
    const deadline=Date.now()+timeout;
    while(Date.now()<deadline) {
      this.send(packet); const end=Math.min(deadline,Date.now()+1000);
      while(Date.now()<end) {
        let item;
        try { item=await this.discovery.shift(Math.max(1,end-Date.now())); }
        catch(e) { if(this.error) throw this.error; break; }
        if(accepted.has(item.data[1])&&item.data.length>=16) { this.remote=item.addr; return item.data; }
      }
    }
    throw new TransportError('CS2 handshake timed out; check the camera IP and LAN connectivity');
  }
  send(packet) {
    if(this.closed||this.error) throw this.error||new TransportError('Camera transport is closed');
    if(this.tcp) {
      if(this.tcp.writableLength>MAX_MESSAGE) throw new TransportError('Camera TCP write queue exceeded its limit');
      const h=Buffer.alloc(8); h.writeUInt16BE(packet.length); h[2]=0x68; this.tcp.write(Buffer.concat([h,packet]));
    } else if(this.udp) this.udp.send(packet,this.remote.port,this.remote.address,error=>{ if(error&&!this.closed) this.fail(new TransportError('Camera UDP send failed')); });
    else throw new TransportError('Camera transport is unavailable');
  }
  receiveTCP(data) {
    if(this.tcpBuffer.length+data.length>MAX_MESSAGE) throw new ProtocolError('CS2 TCP buffer limit exceeded');
    this.tcpBuffer=Buffer.concat([this.tcpBuffer,data]);
    while(this.tcpBuffer.length>=8) {
      const n=this.tcpBuffer.readUInt16BE(0);
      if(this.tcpBuffer[2]!==0x68||n<4) throw new ProtocolError('Invalid CS2 TCP frame');
      if(this.tcpBuffer.length<n+8) return;
      const packet=this.tcpBuffer.subarray(8,8+n); this.tcpBuffer=this.tcpBuffer.subarray(8+n);
      if(packet[0]!==MAGIC||packet.readUInt16BE(2)!==packet.length-4) throw new ProtocolError('Invalid CS2 TCP packet length');
      this.handle(packet);
    }
  }
  handle(packet) {
    const kind=packet[1];
    if(kind===DRW) {
      if(packet.length<8||packet[4]!==ACK) throw new ProtocolError('Invalid CS2 channel header');
      const id=packet[5],channel=this.channels.get(id),seq=packet.readUInt16BE(6);
      if(!channel) return;
      if(this.protocol==='cs2+tcp') channel.feed(packet.subarray(8));
      else if(channel.feedSequence(seq,packet.subarray(8))) {
        const a=Buffer.alloc(6); a[0]=ACK; a[1]=id; a.writeUInt16BE(1,2); a.writeUInt16BE(seq,4); this.send(message(ACK,a));
      }
    } else if(kind===ACK) {
      if(packet.length<8||packet[4]!==ACK||packet[5]!==0||!this.ack) return;
      const n=packet.readUInt16BE(6);
      if(packet.length!==8+n*2) return;
      for(let i=0;i<n;i++) if(packet.readUInt16BE(8+i*2)===this.ack.seq) { this.ack.resolve(); break; }
    } else if(kind===0xe0) this.send(message(0xe1));
    else if(kind===0xf0) { this.send(message(0xf1)); this.fail(new TransportError('Camera closed the CS2 session')); }
  }
  writeCommand(command,data) {
    return this.commands.run(async()=>{
      const seq=this.sequence; this.sequence=(seq+1)&65535; const packet=marshalCommand(seq,command,data);
      if(this.protocol==='cs2+tcp') { this.send(packet); return; }
      let done=false,resolve;
      const acked=new Promise(r=>{resolve=()=>{done=true;r();};}); this.ack={seq,resolve};
      try {
        for(let i=0;i<5;i++) {
          this.send(packet);
          let timer; await Promise.race([acked,new Promise(r=>{timer=setTimeout(r,1000);})]); clearTimeout(timer);
          if(this.error) throw this.error;
          if(done) return;
        }
        throw new TransportError('Camera did not acknowledge the CS2 command');
      } finally { this.ack=null; }
    });
  }
  readChannel(id,timeout=15000) { return this.channels.get(id).queue.shift(timeout); }
  fail(error) {
    if(this.closed||this.error) return;
    this.error=error instanceof ProtocolError||error instanceof TransportError?error:new TransportError('Camera transport failed');
    clearInterval(this.keepalive); this.discovery.close(this.error); this.ack?.resolve();
    for(const c of this.channels.values()) c.close(this.error);
    this.tcp?.destroy();
  }
  close() {
    if(this.closed) return;
    if(!this.error) { try { this.send(message(0xf0)); } catch {} }
    this.closed=true; clearInterval(this.keepalive); this.ack?.resolve(); this.discovery.close();
    if(this.udp) { try { this.udp.close(); } catch {} this.udp=null; }
    this.tcp?.destroy(); for(const c of this.channels.values()) c.close();
  }
}
module.exports={CS2Connection,DataChannel,message,marshalCommand,validIPv4,MAX_MESSAGE};
