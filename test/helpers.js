'use strict';
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn,spawnSync}=require('node:child_process');
const readline=require('node:readline');
const {AsyncQueue}=require('../lib/async');
function fixture(codec=4,size='320x180'){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'xiaomi-camera-test-')),file=path.join(root,codec===4?'fixture.h264':'fixture.h265');
  const args=['-v','error','-f','lavfi','-i',`testsrc2=size=${size}:rate=20`,'-t','2','-an','-c:v',codec===4?'libx264':'libx265','-threads','1',...(codec===4?['-x264-params','aud=1:repeat-headers=1:keyint=20:bframes=0']:['-x265-params','aud=1:repeat-headers=1:keyint=20:bframes=0:pools=1:frame-threads=1:log-level=error']),'-f',codec===4?'h264':'hevc',file];
  const r=spawnSync('ffmpeg',args,{timeout:30000});if(r.status!==0)throw new Error(r.stderr.toString());
  const raw=fs.readFileSync(file),starts=[];
  for(let i=0;i<raw.length-5;i++){let header=-1;if(raw[i]===0&&raw[i+1]===0){if(raw[i+2]===1)header=i+3;else if(raw[i+2]===0&&raw[i+3]===1)header=i+4;}if(header>=0&&raw[header]===(codec===4?9:0x46)){starts.push(i);i=header;}}
  starts[0]=0;
  return {file,root,frames:starts.map((start,i)=>raw.subarray(start,starts[i+1]??raw.length)),close(){fs.rmSync(root,{recursive:true,force:true});}};
}
async function peer(transport,codec,fixturePath){
  const child=spawn(process.env.PYTHON||'python3',[path.join(__dirname,'fixtures/peer.py'),transport,String(codec),fixturePath],{env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},stdio:['pipe','pipe','pipe']});
  const lines=new AsyncQueue();let stderr='';child.stderr.on('data',d=>stderr+=d);
  const rl=readline.createInterface({input:child.stdout});rl.on('line',line=>{try{lines.push(JSON.parse(line));}catch{}});
  child.once('exit',()=>lines.close(new Error('Python peer exited: '+stderr)));
  let ready;
  try{ready=await lines.shift(10000);}catch(e){child.kill('SIGKILL');throw e;}
  const provisioning={...ready};for(const key of ['public','private','devicePublic'])provisioning[key]=Buffer.from(provisioning[key],'hex');
  return {ready,provisioning,async stats(){child.stdin.write('stats\n');return lines.shift(5000);},async close(){if(child.exitCode!==null)return;child.stdin.end('close\n');await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},4000);child.once('exit',()=>{clearTimeout(timer);resolve();});});rl.close();}};
}
module.exports={fixture,peer};
