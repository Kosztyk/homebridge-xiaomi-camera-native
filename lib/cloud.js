'use strict';
// Xiaomi account and MISS provisioning, adapted from the supplied integration.
const {createHash,randomBytes}=require('node:crypto');
const {b64,fromB64,encryptCloudRequest,rc4Drop1024,generateKeypair}=require('./crypto');
const {AuthenticationError,CloudError,LoginChallenge,ProtocolError}=require('./errors');
const {Mutex}=require('./async');
const REGIONS={cn:'China',de:'Europe',i2:'India',ru:'Russia',sg:'Singapore',us:'United States'};
const ACCOUNT='https://account.xiaomi.com';
class CookieJar {
  constructor() { this.cookies=new Map(); }
  take(headers,url) {
    const u=new URL(url);
    for(const line of headers.getSetCookie?.()||[]) {
      const [first,...attrs]=line.split(';'),eq=first.indexOf('='); if(eq<1) continue;
      const cookie={name:first.slice(0,eq).trim(),value:first.slice(eq+1).trim(),domain:u.hostname,path:'/',hostOnly:true,secure:false};
      for(const attr of attrs) {
        const [raw,...rest]=attr.trim().split('='),name=raw.toLowerCase(),value=rest.join('=');
        if(name==='domain') { cookie.domain=value.replace(/^\./,'').toLowerCase(); cookie.hostOnly=false; }
        if(name==='path') cookie.path=value;
        if(name==='secure') cookie.secure=true;
        if(name==='max-age') cookie.expires=Date.now()+Number(value)*1000;
        if(name==='expires'&&cookie.expires===undefined) cookie.expires=Date.parse(value);
      }
      if(u.hostname!==cookie.domain&&!u.hostname.endsWith('.'+cookie.domain)) continue;
      const id=[cookie.domain,cookie.path,cookie.name].join('|');
      if(!cookie.value||cookie.expires<=Date.now()) this.cookies.delete(id); else this.cookies.set(id,cookie);
    }
  }
  header(url,extra={}) {
    const u=new URL(url),out={};
    for(const c of this.cookies.values()) {
      if(c.expires<=Date.now()||(c.secure&&u.protocol!=='https:')) continue;
      if((c.hostOnly?u.hostname===c.domain:u.hostname===c.domain||u.hostname.endsWith('.'+c.domain))&&u.pathname.startsWith(c.path)) out[c.name]=c.value;
    }
    return Object.entries({...out,...extra}).map(([k,v])=>{
      if(/[;\r\n]/.test(String(v)))throw new AuthenticationError('Invalid Xiaomi account cookie');
      return `${k}=${v}`;
    }).join('; ');
  }
}
class XiaomiCloud {
  constructor(region='de',options={}) {
    if(!(region in REGIONS)) throw new ProtocolError('Unsupported Xiaomi region');
    this.region=region; this.fetch=options.fetch||globalThis.fetch; this.onCredentials=options.onCredentials||(()=>{});
    this.jar=new CookieJar(); this.credentials={user_id:'',pass_token:'',service_token:'',c_user_id:'',security:''}; this.auth={}; this.refresh=new Mutex();
  }
  get baseURL() { return `https://${this.region==='cn'?'':this.region+'.'}api.io.mi.com/app`; }
  missing() { return ['user_id','pass_token','service_token','security'].filter(k=>!this.credentials[k]); }
  takeFields(data) {
    if(!data||typeof data!=='object'||Array.isArray(data)) throw new AuthenticationError('Invalid Xiaomi authentication fields');
    for(const [source,target] of [['userId','user_id'],['passToken','pass_token'],['cUserId','c_user_id'],['serviceToken','service_token']]) if(data[source]) this.credentials[target]=String(data[source]);
    if(data.ssecurity) { fromB64(data.ssecurity); this.credentials.security=data.ssecurity; }
  }
  takeResponse(response,url) {
    this.jar.take(response.headers,url);
    for(const line of response.headers.getSetCookie?.()||[]) {
      const eq=line.indexOf('='),name=line.slice(0,eq).trim(),value=line.slice(eq+1).split(';',1)[0];
      if(value&&['userId','passToken','cUserId','serviceToken'].includes(name)) this.takeFields({[name]:value});
    }
    const extra=response.headers.get('extension-pragma');
    if(extra) { try { this.takeFields(JSON.parse(extra)); } catch { throw new AuthenticationError('Invalid Xiaomi authentication headers'); } }
  }
  async http(method,url,{form,params,cookies={},headers={},signal}={}) {
    const u=new URL(url); if(params) for(const [k,v] of Object.entries(params)) u.searchParams.set(k,v);
    try {
      const response=await this.fetch(u,{method,redirect:'manual',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000),
        headers:{'User-Agent':'Android-7.1.1-1.0.0-ONEPLUS A3010-136-XIAOMIAPP-APP/com.xiaomi.smarthome APPV/62830','Accept-Encoding':'identity',...(form?{'Content-Type':'application/x-www-form-urlencoded'}:{}),Cookie:this.jar.header(u,cookies),...headers},
        body:form?new URLSearchParams(form).toString():undefined});
      this.takeResponse(response,u);
      const chunks=[]; let size=0;
      if(response.body) for await(const chunk of response.body) { size+=chunk.length; if(size>4*1024*1024) throw new CloudError('Xiaomi response exceeded its size limit'); chunks.push(chunk); }
      return {status:response.status,headers:response.headers,body:Buffer.concat(chunks)};
    } catch(e) { if(e instanceof CloudError||e instanceof AuthenticationError||e instanceof ProtocolError) throw e; throw new CloudError('Cannot connect to Xiaomi cloud; check internet access'); }
  }
  async loginRequest(method,url,options={}) {
    const r=await this.http(method,url,options);
    if(r.status!==200) throw new CloudError('Xiaomi login service is unavailable');
    if(options.image) return r;
    try {
      const text=r.body.toString('utf8'); if(!text.startsWith('&&&START&&&')) throw Error();
      const data=JSON.parse(text.slice(11)); if(!data||typeof data!=='object'||Array.isArray(data)) throw Error();
      this.takeFields(data);
      return {data,headers:r.headers};
    } catch { throw new CloudError('Unexpected Xiaomi login response'); }
  }
  async login(username,password) {
    if(!username||!password) throw new AuthenticationError('Enter your Xiaomi username and password');
    this.auth={username,hash:createHash('md5').update(password).digest('hex').toUpperCase()}; return this.passwordLogin();
  }
  async passwordLogin() {
    const {data:first}=await this.loginRequest('GET',ACCOUNT+'/pass/serviceLogin',{params:{_json:'true',sid:'xiaomiio'}});
    if(!['sid','callback','_sign','qs'].every(k=>k in first)) throw new AuthenticationError('Xiaomi login initialization failed');
    const form=Object.fromEntries(['sid','callback','_sign','qs'].map(k=>[k,String(first[k])]));
    Object.assign(form,{_json:'true',user:this.auth.username,hash:this.auth.hash});
    const cookies={deviceId:randomBytes(8).toString('hex')};
    if(this.auth.captcha_code) {form.captCode=this.auth.captcha_code;cookies.ick=this.auth.ick||'';}
    const {data}=await this.loginRequest('POST',ACCOUNT+'/pass/serviceLoginAuth2',{form,cookies});
    if(data.captchaURL) return this.captcha(data.captchaURL);
    if(data.notificationUrl) return this.startVerification(data.notificationUrl);
    this.takeFields(data);
    if(!data.location) throw new AuthenticationError('Xiaomi rejected the account login');
    await this.finishAuth(data.location); this.auth={};
  }
  async captcha(path) {
    const url=new URL(path,ACCOUNT); if(url.hostname!=='account.xiaomi.com'||url.protocol!=='https:') throw new AuthenticationError('Unexpected Xiaomi verification address');
    const r=await this.loginRequest('GET',url,{image:true});
    this.auth.ick=this.jar.cookies.size?[...this.jar.cookies.values()].find(c=>c.name==='ick')?.value||'':'';
    if(r.body.length>1024*1024) throw new CloudError('Xiaomi CAPTCHA image is too large');
    throw new LoginChallenge('captcha',{image:'data:image/jpeg;base64,'+b64(r.body)});
  }
  async submitCaptcha(answer) {
    if(!this.auth.ick) throw new AuthenticationError('Xiaomi login challenge expired; start again');
    this.auth.captcha_code=String(answer||'').trim();
    return this.auth.flag?this.sendTicket():this.passwordLogin();
  }
  async startVerification(notification) {
    const url=new URL(notification.replace('/fe/service/identity/authStart','/identity/list'));
    if(url.hostname!=='account.xiaomi.com'||url.protocol!=='https:') throw new AuthenticationError('Unsupported Xiaomi account verification');
    const {data}=await this.loginRequest('GET',url);
    const flag=String(data.flag||''),identity=[...this.jar.cookies.values()].find(c=>c.name==='identity_session')?.value;
    if(!['4','8'].includes(flag)||!identity) throw new AuthenticationError('Xiaomi verification method is unsupported; use account ID and passToken');
    Object.assign(this.auth,{flag,identity_session:identity}); return this.sendTicket();
  }
  verificationName() { return this.auth.flag==='4'?'Phone':'Email'; }
  async sendTicket() {
    const name=this.verificationName(),cookies={identity_session:this.auth.identity_session};
    const {data:details}=await this.loginRequest('GET',ACCOUNT+'/identity/auth/verify'+name,{params:{_flag:this.auth.flag,_json:'true'},cookies});
    if(this.auth.ick) cookies.ick=this.auth.ick;
    const {data}=await this.loginRequest('POST',ACCOUNT+'/identity/auth/send'+name+'Ticket',{form:{_json:'true',icode:this.auth.captcha_code||'',retry:'0'},cookies});
    if(data.captchaURL) return this.captcha(data.captchaURL);
    if(data.code!==0) throw new AuthenticationError('Xiaomi could not send a verification code');
    delete this.auth.captcha_code;
    throw new LoginChallenge('verification',{destination:String(details.maskedPhone||details.maskedEmail||'your account')});
  }
  async submitVerification(answer) {
    if(!this.auth.identity_session) throw new AuthenticationError('Xiaomi login challenge expired; start again');
    const {data}=await this.loginRequest('POST',ACCOUNT+'/identity/auth/verify'+this.verificationName(),{params:{_flag:this.auth.flag,ticket:String(answer||'').trim(),trust:'false',_json:'true'},cookies:{identity_session:this.auth.identity_session}});
    if(!data.location) throw new AuthenticationError('Xiaomi rejected the verification code');
    await this.finishAuth(data.location); this.auth={};
  }
  async finishAuth(location,{signal}={}) {
    for(let i=0;i<10;i++) {
      let u; try { u=new URL(location); } catch { throw new AuthenticationError('Invalid Xiaomi authentication redirect'); }
      if(u.protocol!=='https:'||!['mi.com','xiaomi.com'].some(d=>u.hostname===d||u.hostname.endsWith('.'+d))) throw new AuthenticationError('Unexpected Xiaomi login redirect');
      const r=await this.http('GET',u,{signal});
      if([301,302,303,307,308].includes(r.status)) { const next=r.headers.get('location'); if(!next) throw new AuthenticationError('Missing Xiaomi authentication redirect'); location=new URL(next,u).href; continue; }
      if(r.status!==200) throw new AuthenticationError('Xiaomi authentication callback failed');
      const missing=this.missing(); if(missing.length) throw new AuthenticationError('Xiaomi returned incomplete authentication credentials (missing: '+missing.join(', ')+')');
      await this.onCredentials({...this.credentials}); return;
    }
    throw new AuthenticationError('Too many Xiaomi authentication redirects');
  }
  async loginWithToken(userId,passToken,{signal}={}) {
    if(!/^\d+$/.test(String(userId||''))||!String(passToken||'').trim()) throw new AuthenticationError('Enter the numeric Xiaomi account ID and its account passToken');
    this.credentials={user_id:String(userId).trim(),pass_token:String(passToken).trim(),service_token:'',c_user_id:'',security:''};
    const {data}=await this.loginRequest('GET',ACCOUNT+'/pass/serviceLogin',{params:{_json:'true',sid:'xiaomiio'},cookies:{userId:this.credentials.user_id,passToken:this.credentials.pass_token},signal});
    if(!data.location) throw new AuthenticationError('Xiaomi account credential expired; sign in again');
    this.takeFields(data); await this.finishAuth(data.location,{signal});
  }
  async authenticate(saved) {
    this.credentials={user_id:'',pass_token:'',service_token:'',c_user_id:'',security:'',...saved};
    try{if(!fromB64(this.credentials.security).length)this.credentials.security='';}catch{this.credentials.security='';}
    if(!this.missing().length) {
      try { await this.request('/v2/home/device_list_page',{limit:1},false); return; }
      catch(e) { if(!(e instanceof AuthenticationError)) throw e; }
    }
    return this.loginWithToken(this.credentials.user_id,this.credentials.pass_token);
  }
  async request(path,params,retry=true,{signal}={}) {
    signal?.throwIfAborted();
    if(!this.credentials.service_token) throw new AuthenticationError('Xiaomi account is not authenticated');
    const creds={...this.credentials};
    const {values,signed}=encryptCloudRequest(fromB64(creds.security),path,JSON.stringify(params));
    const r=await this.http('POST',this.baseURL+path,{form:values,cookies:{userId:creds.user_id,cUserId:creds.c_user_id,serviceToken:creds.service_token},headers:{'MIOT-ENCRYPT-ALGORITHM':'ENCRYPT-RC4'},signal});
    let result;
    if([401,403].includes(r.status)) result={code:-10001};
    else {
      if(r.status!==200) throw new CloudError(`Xiaomi cloud HTTP error ${r.status}`);
      try {result=JSON.parse(rc4Drop1024(signed,fromB64(r.body.toString())).toString());}
      catch {try {result=JSON.parse(r.body.toString());} catch {throw new CloudError('Invalid Xiaomi cloud response');}}
    }
    if(!result||typeof result!=='object'||Array.isArray(result)) throw new CloudError('Unexpected Xiaomi cloud response');
    if([-10001,-10000,-10004,3].includes(result.code)) {
      if(!retry) throw new AuthenticationError('Xiaomi account needs to be authenticated again');
      await this.refresh.run(async()=>{ if(this.credentials.service_token===creds.service_token) await this.loginWithToken(creds.user_id,creds.pass_token,{signal}); });
      return this.request(path,params,false,{signal});
    }
    if(result.code!==0) throw new CloudError('Xiaomi cloud rejected the request (code '+(Number.isInteger(result.code)?result.code:'unknown')+')');
    return result.result;
  }
  async devices({signal}={}) {
    const found=new Map(); let start='';
    for(let i=0;i<100;i++) {
      const result=await this.request('/v2/home/device_list_page',{start_did:start,limit:200},true,{signal});
      if(!result||!Array.isArray(result.list)) throw new CloudError('Invalid Xiaomi device list');
      for(const d of result.list) if(d&&d.did&&['.camera.','.cateye.'].some(t=>String(d.model||'').includes(t))) {
        found.set(String(d.did),{did:String(d.did),name:String(d.name||d.model||'Xiaomi camera'),model:String(d.model||''),host:String(d.localip||''),mac:String(d.mac||''),online:d.isOnline!==false});
      }
      const next=String(result.next_start_did||'');
      if(!result.has_more||!next||next===start) return [...found.values()]; start=next;
    }
    throw new CloudError('Xiaomi device list pagination limit exceeded');
  }
  async provision(device) {
    if(device.model.includes('.cateye.')) await this.request('/home/rpc/'+encodeURIComponent(device.did),{id:1,method:'wakeup',params:{video:'1'}});
    const pair=generateKeypair();
    const result=await this.request('/v2/device/miss_get_vendor',{app_pubkey:pair.public.toString('hex'),did:device.did,support_vendors:'TUTK_CS2_MTP'});
    if(!result||result.vendor?.vendor!==4) throw new ProtocolError('This camera does not offer CS2; TUTK, MTP and legacy cameras are unsupported');
    if(typeof result.public_key!=='string'||!/^[a-fA-F0-9]{64}$/.test(result.public_key)||typeof result.sign!=='string'||!result.sign) throw new ProtocolError('Xiaomi returned invalid camera session keys');
    return {...pair,devicePublic:Buffer.from(result.public_key,'hex'),signature:result.sign};
  }
}
module.exports={XiaomiCloud,REGIONS,CookieJar};
