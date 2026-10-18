'use strict';
const {XiaomiCloud}=require('./cloud');
const {AuthStore}=require('./store');
const {PairingRegistry}=require('./pairing');
const {CameraSession,SourceServer}=require('./session');
const {StreamingDelegate}=require('./streaming');
const {PAN_TILT_MODELS}=require('./miss');
const {ffmpegPath,checkFFmpeg}=require('./ffmpeg');
const {validIPv4}=require('./cs2');
const {ProtocolError,AuthenticationError,safeError}=require('./errors');
const PLUGIN_NAME='homebridge-xiaomi-camera-native',PLATFORM_NAME='XiaomiCameraNative';
const VERSION=require('../package.json').version;
class XiaomiCameraPlatform {
  constructor(log,config,api) {
    this.log=log;this.config=config||{};this.api=api;this.sessions=new Map();this.accessories=new Map();this.delegates=new Map();this.cached=[];this.stopped=false;
    this.store=new AuthStore(api.user.storagePath());this.source=new SourceServer(this.sessions);this.ffmpeg=ffmpegPath(this.config.ffmpegPath);
    this.pairing=new PairingRegistry(api.user.storagePath(),()=>this.log.warn('Could not update camera pairing details; check Homebridge storage permissions'));
    api.on('didFinishLaunching',()=>this.launch());api.on('shutdown',()=>this.shutdown());
  }
  configureAccessory(accessory) {this.cached.push(accessory);}
  async launch() {
    if(!this.pairingStarted){this.pairingStarted=true;await this.pairing.start(!this.config.disabled).catch(()=>this.log.warn('Could not prepare camera pairing details'));}
    if(this.config.disabled)return;
    try {
      await checkFFmpeg(this.ffmpeg);if(this.stopped)return;
      if(!this.source.port)await this.source.start();if(this.stopped){await this.source.close();return;}
      await this.discover();
      if(!this.stopped){this.refreshTimer=setInterval(()=>this.discover().catch(e=>this.log.warn(safeError(e))),Math.max(60,this.config.discoveryInterval||900)*1000);this.refreshTimer.unref();}
    } catch(e) {
      this.log.error(safeError(e));
      if(!(e instanceof AuthenticationError)&&!this.stopped){this.retryTimer=setTimeout(()=>this.launch(),60000);this.retryTimer.unref();}
    }
  }
  async connectCloud() {
    if(this.cloud)return;
    const region=this.config.region||'de';let record;
    if(this.config.authId)record=await this.store.load(this.config.authId);
    else if(this.config.userId&&this.config.passToken)record={region,credentials:{user_id:String(this.config.userId),pass_token:this.config.passToken}};
    else throw new AuthenticationError('Open Xiaomi Camera Native plugin settings, sign in, save and restart Homebridge');
    if(record.region!==region)throw new AuthenticationError('Account region changed; sign in again with the selected region');
    const cloud=new XiaomiCloud(region,{onCredentials:async credentials=>{
      if(this.config.authId){record={...record,credentials};await this.store.save(this.config.authId,record);}
    }});
    await cloud.authenticate(record.credentials);this.cloud=cloud;
  }
  async discover() {
    if(this.discovering||this.stopped)return;this.discovering=true;
    try {
      await this.connectCloud();const devices=await this.cloud.devices();if(this.stopped)return;
      const overrides=new Map((Array.isArray(this.config.cameras)?this.config.cameras:[]).filter(c=>c&&String(c.did||'').trim()).map(c=>[String(c.did).trim(),c]));
      for(const device of devices) {
        const override=overrides.get(device.did)||{};
        if(override.exclude===true||(this.config.includeOnlyConfigured&&(!overrides.has(device.did)||override.exclude)))continue;
        const options={maxWidth:1280,maxHeight:720,maxFPS:20,maxBitrate:1500,idleTimeout:15,...this.config,...override};
        options.host=override.host||device.host;
        if(!validIPv4(options.host)){this.log.warn(`${device.name}: no valid local IPv4 address; set the camera IP in plugin settings`);continue;}
        if(override.name)device.name=override.name;
        if(this.sessions.has(device.did)){this.sessions.get(device.did).device=device;this.sessions.get(device.did).options=options;continue;}
        this.addCamera(device,options);
      }
      if(this.cached.length){this.api.unregisterPlatformAccessories(PLUGIN_NAME,PLATFORM_NAME,this.cached);this.cached=[];}
      this.log.info(`Discovered ${devices.length} Xiaomi camera(s); ${this.sessions.size} published for separate pairing in Apple Home`);
    } finally {this.discovering=false;}
  }
  addCamera(device,options) {
    const hap=this.api.hap;
    const id=hap.uuid.generate(`${PLUGIN_NAME}:${this.cloud.credentials.user_id}:${this.cloud.region}:${device.did}`);
    const accessory=new this.api.platformAccessory(device.name,id,hap.Categories.IP_CAMERA);
    accessory.getService(hap.Service.AccessoryInformation).setCharacteristic(hap.Characteristic.Manufacturer,'Xiaomi').setCharacteristic(hap.Characteristic.Model,device.model).setCharacteristic(hap.Characteristic.SerialNumber,device.mac||'xiaomi-'+device.did).setCharacteristic(hap.Characteristic.FirmwareRevision,VERSION);
    const session=new CameraSession(this.cloud,device,options,{debug:m=>{if(this.config.debug)this.log.debug(m);},warn:m=>this.log.warn(m)});
    this.sessions.set(device.did,session);
    const delegate=new StreamingDelegate(hap,session,this.source.source(device.did),this.ffmpeg,options,this.log);
    accessory.configureController(delegate.controller);
    if(options.exposePanTilt!==false&&(PAN_TILT_MODELS.has(device.model)||options.panTilt===true)) {
      for(const [direction,label] of [['left','Pan Left'],['right','Pan Right'],['up','Tilt Up'],['down','Tilt Down']]) {
        const service=accessory.addService(hap.Service.Switch,label,'ptz-'+direction);
        service.setCharacteristic(hap.Characteristic.Name,label);
        service.addOptionalCharacteristic(hap.Characteristic.ConfiguredName);service.setCharacteristic(hap.Characteristic.ConfiguredName,label);
        const on=service.getCharacteristic(hap.Characteristic.On);
        on.onGet(()=>false).onSet(async value=>{
          if(!value)return;
          try{await session.panTilt(direction);}
          catch(e){this.log.warn(`${device.name}: ${safeError(e)}`);throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);}
          finally{const timer=setTimeout(()=>on.updateValue(false),200);timer.unref();}
        });
      }
    }
    accessory.on('identify',(_paired,callback)=>{this.log.info(`${device.name}: Xiaomi camera ${device.model}`);callback?.();});
    this.pairing.track(device,accessory,hap);
    this.api.publishExternalAccessories(PLUGIN_NAME,[accessory]);this.accessories.set(device.did,accessory);this.delegates.set(device.did,delegate);
    this.log.info(`${device.name}: camera ready to pair in Apple Home${options.maxHeight<=720?' (H.264, up to 720p)':''}`);
  }
  async shutdown() {
    this.stopped=true;clearInterval(this.refreshTimer);clearTimeout(this.retryTimer);
    for(const d of this.delegates.values())d.close();
    await this.source.close();await Promise.allSettled([...this.sessions.values()].map(s=>s.close()));
    await this.pairing.close().catch(()=>{});
  }
}
module.exports={XiaomiCameraPlatform,PLUGIN_NAME,PLATFORM_NAME};
