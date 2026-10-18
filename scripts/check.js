'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
let count=0;
function check(dir){for(const file of fs.readdirSync(dir,{withFileTypes:true})){if(['node_modules','.git'].includes(file.name))continue;const p=path.join(dir,file.name);if(file.isDirectory())check(p);else if(p.endsWith('.js')){const r=spawnSync(process.execPath,['--check',p],{encoding:'utf8'});if(r.status!==0){process.stderr.write(r.stderr);process.exit(1);}count++;}else if(p.endsWith('.json'))JSON.parse(fs.readFileSync(p,'utf8'));}}
check(path.join(__dirname,'..'));console.log(`Syntax and JSON checks passed (${count} JavaScript files).`);
