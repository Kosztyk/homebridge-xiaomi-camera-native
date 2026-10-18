'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {XiaomiCloud,CookieJar}=require('../lib/cloud');
const {fromB64,rc4Drop1024}=require('../lib/crypto');
const {createHash}=require('node:crypto');
const {AuthenticationError,LoginChallenge}=require('../lib/errors');
function response(data,{status=200,cookies=[],headers={},body}={}) {const h=new Headers(headers);for(const c of cookies)h.append('set-cookie',c);return new Response(body===undefined?'&&&START&&&'+JSON.stringify(data||{}):body,{status,headers:h});}
function mock(...responses){const calls=[];const fetch=async(url,options)=>{calls.push({url:String(url),...options});const item=responses.shift();if(!item)throw Error('Unexpected request');return typeof item==='function'?item(url,options):item;};return {fetch,calls};}
function fields(){return {userId:'1000',passToken:'synthetic-pass',ssecurity:Buffer.alloc(16,2).toString('base64'),location:'https://account.xiaomi.com/callback'};}
test('authentication retains credentials across JSON, cookies, headers and redirects',async()=>{
  const f=fields(),http=mock(response(f,{cookies:['serviceToken=early-service; Path=/'],headers:{'Extension-Pragma':JSON.stringify({cUserId:'cuser'})}}),response({}, {status:302,headers:{Location:'https://de.api.io.mi.com/callback'}}),response({}, {cookies:['passToken=; Max-Age=0','serviceToken=; Max-Age=0']}));
  const cloud=new XiaomiCloud('de',{fetch:http.fetch});await cloud.loginWithToken('1000','synthetic-pass');assert.deepEqual(cloud.credentials,{user_id:'1000',pass_token:'synthetic-pass',service_token:'early-service',c_user_id:'cuser',security:f.ssecurity});
});
test('missing credentials and invalid redirects never expose secret values',async()=>{
  const f=fields();delete f.ssecurity;const cloud=new XiaomiCloud('de',{fetch:mock(response(f),response({}, {cookies:['serviceToken=private-service']})).fetch});
  await assert.rejects(cloud.loginWithToken('1000','private-pass'),e=>e instanceof AuthenticationError&&e.message.includes('security')&&!e.message.includes('private-'));
  const other=new XiaomiCloud('de',{fetch:mock(response({...fields(),location:'https://example.com/steal'})).fetch});await assert.rejects(other.loginWithToken('1000','private-pass'),/Unexpected Xiaomi login redirect/);
});
test('cloud request signing and response encryption interoperate independently',async()=>{
  const security=Buffer.alloc(16,9);let checked=false;
  const http=mock((_url,opts)=>{
    const params=new URLSearchParams(opts.body),nonce=fromB64(params.get('_nonce'));
    const signed=createHash('sha256').update(Buffer.concat([security,nonce])).digest();
    const data=rc4Drop1024(signed,fromB64(params.get('data'))).toString();assert.deepEqual(JSON.parse(data),{limit:1});
    const expectedHash=createHash('sha1').update(['POST','/v2/home/device_list_page','data='+data,signed.toString('base64')].join('&')).digest('base64');
    assert.equal(rc4Drop1024(signed,fromB64(params.get('rc4_hash__'))).toString(),expectedHash);
    const expectedSignature=createHash('sha1').update(['POST','/v2/home/device_list_page','data='+params.get('data'),'rc4_hash__='+params.get('rc4_hash__'),signed.toString('base64')].join('&')).digest('base64');assert.equal(params.get('signature'),expectedSignature);checked=true;
    return response({}, {body:rc4Drop1024(signed,Buffer.from(JSON.stringify({code:0,result:{list:[]}}))).toString('base64')});
  });
  const cloud=new XiaomiCloud('de',{fetch:http.fetch});cloud.credentials={user_id:'1000',pass_token:'pass',service_token:'service',c_user_id:'',security:security.toString('base64')};
  assert.deepEqual(await cloud.request('/v2/home/device_list_page',{limit:1}),{list:[]});assert.ok(checked);
});
test('password login supports CAPTCHA without persisting the password',async()=>{
  const init={sid:'xiaomiio',callback:'callback',_sign:'sign',qs:'qs'};
  const http=mock(response(init),response({captchaURL:'/captcha'}),response({}, {body:Buffer.from('synthetic-image'),cookies:['ick=test-ick; Path=/']}),response(init),response({...fields(),serviceToken:'service'}),response());
  const cloud=new XiaomiCloud('de',{fetch:http.fetch});await assert.rejects(cloud.login('test','password'),e=>e instanceof LoginChallenge&&e.kind==='captcha'&&e.image.startsWith('data:image/jpeg;base64,'));
  assert.equal(cloud.auth.password,undefined);await cloud.submitCaptcha('abc');assert.deepEqual(cloud.auth,{});assert.ok(http.calls[4].body.includes('captCode=abc'));
});
test('password login supports email verification and preserves session fields',async()=>{
  const http=mock(response({sid:'xiaomiio',callback:'cb',_sign:'s',qs:'q'}),response({notificationUrl:'https://account.xiaomi.com/fe/service/identity/authStart'}),response({flag:8},{cookies:['identity_session=identity; Path=/']}),response({maskedEmail:'t***@example.com'}),response({code:0}),response(fields()),response({}, {cookies:['serviceToken=verified; Path=/']}));
  const cloud=new XiaomiCloud('de',{fetch:http.fetch});await assert.rejects(cloud.login('test','password'),e=>e instanceof LoginChallenge&&e.kind==='verification');await cloud.submitVerification('123456');assert.equal(cloud.credentials.service_token,'verified');assert.ok(http.calls[5].url.includes('ticket=123456'));
});
test('pagination retains cameras and drops unrelated devices',async()=>{
  const cloud=new XiaomiCloud();let n=0;cloud.request=async()=>++n===1?{list:[{did:1,model:'chuangmi.camera.029a02',name:'One',localip:'192.168.68.1'},{did:2,model:'zhimi.airpurifier.v1'}],has_more:true,next_start_did:'3'}:{list:[{did:3,model:'mxiang.camera.c301',name:'Two'}],has_more:false};
  assert.deepEqual((await cloud.devices()).map(d=>d.did),['1','3']);
});
test('cookie jar respects domain, path and secure attributes',()=>{
  const jar=new CookieJar(),h=new Headers();h.append('set-cookie','a=1; Domain=.xiaomi.com; Path=/pass; Secure');jar.take(h,'https://account.xiaomi.com/pass/serviceLogin');
  assert.equal(jar.header('https://account.xiaomi.com/pass/next'),'a=1');assert.equal(jar.header('https://evil.example/pass'),'');assert.equal(jar.header('http://account.xiaomi.com/pass'),'');assert.equal(jar.header('https://account.xiaomi.com/identity'),'');
});
test('cookie serialization preserves base64 token characters',()=>{
  const jar=new CookieJar();assert.equal(jar.header('https://de.api.io.mi.com',{serviceToken:'token+value/with=padding'}),'serviceToken=token+value/with=padding');
});
test('corrupt saved security refreshes using the existing account credential',async()=>{
  const cloud=new XiaomiCloud('de',{fetch:mock(response({...fields(),serviceToken:'new-service'}),response()).fetch});
  await cloud.authenticate({user_id:'1000',pass_token:'synthetic-pass',service_token:'old-service',security:'invalid-base64'});assert.equal(cloud.credentials.service_token,'new-service');
});
