'use strict';
// Проверка минимальной и воспроизводимой сборки — без личных данных и служебных файлов.
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const zlib=require('node:zlib');
const root=path.resolve(__dirname,'..');
const version=require(path.join(root,'package.json')).version;
const file=path.join(root,'dist','VORNIXO_Alpha_'+version+'_CLEAN.zip');
const zip=fs.readFileSync(file);
const endSig=Buffer.from([0x50,0x4b,0x05,0x06]);
const eocd=zip.lastIndexOf(endSig);
assert.ok(eocd>=0&&eocd+22<=zip.length,'ZIP central directory is missing');
const total=zip.readUInt16LE(eocd+10);
let at=zip.readUInt32LE(eocd+16);
const found=[];
for(let i=0;i<total;i++){
  assert.equal(zip.readUInt32LE(at),0x02014b50,'Invalid ZIP central directory');
  const method=zip.readUInt16LE(at+10);
  const packedSize=zip.readUInt32LE(at+20);
  const originalSize=zip.readUInt32LE(at+24);
  const nameSize=zip.readUInt16LE(at+28);
  const extraSize=zip.readUInt16LE(at+30);
  const commentSize=zip.readUInt16LE(at+32);
  const localOffset=zip.readUInt32LE(at+42);
  const name=zip.subarray(at+46,at+46+nameSize).toString('utf8');
  found.push(name);
  assert.equal(zip.readUInt32LE(localOffset),0x04034b50);
  const offset=localOffset+30+zip.readUInt16LE(localOffset+26)+zip.readUInt16LE(localOffset+28);
  const compressed=zip.subarray(offset,offset+packedSize);
  const data=method===0?compressed:method===8?zlib.inflateRawSync(compressed):null;
  assert.ok(data,'Unknown ZIP compression type');
  assert.equal(data.length,originalSize,'Bad ZIP entry size: '+name);
  if(!name.endsWith('/')){
    const relative=name.replace(/^VORNIXO\//,'');
    const local=fs.readFileSync(path.join(root,relative));
    const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
    assert.equal(sha(data),sha(local),'Wrong ZIP file content: '+name);
  }
  at+=46+nameSize+extraSize+commentSize;
}
const expected=['VORNIXO/START_WINDOWS.bat','VORNIXO/server.js','VORNIXO/public/index.html','VORNIXO/public/style.css','VORNIXO/public/game.js','VORNIXO/data/'];
assert.deepEqual(found.sort(),expected.sort(),'Unexpected files in CLEAN archive');
assert.ok(zip.length<2000000,'Distribution unexpectedly large');
console.log('Проверка CLEAN-сборки пройдена: '+path.basename(file)+' ('+found.length+' элементов)');
