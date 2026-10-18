'use strict';
const {ProtocolError}=require('./errors');
const START=Buffer.from([0,0,0,1]);
function crc32Mpeg(data) { let crc=0xffffffff; for(const byte of data) { crc=(crc^(byte<<24))>>>0; for(let i=0;i<8;i++) crc=((crc<<1)^((crc&0x80000000)?0x04c11db7:0))>>>0; } return crc; }
function nalUnits(data) {
  const starts=[];
  for(let i=0;i<data.length-2;i++) if(data[i]===0&&data[i+1]===0) {
    if(data[i+2]===1) {starts.push([i,i+3]);i+=2;}
    else if(data[i+2]===0&&data[i+3]===1) {starts.push([i,i+4]);i+=3;}
  }
  return starts.length?starts.map((s,i)=>data.subarray(s[1],i+1<starts.length?starts[i+1][0]:data.length)).filter(b=>b.length):data.length?[data]:[];
}
const nalType=(unit,codec)=>codec===4?unit[0]&31:(unit[0]>>>1)&63;
function encodePTS(value) { const n=BigInt(value)&((1n<<33n)-1n); return Buffer.from([Number(0x21n|((n>>29n)&14n)),Number((n>>22n)&255n),Number(((n>>14n)&254n)|1n),Number((n>>7n)&255n),Number(((n<<1n)&254n)|1n)]); }
class MpegTsMuxer {
  constructor() { this.codec=null;this.cc=new Map();this.parameters=new Map();this.started=false;this.lastInput=null;this.pts=90000;this.lastTables=-90000; }
  header(pid,start,adaptation) {
    const cc=this.cc.get(pid)||0;this.cc.set(pid,(cc+1)&15);
    return Buffer.from([0x47,((pid>>>8)&31)|(start?0x40:0),pid&255,(adaptation?0x30:0x10)|cc]);
  }
  restart() {this.started=false;this.parameters.clear();this.lastInput=null;this.pts+=4500;}
  section(pid,section) {
    const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32Mpeg(section)); const payload=Buffer.concat([Buffer.from([0]),section,crc]);
    return Buffer.concat([this.header(pid,true,false),payload,Buffer.alloc(184-payload.length,255)]);
  }
  tables() {
    return Buffer.concat([this.section(0,Buffer.from('00b00d0001c100000001f000','hex')),this.section(0x1000,Buffer.concat([Buffer.from('02b0120001c10000e100f000','hex'),Buffer.from([this.codec===4?0x1b:0x24]),Buffer.from('e100f000','hex')]))]);
  }
  packetize(payload,pts,keyframe) {
    let pes=Buffer.concat([Buffer.from('000001e00000808005','hex'),encodePTS(pts),payload]),first=true;const packets=[];
    while(pes.length) {
      const capacity=first?176:184,chunk=pes.subarray(0,capacity);pes=pes.subarray(capacity);
      const adaptation=first||chunk.length<184;let header=this.header(0x100,first,adaptation);
      if(adaptation) {
        const size=183-chunk.length;let extra;
        if(first) {
          const pcr=(((BigInt(pts)-27000n)&((1n<<33n)-1n))<<15n)|0x7e00n;
          extra=Buffer.alloc(7);extra[0]=0x10|(keyframe?0x40:0);extra.writeUIntBE(Number(pcr),1,6);
        } else extra=size?Buffer.from([0]):Buffer.alloc(0);
        header=Buffer.concat([header,Buffer.from([size]),extra,Buffer.alloc(size-extra.length,255)]);
      }
      packets.push(header,chunk);first=false;
    }
    return Buffer.concat(packets);
  }
  feed(packet) {
    if(![4,5].includes(packet.codec)) return null;
    if(this.codec!==null&&packet.codec!==this.codec) throw new ProtocolError('Camera changed its video codec; reconnecting is required');
    this.codec=packet.codec;const units=nalUnits(packet.payload);if(!units.length) return null;
    const parameterTypes=this.codec===4?[7,8]:[32,33,34],present=new Set(units.map(u=>nalType(u,this.codec)));
    for(const u of units) if(parameterTypes.includes(nalType(u,this.codec))) this.parameters.set(nalType(u,this.codec),Buffer.concat([START,u]));
    const isVcl=[...present].some(k=>this.codec===4?k>=1&&k<=5:k<=31);if(!isVcl) return null;
    const keyframe=this.codec===4?present.has(5):[...present].some(k=>k>=16&&k<=23);
    if(!this.started) {if(!keyframe||!parameterTypes.every(k=>this.parameters.has(k))) return null;this.started=true;}
    if(this.lastInput!==null) {const delta=packet.timestampMs-this.lastInput;this.pts+=90*(delta>=1&&delta<=1000?delta:50);}
    this.lastInput=packet.timestampMs;
    const prefix=keyframe?parameterTypes.filter(k=>!present.has(k)).map(k=>this.parameters.get(k)):[];
    const aud=present.has(this.codec===4?9:35)?Buffer.alloc(0):Buffer.concat([START,Buffer.from(this.codec===4?'09f0':'460150','hex')]);
    const chunks=[];if(keyframe||this.pts-this.lastTables>=90000) {chunks.push(this.tables());this.lastTables=this.pts;}
    chunks.push(this.packetize(Buffer.concat([aud,...prefix,packet.payload]),this.pts,keyframe));
    return {data:Buffer.concat(chunks),keyframe};
  }
}
module.exports={MpegTsMuxer,nalUnits,nalType,crc32Mpeg,encodePTS};
