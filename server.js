'use strict';
/** VORNIXO alpha — dependency-free Node.js HTTP + WebSocket authoritative game server. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const WORLD = { width: 3200, height: 2400 };
const GRID = 54;
const MAX_PLAYERS = 16;
const MAX_CLIENT_MESSAGE = 8192, MAX_SOCKET_BACKLOG = 1024 * 1024;
const MAX_MESSAGES_PER_SEC = 50, MESSAGE_BURST = 100;
const LOGIN_TIMEOUT_MS = 30000, MAX_CONNECTIONS_PER_IP = 4;
const SOCKET_IDLE_TIMEOUT_MS = 25000; // Client sends input ~18 times/s or a ping every 5s.
const VERSION='0.16.0', PULSE_COOLDOWN=16, PULSE_COST=10, DASH_COOLDOWN=8, DASH_DISTANCE=175;
const MAX_BASES=5, BASE_RADIUS=610, BASE_SPACING=1260, MAX_BUILDINGS_PER_BASE=65;
const MAX_WAVE_SPAWNS=36, WAVE_WARNING_SECONDS=10;
const CRAFTS=Object.freeze({
  medkit:{wood:15,stone:10,gold:5,qty:1,label:'Аптечка'},
  repairkit:{wood:25,stone:15,gold:0,qty:1,label:'Ремкомплект'},
  bolts:{wood:8,stone:6,gold:0,qty:14,label:'Болты арбалета'},
  flare:{wood:12,stone:8,gold:8,qty:1,label:'Сигнальная граната'},
  shells:{wood:10,stone:14,gold:7,qty:6,label:'Патроны дробовика'}
});
const RECIPES = Object.freeze({
  core:   {wood:0,  stone:0,  gold:0, hp:750, size:68, label:'Маяк'},
  wall:   {wood:18, stone:8,  gold:0, hp:175, size:49, label:'Баррикада'},
  turret: {wood:35, stone:48, gold:0, hp:225, size:53, label:'Автотурель'},
  mine:   {wood:38, stone:25, gold:0, hp:190, size:54, label:'Генератор'},
  spike:  {wood:22, stone:18, gold:0, hp:105, size:47, label:'Шипы'},
  medic:  {wood:45, stone:30, gold:20, hp:165, size:52, label:'Медстанция'},
  frost:  {wood:40, stone:55, gold:25, hp:195, size:54, label:'Криобашня'},
  tesla:  {wood:65, stone:70, gold:40, hp:200, size:54, label:'Разрядник'},
  mortar: {wood:85, stone:100,gold:65, hp:180, size:56, label:'Миномёт'},
  flame:  {wood:75, stone:90, gold:55, hp:185, size:55, label:'Огнемёт'},
});
const clamp = (n,a,b) => Math.max(a,Math.min(b,n));
const distance = (a,b) => Math.hypot(a.x-b.x,a.y-b.y);
const cleanName = (v) => String(v || 'Выживший').replace(/[<>\u0000-\u001f]/g,'').trim().slice(0,18) || 'Выживший';

const SKILLS = Object.freeze({power:{label:'Урон',base:30},vitality:{label:'Здоровье',base:35},speed:{label:'Скорость',base:40}});
const TECHNOLOGIES = Object.freeze({
  armor:{label:'Фортификация',description:'Урон по постройкам снижен на 9% за уровень'},
  power:{label:'Инженерия',description:'Урон автоматических башен +15% за уровень'},
  harvest:{label:'Логистика',description:'Добыча ресурсов +20% за уровень'}
});
const ACHIEVEMENTS=Object.freeze({
  gatherer:{title:'Первый запас',description:'Нанесите 20 ударов по ресурсам',field:'harvested',goal:20,reward:50},
  engineer:{title:'Архитектор',description:'Возведите 8 построек',field:'built',goal:8,reward:90},
  hunter:{title:'Охотник',description:'Уничтожьте 10 зомби лично',field:'kills',goal:10,reward:75},
  artisan:{title:'Мастерская',description:'Выполните 5 операций крафта',field:'crafted',goal:5,reward:65},
  defender:{title:'Ветеран обороны',description:'Отбейте третью волну своей базы',field:'bestWave',goal:3,reward:120}
});
const defaultStats=()=>({harvested:0,built:0,crafted:0,bestWave:0});
const defaultBaseStats=()=>({wavesCleared:0,zombiesDefeated:0,buildingsLost:0,damageTaken:0});
const defaultTech=()=>({armor:0,power:0,harvest:0});
const techCost=level=>({wood:35+level*25,stone:30+level*25,gold:20+level*25});
// Deterministic regions do not require additional world-state files.
function biomeAt(x,y){
  if((x<1100&&y>1330)||(x>2230&&y<950))return 'marsh';
  if((x<1050&&y<920)||(x>2350&&y>1430))return 'highlands';
  return 'forest';
}
function skillCost(skill,level){return SKILLS[skill].base + level*25;}
function createGame({records=[],world=null}={}) {
  let seed = 929137; const rand = () => {seed = (Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const g = { players:new Map(), resources:[], buildings:[], enemies:[], bullets:[], chat:[], core:null, cycles:new Map(), primaryChanged:false,
    phase:'waiting', phaseEnds:0, wave:0, remainingSpawns:0, nextSpawn:0, nextId:1, resourceRevision:0, nextGold:0, spawnOrder:0, records:Array.isArray(records)?records.slice(0,10):[], startedAt:Date.now()/1000 };
  const nextId = () => g.nextId++;
  const resetResources = () => {
    g.resourceRevision++;
    g.resources=[];
    for (let i=0; i<215; i++) {
      let x,y,attempt=0;
      do { x=95+rand()*(WORLD.width-190); y=95+rand()*(WORLD.height-190); attempt++; }
      while (Math.hypot(x-WORLD.width/2,y-WORLD.height/2)<245 && attempt<20);
      const biome=biomeAt(x,y);
      const type=biome==='highlands'?(i%5===0?'crystal':i%4===0?'tree':'rock'):
        biome==='marsh'?(i%3===0?'crystal':i%5===0?'rock':'tree'):
        i%7===0?'crystal':i%3===0?'rock':'tree';
      g.resources.push({id:nextId(),x:Math.round(x),y:Math.round(y),type,hp:type==='crystal'?6:4,maxHp:type==='crystal'?6:4,respawn:0});
    }
  };
  resetResources();
  const cores=()=>g.buildings.filter(b=>b.type==='core');
  const coreFor=b=>b.type==='core'?b:cores().find(c=>c.id===b.baseId);
  const canManage=(p,c)=>!!(p&&c&&( (!c.ownerKey&&!c.teamId) ||
    (c.teamId?c.teamId===p.teamId:c.ownerKey===p.profileKey)));
  const bestBase=p=>cores().filter(c=>canManage(p,c)).sort((a,b)=>distance(p,a)-distance(p,b))[0]||null;
  const enemyForBase=(e,c)=>!!c&&(e.baseId===c.id||(!e.baseId&&c===g.core));
  const freshCycle=(now)=>({phase:'day',wave:0,phaseEnds:now+42,remainingSpawns:0,nextSpawn:now+.2,paused:false,warned:false,lastObservedAt:now});
  const exportCycle=(c,now)=>({phase:c.phase,wave:c.wave,phaseRemaining:Math.max(0,c.phaseEnds-now),remainingSpawns:c.remainingSpawns,nextSpawnIn:Math.max(0,c.nextSpawn-now)});
  function importCycle(raw,now){
    if(!raw||!['day','night'].includes(raw.phase))return null;
    const valid=(v,lo,hi,d=lo)=>Number.isFinite(v)&&v>=lo&&v<=hi?v:d;
    return {phase:raw.phase,wave:Math.trunc(valid(raw.wave,0,10000)),phaseEnds:now+valid(raw.phaseRemaining,0,120),
      remainingSpawns:raw.phase==='night'?Math.trunc(valid(raw.remainingSpawns,0,100)):0,
      nextSpawn:now+valid(raw.nextSpawnIn,0,30),paused:false,warned:false,lastObservedAt:now};
  }
  function syncLegacyFromPrimary(){
    const c=g.core&&g.cycles.get(g.core.id);
    if(c){g.phase=c.phase;g.wave=c.wave;g.phaseEnds=c.phaseEnds;g.remainingSpawns=c.remainingSpawns;g.nextSpawn=c.nextSpawn;}
    else {g.phase='waiting';g.wave=0;g.phaseEnds=0;g.remainingSpawns=0;g.nextSpawn=0;}
  }
  function syncPrimaryFromLegacy(){
    const c=g.core&&g.cycles.get(g.core.id);if(!c)return;
    c.phase=g.phase;c.wave=g.wave;c.phaseEnds=g.phaseEnds;c.remainingSpawns=g.remainingSpawns;c.nextSpawn=g.nextSpawn;
  }
  function restoreWorld(saved,now=Date.now()/1000){
    if(!saved||![1,2,3,4,5,6,7].includes(saved.schema)||!Array.isArray(saved.resources)||!Array.isArray(saved.buildings)||saved.resources.length!==215)return false;
    try{
      const valid=(n,low,high,fallback=low)=>Number.isFinite(n)&&n>=low&&n<=high?n:fallback;
      const at=o=>o&&Number.isFinite(o.x)&&Number.isFinite(o.y)&&o.x>=0&&o.y>=0&&o.x<=WORLD.width&&o.y<=WORLD.height;
      const nodes=saved.resources.filter(n=>at(n)&&Number.isInteger(n.id)&&n.id>0&&['tree','rock','crystal'].includes(n.type))
        .map(n=>({id:n.id,x:n.x,y:n.y,type:n.type,maxHp:n.type==='crystal'?6:4,hp:Math.trunc(valid(n.hp,0,6)),respawn:now+valid(n.respawnIn,0,60)}));
      if(nodes.length!==215)throw Error('invalid resource layout');
      const bs=saved.buildings.filter(b=>at(b)&&Number.isInteger(b.id)&&b.id>0&&Object.hasOwn(RECIPES,b.type)).slice(0,180)
        .map(b=>({id:b.id,x:b.x,y:b.y,type:b.type,hp:valid(b.hp,0,10000),maxHp:valid(b.maxHp,1,10000),level:Math.trunc(valid(b.level,1,3)),
          baseId:Number.isInteger(b.baseId)?b.baseId:null,
          ownerKey:typeof b.ownerKey==='string'&&/^[0-9a-f]{64}$/.test(b.ownerKey)?b.ownerKey:null,
          teamId:typeof b.teamId==='string'&&/^t_[0-9a-f]{16}$/.test(b.teamId)?b.teamId:null,
          ownerName:cleanName(b.ownerName||'Выжившие'),lastShot:0,lastSpikes:0}));
      const loadedCores=bs.filter(b=>b.type==='core');
      if(loadedCores.length>MAX_BASES||(!loadedCores.length&&bs.length)|| (saved.schema===1&&loadedCores.length>1))throw Error('core integrity');
      for(const b of bs){if(b.type==='core')b.baseId=b.id;else if(saved.schema===1)b.baseId=loadedCores[0]?.id;
        if(!loadedCores.some(c=>c.id===b.baseId))throw Error('orphaned building');}
      for(const b of bs)if(b.type!=='core'){
        const c=loadedCores.find(c=>c.id===b.baseId);if(!c||distance(b,c)>BASE_RADIUS+5)throw Error('building out of base bounds');
      }
      if(loadedCores.some((c,i)=>loadedCores.slice(i+1).some(q=>distance(c,q)<BASE_SPACING-1)))throw Error('overlapping bases');
      const enemies=(Array.isArray(saved.enemies)?saved.enemies:[]).filter(e=>at(e)&&Number.isInteger(e.id)&&e.id>0&&['normal','runner','brute','boss','spitter','tank','raider','sapper','shaman','berserker'].includes(e.kind)).slice(0,160)
        .map(e=>({id:e.id,x:e.x,y:e.y,kind:e.kind,big:['boss','brute','tank'].includes(e.kind),hp:valid(e.hp,1,50000),maxHp:valid(e.maxHp,1,50000),speed:valid(e.speed,1,300),damage:valid(e.damage,1,150),baseId:Number.isInteger(e.baseId)?e.baseId:loadedCores[0]?.id,lastAttack:now,slowUntil:0,burnUntil:0,lastBurn:now,lastHeal:now})).filter(e=>loadedCores.some(c=>c.id===e.baseId));
      const ids=[...nodes,...bs,...enemies].map(o=>o.id);if(new Set(ids).size!==ids.length)throw Error('duplicate IDs');
      for(const c of loadedCores){
        const raw=Array.isArray(saved.technologies)?saved.technologies.find(t=>t.id===c.id):null;
        c.tech=defaultTech();
        for(const key of Object.keys(TECHNOLOGIES))if(Number.isInteger(raw?.[key])&&raw[key]>=0&&raw[key]<=3)c.tech[key]=raw[key];
        const counts=Array.isArray(saved.baseStats)?saved.baseStats.find(item=>item.id===c.id):null;
        c.stats=defaultBaseStats();
        for(const field of Object.keys(c.stats))if(Number.isSafeInteger(counts?.[field])&&counts[field]>=0&&counts[field]<=1000000000)c.stats[field]=counts[field];
      }
      g.resources=nodes;g.resourceRevision++;g.buildings=bs;g.core=loadedCores[0]||null;g.enemies=g.core?enemies:[];g.bullets=[];
      g.phase=g.core?(saved.phase==='night'?'night':'day'):'waiting';g.wave=Math.trunc(valid(saved.wave,0,10000));
      g.phaseEnds=g.core?now+valid(saved.phaseRemaining,0,120):0;
      g.remainingSpawns=g.phase==='night'?Math.trunc(valid(saved.remainingSpawns,0,70)):0;
      g.nextSpawn=now+valid(saved.nextSpawnIn,0,30);g.nextGold=now+valid(saved.nextGoldIn,0,10);
      g.cycles.clear();
      for(const core of loadedCores){
        const raw=Array.isArray(saved.cycles)?saved.cycles.find(c=>c.id===core.id):null;
        let cycle=importCycle(raw,now);
        if(!cycle){cycle=core===loadedCores[0]&&g.phase!=='waiting'
          ?{phase:g.phase,wave:g.wave,phaseEnds:g.phaseEnds,remainingSpawns:g.remainingSpawns,nextSpawn:g.nextSpawn,paused:false,warned:false,lastObservedAt:now}
          :freshCycle(now);}
        g.cycles.set(core.id,cycle);
      }
      syncLegacyFromPrimary();
      g.nextId=Math.max(1,Math.trunc(valid(saved.nextId,1,1000000000)),...ids.map(id=>id+1));
      announce('Экспедиция продолжена из сохранения');return true;
    }catch(e){console.warn('Ошибка сохранения мира:',e.message);return false;}
  }
  function exportWorld(now=Date.now()/1000){if(g.primaryChanged){syncLegacyFromPrimary();g.primaryChanged=false;}else syncPrimaryFromLegacy();return {schema:7,version:VERSION,savedAt:new Date().toISOString(),nextId:g.nextId,phase:g.phase,wave:g.wave,
    phaseRemaining:Math.max(0,g.phaseEnds-now),remainingSpawns:g.remainingSpawns,nextSpawnIn:Math.max(0,g.nextSpawn-now),nextGoldIn:Math.max(0,g.nextGold-now),
    cycles:cores().map(c=>({id:c.id,...exportCycle(g.cycles.get(c.id)||freshCycle(now),now)})),
    technologies:cores().map(c=>({id:c.id,...c.tech||defaultTech()})),
    baseStats:cores().map(c=>({id:c.id,...c.stats||defaultBaseStats()})),
    buildings:g.buildings.map(({id,x,y,type,hp,maxHp,level,baseId,ownerKey,teamId,ownerName})=>({id,x,y,type,hp,maxHp,level,baseId,...(type==='core'?{ownerKey,teamId,ownerName}:{})})),
    resources:g.resources.map(({id,x,y,type,hp,respawn})=>({id,x,y,type,hp,respawnIn:Math.max(0,respawn-now)})),
    enemies:g.enemies.map(({id,x,y,kind,hp,maxHp,speed,damage,baseId})=>({id,x,y,kind,hp,maxHp,speed,damage,baseId}))};}
  if(world&&!restoreWorld(world)){resetResources();g.buildings=[];g.enemies=[];g.core=null;g.wave=0;g.phase='waiting';}
  function announce(message) { g.chat.push({id:nextId(),name:'СИСТЕМА',text:message,time:Date.now()});g.chat=g.chat.slice(-16); }
  function addPlayer(name,profile=null) {
    const id=nextId();const safe=(v,otherwise,max)=>Number.isSafeInteger(v)&&v>=0&&v<=max?v:otherwise;
    const skills={power:0,vitality:0,speed:0};for(const k of Object.keys(skills))skills[k]=Math.min(3,safe(profile?.skills?.[k],0,3));
    const maxHp=100+35*skills.vitality,spawn=bestBase({profileKey:null,teamId:null}),x=spawn?.x||1600,y=spawn?.y||1200;
    const p={id,name:cleanName(profile?.name||name),x:Number.isFinite(profile?.x)?clamp(profile.x,28,WORLD.width-28):x+(rand()-.5)*145,
      y:Number.isFinite(profile?.y)?clamp(profile.y,28,WORLD.height-28):y+(rand()-.5)*145,aim:0,
      hp:Math.min(maxHp,safe(profile?.hp,maxHp,maxHp)),maxHp,
      wood:safe(profile?.wood,115,1000000),stone:safe(profile?.stone,95,1000000),gold:safe(profile?.gold,30,1000000),
      kills:safe(profile?.kills,0,100000000),score:safe(profile?.score,0,1000000000),alive:true,respawnAt:0,
      lastSwing:0,lastShot:0,lastBuild:0,lastAction:0,lastPulse:-PULSE_COOLDOWN,pulseUntil:0,lastDash:-DASH_COOLDOWN,dashingUntil:0,skills,
      inventory:{medkit:safe(profile?.inventory?.medkit,0,99),repairkit:safe(profile?.inventory?.repairkit,0,99),bolts:safe(profile?.inventory?.bolts,0,999),flare:safe(profile?.inventory?.flare,0,99),shells:safe(profile?.inventory?.shells,0,99)},
      stats:Object.fromEntries(Object.keys(defaultStats()).map(k=>[k,safe(profile?.stats?.[k],0,100000000)])),
      achievements:Array.isArray(profile?.achievements)?profile.achievements.filter(k=>Object.hasOwn(ACHIEVEMENTS,k)).filter((k,i,a)=>a.indexOf(k)===i):[],teamId:null,
      input:{up:false,down:false,left:false,right:false},socket:null,profileKey:null};
    g.players.set(id,p);announce(`${p.name} присоединился к экспедиции`);return p;
  }
  function exportProfile(p){return {name:p.name,x:Math.round(p.x),y:Math.round(p.y),hp:Math.max(0,Math.round(p.hp)),wood:p.wood,stone:p.stone,gold:p.gold,kills:p.kills,score:p.score,skills:{...p.skills},inventory:{...p.inventory},stats:{...p.stats},achievements:[...p.achievements]};}
  function updateRecords(){
    const best=new Map(g.records.filter(r=>r&&typeof r.name==='string'&&Number.isFinite(r.score)&&r.score>=0).map(r=>[r.name,r]));
    for(const p of g.players.values()){const old=best.get(p.name);if(!old||old.score<p.score)best.set(p.name,{name:p.name,score:p.score,kills:p.kills,wave:g.wave});}
    g.records=[...best.values()].sort((a,b)=>b.score-a.score).slice(0,10);return g.records;
  }
  function removePlayer(id){const p=g.players.get(id);if(p){updateRecords();g.players.delete(id);announce(`${p.name} покинул экспедицию`);}}
  function checkAchievements(p){
    for(const [key,a] of Object.entries(ACHIEVEMENTS)){
      if(p.achievements.includes(key))continue;
      const progress=a.field==='kills'?p.kills:p.stats[a.field];
      if(progress<a.goal)continue;
      p.achievements.push(key);p.gold+=a.reward;
      send(p,{type:'toast',text:`🏆 ${a.title}: +${a.reward} золота`});
    }
  }
  const fail = (p, why) => send(p,{type:'toast',text:why});
  function recordKill(e){
    if(e._counted)return; e._counted=true;
    const base=cores().find(c=>c.id===e.baseId);if(base){base.stats ||= defaultBaseStats();base.stats.zombiesDefeated++;}
  }
  function send(p,msg) {if(p.socket && !p.socket.closed) p.socket.sendJSON(msg);}
  function charge(p,r,scale=1){return p.wood >=Math.ceil(r.wood*scale) && p.stone>=Math.ceil(r.stone*scale) && p.gold>=Math.ceil(r.gold*scale);}
  function pay(p,r,scale=1){p.wood-=Math.ceil(r.wood*scale);p.stone-=Math.ceil(r.stone*scale);p.gold-=Math.ceil(r.gold*scale);}
  function resetBase(core){
    // Losing a beacon destroys only that settlement, not the others.
    if(!core)return;
    const losers=[...g.players.values()].filter(p=>canManage(p,core));
    g.buildings=g.buildings.filter(b=>b.baseId!==core.id);g.cycles.delete(core.id);
    g.enemies=g.enemies.filter(e=>!enemyForBase(e,core));
    g.bullets=g.bullets.filter(b=>b.baseId!==core.id);g.core=cores()[0]||null;g.primaryChanged=!!g.core;
    for(const p of losers){p.hp=p.maxHp;p.alive=true;p.wood=Math.max(95,p.wood);p.stone=Math.max(75,p.stone);p.gold=Math.max(15,p.gold);
      send(p,{type:'toast',text:'Ваш маяк уничтожен. Постройте новый!'});}
    announce(`Маяк «${core.ownerName||'Выжившие'}» разрушен!`);
    if(!g.core){g.phase='waiting';g.phaseEnds=0;g.wave=0;g.remainingSpawns=0;g.enemies=[];announce('Все маяки уничтожены. Новая экспедиция!');}
  }
  function build(p,type,at){
    const r=RECIPES[type]; if(!r)return;
    if(Date.now()/1000-p.lastBuild<0.13)return;
    p.lastBuild=Date.now()/1000;
    const x=Math.round(at.x/GRID)*GRID,y=Math.round(at.y/GRID)*GRID;
    if(!Number.isFinite(x)||!Number.isFinite(y)||x<70||y<70||x>WORLD.width-70||y>WORLD.height-70 || distance(p,{x,y})>275){fail(p,'Слишком далеко для строительства');return;}
    let base=null;
    if(type==='core'){
      if(cores().length>=MAX_BASES){fail(p,'Лимит маяков мира достигнут');return;}
      if(cores().some(c=>distance(c,{x,y})<BASE_SPACING)){fail(p,'Отойдите дальше от других баз');return;}
      if(cores().some(c=>(p.teamId&&c.teamId===p.teamId)||(!p.teamId&&p.profileKey&&c.ownerKey===p.profileKey&&!c.teamId)||(!p.profileKey&&!c.ownerKey&&!c.teamId))){fail(p,'У вас уже есть маяк этого типа');return;}
    }else{
      base=cores().sort((a,b)=>distance(a,{x,y})-distance(b,{x,y}))[0];
      if(!base||distance(base,{x,y})>BASE_RADIUS){fail(p,'Стройте в пределах зоны маяка');return;}
      if(!canManage(p,base)){fail(p,'Это территория чужой базы');return;}
      if(g.buildings.filter(b=>b.baseId===base.id).length>=MAX_BUILDINGS_PER_BASE){fail(p,'Лимит построек этой базы достигнут');return;}
    }
    if(g.buildings.length>=180){fail(p,'Лимит построек мира достигнут');return;}
    if(g.buildings.some(b=>distance(b,{x,y}) < (RECIPES[b.type].size+r.size)/2+5) ||
      g.resources.some(n=>n.hp>0 && distance(n,{x,y})<r.size/2+26)) {fail(p,'Место занято');return;}
    if(!charge(p,r)){fail(p,'Недостаточно ресурсов');return;}
    pay(p,r);
    const b={id:nextId(),x,y,type,hp:r.hp,maxHp:r.hp,level:1,lastShot:0,lastSpikes:0,baseId:base?.id||null};
    if(type==='core'){
      b.baseId=b.id;b.teamId=p.teamId||null;b.ownerKey=p.profileKey||null;b.ownerName=p.teamId?(p.teamName||'Отряд'):p.name;b.tech=defaultTech();b.stats=defaultBaseStats();
    }
    g.buildings.push(b);
    if(type==='core'){
      g.cycles.set(b.id,freshCycle(Date.now()/1000));
      if(!g.core){g.core=b;syncLegacyFromPrimary();g.nextGold=Date.now()/1000+4;}
      announce(`${p.name} активировал маяк «${b.ownerName}»!`);
    }
    p.stats.built++;checkAchievements(p);send(p,{type:'toast',text:`Построено: ${r.label}`});
  }
  function buildingAt(pos) {return g.buildings.filter(b=>distance(b,pos)<RECIPES[b.type].size/2+17).sort((a,b)=>distance(a,pos)-distance(b,pos))[0];}
  function upgrade(p, pos) {
    const b=buildingAt(pos);if(!b){fail(p,'Наведите курсор на постройку');return;}
    if(distance(p,b)>285){fail(p,'Подойдите ближе');return;}
    if(!canManage(p,coreFor(b))){fail(p,'Чужую постройку нельзя улучшать');return;}
    if(b.level>=3){fail(p,'Максимальный уровень');return;}
    if(b.type!=='core' && coreFor(b) && b.level >= coreFor(b).level){fail(p,'Сначала улучшите маяк');return;}
    const cost={wood:15*b.level,stone:25*b.level,gold:(b.type==='core'?20:14)*b.level};
    if(!charge(p,cost)){fail(p,'Не хватает ресурсов для улучшения');return;}
    pay(p,cost);b.level++;b.maxHp=Math.round(b.maxHp*1.42);b.hp=b.maxHp;
    send(p,{type:'toast',text:`Улучшено до уровня ${b.level}`});
  }
  function repair(p,pos){
    const b=buildingAt(pos);if(!b||distance(p,b)>285)return fail(p,'Наведите курсор на ближайшую постройку');
    if(!canManage(p,coreFor(b)))return fail(p,'Чужую постройку нельзя ремонтировать');
    if(b.hp>=b.maxHp)return fail(p,'Прочность уже полная');
    if(p.wood<10||p.stone<5)return fail(p,'Для починки нужно 10 древесины и 5 камня');
    p.wood-=10;p.stone-=5;b.hp=Math.min(b.maxHp,b.hp+85);
    send(p,{type:'toast',text:'Постройка восстановлена +85 HP'});
  }
  function swing(p, pos, now){
    if(now-p.lastSwing<0.34 || !p.alive)return;
    p.lastSwing=now;
    let target=g.enemies.filter(e=>distance(p,e)<108&&distance(e,pos)<78).sort((a,b)=>distance(a,pos)-distance(b,pos))[0];
    if(target){target.hp-=(target.kind==='tank'?.58:1)*(31+9*p.skills.power); if(target.hp<=0){recordKill(target);g.enemies=g.enemies.filter(e=>e.id!==target.id);p.kills++;p.score+=25;p.gold+=7;checkAchievements(p);}return;}
    const node=g.resources.filter(n=>n.hp>0&&distance(p,n)<115&&distance(n,pos)<75).sort((a,b)=>distance(a,pos)-distance(b,pos))[0];
    if(node){node.hp--;g.resourceRevision++; const tech=bestBase(p)?.tech?.harvest||0,scale=1+.2*tech,biome=biomeAt(node.x,node.y);
      if(node.type==='tree')p.wood+=Math.round((14+(biome==='forest'?3:0))*scale);
      else if(node.type==='rock')p.stone+=Math.round((12+(biome==='highlands'?4:0))*scale);
      else {p.stone+=Math.round(8*scale);p.gold+=3+(biome==='marsh'?2:0);}
      p.score+=2;p.stats.harvested++;checkAchievements(p);if(node.hp<=0)node.respawn=now+23;
    }
  }
  function craft(p,item){
    if(!Object.hasOwn(CRAFTS,item))return;
    const r=CRAFTS[item];
    if(p.inventory[item]+r.qty>(item==='bolts'?999:99))return fail(p,'Инвентарь переполнен');
    if(!charge(p,r))return fail(p,'Для крафта не хватает ресурсов');
    pay(p,r);p.inventory[item]+=r.qty;p.stats.crafted++;checkAchievements(p);
    send(p,{type:'toast',text:`Создано: ${r.label} ×${r.qty}`});
  }
  function useItem(p,item,pos){
    if(item==='medkit'){
      if(!p.inventory.medkit)return fail(p,'Сначала создайте аптечку');
      if(p.hp>=p.maxHp)return fail(p,'Здоровье уже полное');
      p.inventory.medkit--;p.hp=Math.min(p.maxHp,p.hp+65);
      return send(p,{type:'toast',text:'Аптечка: +65 HP'});
    }
    if(item==='flare'){
      if(!p.inventory.flare)return fail(p,'Сначала создайте сигнальную гранату');
      if(distance(p,pos)>360)return fail(p,'Цель слишком далеко');
      p.inventory.flare--;
      let affected=0;
      for(const e of g.enemies)if(distance(e,pos)<230){e.slowUntil=Math.max(e.slowUntil,Date.now()/1000+5);affected++;}
      g.bullets.push({id:nextId(),x:p.x,y:p.y,tx:pos.x,ty:pos.y,kind:'flare',until:Date.now()/1000+.45});
      return send(p,{type:'toast',text:`Граната: замедлено зомби — ${affected}`});
    }
    if(item==='repairkit'){
      const b=buildingAt(pos);if(!b||distance(p,b)>285)return fail(p,'Подойдите к повреждённой постройке');
      if(!canManage(p,coreFor(b)))return fail(p,'Чужую постройку нельзя ремонтировать');
      if(b.hp>=b.maxHp)return fail(p,'Постройка не нуждается в ремонте');
      if(!p.inventory.repairkit)return fail(p,'Сначала создайте ремкомплект');
      p.inventory.repairkit--;b.hp=Math.min(b.maxHp,b.hp+175);
      return send(p,{type:'toast',text:'Ремкомплект: +175 прочности'});
    }
  }
  function shoot(p,pos,now){
    if(now-p.lastShot<.72)return;
    const target=g.enemies.filter(e=>distance(p,e)<=520 && distance(e,pos)<70)
      .sort((a,b)=>distance(a,pos)-distance(b,pos))[0];
    if(!target)return;
    if(p.inventory.bolts<1&&p.wood<1)return fail(p,'Нужен болт или 1 древесина');
    p.lastShot=now;if(p.inventory.bolts>0)p.inventory.bolts--;else p.wood-=1;
    const damage=(target.kind==='tank'?.58:1)*(45+13*p.skills.power);target.hp-=damage;
    g.bullets.push({id:nextId(),x:p.x,y:p.y,tx:target.x,ty:target.y,kind:'arrow',until:now+.22});
    if(target.hp<=0){recordKill(target);g.enemies=g.enemies.filter(e=>e.id!==target.id);p.kills++;p.score+=target.kind==='boss'?300:35;p.gold+=target.kind==='boss'?85:8;checkAchievements(p);}
  }
  function shotgun(p,pos,now){
    if(now-p.lastShot<1.25)return;
    if(p.inventory.shells<1)return fail(p,'Нет патронов. Создайте их в мастерской (I)');
    const aim=Math.atan2(pos.y-p.y,pos.x-p.x), range=330, cone=.29;
    const targets=g.enemies.filter(e=>{
      const d=distance(p,e);if(d>range||d<1)return false;
      return Math.abs(Math.atan2(Math.sin(Math.atan2(e.y-p.y,e.x-p.x)-aim),Math.cos(Math.atan2(e.y-p.y,e.x-p.x)-aim)))<=cone;
    }).sort((a,b)=>distance(p,a)-distance(p,b)).slice(0,4);
    if(!targets.length)return;
    p.inventory.shells--;p.lastShot=now;
    for(const e of targets){
      const d=distance(p,e),falloff=1-.55*(d/range);
      e.hp-=Math.round((76+16*p.skills.power)*falloff*(e.kind==='tank'?.58:1));
      g.bullets.push({id:nextId(),x:p.x,y:p.y,tx:e.x,ty:e.y,kind:'shotgun',until:now+.22});
      if(e.hp<=0){recordKill(e);p.kills++;p.score+=e.kind==='boss'?300:35;p.gold+=e.kind==='boss'?85:8;}
    }
    g.enemies=g.enemies.filter(e=>e.hp>0);checkAchievements(p);
  }
  function research(p,key){
    if(!Object.hasOwn(TECHNOLOGIES,key))return;
    const base=bestBase(p);
    if(!base||distance(p,base)>BASE_RADIUS)return fail(p,'Для исследований войдите на свою базу');
    if(!canManage(p,base))return fail(p,'Исследования доступны только владельцам базы');
    const tech=base.tech||(base.tech=defaultTech());
    const level=tech[key];
    if(level>=3)return fail(p,'Эта технология уже изучена полностью');
    if(base.level<level+1)return fail(p,'Сначала повысьте уровень маяка');
    const cost=techCost(level);
    if(!charge(p,cost))return fail(p,'Не хватает ресурсов для исследования');
    pay(p,cost);tech[key]++;
    announce(`База «${base.ownerName}»: ${TECHNOLOGIES[key].label} ${tech[key]}/3`);
    send(p,{type:'toast',text:`Изучено: ${TECHNOLOGIES[key].label}, уровень ${tech[key]}`});
  }
  function buySkill(p,skill){
    if(!Object.hasOwn(SKILLS,skill))return;
    const level=p.skills[skill];if(level>=3)return fail(p,'Улучшение уже максимальное');
    const cost=skillCost(skill,level);if(p.gold<cost)return fail(p,`Нужно ${cost} золота`);
    p.gold-=cost;p.skills[skill]++;
    if(skill==='vitality'){p.maxHp+=35;p.hp=Math.min(p.maxHp,p.hp+35);}
    send(p,{type:'toast',text:`${SKILLS[skill].label}: уровень ${p.skills[skill]} / 3`});
  }
  function pulse(p,now){
    if(now-p.lastPulse<PULSE_COOLDOWN)return fail(p,`Перезарядка: ${Math.ceil(PULSE_COOLDOWN-(now-p.lastPulse))} с`);
    if(p.gold<PULSE_COST)return fail(p,'Для импульса нужно 10 золота');
    p.gold-=PULSE_COST;p.lastPulse=now;p.pulseUntil=now+.4;
    const defeated=new Set();
    for(const e of g.enemies){if(distance(p,e)>220)continue;
      e.hp-=(e.kind==='tank'?.58:1)*(65+p.skills.power*18);
      const a=Math.atan2(e.y-p.y,e.x-p.x);e.x=clamp(e.x+Math.cos(a)*58,20,WORLD.width-20);e.y=clamp(e.y+Math.sin(a)*58,20,WORLD.height-20);
      if(e.hp<=0){recordKill(e);defeated.add(e.id);p.kills++;p.score+=e.kind==='boss'?300:35;p.gold+=e.kind==='boss'?85:8;}}
    if(defeated.size){g.enemies=g.enemies.filter(e=>!defeated.has(e.id));checkAchievements(p);}
    send(p,{type:'toast',text:'⚡ Защитный импульс активирован!'});
  }
  function dash(p,now){
    if(now-p.lastDash<DASH_COOLDOWN)return fail(p,`Рывок: ${Math.ceil(DASH_COOLDOWN-(now-p.lastDash))} с до готовности`);
    const dx=(p.input.right?1:0)-(p.input.left?1:0),dy=(p.input.down?1:0)-(p.input.up?1:0);
    const l=Math.hypot(dx,dy);
    if(!l)return fail(p,'Для рывка удерживайте клавишу движения');
    p.x=clamp(p.x+dx/l*DASH_DISTANCE,28,WORLD.width-28);
    p.y=clamp(p.y+dy/l*DASH_DISTANCE,28,WORLD.height-28);
    p.lastDash=now;p.dashingUntil=now+.28;
    g.bullets.push({id:nextId(),x:p.x-dx/l*DASH_DISTANCE,y:p.y-dy/l*DASH_DISTANCE,tx:p.x,ty:p.y,kind:'dash',until:now+.24});
  }
  function action(p,msg,now){
    if(!p.alive || now-p.lastAction<0.065)return;p.lastAction=now;
    if(msg.action==='skill'){buySkill(p,String(msg.skill||''));return;}
    if(msg.action==='pulse'){pulse(p,now);return;}
    if(msg.action==='dash'){dash(p,now);return;}
    if(msg.action==='craft'){craft(p,String(msg.item||''));return;}
    if(msg.action==='research'){research(p,String(msg.tech||''));return;}
    const x=Number(msg.x),y=Number(msg.y);
    if(!Number.isFinite(x)||!Number.isFinite(y))return;
    const pos={x:clamp(x,0,WORLD.width),y:clamp(y,0,WORLD.height)};
    if(msg.action==='swing')swing(p,pos,now);
    else if(msg.action==='shoot')shoot(p,pos,now);
    else if(msg.action==='shotgun')shotgun(p,pos,now);
    else if(msg.action==='build')build(p,String(msg.build||''),pos);
    else if(msg.action==='upgrade')upgrade(p,pos);
    else if(msg.action==='repair')repair(p,pos);
    else if(msg.action==='use')useItem(p,String(msg.item||''),pos);
  }
  function spawnEnemy(target,cycle,boss=false) {
    if(!target || g.enemies.length>=160)return false;
    const a=rand()*Math.PI*2,r=620+rand()*155;
    const x=clamp(target.x+Math.cos(a)*r,32,WORLD.width-32),y=clamp(target.y+Math.sin(a)*r,32,WORLD.height-32);
    const chance=rand(),wave=cycle.wave;
    const kind=boss?'boss':wave>=10&&chance>.97?'berserker':wave>=9&&chance>.955?'shaman':wave>=7&&chance>.92?'sapper':wave>=8&&chance>.85?'raider':wave>=6&&chance<.10?'tank':wave>=3&&chance<.24?'spitter':
      chance<Math.min(.48,.10+wave*.018)?'runner':wave%4===0&&chance>.80?'brute':'normal';
    const maxHp=kind==='boss'?1500+wave*115:kind==='berserker'?150+wave*22:kind==='tank'?330+wave*35:
      kind==='brute'?180+wave*21:kind==='sapper'?125+wave*16:kind==='shaman'?110+wave*20:kind==='raider'?105+wave*18:kind==='spitter'?65+wave*12:kind==='runner'?48+wave*9:75+wave*13;
    g.enemies.push({id:nextId(),x,y,hp:maxHp,maxHp,kind,big:['boss','brute','tank'].includes(kind),
      speed:kind==='boss'?34:kind==='berserker'?72:kind==='tank'?29:kind==='brute'?43:kind==='sapper'?78:kind==='shaman'?46:kind==='raider'?105:kind==='spitter'?58:kind==='runner'?126:65+Math.min(wave,12)*2,
      damage:kind==='boss'?65:kind==='berserker'?28:kind==='tank'?35:kind==='brute'?22:kind==='sapper'?22:kind==='shaman'?12:kind==='raider'?19:kind==='spitter'?11+Math.floor(wave/4)*3:kind==='runner'?8:10+Math.floor(wave/3)*2,
      baseId:target.id,slowUntil:0,lastAttack:0,burnUntil:0,lastBurn:0,lastHeal:0});
    return true;
  }
  function update(dt,now){
    const d=Math.min(.06,Math.max(0,dt));
    for(const p of g.players.values()){
      if(!p.alive){if(now>p.respawnAt){p.alive=true;p.hp=p.maxHp;const spawn=bestBase(p)||g.core;p.x=spawn?.x||1600;p.y=spawn?.y||1200;send(p,{type:'toast',text:'Вы возродились у стартовой точки'});}continue;}
      let dx=(p.input.right?1:0)-(p.input.left?1:0),dy=(p.input.down?1:0)-(p.input.up?1:0);
      const len=Math.hypot(dx,dy)||1; const speed=225+18*p.skills.speed;
      p.x=clamp(p.x+dx/len*speed*d,28,WORLD.width-28);
      p.y=clamp(p.y+dy/len*speed*d,28,WORLD.height-28);
    }
    for(const node of g.resources)if(node.hp<=0 && now>=node.respawn){node.hp=node.maxHp;g.resourceRevision++;}
    if(!g.core)return;
    if(now>=g.nextGold){
      for(const p of g.players.values())p.gold+=g.buildings.filter(b=>b.type==='mine'&&canManage(p,coreFor(b))).reduce((n,b)=>n+b.level*5,0);
      g.nextGold=now+5;
    }
    // Each beacon has its own day/night cycle and enemy budget.
    // With nobody connected to defend a settlement, freeze its wave timers and combat.
    // No changes to the world save schema are required: phaseRemaining is already relative.
    const pausedBases=new Set();
    if(g.primaryChanged){syncLegacyFromPrimary();g.primaryChanged=false;}
    else syncPrimaryFromLegacy(); // compatibility with 0.1-0.5 and test/admin helpers
    for(const core of cores()){
      const cycle=g.cycles.get(core.id);if(!cycle)continue;
      const elapsed=Math.max(0,now-(cycle.lastObservedAt??now));
      cycle.lastObservedAt=now;
      const defenders=[...g.players.values()].filter(p=>canManage(p,core));
      if(!defenders.length){
        cycle.paused=true;pausedBases.add(core.id);
        cycle.phaseEnds+=elapsed;cycle.nextSpawn+=elapsed;
        // A paused wave does not advance or grant rewards to an empty base.
        continue;
      }
      cycle.paused=false;
      if(cycle.phase==='day'&&!cycle.warned&&cycle.phaseEnds-now<=WAVE_WARNING_SECONDS&&cycle.phaseEnds>now){
        cycle.warned=true;
        for(const p of defenders)send(p,{type:'toast',text:`До волны ${cycle.wave+1} осталось ${Math.ceil(cycle.phaseEnds-now)} с!`});
      }
      if(cycle.phase==='day'&&now>=cycle.phaseEnds){
        cycle.phase='night';cycle.wave++;cycle.phaseEnds=now+42;
        // Cooperative squads face a few additional enemies, without punishing solo bases.
        const extra=Math.min(6,Math.max(0,defenders.length-1)*2);
        cycle.remainingSpawns=Math.min(MAX_WAVE_SPAWNS,Math.min(30,5+cycle.wave*4)+extra+(cycle.wave%5===0?1:0));
        cycle.warned=false;cycle.nextSpawn=now+.2;
        if(cycle.wave%5===0)announce(`БОСС: пятая волна базы «${core.ownerName}»!`);
        announce(`База «${core.ownerName}»: волна ${cycle.wave}!`);
      }
      if(cycle.phase==='night'&&cycle.remainingSpawns>0&&now>=cycle.nextSpawn){
        const boss=cycle.wave%5===0&&cycle.remainingSpawns===1;
        if(spawnEnemy(core,cycle,boss))cycle.remainingSpawns--;
        cycle.nextSpawn=now+Math.max(.32,1.35-cycle.wave*.035);
      }
    }
    syncLegacyFromPrimary();
    for(const b of g.buildings){
      if(pausedBases.has(b.baseId))continue;
      if(b.type==='turret' && now-b.lastShot>Math.max(.36,.90-b.level*.12)){
        const target=g.enemies.filter(e=>enemyForBase(e,coreFor(b))&&distance(b,e)<305+b.level*42).sort((a,c)=>distance(a,b)-distance(c,b))[0];
        if(target){target.hp-=(target.kind==='tank'?.58:1)*22*b.level*(1+.15*(coreFor(b)?.tech?.power||0));b.lastShot=now;g.bullets.push({id:nextId(),x:b.x,y:b.y,tx:target.x,ty:target.y,kind:'turret',until:now+.22});
          if(target.hp<=0){recordKill(target);g.enemies=g.enemies.filter(e=>e.id!==target.id);for(const p of g.players.values())if(canManage(p,coreFor(b))){p.gold+=3;p.score+=12;}}
        }
      }
      if(b.type==='medic'&&now-b.lastShot>=2){
        for(const p of g.players.values())if(p.alive&&canManage(p,coreFor(b))&&distance(p,b)<190+b.level*30)p.hp=Math.min(p.maxHp,p.hp+7*b.level);
        b.lastShot=now;
      }
      if(b.type==='frost'&&now-b.lastShot>=1.5){
        for(const e of g.enemies)if(enemyForBase(e,coreFor(b))&&distance(b,e)<230+b.level*30)e.slowUntil=now+2.2;
        b.lastShot=now;
      }
      if(b.type==='tesla'&&now-b.lastShot>=Math.max(.5,1.8-b.level*.22)){
        const targets=g.enemies.filter(e=>enemyForBase(e,coreFor(b))&&distance(b,e)<240+b.level*40)
          .sort((a,c)=>distance(a,b)-distance(c,b)).slice(0,2+b.level);
        if(targets.length){b.lastShot=now;
          for(const target of targets){target.hp-=(target.kind==='tank'?.8:1)*(20+11*b.level)*(1+.15*(coreFor(b)?.tech?.power||0));
            g.bullets.push({id:nextId(),baseId:b.baseId,x:b.x,y:b.y,tx:target.x,ty:target.y,kind:'tesla',until:now+.24});
            if(target.hp<=0)for(const p of g.players.values())if(canManage(p,coreFor(b))){p.gold+=3;p.score+=12;}
          }
        }
      }
      if(b.type==='mortar'&&now-b.lastShot>=Math.max(1.6,3.2-.4*b.level)){
        const candidates=g.enemies.filter(e=>enemyForBase(e,coreFor(b))&&distance(b,e)<440+35*b.level)
          .sort((a,c)=>distance(a,b)-distance(c,b));
        if(candidates.length){
          const center=candidates[0], radius=90+b.level*12;
          const damage=(34+20*b.level)*(1+.15*(coreFor(b)?.tech?.power||0));
          b.lastShot=now;
          g.bullets.push({id:nextId(),baseId:b.baseId,x:b.x,y:b.y,tx:center.x,ty:center.y,kind:'mortar',until:now+.38});
          for(const e of g.enemies)if(enemyForBase(e,coreFor(b))&&distance(e,center)<=radius){
            e.hp-=damage*(e.kind==='tank'?.8:1);
            if(e.hp<=0)for(const p of g.players.values())if(canManage(p,coreFor(b))){p.gold+=3;p.score+=12;}
          }
        }
      }
      if(b.type==='flame'&&now-b.lastShot>=Math.max(.45,1.05-b.level*.15)){
        const targets=g.enemies.filter(e=>enemyForBase(e,coreFor(b))&&distance(b,e)<155+b.level*23).slice(0,9);
        if(targets.length){b.lastShot=now;
          for(const e of targets){
            e.hp-=(11+6*b.level)*(1+.15*(coreFor(b)?.tech?.power||0))*(e.kind==='tank'?.8:1);
            e.burnUntil=Math.max(e.burnUntil||0,now+2.5);
            e.lastBurn=now;
            g.bullets.push({id:nextId(),baseId:b.baseId,x:b.x,y:b.y,tx:e.x,ty:e.y,kind:'flame',until:now+.28});
            if(e.hp<=0)for(const p of g.players.values())if(canManage(p,coreFor(b))){p.gold+=3;p.score+=12;}
          }
        }
      }
      if(b.type==='spike'&&now-b.lastSpikes>.45){
        for(const e of g.enemies)if(enemyForBase(e,coreFor(b))&&distance(b,e)<58){e.hp-=7*b.level;}
        b.lastSpikes=now;
      }
    }
    // DoT and shaman support are authoritative and restricted to the enemy's assigned base.
    for(const e of g.enemies){
      if(pausedBases.has(e.baseId))continue;
      if(e.burnUntil>now&&now-(e.lastBurn||0)>=.5){e.hp-=7;e.lastBurn=now;}
      if(e.kind==='shaman'&&e.hp>0&&now-(e.lastHeal||0)>=2.1){
        const allies=g.enemies.filter(a=>a.id!==e.id&&a.baseId===e.baseId&&a.hp>0&&a.hp<a.maxHp&&distance(a,e)<180).slice(0,5);
        e.lastHeal=now;
        for(const ally of allies){ally.hp=Math.min(ally.maxHp,ally.hp+18);
          g.bullets.push({id:nextId(),baseId:e.baseId,x:e.x,y:e.y,tx:ally.x,ty:ally.y,kind:'heal',until:now+.38});}
      }
    }
    for(const e of g.enemies)if(e.hp<=0)recordKill(e);
    g.enemies=g.enemies.filter(e=>e.hp>0);
    g.bullets=g.bullets.filter(b=>b.until>now);
    // Build once per simulation tick instead of searching every settlement's structures for each zombie.
    const activeBases=cores(),baseById=new Map(activeBases.map(c=>[c.id,c]));
    const buildingsByBase=new Map(activeBases.map(c=>[c.id,[]]));
    for(const b of g.buildings)if(b.hp>0&&buildingsByBase.has(b.baseId))buildingsByBase.get(b.baseId).push(b);
    const livePlayers=[...g.players.values()].filter(p=>p.alive);
    for(const e of g.enemies){
      if(pausedBases.has(e.baseId))continue;
      const targetCore=baseById.get(e.baseId||g.core?.id);if(!targetCore)continue;
      const baseBuildings=buildingsByBase.get(targetCore.id)||[];
      const nearby=baseBuildings.filter(b=>distance(b,e)<RECIPES[b.type].size/2+39).sort((a,b)=>distance(a,e)-distance(b,e));
      const nearestPlayer=livePlayers.filter(p=>distance(p,e)<32).sort((a,b)=>distance(a,e)-distance(b,e))[0];
      if(nearby.length){
        const b=nearby[0];if(now-e.lastAttack>.75){const damage=e.damage*(e.kind==='berserker'&&e.hp<e.maxHp*.5?1.6:1)*(e.kind==='sapper'&&b.type==='wall'?2:1)*(1-.09*(targetCore.tech?.armor||0));b.hp-=damage;targetCore.stats.damageTaken+=Math.round(damage);e.lastAttack=now;}
      }else if(e.kind==='spitter'&&distance(e,targetCore)<255){
        if(now-e.lastAttack>=2.4){
          const candidates=g.buildings.filter(b=>b.baseId===targetCore.id&&distance(e,b)<=305)
            .sort((a,b)=>distance(e,a)-distance(e,b));
          const victim=candidates[0]||targetCore;
          const damage=e.damage*(1-.09*(targetCore.tech?.armor||0));victim.hp-=damage;targetCore.stats.damageTaken+=Math.round(damage);
          e.lastAttack=now;
          g.bullets.push({id:nextId(),baseId:e.baseId,x:e.x,y:e.y,tx:victim.x,ty:victim.y,kind:'acid',until:now+.4});
        }
      }else if(nearestPlayer){
        if(now-e.lastAttack>.8){nearestPlayer.hp-=e.damage;e.lastAttack=now;if(nearestPlayer.hp<=0){nearestPlayer.alive=false;nearestPlayer.respawnAt=now+3;nearestPlayer.wood=Math.floor(nearestPlayer.wood*.9);nearestPlayer.stone=Math.floor(nearestPlayer.stone*.9);}}
      }else{
        const special=e.kind==='raider'?'mine':e.kind==='sapper'?'wall':null;
        // Seek specialist targets only locally: distant generators should not make raiders ignore defenses.
        const priority=special?baseBuildings.filter(b=>b.type===special&&distance(b,e)<460).sort((a,b)=>distance(a,e)-distance(b,e))[0]:null;
        // Walls between the invader and beacon become meaningful obstacles instead of being bypassed.
        const wall=baseBuildings.filter(b=>b.type==='wall'&&distance(b,e)<170&&
          distance(b,targetCore)<distance(e,targetCore)+45).sort((a,b)=>distance(a,e)-distance(b,e))[0];
        const player=livePlayers.filter(p=>distance(p,e)<160).sort((a,b)=>distance(a,e)-distance(b,e))[0];
        const target=priority||wall||player||targetCore;
        const dx=target.x-e.x,dy=target.y-e.y,len=Math.hypot(dx,dy)||1;
        const speed=e.speed*(e.slowUntil>now?.47:1)*(e.kind==='berserker'&&e.hp<e.maxHp*.5?1.75:1);
        e.x=clamp(e.x+dx/len*speed*d,20,WORLD.width-20);e.y=clamp(e.y+dy/len*speed*d,20,WORLD.height-20);
      }
    }
    for(const c of cores().filter(c=>c.hp<=0))resetBase(c);
    for(const b of g.buildings)if(b.hp<=0&&b.type!=='core'){const owner=cores().find(c=>c.id===b.baseId);if(owner)owner.stats.buildingsLost++;}
    g.buildings=g.buildings.filter(b=>b.hp>0);
    if(!g.core)return;
    for(const core of cores()){
      const cycle=g.cycles.get(core.id);
      if(!cycle||cycle.paused||cycle.phase!=='night'||cycle.remainingSpawns>0||g.enemies.some(e=>enemyForBase(e,core)))continue;
      cycle.phase='day';cycle.phaseEnds=now+43;cycle.warned=false;core.stats.wavesCleared++;
      for(const p of g.players.values())if(canManage(p,core)){p.gold+=18+cycle.wave*4;p.score+=100*cycle.wave;p.stats.bestWave=Math.max(p.stats.bestWave,cycle.wave);checkAchievements(p);}
      updateRecords();announce(`База «${core.ownerName}» отбила волну ${cycle.wave}!`);
    }
    if(!g.primaryChanged)syncLegacyFromPrimary();

  }
  function snapshot(now,viewer=null,{includeResources=true}={}){const mine=viewer?bestBase(viewer):g.core;
    const liveCores=cores();
    const bases=liveCores.map(b=>{const c=g.cycles.get(b.id)||freshCycle(now);
      return {id:b.id,ownerName:b.ownerName,phase:c.phase,wave:c.wave,paused:!!c.paused,remaining:Math.max(0,Math.ceil(c.phaseEnds-now)),
        enemies:g.enemies.filter(e=>e.baseId===b.id).length,remainingSpawns:c.remainingSpawns,canManage:viewer?canManage(viewer,b):false};});
    const viewing=mine||(!viewer?g.core:liveCores.slice().sort((a,b)=>distance(viewer,a)-distance(viewer,b))[0]);
    const baseStatus=bases.find(b=>b.id===viewing?.id)||null;
    return {
    type:'state', t:now, world:WORLD, phase:g.phase, remaining:g.phase==='waiting'?0:Math.max(0,Math.ceil(g.phaseEnds-now)),wave:g.wave,
    players:[...g.players.values()].map(({id,name,x,y,aim,hp,maxHp,wood,stone,gold,kills,score,alive,skills,inventory,teamId,lastPulse,pulseUntil,lastDash,dashingUntil})=>({
      id,name,x:Math.round(x),y:Math.round(y),aim,hp:Math.max(0,Math.round(hp)),maxHp,kills,score,alive,teamId,dashing:dashingUntil>now,pulsing:pulseUntil>now,
      ...(viewer?.id===id||!viewer?{wood,stone,gold,skills,inventory,pulseCooldown:Math.max(0,Math.ceil(PULSE_COOLDOWN-(now-lastPulse))),dashCooldown:Math.max(0,Math.ceil(DASH_COOLDOWN-(now-lastDash)))}:{})
    })),
    resources:includeResources?g.resources.filter(n=>n.hp>0).map(({id,x,y,type,hp,maxHp})=>({id,x,y,type,hp,maxHp})):null,
    buildings:g.buildings.map(({id,x,y,type,hp,maxHp,level,baseId,teamId,ownerName})=>({id,x,y,type,hp:Math.max(0,hp),maxHp,level,baseId,...(type==='core'?{teamId,ownerName,canManage:viewer?canManage(viewer,g.buildings.find(b=>b.id===id)):false}:{})})),
    enemies:g.enemies.map(({id,x,y,hp,maxHp,big,kind,slowUntil,baseId,burnUntil})=>({id,x:Math.round(x),y:Math.round(y),hp:Math.max(0,hp),maxHp,big,kind,baseId,slowed:slowUntil>now,burning:burnUntil>now})),
    bullets:g.bullets, chat:g.chat.slice(-6), records:g.records, ownedBaseId:mine?.id||null,
    bases,baseStatus,baseStats:mine?{...mine.stats||defaultBaseStats(),ownerName:mine.ownerName,level:mine.level,buildings:g.buildings.filter(b=>b.baseId===mine.id).length,coreHp:Math.max(0,Math.round(mine.hp)),coreMaxHp:mine.maxHp}:null,
    myAchievements:viewer?{earned:[...viewer.achievements],stats:{...viewer.stats},kills:viewer.kills}:null,
    technologies:mine?{...mine.tech||defaultTech()}:null,biome:viewer?biomeAt(viewer.x,viewer.y):'forest',
    baseCount:cores().length, maxBases:MAX_BASES
  };}
  return {g,addPlayer,removePlayer,update,snapshot,action,announce,updateRecords,exportWorld,exportProfile};
}

function makeSocket(socket,onMessage,onClose,{idleTimeoutMs=SOCKET_IDLE_TIMEOUT_MS}={}){
  let buffer=Buffer.alloc(0),closed=false,rateTokens=MESSAGE_BURST,lastRate=Date.now();
  function finish(){if(closed)return;closed=true;onClose();}
  function abort(){if(!socket.destroyed)socket.destroy();finish();}
  function sendFrame(op,body){
    if(closed||socket.destroyed)return false;
    if(socket.writableLength>MAX_SOCKET_BACKLOG){abort();return false;}
    const len=body.length;
    let header;
    if(len<126)header=Buffer.from([0x80|op,len]);
    else if(len<65536){header=Buffer.alloc(4);header[0]=0x80|op;header[1]=126;header.writeUInt16BE(len,2);}
    else{header=Buffer.alloc(10);header[0]=0x80|op;header[1]=127;header.writeBigUInt64BE(BigInt(len),2);}
    try{socket.write(Buffer.concat([header,body]));return true;}catch{abort();return false;}
  }
  const client={get closed(){return closed;},close(){if(!closed){socket.end();abort();}},sendJSON(data){
    if(closed)return false;
    return sendFrame(1,Buffer.from(JSON.stringify(data)));
  }};
  socket.setNoDelay(true);
  socket.setKeepAlive(true,30000);
  // A dead TCP peer can otherwise reserve a player slot and lock a profile indefinitely.
  // The timer is reset by received bytes; an idle browser reconnects with its saved session.
  socket.setTimeout(idleTimeoutMs,abort);
  socket.on('data',chunk=>{
    if(closed)return;
    // Ignore clients that stream unbounded data without valid WebSocket frames.
    if(buffer.length+chunk.length>MAX_CLIENT_MESSAGE*2+32){abort();return;}
    buffer=Buffer.concat([buffer,chunk]);
    while(!closed&&buffer.length>=2){
      const first=buffer[0],op=first&15,masked=!!(buffer[1]&128);
      let len=buffer[1]&127,head=2;
      if(first&0x70 || !(first&0x80) || !masked || ![1,8,9,10].includes(op)){abort();return;}
      if(len===126){if(buffer.length<4)return;len=buffer.readUInt16BE(2);head=4;}
      else if(len===127){if(buffer.length<10)return;const value=buffer.readBigUInt64BE(2);if(value>BigInt(MAX_CLIENT_MESSAGE)){abort();return;}len=Number(value);head=10;}
      if(len>MAX_CLIENT_MESSAGE || (op>=8&&len>125)){abort();return;}
      if(buffer.length<head+4+len)return;
      const mask=buffer.subarray(head,head+4),body=Buffer.from(buffer.subarray(head+4,head+4+len));buffer=buffer.subarray(head+4+len);
      for(let i=0;i<body.length;i++)body[i]^=mask[i%4];
      if(op===8){abort();return;}
      if(op===9){sendFrame(10,body);continue;}
      if(op===10)continue;
      const now=Date.now();rateTokens=Math.min(MESSAGE_BURST,rateTokens+(now-lastRate)*MAX_MESSAGES_PER_SEC/1000);lastRate=now;
      if(rateTokens<1){abort();return;}rateTokens--;
      try{
        const msg=JSON.parse(body.toString('utf8'));
        if(msg&&typeof msg==='object'&&!Array.isArray(msg))onMessage(msg);
      }catch{/* malformed JSON is ignored; excessive traffic is handled above */}
    }
  });
  socket.on('close',finish);
  socket.on('error',finish);
  return client;
}

function startServer({port=PORT,host=HOST,idleTimeoutMs=SOCKET_IDLE_TIMEOUT_MS,dataFile=path.join(__dirname,'data','records.json'),worldFile=path.join(path.dirname(dataFile),'world.json'),profilesFile=path.join(path.dirname(dataFile),'profiles.json'),teamsFile=path.join(path.dirname(dataFile),'teams.json'),accountsFile=path.join(path.dirname(dataFile),'accounts.json')}={}){
  let records=[];
  try{const loaded=JSON.parse(fs.readFileSync(dataFile,'utf8'));if(Array.isArray(loaded))records=loaded;}catch(e){if(e.code!=='ENOENT')console.warn('Невозможно прочитать рекорды:',e.message);}
  function readJson(file,fallback){
    for(const candidate of [file,file+'.bak']){
      try{const data=JSON.parse(fs.readFileSync(candidate,'utf8'));
        if(candidate!==file)console.warn('Восстановлены данные из резервной копии:',path.basename(candidate));
        return data;
      }catch(e){if(e.code!=='ENOENT')console.warn('Ошибка чтения',path.basename(candidate),e.message);}
    }
    return fallback;
  }
  const game=createGame({records,world:readJson(worldFile,null)});
  const savedProfiles=readJson(profilesFile,{schema:1,profiles:{}});
  const profiles=new Map(Object.entries(savedProfiles?.schema===1&&savedProfiles.profiles&&typeof savedProfiles.profiles==='object'?savedProfiles.profiles:{}));
  const activeProfiles=new Set();
  // Password-backed accounts retain the same stable profileKey used by existing guest saves.
  // Passwords are derived via async PBKDF2, never stored or logged as plaintext.
  const passwordIterations=210000;
  const savedAccounts=readJson(accountsFile,{schema:1,users:[]});
  const accounts=new Map();
  if(savedAccounts?.schema===1&&Array.isArray(savedAccounts.users))for(const u of savedAccounts.users.slice(0,10000)){
    if(!u||typeof u.username!=='string'||! /^[a-z0-9_]{3,20}$/.test(u.username)||
      typeof u.profileKey!=='string'||! /^[a-f0-9]{64}$/.test(u.profileKey)||
      typeof u.salt!=='string'||! /^[a-f0-9]{32}$/.test(u.salt)||
      typeof u.passwordHash!=='string'||! /^[a-f0-9]{64}$/.test(u.passwordHash)||
      typeof u.recoveryHash!=='string'||! /^[a-f0-9]{64}$/.test(u.recoveryHash))continue;
    accounts.set(u.username,{username:u.username,profileKey:u.profileKey,salt:u.salt,passwordHash:u.passwordHash,
      recoveryHash:u.recoveryHash,sessionHash:typeof u.sessionHash==='string'?u.sessionHash:null,
      sessionUntil:Number.isFinite(u.sessionUntil)?u.sessionUntil:0,createdAt:u.createdAt||''});
  }
  const claimedProfiles=()=>new Set([...accounts.values()].map(a=>a.profileKey));
  const validUsername=v=>typeof v==='string'&&/^[a-zA-Z0-9_]{3,20}$/.test(v);
  const validPassword=v=>typeof v==='string'&&v.length>=10&&v.length<=128&&Buffer.byteLength(v,'utf8')<=256;
  const normalizeUsername=v=>String(v).toLowerCase();
  function derivePassword(password,salt){return new Promise((resolve,reject)=>crypto.pbkdf2(password,Buffer.from(salt,'hex'),passwordIterations,32,'sha256',(e,h)=>e?reject(e):resolve(h.toString('hex'))));}
  function safeHashEquals(a,b){if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length||a.length!==64)return false;
    return crypto.timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));}
  function newRecovery(){const code=crypto.randomBytes(16).toString('hex').toUpperCase();return {code,hash:crypto.createHash('sha256').update(code).digest('hex')};}
  function saveAccounts(){atomicWrite(accountsFile,{schema:1,users:[...accounts.values()]});}
  function newSession(account){const value=crypto.randomBytes(32).toString('hex');account.sessionHash=digest(value);account.sessionUntil=Date.now()+30*24*3600*1000;return value;}
  const authAttempts=new Map();
  function authAllowed(ip){const now=Date.now();let state=authAttempts.get(ip);
    if(!state||now-state.since>60000)state={since:now,hits:0};state.hits++;authAttempts.set(ip,state);
    if(authAttempts.size>1024)for(const [key,val] of authAttempts){if(now-val.since>60000)authAttempts.delete(key);}
    return state.hits<=12;
  }
  const teamSaved=readJson(teamsFile,{schema:1,teams:[]});
  const teams=new Map();
  if(teamSaved?.schema===1&&Array.isArray(teamSaved.teams))for(const t of teamSaved.teams.slice(0,200)){
    if(!t||typeof t.id!=='string'||!/^t_[0-9a-f]{16}$/.test(t.id)||typeof t.code!=='string'||! /^[A-Z2-9]{6}$/.test(t.code)||!Array.isArray(t.members)||t.members.length<1||t.members.length>4)continue;
    const members=t.members.filter(m=>m&&typeof m.key==='string'&&/^[0-9a-f]{64}$/.test(m.key)&&typeof m.name==='string')
      .map(m=>({key:m.key,name:cleanName(m.name)}));
    if(!members.length||new Set(members.map(m=>m.key)).size!==members.length)continue;
    teams.set(t.id,{id:t.id,name:cleanName(t.name),code:t.code,members,owner:members.some(m=>m.key===t.owner)?t.owner:members[0].key});
  }
  function teamFor(key){return [...teams.values()].find(t=>t.members.some(m=>m.key===key))||null;}
  function teamInfo(p){const t=p?.profileKey&&teamFor(p.profileKey);if(!t)return null;
    return {id:t.id,name:t.name,code:t.code,owner:t.owner===p.profileKey,members:t.members.map(m=>({name:m.name,online:[...game.g.players.values()].some(q=>q.profileKey===m.key)}))};
  }
  function saveTeams(){try{atomicWrite(teamsFile,{schema:1,teams:[...teams.values()]});}catch(e){console.warn('Ошибка сохранения отрядов:',e.message);}}
  function teamAction(p,msg){
    const mode=String(msg.action||'');const old=teamFor(p.profileKey);
    if(mode==='create'){
      if(old)return p.socket.sendJSON({type:'toast',text:'Сначала покиньте текущий отряд'});
      if(teams.size>=200)return p.socket.sendJSON({type:'toast',text:'Лимит отрядов сервера достигнут'});
      const name=cleanName(msg.name).slice(0,18);
      if(!name)return;
      let code;do{code=crypto.randomBytes(5).toString('hex').toUpperCase().replace(/[01]/g,'A').slice(0,6);}while([...teams.values()].some(t=>t.code===code));
      const id='t_'+crypto.randomBytes(8).toString('hex');
      teams.set(id,{id,name,code,owner:p.profileKey,members:[{key:p.profileKey,name:p.name}]});p.teamId=id;p.teamName=name;
      p.socket.sendJSON({type:'toast',text:`Отряд «${name}» создан. Код: ${code}`});saveTeams();return;
    }
    if(mode==='join'){
      if(old)return p.socket.sendJSON({type:'toast',text:'Вы уже состоите в отряде'});
      const code=String(msg.code||'').trim().toUpperCase();const t=[...teams.values()].find(t=>t.code===code);
      if(!t)return p.socket.sendJSON({type:'toast',text:'Отряд с таким кодом не найден'});
      if(t.members.length>=4)return p.socket.sendJSON({type:'toast',text:'В отряде максимум 4 участника'});
      t.members.push({key:p.profileKey,name:p.name});p.teamId=t.id;p.teamName=t.name;
      p.socket.sendJSON({type:'toast',text:`Вы вступили в отряд «${t.name}»`});saveTeams();return;
    }
    if(mode==='leave'){
      if(!old)return;
      old.members=old.members.filter(m=>m.key!==p.profileKey);p.teamId=null;p.teamName=null;
      if(!old.members.length){teams.delete(old.id);for(const b of game.g.buildings)if(b.type==='core'&&b.teamId===old.id){b.teamId=null;b.ownerKey=p.profileKey;b.ownerName=p.name;}}
      else if(old.owner===p.profileKey)old.owner=old.members[0].key;
      p.socket.sendJSON({type:'toast',text:'Вы покинули отряд'});saveTeams();
    }
  }
  function teamChat(p,msg){
    const t=teamFor(p.profileKey),now=Date.now()/1000;
    if(!t||now-(p.lastTeamChat||0)<1.2)return;
    const text=String(msg.text||'').replace(/[<>\u0000-\u001f]/g,'').trim().slice(0,110);if(!text)return;
    p.lastTeamChat=now;
    for(const q of game.g.players.values())if(q.profileKey&&t.members.some(m=>m.key===q.profileKey)&&q.socket&&!q.socket.closed)
      q.socket.sendJSON({type:'team_chat',name:p.name,text,team:t.name});
  }
  function trade(p,msg){
    const t=teamFor(p.profileKey);if(!t||!p.alive)return;
    const resource=String(msg.resource||''),amount=Number(msg.amount),target=game.g.players.get(Number(msg.target));
    if(!['wood','stone','gold'].includes(resource)||!Number.isSafeInteger(amount)||amount!==25||!target||target.id===p.id||!target.alive||
      !target.profileKey||!t.members.some(m=>m.key===target.profileKey)||distance(p,target)>275||p[resource]<amount||target[resource]>999975)return;
    const now=Date.now()/1000;if(now-(p.lastTrade||0)<.7)return;p.lastTrade=now;
    p[resource]-=amount;target[resource]+=amount;
    const resourceName={wood:'дерева',stone:'камня',gold:'золота'}[resource];
    p.socket.sendJSON({type:'toast',text:`Передано ${amount} ${resourceName}: ${target.name}`});
    target.socket?.sendJSON({type:'toast',text:`${p.name} передал вам ${amount} ${resourceName}`});
  }
  const digest=token=>crypto.createHash('sha256').update(token).digest('hex');
  function atomicWrite(file,value){
    fs.mkdirSync(path.dirname(file),{recursive:true});
    const tmp=file+'.tmp';
    fs.writeFileSync(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});
    // Maintain one previous valid JSON version for unexpected crashes or corrupted saves.
    try{const previous=fs.readFileSync(file,'utf8');JSON.parse(previous);fs.writeFileSync(file+'.bak',previous,{mode:0o600});}
    catch(e){if(e.code!=='ENOENT')console.warn('Резервная копия не создана:',path.basename(file),e.message);}
    fs.renameSync(tmp,file);
  }
  function saveAll(){
    game.updateRecords();for(const p of game.g.players.values())if(p.profileKey)profiles.set(p.profileKey,game.exportProfile(p));
    for(const [file,value] of [[dataFile,game.g.records],[worldFile,game.exportWorld()],[profilesFile,{schema:1,profiles:Object.fromEntries(profiles)}],[teamsFile,{schema:1,teams:[...teams.values()]}]]){
      try{atomicWrite(file,value);}catch(e){console.warn('Не удалось сохранить',path.basename(file),e.message);}
    }
  }
  function saveRecords(){
    game.updateRecords();
    try{atomicWrite(dataFile,game.g.records);}
    catch(e){console.warn('Не удалось сохранить рекорды:',e.message);}
  }const peers=new Set();const publicDir=path.join(__dirname,'public');
  const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png'};
  const server=http.createServer((req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405,{'Allow':'GET, HEAD'});res.end('Method not allowed');return;}
    if(!req.url||req.url.length>2048){res.writeHead(414);res.end('URL too long');return;}
    let pathname;try{pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);}catch{res.writeHead(400);res.end('Bad URL');return;}
    if(pathname.startsWith('/.')||pathname.split('/').some(part=>part.startsWith('.'))){res.writeHead(403);res.end('Forbidden');return;}
    if(pathname==='/api/status'){res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify({name:'VORNIXO',version:VERSION,players:game.g.players.size,maxPlayers:MAX_PLAYERS,wave:game.g.wave,phase:game.g.phase,bases:game.g.buildings.filter(b=>b.type==='core').length,maxBases:MAX_BASES,baseWaves:[...game.g.cycles].map(([id,c])=>({id,wave:c.wave,phase:c.phase}))}));return;}
    const file=path.resolve(publicDir,'.'+(pathname==='/'?'/index.html':pathname));
    if(!(file===path.join(publicDir,'index.html')||file.startsWith(publicDir+path.sep))) {res.writeHead(403);res.end('Forbidden');return;}
    fs.readFile(file,(err,data)=>{
      if(err){res.writeHead(404);res.end('Not found');return;}
      res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');res.setHeader('Cache-Control','no-cache');res.end(req.method==='HEAD'?undefined:data);
    });
  });
  server.on('upgrade',(req,socket)=>{
    const ip=socket.remoteAddress||'unknown';
    const key=req.headers['sec-websocket-key'];
    if(req.method!=='GET'||req.url!=='/ws'||String(req.headers.upgrade||'').toLowerCase()!=='websocket'||
      req.headers['sec-websocket-version']!=='13'||typeof key!=='string'||!(/^[A-Za-z0-9+/]{22}==$/.test(key))||
      peers.size>=MAX_PLAYERS || [...peers].filter(p=>p.ip===ip).length>=MAX_CONNECTIONS_PER_IP){socket.destroy();return;}
    if(req.headers.origin){try{const origin=new URL(req.headers.origin);if(!['http:','https:'].includes(origin.protocol)||origin.host!==req.headers.host){socket.destroy();return;}}catch{socket.destroy();return;}}
    const accept=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
    let p=null;let didClose=false,authBusy=false;
    let loginTimer=null;
    let peer;
    function authError(message){if(!peer.closed)peer.sendJSON({type:'auth_error',text:message});}
    function enterGame(key,name,profile,extra={}){
      if(peer.closed||didClose)return;
      if(activeProfiles.has(key)){authError('Этот профиль уже в игре');return;}
      clearTimeout(loginTimer);
      p=game.addPlayer(name,profile);p.profileKey=key;p.socket=peer;
      p.authUsername=extra.username||null;p.teamId=teamFor(key)?.id||null;p.teamName=teamFor(key)?.name||null;
      profiles.set(key,game.exportProfile(p));activeProfiles.add(key);
      peer.sendJSON({type:'welcome',id:p.id,version:VERSION,restored:!!profile,token:extra.guestToken||null,
        ...(extra.session?{session:extra.session,username:extra.username}:{}),
        ...(extra.recoveryCode?{recoveryCode:extra.recoveryCode}:{})});
    }
    async function authenticate(msg){
      if(!authAllowed(ip))return authError('Слишком много попыток. Повторите через минуту.');
      const type=msg.type;
      if(type==='join'){
        const token=typeof msg.token==='string'&&/^[a-f0-9]{64}$/.test(msg.token)?msg.token:null;
        let key=token?digest(token):null;
        if(key&&claimedProfiles().has(key))return authError('Профиль привязан к аккаунту. Войдите с паролем.');
        const restored=!!(key&&profiles.has(key));if(!restored)key=null;
        if(key&&activeProfiles.has(key))return authError('Этот профиль уже в игре');
        const issued=key?null:crypto.randomBytes(32).toString('hex');if(!key)key=digest(issued);
        enterGame(key,msg.name,restored?profiles.get(key):null,{guestToken:issued});return;
      }
      if(!validUsername(msg.username))return authError('Логин: 3–20 латинских букв, цифр или _.');
      const username=normalizeUsername(msg.username);
      if(type==='account_register'){
        if(!validPassword(msg.password))return authError('Пароль: 10–128 символов.');
        if(accounts.has(username))return authError('Этот логин занят.');
        const token=typeof msg.token==='string'&&/^[a-f0-9]{64}$/.test(msg.token)?msg.token:null;
        const oldKey=token?digest(token):null;
        if(oldKey&&claimedProfiles().has(oldKey))return authError('Этот профиль уже привязан к аккаунту.');
        if(oldKey&&activeProfiles.has(oldKey))return authError('Профиль уже открыт в игре.');
        const key=oldKey&&profiles.has(oldKey)?oldKey:digest(crypto.randomBytes(32).toString('hex'));
        const salt=crypto.randomBytes(16).toString('hex'),passwordHash=await derivePassword(msg.password,salt);
        if(peer.closed||didClose)return;
        if(accounts.has(username)||claimedProfiles().has(key))return authError('Не удалось создать аккаунт.');
        const rec=newRecovery();const acc={username,profileKey:key,salt,passwordHash,recoveryHash:rec.hash,sessionHash:null,sessionUntil:0,createdAt:new Date().toISOString()};
        const session=newSession(acc);accounts.set(username,acc);
        try{saveAccounts();}catch(e){accounts.delete(username);console.error('Ошибка сохранения аккаунта:',e.message);return authError('Не удалось сохранить аккаунт.');}
        enterGame(key,msg.name,profiles.get(key)||null,{username,session,recoveryCode:rec.code});return;
      }
      const acc=accounts.get(username);
      if(type==='account_login'){
        if(!acc)return authError('Неверный логин или пароль.');
        let verified=false;
        if(typeof msg.session==='string'&&/^[a-f0-9]{64}$/.test(msg.session)&&acc.sessionUntil>Date.now())
          verified=safeHashEquals(digest(msg.session),acc.sessionHash);
        if(!verified&&typeof msg.password==='string'&&msg.password.length<=128){
          const hashed=await derivePassword(msg.password,acc.salt);verified=safeHashEquals(hashed,acc.passwordHash);
        }
        if(!verified)return authError('Неверный логин или пароль.');
        if(peer.closed||didClose)return;
        if(activeProfiles.has(acc.profileKey))return authError('Этот профиль уже в игре.');
        const session=newSession(acc);
        try{saveAccounts();}catch(e){return authError('Не удалось сохранить сеанс.');}
        enterGame(acc.profileKey,username,profiles.get(acc.profileKey)||null,{username,session});return;
      }
      if(type==='account_recover'){
        if(!acc||!validPassword(msg.password)||typeof msg.recoveryCode!=='string')return authError('Неверный код восстановления или данные.');
        const recHash=digest(msg.recoveryCode.replace(/[ -]/g,'').toUpperCase());
        if(!safeHashEquals(recHash,acc.recoveryHash))return authError('Неверный код восстановления или данные.');
        if(activeProfiles.has(acc.profileKey))return authError('Профиль открыт в игре. Отключите его перед восстановлением.');
        const salt=crypto.randomBytes(16).toString('hex'),passwordHash=await derivePassword(msg.password,salt);
        if(peer.closed||didClose)return;
        const previous={...acc},next=newRecovery();acc.salt=salt;acc.passwordHash=passwordHash;acc.recoveryHash=next.hash;
        const session=newSession(acc);
        try{saveAccounts();}catch(e){Object.assign(acc,previous);return authError('Не удалось сохранить восстановление.');}
        enterGame(acc.profileKey,username,profiles.get(acc.profileKey)||null,{username,session,recoveryCode:next.code});return;
      }
    }
    peer=makeSocket(socket,(msg)=>{
      if(!msg||typeof msg!=='object')return;
      if(!p&&['join','account_register','account_login','account_recover'].includes(msg.type)){
        if(authBusy)return;
        authBusy=true;
        Promise.resolve().then(()=>authenticate(msg)).catch(e=>{console.warn('Ошибка авторизации:',e.message);authError('Не удалось выполнить вход.');}).finally(()=>{authBusy=false;});
        return;
      }
      else if(!p)return;
      else if(msg.type==='ping')peer.sendJSON({type:'pong',sent:Number.isFinite(msg.sent)?msg.sent:0});
      else if(msg.type==='account_password'&&p.authUsername&&!authBusy){
        if(!authAllowed(ip))return authError('Слишком много попыток. Повторите через минуту.');
        if(!validPassword(msg.newPassword)||typeof msg.oldPassword!=='string')return authError('Новый пароль должен содержать 10–128 символов.');
        const acc=accounts.get(p.authUsername);if(!acc)return;
        authBusy=true;
        Promise.resolve().then(async()=>{
          const hashed=await derivePassword(msg.oldPassword,acc.salt);
          if(!safeHashEquals(hashed,acc.passwordHash))return authError('Неправильный текущий пароль.');
          const old={...acc},salt=crypto.randomBytes(16).toString('hex');
          const passwordHash=await derivePassword(msg.newPassword,salt);
          if(peer.closed)return;
          acc.salt=salt;acc.passwordHash=passwordHash;
          const session=newSession(acc);
          try{saveAccounts();}catch(e){Object.assign(acc,old);return authError('Не удалось сохранить пароль.');}
          peer.sendJSON({type:'account_session',session,username:p.authUsername});
          peer.sendJSON({type:'toast',text:'Пароль изменён. Старые сеансы больше не действуют.'});
        }).catch(e=>authError('Ошибка изменения пароля.')).finally(()=>{authBusy=false;});
      }
      else if(msg.type==='input'){
        p.input={up:!!msg.up,down:!!msg.down,left:!!msg.left,right:!!msg.right};
        if(Number.isFinite(msg.aim))p.aim=msg.aim;
      }else if(msg.type==='act'){game.action(p,msg,Date.now()/1000);}
      else if(msg.type==='team')teamAction(p,msg);
      else if(msg.type==='team_chat')teamChat(p,msg);
      else if(msg.type==='trade')trade(p,msg);
      else if(msg.type==='chat'){
        const txt=String(msg.text||'').replace(/[<>\u0000-\u001f]/g,'').trim().slice(0,110);
        if(txt && Date.now()/1000-(p.lastChat||0)>1.2){p.lastChat=Date.now()/1000;game.g.chat.push({id:game.g.nextId++,name:p.name,text:txt,time:Date.now()});game.g.chat=game.g.chat.slice(-16);}
      }
    },()=>{if(!didClose){didClose=true;clearTimeout(loginTimer);peers.delete(peer);if(p){if(p.profileKey){profiles.set(p.profileKey,game.exportProfile(p));activeProfiles.delete(p.profileKey);}game.removePlayer(p.id);}}},{idleTimeoutMs});
    peer.ip=ip;
    peers.add(peer);
    loginTimer=setTimeout(()=>{if(!p)peer.close();},LOGIN_TIMEOUT_MS);
    loginTimer.unref();
  });
  let last=Date.now()/1000;const tick=setInterval(()=>{
    const now=Date.now()/1000;game.update(now-last,now);last=now;
  },50);
  const broadcast=setInterval(()=>{
    if(!peers.size)return;
    const now=Date.now()/1000;
    for(const p of game.g.players.values())if(p.socket&&!p.socket.closed){
      // Resource nodes rarely change; send the initial list and updates only when their revision changes.
      const revision=game.g.resourceRevision;
      const includeResources=p._sentResourceRevision!==revision;
      const sent=p.socket.sendJSON({...game.snapshot(now,p,{includeResources}),myTeam:teamInfo(p)});
      if(sent&&includeResources)p._sentResourceRevision=revision;
    }
  },150);
  const persistence=setInterval(saveAll,10000);
  server.listen(port,host,()=>console.log(`\n VORNIXO Alpha ${VERSION} запущен: http://localhost:${server.address().port}\n Игроки в одной сети: http://<IP_компьютера>:${server.address().port}\n Остановить: Ctrl+C\n`));
  return {server,game,close:()=>{clearInterval(tick);clearInterval(broadcast);clearInterval(persistence);saveAll();for(const peer of peers)peer.close();server.close();}};
}
if(require.main===module){
  const app=startServer();let stopping=false;
  const shutdown=()=>{
    if(stopping)return;stopping=true;
    console.log('\n VORNIXO: сохранение прогресса перед выключением...');
    app.close();
    const timeout=setTimeout(()=>process.exit(0),1500);timeout.unref();
  };
  process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
}
module.exports={createGame,startServer,RECIPES,CRAFTS,SKILLS,TECHNOLOGIES,ACHIEVEMENTS,techCost,biomeAt,skillCost,WORLD,PULSE_COOLDOWN,PULSE_COST,DASH_COOLDOWN,DASH_DISTANCE,MAX_BASES,BASE_RADIUS,BASE_SPACING};
