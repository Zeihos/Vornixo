'use strict';
// Short automated endurance and recovery checks. Not a public internet load test.
const test=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {startServer}=require('../server.js');

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function poll(check,name,timeoutMs=5000){
  const until=Date.now()+timeoutMs;
  while(Date.now()<until){const value=check();if(value)return value;await delay(30);}
  throw Error('Timeout: '+name);
}
async function boot(dir){
  const app=startServer({host:'127.0.0.1',port:0,dataFile:path.join(dir,'records.json')});
  await once(app.server,'listening');
  return app;
}
async function stop(app){
  if(!app.server.listening)return;
  const closed=once(app.server,'close');
  app.close();
  await closed;
}
function messages(ws){
  const inbox=[];
  ws.addEventListener('message',event=>{
    try{inbox.push(JSON.parse(event.data));}catch{}
  });
  return inbox;
}
async function connect(app,payload){
  const ws=new WebSocket('ws://127.0.0.1:'+app.server.address().port+'/ws');
  const inbox=messages(ws);
  await once(ws,'open');
  ws.send(JSON.stringify(payload));
  const welcome=await poll(()=>inbox.find(m=>m.type==='welcome'),'welcome');
  return {ws,inbox,welcome};
}
async function waitClose(ws){
  if(ws.readyState===WebSocket.CLOSED)return;
  const closed=once(ws,'close');ws.close();await closed;
}

test('после выхода профиль сохраняется на диск, не дожидаясь планового интервала',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vornixo-quicksave-'));
  let app=await boot(dir);
  t.after(async()=>{await stop(app);fs.rmSync(dir,{recursive:true,force:true});});
  const client=await connect(app,{type:'join',name:'Survivor'});
  const player=[...app.game.g.players.values()][0];
  player.gold=727;player.stone=626;player.wood=525;
  const key=player.profileKey;
  await waitClose(client.ws);
  const profilesFile=path.join(dir,'profiles.json');
  const stored=await poll(()=>{
    try{
      const saved=JSON.parse(fs.readFileSync(profilesFile,'utf8'));
      return saved.profiles?.[key]?.gold===727&&saved.profiles[key].stone===626&&saved.profiles[key].wood===525;
    }catch{return false;}
  },'profile flush on disconnect',4000);
  assert.ok(stored);
  assert.ok(app.metrics.saveRuns>=1);
  assert.equal(app.metrics.saveFailures,0);
  assert.ok(app.metrics.lastSavedAt>0);
  await stop(app);
  app=await boot(dir);
  const restored=await connect(app,{type:'join',name:'Survivor',token:client.welcome.token});
  assert.equal(restored.welcome.restored,true);
  assert.equal([...app.game.g.players.values()][0].gold,727);
  await waitClose(restored.ws);
});

test('повреждённое сохранение мира восстанавливается из предыдущей валидной резервной копии',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vornixo-backup-'));
  let app=await boot(dir);
  t.after(async()=>{await stop(app);fs.rmSync(dir,{recursive:true,force:true});});
  const now=Date.now()/1000;
  const player=app.game.addPlayer('Engineer');
  player.profileKey='a'.repeat(64);
  player.x=1600;player.y=1200;
  app.game.action(player,{action:'build',build:'core',x:1600,y:1200},now);
  assert.ok(app.game.g.buildings.some(b=>b.type==='core'));
  await stop(app);
  // Second snapshot creates the previous-valid .bak from the first saved world.
  app=await boot(dir);
  await stop(app);
  const worldFile=path.join(dir,'world.json');
  const backup=worldFile+'.bak';
  assert.ok(fs.existsSync(backup));
  assert.ok(JSON.parse(fs.readFileSync(backup,'utf8')).buildings.some(b=>b.type==='core'));
  fs.writeFileSync(worldFile,'{unreadable JSON');
  app=await boot(dir);
  assert.ok(app.game.g.buildings.some(b=>b.type==='core'),'world restored from backup');
  assert.equal(app.game.exportWorld().schema,7);
  await stop(app);
  assert.ok(JSON.parse(fs.readFileSync(worldFile,'utf8')).buildings.some(b=>b.type==='core'));
  assert.equal(fs.existsSync(backup+'.tmp'),false,'temporary backup file not left behind');
});

test('длительная сетевая сессия четырёх клиентов с переподключением и сохранением',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vornixo-endurance-'));
  const app=await boot(dir);
  t.after(async()=>{await stop(app);fs.rmSync(dir,{recursive:true,force:true});});
  const clients=[];
  for(let i=0;i<4;i++)clients.push(await connect(app,{type:'join',name:'Player'+i}));
  assert.equal(app.game.g.players.size,4);
  // Send input for 4 seconds while the world simulates and broadcasts.
  const input=setInterval(()=>{
    for(const c of clients){
      if(c.ws.readyState===WebSocket.OPEN)c.ws.send(JSON.stringify({type:'input',up:true,right:false,left:false,down:false,aim:0}));
    }
  },90);
  await delay(4200);clearInterval(input);
  assert.ok(app.metrics.ticks>=50,'game loop continued running');
  assert.ok(app.metrics.snapshotsSent>=40,'server broadcasted state');
  assert.ok(app.metrics.stateBytes>10000);
  assert.equal(app.metrics.slowDisconnects,0);
  const left=clients.slice(0,2);
  for(const client of left)await waitClose(client.ws);
  await poll(()=>app.game.g.players.size===2,'two clients disconnected');
  const rejoined=[];
  for(const client of left)rejoined.push(await connect(app,{type:'join',name:'Returned',token:client.welcome.token}));
  assert.ok(rejoined.every(c=>c.welcome.restored));
  await poll(()=>app.game.g.players.size===4,'four clients back online');
  assert.equal(app.metrics.saveFailures,0);
  for(const client of [...clients.slice(2),...rejoined])await waitClose(client.ws);
  await poll(()=>app.game.g.players.size===0,'all clients disconnected');
});
