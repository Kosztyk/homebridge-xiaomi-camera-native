'use strict';
const { TransportError } = require('./errors');
class AsyncQueue {
  constructor(limit=128) { this.items=[]; this.waiters=[]; this.limit=limit; this.error=null; }
  push(item) {
    if (this.error) return;
    const waiter=this.waiters.shift();
    if (waiter) { clearTimeout(waiter.timer); waiter.resolve(item); }
    else if(this.items.length<this.limit) this.items.push(item);
    else throw new TransportError('Camera receiver could not keep up with incoming media');
  }
  shift(timeout=15000) {
    if (this.error) return Promise.reject(this.error);
    if (this.items.length) return Promise.resolve(this.items.shift());
    return new Promise((resolve,reject)=>{
      const waiter={resolve,reject}; this.waiters.push(waiter);
      if(timeout!==null) waiter.timer=setTimeout(()=>{ this.waiters=this.waiters.filter(x=>x!==waiter); reject(new TransportError('Camera response timed out')); },timeout);
    });
  }
  close(error=new TransportError('Camera connection closed')) {
    this.error=error; this.items=[];
    for(const w of this.waiters.splice(0)) { clearTimeout(w.timer); w.reject(error); }
  }
}
class Mutex {
  constructor() { this.tail=Promise.resolve(); }
  run(fn) { const result=this.tail.then(fn,fn); this.tail=result.catch(()=>{}); return result; }
}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
module.exports={AsyncQueue,Mutex,delay};
