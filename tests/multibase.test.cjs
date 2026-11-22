'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createGame,RECIPES,BASE_RADIUS}=require('../server.js');

function setup(now=Date.now()/1000){
  const game=createGame();
  const a=game.addPlayer('Alpha'),b=game.addPlayer('Bravo');
  a.profileKey='a'.repeat(64);
  b.profileKey='b'.repeat(64);
  function plant(player,x,y){
    player.x=x;player.y=y;
    const initial=game.g.buildings.filter(v=>v.type==='core').length;
    for(const [dx,dy] of [[0,0],[54,0],[-54,0],[0,54],[0,-54],[108,0],[0,108],[-108,0],[54,54],[-54,-54],[162,0],[0,162]]){
      player.lastBuild=-1000;player.lastAction=-1000;
      game.action(player,{action:'build',build:'core',x:x+dx,y:y+dy},now);
      const cores=game.g.buildings.filter(v=>v.type==='core');
      if(cores.length>initial)return cores.at(-1);
    }
    throw Error('Failed to create a valid test settlement');
  }
  const coreA=plant(a,600,594),coreB=plant(b,2592,1782);
  assert.ok(Math.hypot(coreA.x-coreB.x,coreA.y-coreB.y)>1200);
  assert.equal(game.g.cycles.size,2);
  return {game,a,b,coreA,coreB,cycleA:game.g.cycles.get(coreA.id),cycleB:game.g.cycles.get(coreB.id),now};
}
function defense(game,core,type,x,y){
  const recipe=RECIPES[type];
  const b={id:game.g.nextId++,baseId:core.id,x,y,type,level:1,hp:recipe.hp,maxHp:recipe.hp,lastShot:0,lastSpikes:0};
  game.g.buildings.push(b);
  return b;
}
function enemy(game,core,x,y,hp=15){
  const e={id:game.g.nextId++,baseId:core.id,kind:'normal',big:false,
    x,y,hp,maxHp:hp,speed:50,damage:10,lastAttack:0,slowUntil:0,burnUntil:0,lastBurn:0,lastHeal:0};
  game.g.enemies.push(e);
  return e;
}

test('два маяка: волна первой базы идёт, пока вторая приостановлена без защитника',()=>{
  const {game,a,b,coreA,coreB,cycleA,cycleB,now}=setup();
  cycleA.phase='day';cycleA.phaseEnds=now+.15;cycleA.lastObservedAt=now;
  cycleB.phase='day';cycleB.phaseEnds=now+.15;cycleB.lastObservedAt=now;
  game.g.primaryChanged=true;
  game.removePlayer(b.id);
  game.update(.05,now+1);
  assert.equal(cycleA.phase,'night');
  assert.equal(cycleA.wave,1);
  assert.equal(cycleB.phase,'day');
  assert.equal(cycleB.paused,true);
  assert.equal(cycleB.wave,0);
  assert.ok(cycleB.phaseEnds>now+1);
  const returned=game.addPlayer('Bravo');
  returned.profileKey=b.profileKey;
  returned.x=coreB.x+135;returned.y=coreB.y;
  game.update(.05,now+1.3);
  assert.equal(cycleB.paused,false);
  assert.equal(cycleB.wave,1);
  assert.equal(cycleA.wave,1);
  assert.equal(game.snapshot(now+1.3,a).ownedBaseId,coreA.id);
  assert.equal(game.snapshot(now+1.3,returned).ownedBaseId,coreB.id);
});

test('тесла и миномёт не дают повторное золото и очки за уже уничтоженного врага',()=>{
  const {game,a,b,coreA,coreB,now}=setup();
  defense(game,coreA,'tesla',coreA.x+100,coreA.y+30);
  defense(game,coreA,'mortar',coreA.x+105,coreA.y+15);
  defense(game,coreB,'tesla',coreB.x+100,coreB.y+20);
  enemy(game,coreA,coreA.x+150,coreA.y+30);
  enemy(game,coreB,coreB.x+150,coreB.y+20);
  const beforeA={gold:a.gold,score:a.score},beforeB={gold:b.gold,score:b.score};
  game.g.primaryChanged=true;
  game.update(.05,now+1);
  assert.equal(a.gold-beforeA.gold,3);
  assert.equal(a.score-beforeA.score,12);
  assert.equal(b.gold-beforeB.gold,3);
  assert.equal(b.score-beforeB.score,12);
  assert.equal(coreA.stats.zombiesDefeated,1);
  assert.equal(coreB.stats.zombiesDefeated,1);
  assert.equal(game.g.enemies.length,0);
});

test('зомби чужой базы не атакует защитника за пределами своей территории',()=>{
  const {game,a,b,coreA,coreB,now}=setup();
  b.x=coreB.x+145;b.y=coreB.y+30;
  const intruder=enemy(game,coreA,b.x+2,b.y+2,150);
  const hp=b.hp;
  assert.ok(Math.hypot(b.x-coreA.x,b.y-coreA.y)>BASE_RADIUS);
  game.g.primaryChanged=true;
  game.update(.05,now+1);
  assert.equal(b.hp,hp);
  assert.ok(game.g.enemies.includes(intruder));
  // Enemy assigned to the second base CAN still attack its local defender.
  game.g.enemies.length=0;
  enemy(game,coreB,b.x+2,b.y+2,150);
  game.update(.05,now+2);
  assert.ok(b.hp<hp,'local defenders are valid targets');
});

test('отдельные волны и статус своей базы сохраняются после перезапуска мира',()=>{
  const {game,a,b,coreA,coreB,cycleA,cycleB,now}=setup();
  cycleA.phase='day';cycleA.wave=2;cycleA.phaseEnds=now+27;
  cycleB.phase='night';cycleB.wave=7;cycleB.phaseEnds=now+29;
  cycleB.nextSpawn=now+4;cycleB.remainingSpawns=4;
  game.g.primaryChanged=true;
  const snapshot=game.exportWorld(now);
  assert.equal(snapshot.schema,7);
  assert.equal(snapshot.cycles.length,2);
  const loaded=createGame({world:snapshot});
  const aCycle=loaded.g.cycles.get(coreA.id),bCycle=loaded.g.cycles.get(coreB.id);
  assert.equal(aCycle.wave,2);
  assert.equal(aCycle.phase,'day');
  assert.equal(bCycle.wave,7);
  assert.equal(bCycle.phase,'night');
  assert.equal(bCycle.remainingSpawns,4);
  const viewer=loaded.addPlayer('Bravo');viewer.profileKey=b.profileKey;
  const status=loaded.snapshot(now,viewer);
  assert.equal(status.ownedBaseId,coreB.id);
  assert.equal(status.baseStatus.id,coreB.id);
  assert.equal(status.baseStatus.wave,7);
  assert.equal(status.bases.length,2);
  assert.equal(status.bases.find(v=>v.id===coreA.id).canManage,false);
});
