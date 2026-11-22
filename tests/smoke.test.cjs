'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {startServer,createGame,WORLD}=require('../server.js');

async function launch(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vornixo-test-'));
  const app=startServer({host:'127.0.0.1',port:0,dataFile:path.join(dir,'records.json')});
  await once(app.server,'listening');
  t.after(async()=>{
    const closed=once(app.server,'close');
    app.close();
    await closed;
    fs.rmSync(dir,{recursive:true,force:true});
  });
  return 'http://127.0.0.1:'+app.server.address().port;
}

test('game state can be created and exported without external packages',()=>{
  const game=createGame();
  assert.equal(game.g.players.size,0);
  assert.equal(WORLD.width,3200);
  const p=game.addPlayer('SmokeTester');
  assert.ok(p.id);
  assert.equal(game.exportWorld().schema,7);
  assert.ok(game.snapshot(Date.now()/1000).players.some(x=>x.id===p.id));
});

test('HTTP serves the actual game and reports Alpha 0.20.0',async t=>{
  const base=await launch(t);
  const status=await fetch(base+'/api/status');
  assert.equal(status.status,200);
  const info=await status.json();
  assert.equal(info.version,'0.20.0');
  assert.equal(info.players,0);
  for(const asset of ['/','/game.js','/style.css']){
    const result=await fetch(base+asset);
    assert.equal(result.status,200,asset);
    assert.ok((await result.text()).length>100,asset);
  }
  assert.equal((await fetch(base+'/.env')).status,403);
  assert.equal((await fetch(base+'/server.js')).status,404);
});

test('two real WebSocket clients can share one world',async t=>{
  const base=await launch(t);
  const url=base.replace('http:','ws:')+'/ws';
  const a=new WebSocket(url),b=new WebSocket(url);
  t.after(()=>{a.close();b.close();});
  await Promise.all([once(a,'open'),once(b,'open')]);
  let seenWelcome=false,seenBoth=false;
  a.addEventListener('message',event=>{
    const msg=JSON.parse(event.data);
    if(msg.type==='welcome')seenWelcome=true;
    if(msg.type==='state'&&msg.players.length===2)seenBoth=true;
  });
  a.send(JSON.stringify({type:'join',name:'TesterOne'}));
  b.send(JSON.stringify({type:'join',name:'TesterTwo'}));
  const end=Date.now()+3000;
  while(Date.now()<end&&!seenBoth)await new Promise(resolve=>setTimeout(resolve,50));
  assert.ok(seenWelcome,'player receives welcome');
  assert.ok(seenBoth,'players receive shared world state');
});
