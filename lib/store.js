'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomBytes}=require('node:crypto');
const {AuthenticationError}=require('./errors');
class AuthStore {
  constructor(storagePath) { this.root=path.join(storagePath,'xiaomi-camera-native'); }
  file(id) {
    if(!/^[a-f0-9]{32}$/.test(id||'')) throw new AuthenticationError('Sign in through the plugin settings first');
    return path.join(this.root,'account-'+id+'.json');
  }
  async load(id) {
    try { return JSON.parse(await fs.readFile(this.file(id),'utf8')); }
    catch(e) { if(e instanceof AuthenticationError) throw e; throw new AuthenticationError('Saved Xiaomi account was not found; sign in through plugin settings'); }
  }
  async save(id,data) {
    id=id||randomBytes(16).toString('hex'); const file=this.file(id);
    await fs.mkdir(this.root,{recursive:true,mode:0o700});
    const temp=file+'.'+randomBytes(6).toString('hex')+'.tmp';
    try { await fs.writeFile(temp,JSON.stringify(data),{mode:0o600}); await fs.rename(temp,file); await fs.chmod(file,0o600); }
    finally { await fs.rm(temp,{force:true}).catch(()=>{}); }
    return id;
  }
}
module.exports={AuthStore};
