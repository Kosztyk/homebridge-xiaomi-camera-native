'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {PairingRegistry,readPairingDetails,setupURI}=require('../lib/pairing');
const {HomebridgeAPI}=require(path.join(path.dirname(process.env.HOMEBRIDGE_TEST_ENTRY||require.resolve('homebridge')),'api.js'));

async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'xiaomi-pairing-test-'));
  const registry=new PairingRegistry(root);
  t.after(async()=>{await registry.close();await fs.rm(root,{recursive:true,force:true});});
  await fs.mkdir(path.join(root,'persist'));await registry.start();
  return {root,registry};
}
async function record(root,username,info) {
  const file=path.join(root,'persist','AccessoryInfo.'+username.replace(/:/g,'').toUpperCase()+'.json');
  await fs.writeFile(file,JSON.stringify(info));return file;
}
test('camera QR payload agrees with the actual HAP setup URI',()=>{
  const hap=new HomebridgeAPI().hap;
  const accessory=new hap.Accessory('Test Camera',hap.uuid.generate('pairing-fixture'));
  const info=hap.AccessoryInfo.create('12:34:56:78:90:AB');
  Object.assign(info,{pincode:'518-24-963',category:17,setupID:'A7B9'});
  accessory._accessoryInfo=info;accessory._setupID=info.setupID;
  assert.equal(setupURI(info.pincode,info.setupID,17),accessory.setupURI());
  assert.equal(setupURI('bad','A7B9'),null);assert.equal(setupURI(info.pincode,'bad'),null);
});
test('published camera identity is saved privately without pairing secrets',async t=>{
  const {root,registry}=await fixture(t),hap=new HomebridgeAPI().hap;
  const accessory=new (new HomebridgeAPI().platformAccessory)('Living Camera',hap.uuid.generate('published-camera'),17);
  registry.track({did:'1001',name:'Living Camera',model:'chuangmi.camera.046c04'},accessory,hap);
  const underlying=accessory._associatedHAPAccessory,info=hap.AccessoryInfo.create('12:34:56:78:90:AB');
  Object.assign(info,{pincode:'518-24-963',category:17,setupID:'A7B9'});underlying._accessoryInfo=info;
  underlying.emit('listening',5555);await registry.writes.tail;
  const text=await fs.readFile(registry.file,'utf8'),data=JSON.parse(text);
  assert.equal(data.cameras[0].username,info.username);assert.equal(data.cameras[0].did,'1001');
  assert.ok(!text.includes(info.pincode));assert.ok(!text.includes(info.setupID));assert.ok(!text.includes('signSk'));
  assert.equal((await fs.stat(registry.file)).mode&0o777,0o600);
  await record(root,info.username,{category:17,pincode:info.pincode,setupID:info.setupID,pairedClients:{}});
  assert.equal((await readPairingDetails(root)).cameras[0].state,'ready');
});
test('pairing endpoint reads actual camera codes, paired status and locally generated QR images',async t=>{
  const {root,registry}=await fixture(t);
  registry.entries.set('1001',{did:'1001',name:'Living Camera',model:'c200',username:'12:34:56:78:90:AB'});await registry.save();
  const file=await record(root,'12:34:56:78:90:AB',{category:17,pincode:'518-24-963',setupID:'A7B9',pairedClients:{},signSk:'PRIVATE_SIGNING_KEY',passToken:'PRIVATE_ACCOUNT_TOKEN'});
  await record(root,'12:34:56:78:90:CD',{category:17,pincode:'875-13-246',setupID:'Z9C2',pairedClients:{}});
  let result=await readPairingDetails(root);
  assert.equal(result.running,true);assert.equal(result.cameras.length,1);assert.equal(result.cameras[0].pin,'518-24-963');assert.equal(result.cameras[0].paired,false);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_'));assert.ok(!JSON.stringify(result).includes('875-13-246'));
  const png=require('pngjs').PNG.sync.read(Buffer.from(result.cameras[0].qr.split(',')[1],'base64'));
  const decode=require('jsqr'),decoded=decode(new Uint8ClampedArray(png.data),png.width,png.height);
  assert.equal(decoded.data,setupURI('518-24-963','A7B9'));
  const before=await fs.readFile(file);await readPairingDetails(root);assert.ok(before.equals(await fs.readFile(file)));
  const changed=JSON.parse(before);changed.pairedClients={controller:'public-key'};await fs.writeFile(file,JSON.stringify(changed));
  result=await readPairingDetails(root);assert.equal(result.cameras[0].paired,true);
});
test('stopped, pending and invalid camera records never show invented setup codes',async t=>{
  const {root,registry}=await fixture(t);
  registry.entries.set('1001',{did:'1001',name:'Starting Camera',username:'../../private'});await registry.save();
  let result=await readPairingDetails(root);assert.equal(result.cameras[0].state,'starting');assert.equal(result.cameras[0].pin,undefined);
  registry.entries.set('1002',{did:'1002',name:'Wrong Category',username:'12:34:56:78:90:AB'});await registry.save();
  await record(root,'12:34:56:78:90:AB',{category:2,pincode:'518-24-963',setupID:'A7B9',pairedClients:{}});
  result=await readPairingDetails(root);assert.equal(result.cameras[1].pin,undefined);
  await registry.close();assert.deepEqual(await readPairingDetails(root),{running:false,cameras:[]});
});
