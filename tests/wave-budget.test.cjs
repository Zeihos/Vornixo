'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createGame,BASE_RADIUS}=require('../server.js');

function fixture(){
  const now=Date.now()/1000,game=createGame();
  const a=game.addPlayer('LeaderA'),b=game.addPlayer('LeaderB');
  a.profileKey='a'.repeat(64);b.profileKey='b'.repeat(64);
  function createCore(player,x,y){
    player.x=x;player.y=y;
    const count=game.g.buildings.length;
    for(const [dx,dy] of [[0,0],[54,0],[-54,0],[0,54],[0,-54],[108,0],[-108,0],[0,108],[0,-108]]){
      player.lastBuild=-1000;player.lastAction=-1000;
      game.action(player,{action:'build',build:'core',x:x+dx,y:y+dy},now);
      if(game.g.buildings.length>count)return game.g.buildings.at(-1);
    }
    throw Error('Could not create core');
  }
  const coreA=createCore(a,594,594),coreB=createCore(b,1890,594);
  return {game,a,b,coreA,coreB,now,cycleA:game.g.cycles.get(coreA.id),cycleB:game.g.cycles.get(coreB.id)};
}
function wave(cycle,now){
  cycle.phase='night';cycle.wave=11;cycle.phaseEnds=now+200;
  cycle.remainingSpawns=100;cycle.lastObservedAt=now;
}
function advance(game,cycle,now,i){
  const at=now+(i+1)*.05;
  cycle.nextSpawn=at-.01;
  game.g.primaryChanged=true; // avoid legacy 0.1-0.5 admin synchronization overriding the test cycle
  game.update(.05,at);
}
function makeEnemy(game,base,index,kind='normal'){
  return {id:game.g.nextId++,baseId:base.id,kind,big:kind==='boss',
    x:base.x+300+index%40,y:base.y+370+index%30,
    hp:100,maxHp:100,speed:40,damage:10,lastAttack:0,
    slowUntil:0,burnUntil:0,lastBurn:0,lastHeal:0};
}

test('две независимые волны: каждая база получает собственные места под врагов',()=>{
  const {game,coreA,coreB,cycleA,cycleB,now}=fixture();
  wave(cycleA,now);wave(cycleB,now);game.g.primaryChanged=true;
  for(let i=0;i<45;i++){
    advance(game,cycleA,now,i);
    advance(game,cycleB,now,i);
  }
  const countA=game.g.enemies.filter(e=>e.baseId===coreA.id).length;
  const countB=game.g.enemies.filter(e=>e.baseId===coreB.id).length;
  assert.equal(countA,32,'first base cannot occupy the entire world limit');
  assert.equal(countB,32,'second base also receives full independent quota');
  assert.equal(game.g.enemies.length,64);
  assert.ok(cycleA.remainingSpawns>0);
  assert.ok(cycleB.remainingSpawns>0);
  assert.ok(game.g.enemies.every(e=>e.baseId===coreA.id?
    Math.hypot(e.x-coreB.x,e.y-coreB.y)>BASE_RADIUS:
    Math.hypot(e.x-coreA.x,e.y-coreA.y)>BASE_RADIUS),
    'enemy should not spawn inside a rival base territory');
});

test('при заполнении мира старой волной новая база получает слот без удаления босса',()=>{
  const {game,a,coreA,coreB,cycleB,now}=fixture();
  game.g.enemies=Array.from({length:160},(_,i)=>makeEnemy(game,coreA,i,i===0?'boss':'normal'));
  assert.equal(game.g.enemies.length,160);
  const bossId=game.g.enemies[0].id;
  game.removePlayer(a.id); // Old wave is paused, but should not block the active settlement.
  wave(cycleB,now);cycleB.remainingSpawns=1;cycleB.nextSpawn=now-.01;
  game.g.primaryChanged=true;
  game.update(.05,now+.2);
  assert.equal(game.g.enemies.length,160,'world memory cap must remain intact');
  assert.equal(game.g.enemies.filter(e=>e.baseId===coreB.id).length,1);
  assert.equal(game.g.enemies.filter(e=>e.baseId===coreA.id).length,159);
  assert.ok(game.g.enemies.some(e=>e.id===bossId),'boss of the old base must survive');
  assert.equal(cycleB.remainingSpawns,0,'new base made progress');
  assert.equal(game.g.cycles.get(coreA.id).paused,true);
});

test('без старой переполненной группы сервер не превышает мировой лимит',()=>{
  const {game,coreA,coreB,cycleB,now}=fixture();
  game.g.enemies=Array.from({length:160},(_,i)=>makeEnemy(game,i%2===0?coreA:coreB,i));
  wave(cycleB,now);cycleB.remainingSpawns=1;cycleB.nextSpawn=now-.01;
  game.g.primaryChanged=true;
  game.update(.05,now+.2);
  assert.equal(game.g.enemies.length,160);
  assert.equal(cycleB.remainingSpawns,1,'pending spawn is retried after enemies are defeated');
});

test('лимиты врагов не меняют формат сохранения и распределение по базам',()=>{
  const {game,coreA,coreB,cycleA,cycleB,now}=fixture();
  wave(cycleA,now);wave(cycleB,now);game.g.primaryChanged=true;
  for(let i=0;i<3;i++)advance(game,cycleA,now,i);
  for(let i=3;i<6;i++)advance(game,cycleB,now,i);
  const saved=game.exportWorld(now+.3);
  assert.equal(saved.schema,7);
  const restored=createGame({world:saved});
  assert.equal(restored.g.enemies.filter(e=>e.baseId===coreA.id).length,3);
  assert.equal(restored.g.enemies.filter(e=>e.baseId===coreB.id).length,3);
  assert.equal(restored.g.cycles.size,2);
});
