'use strict';
// Adapted from Xiaomi Camera Native and AlexxIT/go2rtc; see NOTICE.
const crypto = require('node:crypto');
const { ProtocolError } = require('./errors');
const b64 = data => Buffer.from(data).toString('base64');
function fromB64(value) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new ProtocolError('Invalid base64 authentication data');
  return Buffer.from(value, 'base64');
}
function hsalsa20(key) {
  if (key.length !== 32) throw new ProtocolError('Invalid camera session key length');
  const c = Buffer.from('expand 32-byte k');
  const x = new Uint32Array([c.readUInt32LE(0), key.readUInt32LE(0), key.readUInt32LE(4), key.readUInt32LE(8), key.readUInt32LE(12), c.readUInt32LE(4), 0, 0, 0, 0, c.readUInt32LE(8), key.readUInt32LE(16), key.readUInt32LE(20), key.readUInt32LE(24), key.readUInt32LE(28), c.readUInt32LE(12)]);
  const rot = (v, n) => (v << n) | (v >>> (32 - n));
  function q(a, b, c0, d) {
    x[b] ^= rot((x[a] + x[d]) >>> 0, 7); x[c0] ^= rot((x[b] + x[a]) >>> 0, 9);
    x[d] ^= rot((x[c0] + x[b]) >>> 0, 13); x[a] ^= rot((x[d] + x[c0]) >>> 0, 18);
  }
  for (let i = 0; i < 10; i++) {
    q(0,4,8,12); q(5,9,13,1); q(10,14,2,6); q(15,3,7,11);
    q(0,1,2,3); q(5,6,7,4); q(10,11,8,9); q(15,12,13,14);
  }
  const out = Buffer.alloc(32);
  [0,5,10,15,6,7,8,9].forEach((v,i) => out.writeUInt32LE(x[v], i*4));
  return out;
}
const PRIVATE_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const PUBLIC_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
function generateKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return { public: publicKey.export({type:'spki',format:'der'}).subarray(-32), private: privateKey.export({type:'pkcs8',format:'der'}).subarray(-32) };
}
function sharedKey(publicKey, privateKey) {
  try {
    if (publicKey.length !== 32 || privateKey.length !== 32) throw Error();
    const secret = crypto.diffieHellman({
      privateKey: crypto.createPrivateKey({key:Buffer.concat([PRIVATE_PREFIX,privateKey]),format:'der',type:'pkcs8'}),
      publicKey: crypto.createPublicKey({key:Buffer.concat([PUBLIC_PREFIX,publicKey]),format:'der',type:'spki'})
    });
    return hsalsa20(secret);
  } catch { throw new ProtocolError('Invalid camera session key'); }
}
function chachaXor(key, nonce, data, counter = 0) {
  if (key.length !== 32 || nonce.length !== 8 || !Number.isInteger(counter) || counter < 0 || counter >= 2**32) throw new ProtocolError('Invalid camera cipher parameters');
  const iv = Buffer.alloc(16); iv.writeUInt32LE(counter); nonce.copy(iv,8);
  const cipher = crypto.createCipheriv('chacha20',key,iv);
  return Buffer.concat([cipher.update(data),cipher.final()]);
}
function encodeMedia(key, data, nonce = crypto.randomBytes(8)) { return Buffer.concat([nonce,chachaXor(key,nonce,data)]); }
function decodeMedia(key, data) {
  if (data.length < 8) throw new ProtocolError('Encrypted camera packet is too short');
  return chachaXor(key,data.subarray(0,8),data.subarray(8));
}
function rc4Drop1024(key, data) {
  if (!key.length) throw new ProtocolError('Missing cloud encryption key');
  const s = Uint8Array.from({length:256},(_,i)=>i);
  let j=0;
  for (let i=0;i<256;i++) { j=(j+s[i]+key[i%key.length])&255; [s[i],s[j]]=[s[j],s[i]]; }
  let i=0; j=0;
  const out=Buffer.alloc(data.length);
  for (let n=0;n<1024+data.length;n++) { i=(i+1)&255; j=(j+s[i])&255; [s[i],s[j]]=[s[j],s[i]]; const v=s[(s[i]+s[j])&255]; if(n>=1024) out[n-1024]=data[n-1024]^v; }
  return out;
}
function cloudSignature(path, values, signed) {
  const parts=['POST',path,`data=${values.data}`];
  if ('rc4_hash__' in values) parts.push(`rc4_hash__=${values.rc4_hash__}`);
  parts.push(b64(signed)); return b64(crypto.createHash('sha1').update(parts.join('&')).digest());
}
function encryptCloudRequest(security,path,data,nonce) {
  if (!nonce) { nonce=Buffer.alloc(12); crypto.randomBytes(8).copy(nonce); nonce.writeUInt32BE(Math.floor(Date.now()/60000),8); }
  const signed=crypto.createHash('sha256').update(Buffer.concat([security,nonce])).digest();
  const plain={data}; plain.rc4_hash__=cloudSignature(path,plain,signed);
  const values=Object.fromEntries(Object.entries(plain).map(([k,v])=>[k,b64(rc4Drop1024(signed,Buffer.from(v)))]));
  values.signature=cloudSignature(path,values,signed); values._nonce=b64(nonce);
  return {values,signed};
}
module.exports={b64,fromB64,hsalsa20,generateKeypair,sharedKey,chachaXor,encodeMedia,decodeMedia,rc4Drop1024,encryptCloudRequest};
