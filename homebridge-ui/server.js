'use strict';
const {HomebridgePluginUiServer}=require('@homebridge/plugin-ui-utils');
const {XiaomiCloud,REGIONS}=require('../lib/cloud');
const {AuthStore}=require('../lib/store');
const {readPairingDetails}=require('../lib/pairing');
const {CameraAddressResolver}=require('../lib/address');
const {LoginChallenge,AuthenticationError,safeError}=require('../lib/errors');
class UiServer extends HomebridgePluginUiServer {
  constructor() {
    super();this.store=new AuthStore(this.homebridgeStoragePath);this.busy=false;
    this.onRequest('/pairing',async()=>{
      try{return {ok:true,...await readPairingDetails(this.homebridgeStoragePath)};}
      catch{return {ok:false,error:'Could not read HomeKit pairing details. Restart Homebridge and refresh.'};}
    });
    for(const [route,handler] of [['/status',this.status],['/login',this.login],['/challenge',this.challenge],['/devices',this.devices]]) {
      this.onRequest(route,async payload=>{
        if(this.busy)return {ok:false,error:'Another account request is in progress'};this.busy=true;
        try{return {ok:true,...await handler.call(this,payload||{})};}
        catch(e){if(e instanceof LoginChallenge)return {ok:true,challenge:{kind:e.kind,image:e.image,destination:e.destination}};return {ok:false,error:safeError(e)};}
        finally{this.busy=false;}
      });
    }
    this.ready();
  }
  makeCloud(region) {
    if(!(region in REGIONS))throw new AuthenticationError('Choose a valid Xiaomi region');
    clearTimeout(this.expiry);
    this.expiry=setTimeout(()=>{if(this.cloud)this.cloud.auth={};},10*60*1000);this.expiry.unref();
    this.cloud=new XiaomiCloud(region,{onCredentials:async credentials=>{
      this.record={...this.record,region,credentials};
      if(this.authId)await this.store.save(this.authId,this.record);
    }});return this.cloud;
  }
  async status(payload) {
    if(!payload.authId)return {authenticated:false};
    this.authId=payload.authId;this.record=await this.store.load(this.authId);
    if(this.record.region!==(payload.region||'de'))return {authenticated:false,regionChanged:true};
    await this.makeCloud(this.record.region).authenticate(this.record.credentials);
    return {authenticated:true,authId:this.authId,devices:await this.listDevices()};
  }
  async login(payload) {
    this.authId=null;this.record=null;const cloud=this.makeCloud(payload.region||'de');
    if(payload.method==='token')await cloud.loginWithToken(String(payload.userId||''),String(payload.passToken||''));
    else await cloud.login(String(payload.username||''),String(payload.password||''));
    return this.complete();
  }
  async challenge(payload) {
    if(!this.cloud)throw new AuthenticationError('Login challenge expired; start again');
    if(payload.kind==='captcha')await this.cloud.submitCaptcha(payload.answer);
    else if(payload.kind==='verification')await this.cloud.submitVerification(payload.answer);
    else throw new AuthenticationError('Unknown Xiaomi account challenge');
    return this.complete();
  }
  async complete() {
    this.record={region:this.cloud.region,credentials:{...this.cloud.credentials}};
    this.authId=await this.store.save(this.authId,this.record);
    return {authenticated:true,authId:this.authId,devices:await this.listDevices()};
  }
  async devices(payload) {
    if(!this.cloud||this.authId!==payload.authId)return this.status(payload);
    return {authenticated:true,authId:this.authId,devices:await this.listDevices()};
  }
  async listDevices() {
    const devices=await this.cloud.devices();
    const addresses=new CameraAddressResolver(this.cloud,{storagePath:this.homebridgeStoragePath});
    await addresses.load();
    return devices.map(device=>({...device,workingHost:addresses.knownAddress(device)||''}));
  }
}
if(require.main===module)new UiServer();
module.exports={UiServer};
