'use strict';
(() => {
  const $=id=>document.getElementById(id);let blocks=[],config={},authId='',challenge=null,devices=[],busy=false;
  const esc=string=>String(string??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function status(message,error=false){$('status').hidden=!message;$('status').textContent=message;$('status').className='status'+(error?' error':'');}
  async function task(fn){if(busy)return;busy=true;document.querySelectorAll('button:not([data-pairing])').forEach(b=>b.disabled=true);try{await fn();}catch(e){status(e.message||'Request failed',true);}finally{busy=false;document.querySelectorAll('button:not([data-pairing])').forEach(b=>b.disabled=false);}}
  async function request(path,payload){const result=await homebridge.request(path,payload);if(!result.ok)throw new Error(result.error||'Request failed');return result;}
  let pairingLoading=false;
  async function refreshPairing(){
    if(pairingLoading)return;pairingLoading=true;$('pairing-refresh').disabled=true;
    try{
      const result=await request('/pairing',{}),box=$('pairing-list');box.replaceChildren();
      $('pairing-note').textContent=!result.running?'Restart Homebridge after installing this update, then refresh to show your cameras.':result.cameras.length?'These are the cameras currently running in Homebridge.':'No cameras are published yet. Save your camera selection, restart Homebridge, then refresh.';
      for(const camera of result.cameras){
        const el=document.createElement('div');el.className='pairing-camera';el.dataset.did=camera.did;
        const title=document.createElement('h3');title.textContent=camera.name;el.append(title);
        const state=document.createElement('span');state.className='pairing-state'+(camera.paired?' paired':'');state.textContent=camera.state!=='ready'?'Starting…':camera.paired?'Already paired':'Ready to add';el.append(state);
        if(camera.pin){
          const input=document.createElement('input');input.className='pairing-code';input.readOnly=true;input.value=camera.pin;input.setAttribute('aria-label','HomeKit pairing code for '+camera.name);el.append(input);
          const copy=document.createElement('button');copy.type='button';copy.textContent='Copy code';copy.dataset.pairing='';
          copy.addEventListener('click',async()=>{
            try{if(!navigator.clipboard?.writeText)throw new Error();await navigator.clipboard.writeText(camera.pin);copy.textContent='Copied';}
            catch{input.focus();input.select();copy.textContent='Code selected — copy it';}
          });el.append(copy);
        }else{const waiting=document.createElement('p');waiting.className='small';waiting.textContent='Waiting for Homebridge to publish this camera. Refresh shortly.';el.append(waiting);}
        if(typeof camera.qr==='string'&&camera.qr.startsWith('data:image/png;base64,')){const img=document.createElement('img');img.className='pairing-qr';img.src=camera.qr;img.alt='Apple Home pairing QR code for '+camera.name;el.append(img);}
        box.append(el);
      }
    }catch(e){$('pairing-note').textContent=e.message||'Could not read pairing details. Restart Homebridge and refresh.';}
    finally{pairingLoading=false;$('pairing-refresh').disabled=false;}
  }
  $('pairing-refresh').addEventListener('click',refreshPairing);
  function currentOverrides(){
    const map=new Map((config.cameras||[]).filter(c=>c&&c.did).map(c=>[String(c.did),{...c}]));
    document.querySelectorAll('.camera').forEach(el=>{
      const did=el.dataset.did,prev=map.get(did)||{};
      map.set(did,{...prev,did,exclude:!el.querySelector('.enabled').checked,host:el.querySelector('.host').value.trim(),autoUpdateIp:el.querySelector('.auto-ip').checked,name:el.querySelector('.device-name').value.trim(),quality:el.querySelector('.quality').value,transport:el.querySelector('.transport').value});
    });return map;
  }
  function renderDevices(list){
    const overrides=currentOverrides();devices=list;const box=$('camera-list');box.replaceChildren();
    if(!list.length){const p=document.createElement('p');p.textContent='No cameras were returned. Check that this is the region and account used in Mi Home.';box.append(p);}
    for(const d of list){
      const c=overrides.get(d.did)||{},el=document.createElement('div');el.className='camera';el.dataset.did=d.did;
      const enabled=overrides.has(d.did)?c.exclude!==true:!config.includeOnlyConfigured;
      const automatic=c.autoUpdateIp!==false,host=(automatic&&d.workingHost)||c.host||d.host||'';
      el.innerHTML=`<div class="camera-title"><input class="enabled" type="checkbox" id="device-${esc(d.did)}" ${enabled?'checked':''}><label for="device-${esc(d.did)}">${esc(d.name)}</label></div><div class="details">${esc(d.model)} · ID ${esc(d.did)}${d.online?'':' · Offline in Xiaomi cloud'}</div><div class="grid"><div><label>Display name<input class="device-name" value="${esc(c.name||d.name)}"></label></div><div><label>Camera IPv4 address<input class="host" value="${esc(host)}" placeholder="192.168.68.x"></label></div><div><label>Source quality<select class="quality"><option value="auto">Automatic</option><option value="hd">HD</option><option value="sd">SD</option><option value="0">0</option><option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="4">4</option><option value="5">5</option></select></label></div><div><label>Transport<select class="transport"><option value="auto">Automatic</option><option value="udp">UDP</option><option value="tcp">TCP</option></select></label></div><div class="wide"><label class="check"><input class="auto-ip" type="checkbox" ${automatic?'checked':''}>Automatically update IP</label><p class="small">Recover camera address changes through Xiaomi discovery and remember the working IP. Turn off to use only the address above.</p></div></div>`;
      el.querySelector('.quality').value=c.quality||(d.model==='mxiang.camera.c301'?'auto':'hd');el.querySelector('.transport').value=c.transport||'auto';box.append(el);
    }
    $('cameras-section').hidden=false;
  }
  function signedIn(result){
    if(result.challenge){challenge=result.challenge;$('challenge').hidden=false;$('answer').value='';$('captcha-image').hidden=challenge.kind!=='captcha';if(challenge.image)$('captcha-image').src=challenge.image;$('challenge-text').textContent=challenge.kind==='captcha'?'Enter the characters shown below.':`Enter the code Xiaomi sent to ${challenge.destination||'your account'}.`;status('Xiaomi requires account verification.');return;}
    if(result.authenticated){authId=result.authId;$('challenge').hidden=true;challenge=null;$('password').value='';$('passToken').value='';$('account-state').textContent='Signed in';renderDevices(result.devices||[]);status('Account connected. Choose cameras, save settings, then restart Homebridge.');}
  }
  $('method').addEventListener('change',()=>{const token=$('method').value==='token';document.querySelectorAll('.password-field').forEach(e=>e.classList.toggle('hidden',token));document.querySelectorAll('.token-field').forEach(e=>e.classList.toggle('hidden',!token));});
  $('region').addEventListener('change',()=>{authId='';$('account-state').textContent='Sign in for the selected region';$('cameras-section').hidden=true;status('Sign in again for the selected region.');});
  $('login').addEventListener('click',()=>task(async()=>{
    status('Signing in to Xiaomi…');const payload={region:$('region').value,method:$('method').value,username:$('username').value.trim(),password:$('password').value,userId:$('userId').value.trim(),passToken:$('passToken').value.trim()};
    try{signedIn(await request('/login',payload));}finally{$('password').value='';$('passToken').value='';}
  }));
  $('submit-challenge').addEventListener('click',()=>task(async()=>signedIn(await request('/challenge',{kind:challenge?.kind,answer:$('answer').value}))));
  $('refresh').addEventListener('click',()=>task(async()=>{status('Refreshing camera list…');signedIn(await request('/devices',{authId,region:$('region').value}));}));
  $('save').addEventListener('click',()=>task(async()=>{
    if(!authId)throw new Error('Sign in before saving camera settings.');
    const cameras=[...currentOverrides().values()];
    for(const c of cameras)if(!c.exclude&&!(c.autoUpdateIp!==false&&!c.host)&&(!/^\d{1,3}(\.\d{1,3}){3}$/.test(c.host)||c.host.split('.').some(x=>Number(x)>255)))throw new Error('Set a valid IPv4 address for '+(c.name||c.did));
    const next={...config,platform:'XiaomiCameraNative',name:config.name||'Xiaomi Camera Native',region:$('region').value,authId,includeOnlyConfigured:true,cameras,maxWidth:1280,maxHeight:Number($('maxHeight').value),maxFPS:Number($('maxFPS').value),maxBitrate:Number($('maxBitrate').value)||1500,idleTimeout:Number($('idleTimeout').value),exposePanTilt:$('exposePanTilt').checked,ffmpegPath:$('ffmpegPath').value.trim()};
    delete next.username;delete next.password;delete next.userId;delete next.passToken;
    const index=blocks.findIndex(b=>b.platform==='XiaomiCameraNative');if(index<0)blocks.push(next);else blocks[index]=next;
    await homebridge.updatePluginConfig(blocks);await homebridge.savePluginConfig();config=next;status('Saved. Restart Homebridge, reopen these settings and refresh pairing details to add each camera in Apple Home.');
  }));
  task(async()=>{
    blocks=await homebridge.getPluginConfig();config=blocks.find(b=>b.platform==='XiaomiCameraNative')||{};authId=config.authId||'';
    for(const [id,def] of [['region','de'],['maxHeight',720],['maxFPS',20],['maxBitrate',1500],['idleTimeout',15],['ffmpegPath','']])$(id).value=config[id]??def;
    $('exposePanTilt').checked=config.exposePanTilt!==false;
    await refreshPairing();
    if(authId){status('Checking saved account…');const result=await request('/status',{authId,region:$('region').value});if(result.authenticated)signedIn(result);else status('Sign in for the selected region.');}
  });
})();
