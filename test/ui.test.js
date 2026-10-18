'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {fork}=require('node:child_process');
const {JSDOM}=require('jsdom');
const {delay,AsyncQueue}=require('../lib/async');
const html=fs.readFileSync(path.join(__dirname,'../homebridge-ui/public/index.html'),'utf8').replace('<script src="app.js"></script>','');
const app=fs.readFileSync(path.join(__dirname,'../homebridge-ui/public/app.js'),'utf8');
async function until(predicate){for(let i=0;i<100;i++){if(predicate())return;await delay(10);}throw Error('UI operation did not finish');}
test('setup UI handles verification, clears password and saves only chosen camera IDs',async t=>{
  let saved=null,saveCount=0;const requests=[];
  const dom=new JSDOM(html,{runScripts:'outside-only'});t.after(()=>dom.window.close());const w=dom.window,d=w.document;
  w.homebridge={getPluginConfig:async()=>[],request:async(route,payload)=>{
    requests.push({route,payload});
    if(route==='/pairing')return {ok:true,running:false,cameras:[]};
    if(route==='/login')return {ok:true,challenge:{kind:'verification',destination:'t***@example.com'}};
    if(route==='/challenge')return {ok:true,authenticated:true,authId:'a'.repeat(32),devices:[{did:'1001',name:'Living Camera',model:'chuangmi.camera.046c04',host:'192.168.68.97',online:true},{did:'1002',name:'Bedroom Camera',model:'mxiang.camera.c301',host:'192.168.68.98',online:true}]};
    throw Error('Unexpected request');
  },updatePluginConfig:async config=>{saved=JSON.parse(JSON.stringify(config));},savePluginConfig:async()=>{saveCount++;}};
  w.eval(app);await until(()=>!d.getElementById('login').disabled);
  d.getElementById('username').value='test-user';d.getElementById('password').value='synthetic-secret';d.getElementById('login').click();await until(()=>!d.getElementById('challenge').hidden&&!d.getElementById('login').disabled);
  assert.equal(d.getElementById('password').value,'');d.getElementById('answer').value='123456';d.getElementById('submit-challenge').click();await until(()=>d.querySelectorAll('.camera').length===2&&!d.getElementById('save').disabled);
  d.querySelectorAll('.camera .enabled')[1].checked=false;d.getElementById('save').click();await until(()=>saveCount===1);
  assert.equal(saved[0].authId,'a'.repeat(32));assert.equal(saved[0].includeOnlyConfigured,true);assert.deepEqual(saved[0].cameras.map(c=>[c.did,c.exclude]),[['1001',false],['1002',true]]);assert.equal(saved[0].password,undefined);assert.ok(!JSON.stringify(saved).includes('synthetic-secret'));assert.equal(requests.find(r=>r.route==='/challenge').payload.answer,'123456');
});
test('UI refresh preserves names, IP overrides and disabled selections',async t=>{
  const dom=new JSDOM(html,{runScripts:'outside-only'});t.after(()=>dom.window.close());const w=dom.window,d=w.document;
  const cameras=[{did:'1001',name:'Cloud Name',model:'mxiang.camera.c301',host:'192.168.68.98',online:true}];let saved;
  w.homebridge={getPluginConfig:async()=>[{platform:'XiaomiCameraNative',authId:'b'.repeat(32),region:'de',cameras:[{did:'1001',name:'My Camera',host:'192.168.68.99',exclude:true}]}],request:async route=>route==='/pairing'?{ok:true,running:false,cameras:[]}:{ok:true,authenticated:true,authId:'b'.repeat(32),devices:cameras},updatePluginConfig:async value=>{saved=JSON.parse(JSON.stringify(value));},savePluginConfig:async()=>{}};
  w.eval(app);await until(()=>d.querySelector('.camera')&&!d.getElementById('refresh').disabled);d.querySelector('.camera .host').value='192.168.68.100';d.getElementById('refresh').click();await until(()=>!d.getElementById('refresh').disabled);
  assert.equal(d.querySelector('.camera .host').value,'192.168.68.100');assert.equal(d.querySelector('.camera .device-name').value,'My Camera');assert.equal(d.querySelector('.camera .enabled').checked,false);
  d.getElementById('save').click();await until(()=>saved&&!d.getElementById('save').disabled);assert.equal(saved[0].cameras[0].host,'192.168.68.100');assert.equal(saved[0].cameras[0].exclude,true);
});
test('custom UI server starts under Homebridge IPC and returns safe errors',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xiaomi-ui-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const child=fork(path.join(__dirname,'../homebridge-ui/server.js'),{env:{...process.env,HOMEBRIDGE_STORAGE_PATH:dir},stdio:['ignore','pipe','pipe','ipc']});t.after(()=>child.kill('SIGKILL'));
  const queue=new AsyncQueue();child.on('message',m=>queue.push(m));const ready=await queue.shift(5000);assert.equal(ready.action,'ready');
  child.send({action:'request',requestId:1,path:'/status',body:{}});const first=await queue.shift(5000);assert.deepEqual(first.payload.data,{ok:true,authenticated:false});
  child.send({action:'request',requestId:2,path:'/status',body:{authId:'../../private-secret'}});const second=await queue.shift(5000);assert.equal(second.payload.data.ok,false);assert.ok(!JSON.stringify(second.payload.data).includes('private-secret'));
  child.send({action:'request',requestId:3,path:'/pairing',body:{file:'../../private-secret'}});const third=await queue.shift(5000);assert.deepEqual(third.payload.data,{ok:true,running:false,cameras:[]});
});
test('pairing codes, QR images and copy buttons remain available when Xiaomi login fails',async t=>{
  const dom=new JSDOM(html,{runScripts:'outside-only'});t.after(()=>dom.window.close());const w=dom.window,d=w.document;
  let copied='',refreshes=0;const requests=[];
  Object.defineProperty(w.navigator,'clipboard',{value:{writeText:async text=>{copied=text;}}});
  w.homebridge={getPluginConfig:async()=>[{platform:'XiaomiCameraNative',authId:'c'.repeat(32),region:'de'}],request:async route=>{
    requests.push(route);
    if(route==='/pairing'){refreshes++;return {ok:true,running:true,cameras:[{did:'1001',name:'Living Camera',state:'ready',pin:'518-24-963',paired:refreshes>1,qr:'data:image/png;base64,AAAA'},{did:'1002',name:'Bedroom Camera',state:'starting'}]};}
    if(route==='/status')return {ok:false,error:'Xiaomi needs a new login'};
    throw Error('Unexpected request');
  }};
  w.eval(app);await until(()=>d.querySelectorAll('.pairing-camera').length===2&&!d.getElementById('login').disabled);
  assert.equal(d.querySelector('.pairing-code').value,'518-24-963');assert.equal(d.querySelector('.pairing-qr').src,'data:image/png;base64,AAAA');
  assert.equal(d.querySelectorAll('.pairing-camera')[1].querySelector('.pairing-code'),null);
  assert.equal(d.querySelector('.pairing-state').textContent,'Ready to add');assert.ok(!requests.includes('/login'));
  const button=d.querySelector('.pairing-camera button');assert.equal(button.disabled,false);button.click();await until(()=>copied==='518-24-963');
  d.getElementById('pairing-refresh').click();await until(()=>refreshes===2&&!d.getElementById('pairing-refresh').disabled);
  assert.equal(d.querySelector('.pairing-state').textContent,'Already paired');
});
test('copy fallback selects the code on browsers without clipboard permission',async t=>{
  const dom=new JSDOM(html,{runScripts:'outside-only'});t.after(()=>dom.window.close());const w=dom.window,d=w.document;
  w.homebridge={getPluginConfig:async()=>[],request:async()=>({ok:true,running:true,cameras:[{did:'1001',name:'Camera',state:'ready',pin:'518-24-963',paired:false}]})};
  w.eval(app);await until(()=>d.querySelector('.pairing-code')&&!d.getElementById('login').disabled);
  d.querySelector('.pairing-camera button').click();const input=d.querySelector('.pairing-code');
  assert.equal(d.activeElement,input);assert.equal(input.selectionStart,0);assert.equal(input.selectionEnd,input.value.length);
});
