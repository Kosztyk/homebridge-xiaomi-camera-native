'use strict';
// Recovery rules adapted from Xiaomi Camera Native for HA 0.3.7 (see NOTICE).
const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash,randomBytes}=require('node:crypto');
const {validIPv4}=require('./cs2');
const {Mutex}=require('./async');
const {AuthenticationError,TransportError}=require('./errors');

function cameraAddress(value) {
  return typeof value==='string'&&validIPv4(value)&&![0,127].includes(Number(value.split('.')[0]))?value:null;
}
function normalizedMac(value) {
  if(typeof value!=='string')return null;
  const mac=value.replace(/[:.\-]/g,'').toLowerCase();
  return /^[a-f0-9]{12}$/.test(mac)&&!['000000000000','ffffffffffff'].includes(mac)?mac:null;
}
function sameCamera(known,found) {
  if(!known||!found||String(known.did)!==String(found.did)||known.model!==found.model)return false;
  const a=normalizedMac(known.mac),b=normalizedMac(found.mac);
  return !a||!b||a===b;
}

class CameraAddressResolver {
  constructor(cloud,{storagePath,interval=30000,timeout=10000,now=()=>performance.now()}={}) {
    this.cloud=cloud;this.interval=interval;this.timeout=timeout;this.now=now;
    this.nextRefresh=0;this.devices=new Map();this.verified=new Map();this.writes=new Mutex();this.closed=false;
    if(storagePath) {
      this.root=path.join(storagePath,'xiaomi-camera-native');
      const scope=createHash('sha256').update(String(cloud.region)+':'+String(cloud.credentials?.user_id)).digest('hex').slice(0,32);
      this.file=path.join(this.root,'addresses-'+scope+'.json');
    }
  }
  async load() {
    if(!this.file)return;
    try {
      const handle=await fs.open(this.file,'r');let record;
      try {if((await handle.stat()).size>1024*1024)return;record=JSON.parse(await handle.readFile('utf8'));}
      finally {await handle.close();}
      if(record?.version!==1||!Array.isArray(record.cameras))return;
      for(const device of record.cameras.slice(0,200)) {
        if(typeof device?.did==='string'&&typeof device.model==='string'&&cameraAddress(device.host))this.verified.set(device.did,device);
      }
    } catch { /* A missing/old cache does not prevent discovery or streaming. */ }
  }
  knownAddress(device) {
    const saved=this.verified.get(device.did);
    return sameCamera(device,saved)?cameraAddress(saved.host):null;
  }
  observe(devices) {
    if(this.closed)return;
    this.devices=new Map(devices.map(device=>[String(device.did),device]));
  }
  async cloudAddress(device) {
    if(this.closed)throw new TransportError('Camera address discovery is shut down');
    if(!this.refreshPromise&&this.now()>=this.nextRefresh) {
      this.nextRefresh=this.now()+this.interval;this.devices.clear();
      const controller=new AbortController();this.controller=controller;
      const timer=setTimeout(()=>controller.abort(),this.timeout);
      this.refreshPromise=Promise.resolve().then(async()=>{
        try {this.observe(await this.cloud.devices({signal:controller.signal}));}
        catch(error){if(error instanceof AuthenticationError)throw error;}
        finally {clearTimeout(timer);this.controller=null;this.refreshPromise=null;}
      });
    }
    if(this.refreshPromise)await this.refreshPromise;
    if(this.closed)throw new TransportError('Camera address discovery is shut down');
    const found=this.devices.get(device.did);
    return sameCamera(device,found)?cameraAddress(found.host):null;
  }
  async confirm(device,host) {
    if(this.closed||!cameraAddress(host))return;
    this.verified.set(device.did,{did:device.did,model:device.model,mac:device.mac||'',host});
    if(!this.file)return;
    await this.writes.run(async()=>{
      await fs.mkdir(this.root,{recursive:true,mode:0o700});
      const temp=this.file+'.'+randomBytes(6).toString('hex')+'.tmp';
      try {
        await fs.writeFile(temp,JSON.stringify({version:1,cameras:[...this.verified.values()]}),{mode:0o600});
        await fs.rename(temp,this.file);await fs.chmod(this.file,0o600);
      } finally {await fs.rm(temp,{force:true}).catch(()=>{});}
    });
  }
  async close() {
    this.closed=true;this.controller?.abort();
    await this.refreshPromise?.catch(()=>{});await this.writes.tail;
  }
}
module.exports={CameraAddressResolver,cameraAddress,normalizedMac,sameCamera};
