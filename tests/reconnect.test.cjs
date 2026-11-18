'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {startServer}=require('../server.js');

async function waitFor(check,label,timeout=4000){
  const limit=Date.now()+timeout;
  while(Date.now()<limit){
    const value=check();
    if(value)return value;
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  throw Error('Тайм-аут теста: '+label);
}
async function setup(t,idleTimeoutMs){
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'vornixo-reconnect-'));
  const app=startServer({port:0,host:'127.0.0.1',idleTimeoutMs,
    dataFile:path.join(folder,'records.json')});
  await once(app.server,'listening');
  const sockets=[];
  t.after(async()=>{
    for(const ws of sockets)try{ws.close();}catch{}
    if(app.server.listening){
      const closed=once(app.server,'close');
      app.close();
      await closed;
    }
    fs.rmSync(folder,{recursive:true,force:true});
  });
  async function connect(payload){
    const ws=new WebSocket('ws://127.0.0.1:'+app.server.address().port+'/ws');
    sockets.push(ws);
    const messages=[];
    ws.addEventListener('message',event=>{
      try{messages.push(JSON.parse(event.data));}catch{}
    });
    await once(ws,'open');
    ws.send(JSON.stringify(payload));
    const welcome=await waitFor(()=>messages.find(msg=>msg.type==='welcome'),'welcome');
    return {ws,welcome,messages};
  }
  return {app,connect};
}

test('зависшее соединение освобождает слот, а гостевой профиль восстанавливается',async t=>{
  const {app,connect}=await setup(t,450);
  const first=await connect({type:'join',name:'Guest'});
  assert.match(first.welcome.token,/^[a-f0-9]{64}$/);
  assert.equal(app.game.g.players.size,1);
  const player=[...app.game.g.players.values()][0];
  player.gold=187;
  await waitFor(()=>app.game.g.players.size===0,'idle peer cleanup',2500);
  const second=await connect({type:'join',name:'Guest',token:first.welcome.token});
  assert.equal(second.welcome.restored,true);
  assert.equal([...app.game.g.players.values()][0].gold,187);
});

test('аккаунт повторно входит по сохранённому сеансу и получает свой прогресс',async t=>{
  const {app,connect}=await setup(t,25000);
  const user='player001',password='ThisIsA-SafeTestPassword-123';
  const first=await connect({type:'account_register',username:user,password,name:'Player'});
  assert.ok(first.welcome.session,'account registration returns a session token');
  const oldPlayer=[...app.game.g.players.values()][0];
  oldPlayer.stone=902;
  first.ws.close();
  await waitFor(()=>app.game.g.players.size===0,'account disconnect cleanup');
  const second=await connect({type:'account_login',username:user,session:first.welcome.session});
  assert.equal(second.welcome.restored,true);
  assert.equal(second.welcome.username,user);
  assert.equal([...app.game.g.players.values()][0].stone,902);
});

test('входящие ping-пакеты поддерживают активное соединение',async t=>{
  const {app,connect}=await setup(t,500);
  const client=await connect({type:'join',name:'Active'});
  const ping=setInterval(()=>{
    try{client.ws.send(JSON.stringify({type:'ping',sent:1234}));}catch{}
  },90);
  t.after(()=>clearInterval(ping));
  await new Promise(resolve=>setTimeout(resolve,1100));
  assert.equal(app.game.g.players.size,1);
  assert.ok(client.messages.some(msg=>msg.type==='pong'&&msg.sent===1234));
});
