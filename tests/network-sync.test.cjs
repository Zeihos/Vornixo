'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {startServer,createGame}=require('../server.js');

async function until(check,message,timeout=4000){
  const end=Date.now()+timeout;
  while(Date.now()<end){const value=check();if(value)return value;await new Promise(resolve=>setTimeout(resolve,25));}
  throw Error('Timeout: '+message);
}

test('сетевой клиент получает ресурсы при входе, а затем только при их изменении',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'vornixo-net-'));
  const app=startServer({host:'127.0.0.1',port:0,dataFile:path.join(directory,'records.json')});
  await once(app.server,'listening');
  const socket=new WebSocket('ws://127.0.0.1:'+app.server.address().port+'/ws');
  const messages=[];
  socket.addEventListener('message',e=>{try{messages.push(JSON.parse(e.data));}catch{}});
  t.after(async()=>{
    try{socket.close();}catch{}
    const closed=once(app.server,'close');app.close();await closed;
    fs.rmSync(directory,{recursive:true,force:true});
  });
  await once(socket,'open');
  socket.send(JSON.stringify({type:'join',name:'NetworkTester'}));
  const first=await until(()=>messages.find(m=>m.type==='state'&&Array.isArray(m.resources)),'initial resources');
  assert.equal(first.resources.length,215);
  const subsequent=await until(()=>messages.find(m=>m.type==='state'&&m.resources===null),'unchanged resources are omitted');
  const player=[...app.game.g.players.values()][0];
  assert.ok(player);
  const node=app.game.g.resources.find(n=>n.hp>0);
  player.x=node.x;player.y=node.y;
  const revision=app.game.g.resourceRevision;
  app.game.action(player,{action:'swing',x:node.x,y:node.y},Date.now()/1000);
  assert.equal(app.game.g.resourceRevision,revision+1,'resource hit increments revision');
  await until(()=>messages.filter(m=>m.type==='state'&&Array.isArray(m.resources)).length>=2,'resource list resent after mining');
  const updates=messages.filter(m=>m.type==='state'&&Array.isArray(m.resources));
  assert.equal(updates.at(-1).resources.length,215);
  assert.ok(JSON.stringify(subsequent).length<JSON.stringify(first).length/2,'reduced snapshot payload');
});

test('отдельный снимок без ресурсов не меняет исходные данные мира',()=>{
  const game=createGame();
  const player=game.addPlayer('Tester');
  const full=game.snapshot(Date.now()/1000,player);
  const compact=game.snapshot(Date.now()/1000,player,{includeResources:false});
  assert.equal(full.resources.length,215);
  assert.equal(compact.resources,null);
  assert.equal(game.g.resources.length,215);
  assert.ok(JSON.stringify(compact).length<JSON.stringify(full).length/2);
});

test('восстановление ресурсов по таймеру тоже обновляет ревизию',()=>{
  const now=Date.now()/1000,game=createGame();
  const node=game.g.resources[0],revision=game.g.resourceRevision;
  node.hp=0;node.respawn=now+1;
  game.update(.05,now+2);
  assert.equal(node.hp,node.maxHp);
  assert.equal(game.g.resourceRevision,revision+1);
});

test('зомби атакуют локальную баррикаду, а не проходят прямо сквозь линию обороны',()=>{
  const now=Date.now()/1000,game=createGame();
  const owner=game.addPlayer('Builder');owner.profileKey='a'.repeat(64);
  const corePos={x:1600,y:1200};
  game.action(owner,{action:'build',build:'core',...corePos},now);
  const core=game.g.buildings.find(b=>b.type==='core');
  assert.ok(core);
  const wall={id:999991,x:core.x+220,y:core.y+80,type:'wall',baseId:core.id,
    hp:175,maxHp:175,level:1,lastShot:0,lastSpikes:0};
  game.g.buildings.push(wall);
  const enemy={id:999992,x:core.x+310,y:core.y,hp:100,maxHp:100,kind:'normal',speed:80,damage:10,
    baseId:core.id,lastAttack:now,slowUntil:0,burnUntil:0,lastBurn:now,lastHeal:now};
  game.g.enemies.push(enemy);
  const cycle=game.g.cycles.get(core.id);
  cycle.phaseEnds=now+60;game.g.primaryChanged=true;
  const startingY=enemy.y;
  game.update(.05,now+.05);
  assert.ok(enemy.y>startingY,'zombie steers towards the nearby wall');
});

test('поиск целей не притягивает зомби к дальним генераторам',()=>{
  const now=Date.now()/1000,game=createGame();
  const owner=game.addPlayer('Builder');owner.profileKey='b'.repeat(64);
  game.action(owner,{action:'build',build:'core',x:1600,y:1200},now);
  const core=game.g.buildings.find(b=>b.type==='core');
  assert.ok(core);
  game.g.buildings.push({id:999993,x:core.x-500,y:core.y+300,type:'mine',baseId:core.id,
    hp:100,maxHp:100,level:1,lastShot:0,lastSpikes:0});
  const enemy={id:999994,x:core.x+400,y:core.y,hp:100,maxHp:100,kind:'raider',speed:100,damage:10,
    baseId:core.id,lastAttack:now,slowUntil:0,burnUntil:0,lastBurn:now,lastHeal:now};
  game.g.enemies.push(enemy);
  const cycle=game.g.cycles.get(core.id);cycle.phaseEnds=now+60;game.g.primaryChanged=true;
  game.update(.05,now+.05);
  assert.ok(Math.abs(enemy.y-core.y)<.01,'raider ignores generators beyond local search range');
});
