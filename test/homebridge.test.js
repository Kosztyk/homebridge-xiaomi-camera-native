'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {XiaomiCameraPlatform}=require('../lib/platform');
const {AuthStore}=require('../lib/store');
const {HomebridgeAPI}=require(path.join(path.dirname(process.env.HOMEBRIDGE_TEST_ENTRY||require.resolve('homebridge')),'api.js'));
const logger={info(){},warn(){},error(){},debug(){}};
function readTlv(data) {
  const fields={};
  for(let offset=0;offset<data.length;) {
    const type=data[offset++],length=data[offset++];
    (fields[type]||=[]).push(data.subarray(offset,offset+length));offset+=length;
  }
  return fields;
}
function create(t,config={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xiaomi-hb-test-'));
  const api=new HomebridgeAPI();api.user={storagePath:()=>dir};const published=[];api.publishExternalAccessories=(_name,items)=>published.push(...items);
  const platform=new XiaomiCameraPlatform(logger,config,api);platform.cloud={region:'de',credentials:{user_id:'1000'},devices:async()=>[{did:'1',name:'Living Camera',model:'chuangmi.camera.046c04',host:'192.168.68.97'},{did:'2',name:'Bedroom Camera',model:'mxiang.camera.c301',host:'192.168.68.98'}]};
  t.after(async()=>{await platform.shutdown();fs.rmSync(dir,{recursive:true,force:true});});return {platform,api,published,dir};
}
test('registers real Homebridge camera accessories and momentary movement services',async t=>{
  const {platform,api,published}=create(t,{cameras:[{}]});await platform.source.start();await platform.discover();
  assert.equal(published.length,2);const camera=published[0];assert.equal(camera.category,api.hap.Categories.IP_CAMERA);
  assert.ok(camera.services.some(s=>s.UUID===api.hap.Service.CameraRTPStreamManagement.UUID));assert.equal(camera.services.filter(s=>s.UUID===api.hap.Service.Switch.UUID).length,4);
  assert.equal(camera.getService(api.hap.Service.AccessoryInformation).getCharacteristic(api.hap.Characteristic.Manufacturer).value,'Xiaomi');
  assert.equal(platform.delegates.size,2);await platform.discover();assert.equal(published.length,2);
});
test('selection, exclusion and host overrides use device IDs and ignore blank rows',async t=>{
  const {platform,published}=create(t,{includeOnlyConfigured:true,cameras:[{}, {did:'2',exclude:false,host:'192.168.68.107',name:'My Camera'}],exposePanTilt:false});await platform.source.start();await platform.discover();
  assert.equal(published.length,1);assert.equal(published[0].displayName,'My Camera');assert.equal(platform.sessions.get('2').options.host,'192.168.68.107');assert.equal(published[0].services.filter(s=>s.UUID===platform.api.hap.Service.Switch.UUID).length,0);
});
test('selecting no cameras publishes none',async t=>{
  const {platform,published}=create(t,{includeOnlyConfigured:true,cameras:[]});await platform.source.start();await platform.discover();assert.equal(published.length,0);
});
test('HomeKit advertises 720p at 15 fps and honors resolution caps',async t=>{
  for(const maxHeight of [720,360]) {
    const {platform,api,published}=create(t,{maxFPS:15,maxHeight});
    await platform.source.start();await platform.discover();
    const service=published[0].getService(api.hap.Service.CameraRTPStreamManagement);
    const value=service.getCharacteristic(api.hap.Characteristic.SupportedVideoStreamConfiguration).value;
    const codec=Buffer.concat(readTlv(Buffer.from(value,'base64'))[1]);
    const resolutions=readTlv(codec)[3].map(data=>{
      const fields=readTlv(data);return [fields[1][0].readUInt16LE(),fields[2][0].readUInt16LE(),fields[3][0][0]];
    });
    assert.ok(resolutions.some(([w,h,f])=>w===(maxHeight===720?1280:640)&&h===maxHeight&&f===15));
    assert.ok(resolutions.every(([,h,f])=>h<=maxHeight&&f<=15));
  }
});
test('same account and device produce stable accessory UUIDs across restarts',async t=>{
  const first=create(t),second=create(t);await first.platform.source.start();await second.platform.source.start();await first.platform.discover();await second.platform.discover();assert.equal(first.published[0].UUID,second.published[0].UUID);
});
test('account storage is private, atomic and rejects path traversal',async t=>{
  const {dir}=create(t);const store=new AuthStore(dir),id=await store.save(null,{region:'de',credentials:{user_id:'1000',pass_token:'synthetic'}});
  assert.match(id,/^[a-f0-9]{32}$/);assert.equal(fs.statSync(store.file(id)).mode&0o777,0o600);assert.equal((await store.load(id)).credentials.user_id,'1000');await store.save(id,{region:'de',credentials:{user_id:'1000',pass_token:'updated'}});assert.equal((await store.load(id)).credentials.pass_token,'updated');assert.throws(()=>store.file('../../wrong'));
});
test('configuration schema starts without placeholder camera rows',()=>{
  const Ajv=require('ajv'),schema=require('../config.schema.json').schema,validate=new Ajv({useDefaults:true,strict:false}).compile(schema),config={};assert.equal(validate(config),true);assert.deepEqual(config.cameras,[]);assert.equal(validate({cameras:[{}]}),false);
});
