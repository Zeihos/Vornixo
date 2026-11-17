'use strict';
// Build a dependency-free, reproducible ZIP containing only files required to run the game.
const fs=require('node:fs');
const path=require('node:path');
const zlib=require('node:zlib');
const root=path.resolve(__dirname,'..');
const files=['START_WINDOWS.bat','server.js','public/index.html','public/style.css','public/game.js'];
const version=(fs.readFileSync(path.join(root,'server.js'),'utf8').match(/const VERSION='([^']+)'/)||[])[1];
if(!version)throw Error('Cannot identify game version from server.js');
function crc32(buf){
  let crc=0xffffffff;
  for(const value of buf){crc^=value;for(let i=0;i<8;i++)crc=(crc>>>1)^(crc&1?0xedb88320:0);}
  return (crc^0xffffffff)>>>0;
}
function zip(entries){
  const local=[],central=[];let offset=0,centralLength=0;
  // Fixed DOS time makes the output stable across repeated builds.
  const date=((2026-1980)<<9)|(11<<5)|17;
  for(const entry of entries){
    const name=Buffer.from('VORNIXO/'+entry.name,'utf8');
    const original=entry.data;
    const method=entry.name.endsWith('/')?0:8;
    const packed=method?zlib.deflateRawSync(original,{level:9}):original;
    const crc=crc32(original);
    const head=Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50,0);
    head.writeUInt16LE(20,4);head.writeUInt16LE(0x800,6);
    head.writeUInt16LE(method,8);head.writeUInt16LE(0,10);head.writeUInt16LE(date,12);
    head.writeUInt32LE(crc,14);head.writeUInt32LE(packed.length,18);
    head.writeUInt32LE(original.length,22);head.writeUInt16LE(name.length,26);
    const centralHead=Buffer.alloc(46);
    centralHead.writeUInt32LE(0x02014b50,0);
    centralHead.writeUInt16LE(20,4);centralHead.writeUInt16LE(20,6);
    centralHead.writeUInt16LE(0x800,8);centralHead.writeUInt16LE(method,10);
    centralHead.writeUInt16LE(0,12);centralHead.writeUInt16LE(date,14);
    centralHead.writeUInt32LE(crc,16);centralHead.writeUInt32LE(packed.length,20);
    centralHead.writeUInt32LE(original.length,24);centralHead.writeUInt16LE(name.length,28);
    centralHead.writeUInt32LE(entry.name.endsWith('/')?0x10:0,38);
    centralHead.writeUInt32LE(offset,42);
    local.push(head,name,packed);
    central.push(centralHead,name);
    offset+=head.length+name.length+packed.length;
    centralLength+=centralHead.length+name.length;
  }
  const end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(entries.length,8);
  end.writeUInt16LE(entries.length,10);end.writeUInt32LE(centralLength,12);
  end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,...central,end]);
}
const entries=files.map(name=>({name,data:fs.readFileSync(path.join(root,name))}));
entries.push({name:'data/',data:Buffer.alloc(0)});
const targetDir=path.join(root,'dist');fs.mkdirSync(targetDir,{recursive:true});
const target=path.join(targetDir,'VORNIXO_Alpha_'+version+'_CLEAN.zip');
fs.writeFileSync(target,zip(entries));
console.log('Clean game package:',target,'('+fs.statSync(target).size+' bytes)');
