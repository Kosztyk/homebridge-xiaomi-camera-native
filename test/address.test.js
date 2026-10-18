'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {CameraAddressResolver,cameraAddress,sameCamera}=require('../lib/address');
const {CameraSession}=require('../lib/session');
const {MissClient}=require('../lib/miss');
const {XiaomiCloud}=require('../lib/cloud');
const {AuthenticationError,CloudError,ProtocolError,TransportError}=require('../lib/errors');
const {fixture,peer}=require('./helpers');
const {delay}=require('../lib/async');
const OLD='192.168.68.97',NEW='192.168.68.120',MAC='78:DF:72:1A:36:3B';
const device=(host=OLD,extra={})=>({did:'1001',name:'Camera',model:'chuangmi.camera.046c04',mac:MAC,host,...extra});
const logger={debug(){},warn(){}};
function client(){return {connection:{protocol:'cs2+tcp',closed:false,error:null},async startMedia(){},async panTilt(){},close(){this.connection.closed=true;}};}
function setup(t,{options={},cloud:cloudOverrides={}}={}) {
  const cloud={region:'de',credentials:{user_id:'1000'},async provision(){return {};},async devices(){return [device(NEW)];},...cloudOverrides};
  const resolver=new CameraAddressResolver(cloud);
  const session=new CameraSession(cloud,device(),{host:OLD,autoUpdateIp:true,quality:'sd',...options},logger,resolver);
  t.after(async()=>{await resolver.close();await session.close();});
  return {cloud,resolver,session};
}
test('address discovery validates IPv4 and exact DID/model/MAC identity',()=>{
  for(const value of [undefined,123,'','camera.local','::1','0.0.0.0','0.1.2.3','127.0.0.1','224.0.0.1','255.255.255.255'])assert.equal(cameraAddress(value),null);
  assert.equal(cameraAddress(NEW),NEW);
  assert.equal(sameCamera(device(),device(NEW,{mac:'78-df-72-1a-36-3b'})),true);
  for(const extra of [{did:'other'},{model:'mxiang.camera.c301'},{mac:'00:11:22:33:44:55'}])assert.equal(sameCamera(device(),device(NEW,extra)),false);
});
test('several failed cameras share one rate-limited account discovery',async t=>{
  let calls=0;
  const resolver=new CameraAddressResolver({async devices(){calls++;return [device(NEW),device('192.168.68.121',{did:'1002'})];}});t.after(()=>resolver.close());
  assert.deepEqual(await Promise.all([resolver.cloudAddress(device()),resolver.cloudAddress(device(OLD,{did:'1002'})),resolver.cloudAddress(device())]),[NEW,'192.168.68.121',NEW]);
  assert.equal(await resolver.cloudAddress(device()),NEW);assert.equal(calls,1);
});
test('discovery failures are throttled and a later refresh sees a new DHCP address',async t=>{
  let time=1,calls=0;
  const resolver=new CameraAddressResolver({async devices(){if(++calls===1)throw new CloudError('Cloud offline');return [device(NEW)];}},{now:()=>time});t.after(()=>resolver.close());
  assert.equal(await resolver.cloudAddress(device()),null);assert.equal(await resolver.cloudAddress(device()),null);assert.equal(calls,1);
  time=31001;assert.equal(await resolver.cloudAddress(device()),NEW);assert.equal(calls,2);
});
test('a synchronous discovery failure cannot leave the shared refresh permanently occupied',async t=>{
  let now=1,calls=0;const resolver=new CameraAddressResolver({devices(){if(++calls===1)throw new CloudError('Offline');return Promise.resolve([device(NEW)]);}},{now:()=>now});t.after(()=>resolver.close());
  assert.equal(await resolver.cloudAddress(device()),null);assert.equal(resolver.refreshPromise,null);now=31001;assert.equal(await resolver.cloudAddress(device()),NEW);assert.equal(calls,2);
});
test('mismatched identities and invalid cloud addresses are never connection candidates',async t=>{
  for(const found of [device(NEW,{did:'wrong'}),device(NEW,{model:'mxiang.camera.c301'}),device(NEW,{mac:'00:11:22:33:44:55'}),device('127.0.0.1'),device('')]){
    const resolver=new CameraAddressResolver({async devices(){return [found];}});t.after(()=>resolver.close());
    assert.equal(await resolver.cloudAddress(device()),null);
  }
});
test('discovery timeout cancels the actual cloud HTTP request',async t=>{
  let aborted=false;
  const cloud=new XiaomiCloud('de',{fetch:async(_url,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(new Error('Aborted'));},{once:true}))});
  cloud.credentials={user_id:'1000',pass_token:'synthetic',service_token:'synthetic',security:Buffer.alloc(16,1).toString('base64')};
  const resolver=new CameraAddressResolver(cloud,{timeout:20});t.after(()=>resolver.close());
  assert.equal(await resolver.cloudAddress(device()),null);assert.equal(aborted,true);assert.equal(resolver.refreshPromise,null);
});
test('discovery cancellation also reaches an expired account refresh',async t=>{
  let requests=0,aborted=false;
  const cloud=new XiaomiCloud('de',{fetch:async(_url,{signal})=>{
    if(++requests===1)return new Response('{}',{status:401});
    return new Promise((_,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(new Error('Aborted'));},{once:true}));
  }});
  cloud.credentials={user_id:'1000',pass_token:'synthetic',service_token:'synthetic',security:Buffer.alloc(16,1).toString('base64')};
  const resolver=new CameraAddressResolver(cloud,{timeout:20});t.after(()=>resolver.close());
  assert.equal(await resolver.cloudAddress(device()),null);assert.equal(requests,2);assert.equal(aborted,true);
});
test('shutdown aborts shared discovery and releases waiting camera operations',async()=>{
  let started;
  const ready=new Promise(resolve=>{started=resolve;});let aborted=false;
  const resolver=new CameraAddressResolver({devices:({signal})=>new Promise((_,reject)=>{started();signal.addEventListener('abort',()=>{aborted=true;reject(new Error('Stopped'));},{once:true});})});
  const pending=resolver.cloudAddress(device());await ready;
  const rejected=assert.rejects(pending,/shut down/);await resolver.close();await rejected;
  assert.equal(aborted,true);assert.equal(resolver.refreshPromise,null);
});
test('authenticated addresses persist privately and remain scoped to the camera and account',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'xiaomi-address-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const cloud={region:'de',credentials:{user_id:'1000'}},first=new CameraAddressResolver(cloud,{storagePath:root});
  await first.confirm(device(),NEW);await first.close();
  assert.equal((await fs.stat(first.file)).mode&0o777,0o600);
  const second=new CameraAddressResolver(cloud,{storagePath:root});await second.load();
  assert.equal(second.knownAddress(device()),NEW);assert.equal(second.knownAddress(device(OLD,{mac:'00:11:22:33:44:55'})),null);await second.close();
  const other=new CameraAddressResolver({region:'de',credentials:{user_id:'2000'}},{storagePath:root});await other.load();assert.equal(other.knownAddress(device()),null);await other.close();
});
test('legacy saved IP recovers after authenticated discovery and keeps source settings',async t=>{
  const {cloud,resolver,session}=setup(t,{options:{quality:'0',transport:'udp'}});const attempts=[];let provisions=0;
  cloud.provision=async()=>({id:++provisions});const connected=client();
  t.mock.method(MissClient,'connect',async(host,keys,options)=>{attempts.push({host,keys,options});if(host===OLD)throw new TransportError('Old IP offline');return connected;});
  await session.connectClient(false);
  assert.deepEqual(attempts.map(a=>a.host),[OLD,NEW]);assert.equal(provisions,2);assert.equal(session.host,NEW);assert.equal(resolver.knownAddress(device()),NEW);
  assert.ok(attempts.every(a=>a.options.quality==='0'&&a.options.transport==='udp'&&a.options.startVideo===false));
  assert.equal(session.addressUpdates,1);
});
test('a healthy shared connection does not request address discovery',async t=>{
  const {cloud,session}=setup(t);let discoveries=0;
  cloud.devices=async()=>{discoveries++;return [device(NEW)];};
  t.mock.method(MissClient,'connect',async()=>client());
  const one=await session.connectClient(true),two=await session.connectClient(false);
  assert.equal(one,two);assert.equal(discoveries,0);
});
test('an edited starting address remains a candidate when the remembered IP stops working',async t=>{
  const {cloud,resolver,session}=setup(t);await resolver.confirm(device(),OLD);session.options.host=NEW;const attempts=[];let discoveries=0;
  cloud.devices=async()=>{discoveries++;return [device()];};
  t.mock.method(MissClient,'connect',async host=>{attempts.push(host);if(host===OLD)throw new TransportError('Old IP offline');return client();});
  await session.connectClient(true);assert.deepEqual(attempts,[OLD,NEW]);assert.equal(session.host,NEW);assert.equal(discoveries,0);assert.equal(resolver.knownAddress(device()),NEW);
});
test('failed MISS authentication never saves an unverified discovered IP',async t=>{
  const {resolver,session}=setup(t);t.mock.method(MissClient,'connect',async()=>{throw new ProtocolError('Camera rejected authentication');});
  await assert.rejects(session.connectClient(true),/rejected authentication/);
  assert.equal(session.host,OLD);assert.equal(session.addressUpdates,0);assert.equal(resolver.knownAddress(device()),null);
});
test('fixed IP mode ignores recovery cache and does not discover alternatives',async t=>{
  const {cloud,resolver,session}=setup(t,{options:{autoUpdateIp:false}});await resolver.confirm(device(),NEW);let discoveries=0;const attempts=[];
  cloud.devices=async()=>{discoveries++;return [device(NEW)];};
  t.mock.method(MissClient,'connect',async host=>{attempts.push(host);throw new TransportError('Fixed IP offline');});
  await assert.rejects(session.connectClient(true),/Fixed IP offline/);
  assert.deepEqual(attempts,[OLD]);assert.equal(discoveries,0);assert.equal(resolver.knownAddress(device()),NEW);
});
test('cloud credential failure stops recovery without trying other IPs',async t=>{
  const {cloud,session}=setup(t);let discoveries=0,connections=0;
  cloud.provision=async()=>{throw new AuthenticationError('Expired account');};cloud.devices=async()=>{discoveries++;return [device(NEW)];};
  t.mock.method(MissClient,'connect',async()=>{connections++;return client();});
  await assert.rejects(session.connectClient(true),/Expired account/);assert.equal(discoveries,0);assert.equal(connections,0);
});
test('duplicate candidates are attempted once and cloud outages retain the LAN error',async t=>{
  for(const offline of [false,true]) {
    const {session}=setup(t,{cloud:{async devices(){if(offline)throw new CloudError('Cloud offline');return [device()];}}});let attempts=0;
    t.mock.method(MissClient,'connect',async()=>{attempts++;throw new TransportError('Handshake timed out');});
    await assert.rejects(session.connectClient(true),/Handshake timed out/);assert.equal(attempts,1);
    t.mock.restoreAll();
  }
});
test('periodic discovery cannot overwrite a successfully recovered working IP',async t=>{
  const {session}=setup(t);const attempts=[];
  t.mock.method(MissClient,'connect',async host=>{attempts.push(host);if(host===OLD)throw new TransportError('Old IP offline');return client();});
  await session.connectClient(true);session.client.close();session.device=device();session.options={host:OLD,quality:'sd'};
  await session.connectClient(true);assert.deepEqual(attempts,[OLD,NEW,NEW]);assert.equal(session.host,NEW);
});
test('automatic recovery survives long outages while watched; fixed mode stays bounded',async t=>{
  for(const automatic of [true,false]) {
    const {session}=setup(t,{options:{autoUpdateIp:automatic}});let attempts=0;
    session.consumers.add({write(){},end(){}});
    t.mock.method(session,'waitForRetry',async()=>{});
    t.mock.method(session,'connectClient',async()=>{if(++attempts<=5)throw new TransportError('Router restarting');session.closed=true;return client();});
    await session.run();assert.equal(attempts,automatic?6:4);
  }
});
test('shutdown interrupts an address-recovery retry delay',async t=>{
  const {session}=setup(t);session.consumers.add({write(){},end(){}});
  const wait=session.waitForRetry(30000),started=performance.now();await session.close();await wait;
  assert.ok(performance.now()-started<1000);
});
test('recovered address authenticates against the original peer and shares video with PTZ',{timeout:15000},async t=>{
  const f=fixture(4);t.after(()=>f.close());const p=await peer('tcp',4,f.file);t.after(()=>p.close());
  const original=MissClient.connect;
  t.mock.method(MissClient,'connect',async(host,...args)=>{if(host==='127.0.0.2')throw new TransportError('Simulated old DHCP address');return original.call(MissClient,host,...args);});
  const resolver={knownAddress(){return null;},async cloudAddress(){return '127.0.0.1';},async confirm(){}};
  const session=new CameraSession({provision:async()=>p.provisioning},device('127.0.0.2'),{host:'127.0.0.2',autoUpdateIp:true,port:p.ready.port,transport:'tcp',quality:'sd'},logger,resolver);t.after(()=>session.close());
  const connected=await session.connectClient(true);
  const video=await connected.readVideo();assert.ok(video.payload.equals(f.frames[0]));assert.equal(session.host,'127.0.0.1');
  await session.panTilt('right');let stats;
  // TCP delivery can finish before the peer's event loop processes the command.
  for(let i=0;i<50;i++){stats=await p.stats();if(stats.operations.length)break;await delay(10);}
  assert.equal(stats.authentications,1);assert.equal(stats.mediaStarts,1);assert.equal(stats.quality,1);assert.deepEqual(stats.operations,[2]);
});
