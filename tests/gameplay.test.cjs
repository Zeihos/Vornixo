'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createGame}=require('../server.js');
const profile=char=>char.repeat(64);
function establishBase(game,owner,now,x=1600,y=1200){
  game.action(owner,{action:'build',build:'core',x,y},now);
  const core=game.g.buildings.find(b=>b.type==='core');
  assert.ok(core,'У базы должен появиться маяк');
  return {core,cycle:game.g.cycles.get(core.id)};
}

test('сохранение мира восстанавливает ресурсы и номер волны',()=>{
  const now=Date.now()/1000,game=createGame();
  assert.equal(game.g.resources.length,215);
  const owner=game.addPlayer('Owner');owner.profileKey=profile('a');
  const {cycle}=establishBase(game,owner,now);
  cycle.wave=3;cycle.phase='day';cycle.phaseEnds=now+25;game.g.primaryChanged=true;
  const saved=game.exportWorld(now);
  assert.equal(saved.schema,7);
  const restored=createGame({world:saved});
  assert.equal(restored.g.resources.length,215);
  const core=restored.g.buildings.find(b=>b.type==='core');
  assert.ok(core);assert.equal(restored.g.cycles.get(core.id).wave,3);
});

test('пустая база защищена, а после возвращения игрока волны возобновляются',()=>{
  const now=Date.now()/1000,game=createGame();
  const owner=game.addPlayer('Defender');owner.profileKey=profile('b');
  const {core,cycle}=establishBase(game,owner,now);
  cycle.phase='night';cycle.wave=4;cycle.remainingSpawns=4;
  cycle.phaseEnds=now+30;cycle.nextSpawn=now+1;game.g.primaryChanged=true;
  game.update(.05,now+.1);
  const hp=core.hp;
  game.removePlayer(owner.id);
  const oldDeadline=cycle.phaseEnds;
  game.update(90,now+90.1);
  assert.equal(cycle.paused,true);
  assert.equal(core.hp,hp);
  assert.equal(cycle.remainingSpawns,4);
  assert.ok(Math.abs(cycle.phaseEnds-oldDeadline-90)<.01);
  const returning=game.addPlayer('Defender');returning.profileKey=owner.profileKey;
  game.update(.05,now+90.15);
  assert.equal(cycle.paused,false);
});

test('число противников зависит от защитников базы, а не посторонних игроков',()=>{
  const now=Date.now()/1000,game=createGame();
  const owner=game.addPlayer('Leader');
  owner.profileKey=profile('c');owner.teamId='t_1234567890abcdef';
  const {cycle}=establishBase(game,owner,now);
  const ally=game.addPlayer('Ally');
  ally.profileKey=profile('d');ally.teamId=owner.teamId;
  const stranger=game.addPlayer('Stranger');stranger.profileKey=profile('e');
  cycle.phaseEnds=now+1;cycle.lastObservedAt=now;game.g.primaryChanged=true;
  game.update(.05,now+2);
  assert.equal(cycle.wave,1);
  assert.equal(cycle.remainingSpawns,11);
  assert.equal(game.snapshot(now+2,stranger).bases[0].canManage,false);
});

test('пауза не теряется при сохранении и перезапуске мира',()=>{
  const now=Date.now()/1000,game=createGame();
  const owner=game.addPlayer('Keeper');owner.profileKey=profile('f');
  const {cycle}=establishBase(game,owner,now);
  cycle.phaseEnds=now+25;game.g.primaryChanged=true;
  game.update(.05,now+.05);game.removePlayer(owner.id);
  game.update(100,now+100.05);
  assert.equal(cycle.paused,true);
  const saved=game.exportWorld(now+100.05);
  assert.equal(saved.schema,7);
  assert.ok(saved.cycles[0].phaseRemaining>24&&saved.cycles[0].phaseRemaining<26);
  const loaded=createGame({world:saved});
  const core=loaded.g.buildings.find(b=>b.type==='core');
  assert.ok(core);
  assert.ok(Math.abs(loaded.g.cycles.get(core.id).phaseEnds-Date.now()/1000-24.95)<2);
});
