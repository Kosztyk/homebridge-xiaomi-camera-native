'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {sharedKey,chachaXor,rc4Drop1024,decodeMedia}=require('../lib/crypto');
test('NaCl precomputed key agrees with RFC 7748 / NaCl vector',()=>{
  assert.equal(sharedKey(Buffer.from('de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f','hex'),Buffer.from('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a','hex')).toString('hex'),'1b27556473e985d462cd51197a9a46c76009549eac6474f206c4ee0844f68389');
});
test('MISS ChaCha20 agrees with the published RFC 8439 ciphertext',()=>{
  const text=Buffer.from("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.");
  assert.equal(chachaXor(Buffer.from(Array.from({length:32},(_,i)=>i)),Buffer.from('0000004a00000000','hex'),text,1).toString('hex'),'6e2e359a2568f98041ba0728dd0d6981e97e7aec1d4360c20a27afccfd9fae0bf91b65c5524733ab8f593dabcd62b3571639d624e65152ab8f530c359f0861d807ca0dbf500d6a6156a38e088a22b65e52bc514d16ccf806818ce91ab77937365af90bbf74a35be6b40b8eedf2785e42874d');
});
test('RC4 drop agrees with RFC 6229 offset 1024',()=>assert.equal(rc4Drop1024(Buffer.from('0102030405','hex'),Buffer.alloc(16)).toString('hex'),'30abbcc7c20b01609f23ee2d5f6bb7df'));
test('invalid curve points and truncated media are rejected',()=>{assert.throws(()=>sharedKey(Buffer.alloc(32),Buffer.alloc(32)));assert.throws(()=>decodeMedia(Buffer.alloc(32),Buffer.alloc(7)));});
