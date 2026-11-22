'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {performance}=require('node:perf_hooks');
const {readyForState,startServer,createGame,RECIPES}=require('../server.js');

async function poll(check,label,timeout=4000){
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){
    const value=check();if(value)return value;
    await new Promise(resolve=>setTimeout(resolve,30));
  }
  throw Error('Timeout: '+label);
}

test('очередь сокета ограничена, а восстановившийся клиент получает обновления',()=>{
  const stats={skippedBackpressure:0,slowDisconnects:0};
  const peer={closed:false,bufferedBytes:0,stateBackpressureAt:0,close(){this.closed=true;}};
  assert.equal(readyForState(peer,1000,stats),true);
  peer.bufferedBytes=300*1024;
  assert.equal(readyForState(peer,1200,stats),false);
  assert.equal(stats.skippedBackpressure,1);
  peer.bufferedBytes=0;
  assert.equal(readyForState(peer,1201,stats),true);
  assert.equal(peer.stateBackpressureAt,0);
  peer.bufferedBytes=300*1024;
  assert.equal(readyForState(peer,2000,stats),false);
  assert.equal(readyForState(peer,14000,stats),false);
  assert.equal(stats.slowDisconnects,1);
  assert.equal(peer.closed,true);
  assert.equal(readyForState(peer,15000,stats),false);
  assert.equal(stats.slowDisconnects,1);
});

test('HTTP статус показывает обезличенные показатели при нескольких WebSocket игроках',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vornixo-load-'));
  const app=startServer({host:'127.0.0.1',port:0,dataFile:path.join(dir,'records.json')});
  await once(app.server,'listening');
  const base='http://127.0.0.1:'+app.server.address().port;
  const clients=[];
  t.after(async()=>{
    for(const client of clients)try{client.close();}catch{}
    if(app.server.listening){const closing=once(app.server,'close');app.close();await closing;}
    fs.rmSync(dir,{recursive:true,force:true});
  });
  for(let i=0;i<4;i++){
    const ws=new WebSocket(base.replace('http','ws')+'/ws');
    clients.push(ws);
    await once(ws,'open');
    ws.send(JSON.stringify({type:'join',name:'Load'+i}));
  }
  await poll(()=>app.game.g.players.size===4,'four live players');
  await poll(()=>app.metrics.snapshotsSent>=4,'outbound frames');
  const response=await fetch(base+'/api/status');
  assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'no-store');
  const status=await response.json();
  assert.equal(status.version,'0.18.0');
  assert.equal(status.players,4);
  assert.ok(status.performance.ticks>=1);
  assert.ok(status.performance.snapshotsSent>=4);
  assert.ok(status.performance.stateBytes>1000);
  assert.ok(status.performance.tickAvgMs>=0);
  assert.ok(status.performance.broadcastAvgMs>=0);
  assert.equal(status.performance.slowDisconnects,0);
  assert.equal(status.performance.skippedBackpressure,0);
  assert.equal(JSON.stringify(status).includes('Load0'),false,'status never exposes player names');
  assert.equal(JSON.stringify(status).includes('profileKey'),false,'status never exposes profile credentials');
});

test('нагрузочная проверка: 16 игроков, укрепления и зомби в одном мире',()=>{
  const now=Date.now()/1000,game=createGame();
  const players=Array.from({length:16},(_,i)=>game.addPlayer('LoadPlayer'+i));
  players[0].profileKey='a'.repeat(64);
  const p=players[0];p.x=1600;p.y=1200;
  game.action(p,{action:'build',build:'core',x:1600,y:1200},now);
  const core=game.g.buildings.find(b=>b.type==='core');
  assert.ok(core);
  const cycle=game.g.cycles.get(core.id);
  cycle.phase='day';cycle.phaseEnds=now+200;cycle.lastObservedAt=now;
  game.g.primaryChanged=true;
  for(let i=0;i<55;i++){
    const angle=i*Math.PI*2/55,dist=160+(i%4)*35;
    game.g.buildings.push({id:game.g.nextId++,baseId:core.id,
      type:'wall',level:1,hp:RECIPES.wall.hp,maxHp:RECIPES.wall.hp,
      x:Math.round(core.x+Math.cos(angle)*dist),y:Math.round(core.y+Math.sin(angle)*dist),
      lastShot:0,lastSpikes:0});
  }
  for(let i=0;i<120;i++){
    const angle=i*Math.PI*2/120,dist=300+(i%7)*20;
    game.g.enemies.push({id:game.g.nextId++,baseId:core.id,
      kind:'normal',hp:90,maxHp:90,speed:60,damage:10,
      x:core.x+Math.cos(angle)*dist,y:core.y+Math.sin(angle)*dist,
      lastAttack:now,slowUntil:0,burnUntil:0,lastBurn:0,lastHeal:0});
  }
  const started=performance.now();
  let payloadBytes=0;
  for(let tick=0;tick<12;tick++){
    const time=now+(tick+1)*.05;
    game.update(.05,time);
    for(const player of players){
      const state=game.snapshot(time,player,{includeResources:false});
      assert.equal(state.players.length,16);
      payloadBytes+=Buffer.byteLength(JSON.stringify(state));
    }
  }
  const elapsedMs=performance.now()-started;
  assert.equal(game.g.players.size,16);
  assert.ok(payloadBytes>10000);
  console.log('VORNIXO load smoke: 16 игроков; 55 баррикад; 120 зомби; 12 тиков; '+elapsedMs.toFixed(1)+' мс; '+payloadBytes+' байт снимков');
  // This is a short synthetic regression check, NOT proof of production-scale latency.
});
