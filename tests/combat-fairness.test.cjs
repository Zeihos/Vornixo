'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createGame,RECIPES}=require('../server.js');

function world(){
  const now=Date.now()/1000,game=createGame();
  const owner=game.addPlayer('Защитник');
  owner.profileKey='a'.repeat(64);
  owner.x=1600;owner.y=1200;
  owner.lastAction=-1;owner.lastBuild=-1;
  game.action(owner,{action:'build',build:'core',x:1600,y:1200},now);
  const core=game.g.buildings.find(b=>b.type==='core');
  assert.ok(core,'base should be created');
  const cycle=game.g.cycles.get(core.id);
  cycle.phase='day';cycle.phaseEnds=now+30;cycle.lastObservedAt=now;
  game.g.primaryChanged=true;
  return {game,owner,core,cycle,now};
}
function building(game,core,type,x,y){
  const recipe=RECIPES[type];
  const b={id:game.g.nextId++,x,y,type,baseId:core.id,
    level:1,hp:recipe.hp,maxHp:recipe.hp,lastShot:0,lastSpikes:0};
  game.g.buildings.push(b);
  return b;
}
function zombie(game,core,x,y,hp=20){
  const e={id:game.g.nextId++,x,y,hp,maxHp:hp,
    kind:'normal',big:false,speed:55,damage:10,baseId:core.id,
    lastAttack:0,slowUntil:0,burnUntil:0,lastBurn:0,lastHeal:0};
  game.g.enemies.push(e);
  return e;
}
function ownAction(game,player,action,x,y,now){
  player.lastAction=-1000;
  game.action(player,{action,x,y},now);
}

test('шипы: награда и статистика начисляются ровно один раз',()=>{
  const {game,owner,core,now}=world();
  const spike=building(game,core,'spike',core.x+140,core.y+22);
  zombie(game,core,spike.x+5,spike.y+4,5);
  const gold=owner.gold,score=owner.score;
  game.update(.05,now+1);
  assert.equal(game.g.enemies.length,0);
  assert.equal(owner.gold,gold+3);
  assert.equal(owner.score,score+12);
  assert.equal(core.stats.zombiesDefeated,1);
  game.update(.05,now+2);
  assert.equal(owner.gold,gold+3,'no repeated rewards after cleanup');
  assert.equal(core.stats.zombiesDefeated,1);
});

test('горение от огнемёта: отложенное убийство засчитывается защитникам базы',()=>{
  const {game,owner,core,now}=world();
  const flame=building(game,core,'flame',core.x+110,core.y+20);
  const e=zombie(game,core,flame.x+35,flame.y,22);
  const gold=owner.gold,score=owner.score;
  game.update(.05,now+1);
  assert.equal(e.hp,5,'initial flame hit leaves zombie alive');
  assert.equal(owner.gold,gold,'no reward before lethal burn');
  game.update(.05,now+1.7);
  assert.equal(game.g.enemies.length,0);
  assert.equal(owner.gold,gold+3);
  assert.equal(owner.score,score+12);
  assert.equal(core.stats.zombiesDefeated,1);
  game.update(.05,now+2.5);
  assert.equal(owner.gold,gold+3);
  assert.equal(core.stats.zombiesDefeated,1);
});

test('пауза базы запрещает фарм зомби чужим игроком всеми видами атаки',()=>{
  const {game,owner,core,cycle,now}=world();
  const visitor=game.addPlayer('Путешественник');
  visitor.profileKey='b'.repeat(64);
  visitor.x=core.x+170;visitor.y=core.y+20;
  visitor.inventory.bolts=2;
  visitor.inventory.shells=2;
  visitor.inventory.flare=1;
  visitor.gold=70;
  const e=zombie(game,core,visitor.x+40,visitor.y,240);
  game.removePlayer(owner.id);
  game.update(.05,now+.2);
  assert.equal(cycle.paused,true);
  assert.ok(game.g.enemies.includes(e));
  const hp=e.hp,slowUntil=e.slowUntil;
  ownAction(game,visitor,'swing',e.x,e.y,now+1);
  ownAction(game,visitor,'shoot',e.x,e.y,now+1.1);
  ownAction(game,visitor,'shotgun',e.x,e.y,now+1.2);
  ownAction(game,visitor,'pulse',e.x,e.y,now+1.3);
  visitor.lastAction=-1000;
  game.action(visitor,{action:'use',item:'flare',x:e.x,y:e.y},now+1.5);
  assert.equal(e.hp,hp,'paused enemy remains unharmed');
  assert.equal(e.slowUntil,slowUntil,'paused enemy cannot be slowed for farming');
  assert.equal(visitor.inventory.bolts,2);
  assert.equal(visitor.inventory.shells,2);
  assert.equal(game.g.enemies.length,1);
  assert.equal(core.stats.zombiesDefeated,0);
  const returned=game.addPlayer('Защитник');
  returned.profileKey=owner.profileKey;
  returned.x=core.x;returned.y=core.y;
  game.update(.05,now+2);
  assert.equal(cycle.paused,false);
  ownAction(game,visitor,'shoot',e.x,e.y,now+2.1);
  assert.ok(e.hp<hp,'active base zombies remain attackable');
});

test('снаряжение и замедление работают для активной базы',()=>{
  const {game,owner,core,now}=world();
  owner.x=core.x+85;owner.y=core.y;
  owner.inventory.flare=1;
  const e=zombie(game,core,owner.x+80,owner.y,180);
  owner.lastAction=-1000;
  game.action(owner,{action:'use',item:'flare',x:e.x,y:e.y},now+1);
  assert.equal(owner.inventory.flare,0);
  assert.ok(e.slowUntil>Date.now()/1000+3);
  const before=e.hp;
  owner.inventory.shells=1;
  ownAction(game,owner,'shotgun',e.x,e.y,now+2);
  assert.ok(e.hp<before,'shotgun still damages active enemies');
});
