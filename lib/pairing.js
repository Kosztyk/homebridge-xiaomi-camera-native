'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomBytes}=require('node:crypto');
const {Mutex}=require('./async');

const REGISTRY_NAME='homekit-cameras.json';
const MAC=/^(?:[A-F0-9]{2}:){5}[A-F0-9]{2}$/i;
const PIN=/^\d{3}-\d{2}-\d{3}$/;

// Only camera identity and publication state go into this file. HomeKit owns
// the pairing codes, setup IDs, client keys and all existing pairing records.
class PairingRegistry {
  constructor(storagePath,onError=()=>{}) {
    this.root=path.join(storagePath,'xiaomi-camera-native');
    this.file=path.join(this.root,REGISTRY_NAME);
    this.entries=new Map();this.writes=new Mutex();this.listeners=[];this.onError=onError;
    this.active=false;
  }
  async start(active=true) {
    this.active=active;this.entries.clear();await this.save();
  }
  track(device,accessory,hap) {
    const underlying=accessory._associatedHAPAccessory;
    this.entries.set(device.did,{did:device.did,name:device.name,model:device.model});
    if(underlying&&typeof hap.Accessory?.serialize==='function') {
      const listening=()=>{
        if(!this.active)return;
        try {
          const username=hap.Accessory.serialize(underlying).lastKnownUsername;
          if(!MAC.test(username||''))return;
          this.entries.set(device.did,{did:device.did,name:underlying.displayName||device.name,model:device.model,username:username.toUpperCase()});
          this.save().catch(this.onError);
        } catch {this.onError();}
      };
      underlying.on('listening',listening);this.listeners.push([underlying,listening]);
    }
    this.save().catch(this.onError);
  }
  save() {
    return this.writes.run(async()=>{
      await fs.mkdir(this.root,{recursive:true,mode:0o700});
      const temp=this.file+'.'+randomBytes(6).toString('hex')+'.tmp';
      try {
        await fs.writeFile(temp,JSON.stringify({version:1,pid:process.pid,active:this.active,cameras:[...this.entries.values()]}),{mode:0o600});
        await fs.rename(temp,this.file);await fs.chmod(this.file,0o600);
      } finally {await fs.rm(temp,{force:true}).catch(()=>{});}
    });
  }
  async close() {
    for(const [accessory,listener] of this.listeners)accessory.removeListener('listening',listener);
    this.listeners=[];this.active=false;await this.save();
  }
}

function setupURI(pin,setupID,category=17) {
  if(!PIN.test(pin||'')||!/^[A-Z0-9]{4}$/.test(setupID||'')||category!==17)return null;
  // HAP setup payload: category in bits 31+, IP transport in bit 28,
  // followed by the accessory's persisted setup ID (not the bridge's ID).
  const payload=(BigInt(category)<<31n)|(1n<<28n)|BigInt(pin.replace(/-/g,''));
  return 'X-HM://'+payload.toString(36).toUpperCase().padStart(9,'0')+setupID;
}

async function readJSON(file) {
  const handle=await fs.open(file,'r');
  try {
    if((await handle.stat()).size>1024*1024)throw new Error('Invalid pairing record size');
    return JSON.parse(await handle.readFile('utf8'));
  } finally {await handle.close();}
}

async function readPairingDetails(storagePath) {
  let registry;
  try {registry=await readJSON(path.join(storagePath,'xiaomi-camera-native',REGISTRY_NAME));}
  catch {return {running:false,cameras:[]};}
  if(!registry||registry.version!==1||!Array.isArray(registry.cameras)||!registry.active||!Number.isSafeInteger(registry.pid)||registry.pid<=0)return {running:false,cameras:[]};
  try {process.kill(registry.pid,0);}catch(error){if(error.code!=='EPERM')return {running:false,cameras:[]};}
  const cameras=[];
  for(const entry of registry.cameras.slice(0,200)) {
    if(!entry||typeof entry.did!=='string'||typeof entry.name!=='string')continue;
    const camera={did:entry.did,name:entry.name,model:String(entry.model||''),state:'starting'};
    cameras.push(camera);
    if(!MAC.test(entry.username||''))continue;
    try {
      const info=await readJSON(path.join(storagePath,'persist','AccessoryInfo.'+entry.username.replace(/:/g,'').toUpperCase()+'.json'));
      if(info.category!==17||!PIN.test(info.pincode||''))continue;
      camera.state='ready';camera.pin=info.pincode;
      camera.paired=!!info.pairedClients&&typeof info.pairedClients==='object'&&Object.keys(info.pairedClients).length>0;
      const uri=setupURI(info.pincode,info.setupID,info.category);
      if(uri) {
        // Generate locally: no pairing codes are sent to an image service.
        const QRCode=require('qrcode');
        camera.qr=await QRCode.toDataURL(uri,{width:224,margin:4,errorCorrectionLevel:'M'});
      }
    } catch {if(!camera.pin)camera.state='starting';}
  }
  return {running:true,cameras};
}
module.exports={PairingRegistry,readPairingDetails,setupURI};
