(()=>{
  'use strict';
  const $=id=>document.getElementById(id);
  const canvas=$('game'),ctx=canvas.getContext('2d',{alpha:false});
  const mini=$('minimap'),mc=mini.getContext('2d');
  const el={ui:$('ui'),start:$('startOverlay'),btn:$('startButton'),name:$('nickname'),hint:$('connectionHint'),
    ping:$('netPing'),resources:$('resources'),wood:$('wood'),stone:$('stone'),gold:$('gold'),hp:$('hpText'),hpBar:$('hpBar'),online:$('online'),
    waveTitle:$('waveTitle'),waveClock:$('waveClock'),waveDesc:$('waveDesc'),timeBar:$('timeBar'),score:$('leaderboard'),
    info:$('playerInfo'),missionTitle:$('missionTitle'),missionDesc:$('missionDesc'),tooltip:$('buildTooltip'),
    chat:$('chatMessages'),chatComposer:$('chatComposer'),chatInput:$('chatInput'),chatSend:$('chatSend'),chatPrompt:document.querySelector('.chat-prompt'),
    toast:$('toastArea'),baseList:$('baseList'),help:$('help'),helpClose:$('helpClose'),serverState:$('serverState'),skills:$('skillOptions'),records:$('recordsList'),pulse:$('pulseButton'),pulseTimer:$('pulseTimer'),dash:$('dashButton'),dashTimer:$('dashTimer'),saveState:$('saveState'),craftPanel:$('craftPanel'),teamPanel:$('teamPanel'),
    craftToggle:$('craftToggle'),teamToggle:$('teamToggle'),researchToggle:$('researchToggle'),settingsToggle:$('settingsToggle'),researchPanel:$('researchPanel'),settingsPanel:$('settingsPanel'),teamNoGroup:$('teamNoGroup'),teamHasGroup:$('teamHasGroup'),
    teamTitle:$('teamTitle'),teamInvite:$('teamInvite'),teamMembers:$('teamMembers'),chatTeam:$('chatTeam'),buildPanel:$('buildPanel'),achievementsPanel:$('achievementsPanel'),achievementList:$('achievementList'),baseStatsPanel:$('baseStatsPanel'),weaponToggle:$('weaponToggle')};
  const tools=[
    {id:'axe',title:'Инструмент',desc:'ЛКМ — добыча ресурсов и атака противников'},
    {id:'core',title:'Маяк',desc:'Бесплатно. Ваша отдельная база или база отряда. Держитесь подальше от чужих маяков.'},
    {id:'wall',title:'Баррикада',desc:'18 древесины + 8 камня. Защищает остальные сооружения'},
    {id:'turret',title:'Автотурель',desc:'35 древесины + 48 камня. Автоматически стреляет по зомби'},
    {id:'mine',title:'Генератор',desc:'38 древесины + 25 камня. Приносит золото владельцам базы'},
    {id:'spike',title:'Шипы',desc:'22 древесины + 18 камня. Наносят урон приблизившимся зомби'},
    {id:'bow',title:'Арбалет',desc:'ЛКМ — выстрел до 520 единиц. Крафтовые болты или 1 древесина на выстрел'},
    {id:'medic',title:'Медстанция',desc:'45 древесины + 30 камня + 20 золота. Восстанавливает здоровье рядом'},
    {id:'frost',title:'Криобашня',desc:'40 древесины + 55 камня + 25 золота. Замедляет зомби'},
    {id:'tesla',title:'Разрядник',desc:'Клавиша 0. Цепной электрический разряд по нескольким врагам. 65 древесины, 70 камня, 40 золота'},
    {id:'mortar',title:'Миномёт',desc:'85 дерева, 100 камня, 65 золота. Медленная дальнобойная атака по области'},
    {id:'flame',title:'Огнемёт',desc:'75 дерева, 90 камня, 55 золота. Поджигает врагов рядом; периодический урон'},
  ];
  let state=null,playerId=null,ws=null,connected=false,started=false,lastMsgId=0;
  let craftingOpen=false,teamOpen=false,researchOpen=false,settingsOpen=false,buildOpen=false,achievementsOpen=false,baseStatsOpen=false,weaponMode='bow';
  const defaults={map:true,effects:true,details:true,smooth:true};
  let settings={...defaults};
  try{const saved=JSON.parse(localStorage.getItem('vornixo_settings_v1')||'null');if(saved&&typeof saved==='object')for(const k of Object.keys(defaults))if(typeof saved[k]==='boolean')settings[k]=saved[k];}catch{}
  function saveSettings(){try{localStorage.setItem('vornixo_settings_v1',JSON.stringify(settings));}catch{}}
  const biomeAt=(x,y)=>((x<1100&&y>1330)||(x>2230&&y<950))?'marsh':((x<1050&&y<920)||(x>2350&&y>1430))?'highlands':'forest';
  let sw=innerWidth,sh=innerHeight,dpr=1,cam={x:700,y:700},targetCam={x:700,y:700};
  let pointer={x:sw/2,y:sh/2},mouseDown=false,tool=0,autoAttack=false,showMap=settings.map,helpOpen=false;
  const keys={up:false,down:false,left:false,right:false};
  const sparks=[],floaters=[],hitFlash=new Map(),motionUntil=new Map();
  let cameraKick=0,lastSwingAt=0,lastFrame=performance.now(),lastUI=0;
  // Snapshot deltas drive purely cosmetic effects; health and damage remain server-authoritative.
  function combatFeedback(previous,next){
    if(!settings.effects||!previous||!next)return;
    const now=performance.now();
    const groups=[['e',previous.enemies,next.enemies],['b',previous.buildings,next.buildings],['p',previous.players,next.players]];
    for(const [prefix,oldList,newList] of groups){
      const oldById=new Map((oldList||[]).map(item=>[item.id,item]));
      for(const item of newList||[]){
        const old=oldById.get(item.id);if(!old)continue;
        if(Math.hypot(item.x-old.x,item.y-old.y)>3)motionUntil.set(prefix+item.id,now+230);
        const damage=old.hp-item.hp;
        if(!Number.isFinite(damage)||damage<=0||damage>50000)continue;
        hitFlash.set(prefix+item.id,now+180);
        if(floaters.length<48 && visible(item.x,item.y,90))floaters.push({x:item.x,y:item.y-(prefix==='b'?44:30),value:'-'+Math.ceil(damage),life:.75,total:.75,color:prefix==='p'?'#ffc2ae':prefix==='b'?'#ffce8a':'#ffead0'});
        if(prefix==='p'&&item.id===playerId)cameraKick=Math.min(11,cameraKick+Math.min(6,damage*.2));
      }
    }
    // Without pruning, visited IDs could accumulate during very long sessions.
    for(const [key,until] of hitFlash)if(until<now)hitFlash.delete(key);
    for(const [key,until] of motionUntil)if(until<now)motionUntil.delete(key);
  }
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const hash=(x,y)=>{let n=Math.imul(x,374761393)+Math.imul(y,668265263);n=Math.imul(n^(n>>>13),1274126177);return ((n^(n>>>16))>>>0)/4294967295;};
  const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
  const me=()=>state?.players.find(p=>p.id===playerId)||null;
  const cores=()=>state?.buildings.filter(b=>b.type==='core')||[];
  const core=()=>cores().find(b=>b.id===state?.ownedBaseId)||null;
  const worldAtPointer=()=>({x:pointer.x+cam.x,y:pointer.y+cam.y});
  const send=m=>{if(ws&&ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(m));};
  function toast(text){let t=document.createElement('div');t.className='toast';t.textContent=text;el.toast.append(t);setTimeout(()=>t.remove(),3200);while(el.toast.children.length>3)el.toast.firstChild.remove();}
  function resize(){sw=innerWidth;sh=innerHeight;dpr=Math.min(2,devicePixelRatio||1);canvas.width=Math.floor(sw*dpr);canvas.height=Math.floor(sh*dpr);canvas.style.width=sw+'px';canvas.style.height=sh+'px';ctx.setTransform(dpr,0,0,dpr,0,0);}
  addEventListener('resize',resize);resize();
  function select(index){tool=clamp(index,0,tools.length-1);document.querySelectorAll('.slot').forEach((b,i)=>b.classList.toggle('selected',i===tool));
    const t=tools[tool];el.tooltip.querySelector('strong').textContent=tool===6&&weaponMode==='shotgun'?'Дробовик':t.title;el.tooltip.querySelector('span').textContent=tool===6&&weaponMode==='shotgun'?'ЛКМ — выстрел конусом до 330 единиц, расходуется 1 патрон. Патроны: I.':t.desc;
  }
  document.querySelectorAll('.slot').forEach((b,i)=>b.addEventListener('click',()=>select(i)));
  document.querySelectorAll('[data-skill]').forEach(b=>b.addEventListener('click',()=>send({type:'act',action:'skill',skill:b.dataset.skill})));
  const auth={
    accountName:$('accountName'),password:$('accountPassword'),nameField:$('accountNameField'),
    passwordField:$('accountPasswordField'),recoveryField:$('recoveryField'),recoveryCode:$('recoveryCodeInput'),
    nickLabel:$('nicknameLabel'),info:$('authInfo'),dialog:$('recoveryDialog'),newCode:$('newRecoveryCode'),
    status:$('accountStatus'),passwordSettings:$('passwordSettings')
  };
  let authMode='guest',accountUsername=null,intentionalExit=false;
  function localGet(key){try{return localStorage.getItem(key);}catch{return null;}}
  function localSet(key,value){try{localStorage.setItem(key,value);}catch{toast('Не удалось сохранить данные браузера');}}
  function localRemove(key){try{localStorage.removeItem(key);}catch{}}
  function setMode(mode){
    if(!['guest','login','register','recover'].includes(mode))return;
    authMode=mode;
    document.querySelectorAll('[data-auth]').forEach(b=>b.classList.toggle('active',b.dataset.auth===mode));
    const isGuest=mode==='guest',isRegister=mode==='register';
    auth.nameField.classList.toggle('hidden',isGuest);
    auth.passwordField.classList.toggle('hidden',isGuest);
    auth.recoveryField.classList.toggle('hidden',mode!=='recover');
    el.name.closest('.namebox').classList.toggle('hidden',!(isGuest||isRegister));
    auth.nickLabel.classList.toggle('hidden',!(isGuest||isRegister));
    const passwordInput=auth.password;
    passwordInput.autocomplete=mode==='register'||mode==='recover'?'new-password':'current-password';
    auth.info.textContent=mode==='guest'?'Без регистрации: сохранение привязано к этому браузеру.':
      mode==='login'?'Введите пароль или оставьте поле пустым для входа с сохранённой сессией.':
      mode==='register'?'Можно привязать существующий гостевой прогресс. Сохраните код восстановления после регистрации.':
      'Введите одноразовый код восстановления и придумайте новый пароль. Старые сессии будут отозваны.';
    el.btn.innerHTML=(isGuest?'НАЧАТЬ ВЫЖИВАНИЕ':isRegister?'СОЗДАТЬ АККАУНТ':mode==='login'?'ВОЙТИ В ИГРУ':'ВОССТАНОВИТЬ ДОСТУП')+' <span>➜</span>';
    el.hint.textContent='Сервер готов к подключению';
  }
  document.querySelectorAll('[data-auth]').forEach(b=>b.addEventListener('click',()=>setMode(b.dataset.auth)));
  const storedAccount=localGet('vornixo_account_username');
  if(storedAccount){auth.accountName.value=storedAccount;setMode('login');}else setMode('guest');
  function authPayload(){
    const name=el.name.value.trim().slice(0,18)||'Выживший';el.name.value=name;
    if(authMode==='guest')return {type:'join',name,token:localGet('vornixo_profile_v1')};
    const username=auth.accountName.value.trim();
    if(!/^[A-Za-z0-9_]{3,20}$/.test(username)){el.hint.textContent='Логин: 3–20 латинских букв, цифр или _.';return null;}
    if(authMode==='login'){
      const savedName=localGet('vornixo_account_username');
      const session=auth.password.value?'':(savedName===username.toLowerCase()?localGet('vornixo_account_session'):null);
      if(!session&&!auth.password.value){el.hint.textContent='Введите пароль аккаунта';return null;}
      return {type:'account_login',username,password:auth.password.value,session};
    }
    if(auth.password.value.length<10){el.hint.textContent='Пароль должен содержать минимум 10 символов';return null;}
    if(authMode==='register')return {type:'account_register',username,password:auth.password.value,name,token:localGet('vornixo_profile_v1')};
    if(!auth.recoveryCode.value.trim()){el.hint.textContent='Введите сохранённый код восстановления';return null;}
    return {type:'account_recover',username,password:auth.password.value,recoveryCode:auth.recoveryCode.value.trim()};
  }
  function start(){
    if(started)return;
    const payload=authPayload();if(!payload)return;
    el.btn.disabled=true;el.btn.textContent='ПОДКЛЮЧЕНИЕ…';el.hint.textContent='Соединяемся с игровым миром...';
    if(ws&&ws.readyState===WebSocket.OPEN){send(payload);return;}
    if(ws&&ws.readyState===WebSocket.CONNECTING)return;
    intentionalExit=false;
    ws=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/ws`);
    ws.addEventListener('open',()=>send(payload));
    ws.addEventListener('message',ev=>{let msg;try{msg=JSON.parse(ev.data);}catch{return;}
      if(msg.type==='welcome'){
        playerId=msg.id;started=true;connected=true;accountUsername=msg.username||null;
        if(msg.token)localSet('vornixo_profile_v1',msg.token);
        if(msg.session){localSet('vornixo_account_session',msg.session);localSet('vornixo_account_username',msg.username);localRemove('vornixo_profile_v1');}
        auth.password.value='';
        auth.status.textContent=accountUsername?'Аккаунт: '+accountUsername:'Гостевой профиль';
        auth.passwordSettings.classList.toggle('hidden',!accountUsername);
        el.saveState.textContent=msg.restored?'● Профиль восстановлен':'● Автосохранение включено';el.start.classList.add('hidden');el.ui.classList.remove('hidden');
        el.serverState.textContent='СЕРВЕР ONLINE';el.btn.disabled=false;el.btn.innerHTML='НАЧАТЬ ВЫЖИВАНИЕ <span>➜</span>';
        toast(msg.restored?'Прогресс загружен!':'Добро пожаловать в VORNIXO! Нажмите H для управления.');
        if(msg.recoveryCode){auth.newCode.textContent=msg.recoveryCode;auth.dialog.classList.remove('hidden');}
      }else if(msg.type==='auth_error'){
        el.hint.textContent=String(msg.text||'Ошибка входа');el.btn.disabled=false;el.btn.innerHTML='ПОПРОБОВАТЬ ЕЩЁ <span>➜</span>';
        toast(el.hint.textContent);
      }else if(msg.type==='account_session'){
        localSet('vornixo_account_session',msg.session);localSet('vornixo_account_username',msg.username);
        $('oldPassword').value='';$('newPassword').value='';
      }else if(msg.type==='state'){if(msg.resources===null)msg.resources=state?.resources||[];combatFeedback(state,msg);state=msg;if(!lastMsgId&&state.chat.length)lastMsgId=state.chat[0].id-1;updateChat();}
      else if(msg.type==='pong'){if(Number.isFinite(msg.sent)){const lag=Math.max(0,Math.round(performance.now()-msg.sent));el.ping.textContent='· '+lag+' мс';}}
      else if(msg.type==='toast')toast(msg.text);
      else if(msg.type==='team_chat')appendChat({name:'[ОТРЯД] '+msg.name,text:msg.text,private:true});
    });
    ws.addEventListener('close',()=>{
      el.ping.textContent='· — мс';toggleCraft(false);toggleTeam(false);toggleResearch(false);toggleSettings(false);closeExtras();
      connected=false;state=null;started=false;playerId=null;accountUsername=null;floaters.length=0;hitFlash.clear();motionUntil.clear();cameraKick=0;
      el.start.classList.remove('hidden');el.ui.classList.add('hidden');el.btn.disabled=false;
      setMode(localGet('vornixo_account_username')?'login':'guest');
      if(!intentionalExit)el.hint.textContent='Соединение закрыто. Проверьте сервер или данные для входа.';
      else el.hint.textContent='Вы вышли из игры.';
    });
    ws.addEventListener('error',()=>{el.hint.textContent='Не удалось подключиться. Убедитесь, что сервер работает.';el.btn.disabled=false;});
  }
  $('copyRecovery').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(auth.newCode.textContent);$('copyRecovery').textContent='СКОПИРОВАНО';}catch{toast('Выделите и скопируйте код вручную.');}});
  $('closeRecovery').addEventListener('click',()=>auth.dialog.classList.add('hidden'));
  $('logoutButton').addEventListener('click',()=>{if(!ws)return;intentionalExit=true;localRemove('vornixo_account_session');ws.close();});
  $('changePassword').addEventListener('click',()=>{
    const oldPassword=$('oldPassword').value,newPassword=$('newPassword').value;
    if(newPassword.length<10)return toast('Новый пароль должен быть от 10 символов');
    send({type:'account_password',oldPassword,newPassword});
  });
  el.pulse.addEventListener('click',()=>send({type:'act',action:'pulse'}));
  el.dash.addEventListener('click',()=>send({type:'act',action:'dash'}));
  el.btn.addEventListener('click',start);[el.name,auth.accountName,auth.password,auth.recoveryCode].forEach(input=>input.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();start();}}));
  function chatting(){return document.activeElement===el.chatInput;}
  function closeChat(){el.chatComposer.classList.add('hidden');el.chatPrompt.classList.remove('hidden');el.chatInput.blur();}
  function openChat(){if(!started)return;el.chatComposer.classList.remove('hidden');el.chatPrompt.classList.add('hidden');for(const k in keys)keys[k]=false;el.chatInput.focus();}
  function sendChat(){const text=el.chatInput.value.trim();if(text)send({type:el.chatTeam.checked&&state?.myTeam?'team_chat':'chat',text});el.chatInput.value='';closeChat();}
  el.chatSend.addEventListener('click',sendChat);
  el.chatInput.addEventListener('keydown',e=>{if(e.key==='Enter'){sendChat();e.preventDefault();}if(e.key==='Escape')closeChat();e.stopPropagation();});
  function updateChat(){
    if(!state)return;
    const msgs=state.chat.filter(x=>x.id>lastMsgId);if(!msgs.length)return;
    for(const item of msgs){lastMsgId=Math.max(lastMsgId,item.id);appendChat(item);}
  }
  function appendChat(item){
    const div=document.createElement('div');div.className='chat-message'+(item.private?' private':item.name==='СИСТЕМА'?' system':'');
    const bold=document.createElement('strong');bold.textContent=item.name+': ';
    div.append(bold,document.createTextNode(item.text));el.chat.append(div);
    while(el.chat.children.length>6)el.chat.firstChild.remove();
  }
  function closeExtras(){toggleBuild(false);toggleAchievements(false);toggleBaseStats(false);}
  function toggleBaseStats(show){if(show){toggleCraft(false);toggleTeam(false);toggleResearch(false);toggleSettings(false);toggleBuild(false);toggleAchievements(false);toggleHelp(false);}baseStatsOpen=!!show;el.baseStatsPanel.classList.toggle('hidden',!baseStatsOpen);}
  function toggleBuild(show){buildOpen=!!show;el.buildPanel.classList.toggle('hidden',!buildOpen);if(buildOpen){toggleCraft(false);toggleTeam(false);toggleResearch(false);toggleSettings(false);toggleAchievements(false);toggleBaseStats(false);toggleHelp(false);}}
  function toggleAchievements(show){achievementsOpen=!!show;el.achievementsPanel.classList.toggle('hidden',!achievementsOpen);if(achievementsOpen){toggleCraft(false);toggleTeam(false);toggleResearch(false);toggleSettings(false);toggleBuild(false);toggleBaseStats(false);toggleHelp(false);}}
  function toggleCraft(show){craftingOpen=!!show;el.craftPanel.classList.toggle('hidden',!craftingOpen);if(craftingOpen){closeExtras();toggleTeam(false);toggleResearch(false);toggleSettings(false);toggleHelp(false);}}
  function toggleTeam(show){teamOpen=!!show;el.teamPanel.classList.toggle('hidden',!teamOpen);if(teamOpen){closeExtras();toggleCraft(false);toggleResearch(false);toggleSettings(false);toggleHelp(false);}}
  function toggleResearch(show){researchOpen=!!show;el.researchPanel.classList.toggle('hidden',!researchOpen);if(researchOpen){closeExtras();toggleCraft(false);toggleTeam(false);toggleSettings(false);toggleHelp(false);}}
  function toggleSettings(show){settingsOpen=!!show;el.settingsPanel.classList.toggle('hidden',!settingsOpen);if(settingsOpen){closeExtras();toggleCraft(false);toggleTeam(false);toggleResearch(false);toggleHelp(false);}}
  $('baseStatsToggle').addEventListener('click',()=>toggleBaseStats(!baseStatsOpen));
  $('baseStatsClose').addEventListener('click',()=>toggleBaseStats(false));
  function toggleWeapon(){weaponMode=weaponMode==='bow'?'shotgun':'bow';select(6);toast(weaponMode==='shotgun'?'Дробовик активен · патроны в мастерской':'Арбалет активен');}
  el.weaponToggle.addEventListener('click',toggleWeapon);
  $('buildToggle').addEventListener('click',()=>toggleBuild(!buildOpen));$('buildClose').addEventListener('click',()=>toggleBuild(false));
  $('achievementsToggle').addEventListener('click',()=>toggleAchievements(!achievementsOpen));$('achievementsClose').addEventListener('click',()=>toggleAchievements(false));
  el.buildPanel.addEventListener('click',e=>{const b=e.target.closest('button[data-build-extra]');if(b){select(tools.findIndex(t=>t.id===b.dataset.buildExtra));toggleBuild(false);toast('Постройка выбрана. Нажмите ЛКМ на своей территории.');}});
  el.researchToggle.addEventListener('click',()=>toggleResearch(!researchOpen));$('researchClose').addEventListener('click',()=>toggleResearch(false));
  el.settingsToggle.addEventListener('click',()=>toggleSettings(!settingsOpen));$('settingsClose').addEventListener('click',()=>toggleSettings(false));
  for(const [key,id] of Object.entries({map:'settingMap',effects:'settingEffects',details:'settingDetails',smooth:'settingSmooth'})){
    const control=$(id);control.checked=settings[key];control.addEventListener('change',()=>{settings[key]=control.checked;saveSettings();if(key==='map'){showMap=settings.map;document.querySelector('.minimap-wrap').classList.toggle('hidden',!showMap);}});
  }
  document.querySelector('.minimap-wrap').classList.toggle('hidden',!showMap);
  document.querySelectorAll('[data-research]').forEach(b=>b.addEventListener('click',()=>send({type:'act',action:'research',tech:b.dataset.research})));
  el.craftToggle.addEventListener('click',()=>toggleCraft(!craftingOpen));$('craftClose').addEventListener('click',()=>toggleCraft(false));
  el.teamToggle.addEventListener('click',()=>toggleTeam(!teamOpen));$('teamClose').addEventListener('click',()=>toggleTeam(false));
  document.querySelectorAll('[data-craft]').forEach(b=>b.addEventListener('click',()=>send({type:'act',action:'craft',item:b.dataset.craft})));
  document.querySelectorAll('[data-use]').forEach(b=>b.addEventListener('click',()=>{const at=worldAtPointer();send({type:'act',action:'use',item:b.dataset.use,x:at.x,y:at.y});}));
  $('teamCreate').addEventListener('click',()=>send({type:'team',action:'create',name:$('teamName').value.trim()}));
  $('teamJoin').addEventListener('click',()=>send({type:'team',action:'join',code:$('teamCode').value.trim()}));
  $('teamLeave').addEventListener('click',()=>send({type:'team',action:'leave'}));
  el.teamMembers.addEventListener('click',e=>{const b=e.target.closest('button[data-trade]');if(b)send({type:'trade',target:Number(b.dataset.target),resource:b.dataset.trade,amount:25});});
  function toggleHelp(force){helpOpen=force??!helpOpen;el.help.classList.toggle('hidden',!helpOpen);}
  el.helpClose.addEventListener('click',()=>toggleHelp(false));
  function keyChange(e,isDown){
    if(chatting()||e.target?.isContentEditable||e.target?.matches?.('input, textarea, select'))return;
    if(!started)return;
    if(isDown&&!e.repeat){
      if(e.key==='Enter'){openChat();e.preventDefault();return;}
      if(e.key==='h'||e.key==='H'){toggleCraft(false);toggleTeam(false);toggleResearch(false);toggleSettings(false);closeExtras();toggleHelp();return;}
      if(e.key==='i'||e.key==='I'){toggleCraft(!craftingOpen);return;}
      if(e.key==='t'||e.key==='T'){toggleTeam(!teamOpen);return;}
      if(e.key==='k'||e.key==='K'){toggleResearch(!researchOpen);return;}
      if(e.key==='p'||e.key==='P'){toggleSettings(!settingsOpen);return;}
      if(e.key==='b'||e.key==='B'){toggleBuild(!buildOpen);return;}
      if(e.key==='o'||e.key==='O'){toggleAchievements(!achievementsOpen);return;}
      if(e.key==='j'||e.key==='J'){toggleBaseStats(!baseStatsOpen);return;}
      if(e.key==='v'||e.key==='V'){if(!baseStatsOpen&&!buildOpen&&!craftingOpen&&!teamOpen&&!researchOpen&&!settingsOpen&&!achievementsOpen&&!helpOpen)toggleWeapon();return;}
      if(e.key==='Escape'){if(helpOpen)toggleHelp(false);else if(achievementsOpen)toggleAchievements(false);else if(baseStatsOpen)toggleBaseStats(false);else if(buildOpen)toggleBuild(false);else if(settingsOpen)toggleSettings(false);else if(researchOpen)toggleResearch(false);else if(teamOpen)toggleTeam(false);else if(craftingOpen)toggleCraft(false);else select(0);return;}
      if(e.key==='m'||e.key==='M'){showMap=!showMap;settings.map=showMap;$('settingMap').checked=showMap;saveSettings();document.querySelector('.minimap-wrap').classList.toggle('hidden',!showMap);return;}
      if(helpOpen||craftingOpen||teamOpen||researchOpen||settingsOpen||buildOpen||achievementsOpen||baseStatsOpen)return;
      if('1234567890'.includes(e.key)){select(e.key==='0'?9:Number(e.key)-1);return;}
      const skillKeys={z:'power',x:'vitality',c:'speed'};
      if(skillKeys[e.key.toLowerCase()]){send({type:'act',action:'skill',skill:skillKeys[e.key.toLowerCase()]});return;}
      if(e.key===' '){autoAttack=!autoAttack;toast(`Автоатака: ${autoAttack?'включена':'выключена'}`);e.preventDefault();return;}
      if(e.key==='q'||e.key==='Q'){send({type:'act',action:'pulse'});return;}
      if(e.key==='Shift'){send({type:'act',action:'dash'});e.preventDefault();return;}
      if(e.key==='e'||e.key==='E')act('upgrade');
      if(e.key==='f'||e.key==='F')act('repair');
    }
    if(helpOpen||craftingOpen||teamOpen||researchOpen||settingsOpen||buildOpen||achievementsOpen||baseStatsOpen)return;
    const k=e.key.toLowerCase();const map={w:'up',arrowup:'up',s:'down',arrowdown:'down',a:'left',arrowleft:'left',d:'right',arrowright:'right'};
    if(map[k]){keys[map[k]]=isDown;e.preventDefault();}
  }
  addEventListener('keydown',e=>keyChange(e,true));addEventListener('keyup',e=>keyChange(e,false));
  addEventListener('blur',()=>{for(const k in keys)keys[k]=false;mouseDown=false;});
  function aimPos(){const p=me();if(!p)return 0;const world=worldAtPointer();return Math.atan2(world.y-p.y,world.x-p.x);}
  function act(action){const w=worldAtPointer();send({type:'act',action:action==='shoot'&&weaponMode==='shotgun'?'shotgun':action,x:w.x,y:w.y,build:tools[tool].id});
    if(action==='swing'||action==='shoot'){const p=me();if(p){sparks.push({x:p.x+Math.cos(aimPos())*43,y:p.y+Math.sin(aimPos())*43,life:.23,total:.23,type:'swing',angle:aimPos()});}}
  }
  canvas.addEventListener('mousemove',e=>{pointer.x=e.clientX;pointer.y=e.clientY;});
  canvas.addEventListener('mousedown',e=>{if(!started||helpOpen||researchOpen||settingsOpen||craftingOpen||teamOpen||buildOpen||achievementsOpen||baseStatsOpen||e.button!==0)return;pointer.x=e.clientX;pointer.y=e.clientY;mouseDown=true;
    if(tool===0||tool===6){act(tool===6?'shoot':'swing');lastSwingAt=performance.now();}else{act('build');}
  });
  addEventListener('mouseup',()=>{mouseDown=false;});
  canvas.addEventListener('contextmenu',e=>{e.preventDefault();select(0);mouseDown=false;});
  setInterval(()=>{if(ws&&ws.readyState===WebSocket.OPEN&&started)send({type:'ping',sent:performance.now()});},5000);
  setInterval(()=>{if(!connected)return;send({type:'input',...keys,aim:aimPos()});
    if((tool===0||tool===6)&&(mouseDown||autoAttack)&&performance.now()-lastSwingAt>(tool===6?(weaponMode==='shotgun'?1300:760):355)){act(tool===6?'shoot':'swing');lastSwingAt=performance.now();}
  },55);

  function circle(x,y,r,fill,stroke=null,width=1){ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);if(fill){ctx.fillStyle=fill;ctx.fill();}if(stroke){ctx.lineWidth=width;ctx.strokeStyle=stroke;ctx.stroke();}}
  function rounded(x,y,w,h,r,color){ctx.fillStyle=color;ctx.beginPath();ctx.roundRect(x,y,w,h,r);ctx.fill();}
  function polygon(points,color,outline=null){ctx.beginPath();points.forEach((v,i)=>i?ctx.lineTo(v[0],v[1]):ctx.moveTo(v[0],v[1]));ctx.closePath();ctx.fillStyle=color;ctx.fill();if(outline){ctx.strokeStyle=outline;ctx.lineWidth=2;ctx.stroke();}}
  function hpBar(x,y,width,percent,color='#84eaba'){rounded(x-width/2,y,width,4,2,'#0b231fb9');if(percent>0)rounded(x-width/2,y,width*clamp(percent,0,1),4,2,color);}
  function visible(x,y,pad=180){return x>cam.x-pad&&x<cam.x+sw+pad&&y>cam.y-pad&&y<cam.y+sh+pad;}
  function renderGround(time){
    ctx.fillStyle='#132a25';ctx.fillRect(cam.x,cam.y,sw,sh);
    const lowX=Math.floor(Math.max(0,cam.x)/54),highX=Math.ceil(Math.min(3200,cam.x+sw)/54);
    const lowY=Math.floor(Math.max(0,cam.y)/54),highY=Math.ceil(Math.min(2400,cam.y+sh)/54);
    for(let i=lowX;i<=highX;i++)for(let j=lowY;j<=highY;j++){
      const v=hash(i,j),biome=biomeAt(i*54+27,j*54+27);
      ctx.fillStyle=biome==='marsh'?(v>.50?'#213d3a':'#1b3532'):biome==='highlands'?(v>.50?'#414b42':'#343f39'):(v>.7?'#274d39':v>.37?'#244432':'#234231');ctx.fillRect(i*54,j*54,54,54);
      if(settings.details&&v>.73){ctx.strokeStyle=biome==='marsh'?'#679e9a55':biome==='highlands'?'#b2bda755':'#41885c55';ctx.lineWidth=1.5;const x=i*54+15+hash(i+1,j)*30,y=j*54+12+hash(i,j+1)*30;
        ctx.beginPath();ctx.moveTo(x,y+5);ctx.lineTo(x-3,y);ctx.moveTo(x,y+5);ctx.lineTo(x+3,y-3);ctx.stroke();}
      if(settings.details&&v<.08){circle(i*54+19,j*54+35,3,'#6ca16c63');circle(i*54+25,j*54+38,2,'#c5bb8974');}
    }
    ctx.strokeStyle='#b7dab20e';ctx.lineWidth=1;
    for(let x=Math.floor(cam.x/54)*54;x<cam.x+sw;x+=54){ctx.beginPath();ctx.moveTo(x,Math.max(0,cam.y));ctx.lineTo(x,Math.min(2400,cam.y+sh));ctx.stroke();}
    for(let y=Math.floor(cam.y/54)*54;y<cam.y+sh;y+=54){ctx.beginPath();ctx.moveTo(Math.max(0,cam.x),y);ctx.lineTo(Math.min(3200,cam.x+sw),y);ctx.stroke();}
    ctx.strokeStyle='#a0d9b661';ctx.lineWidth=6;ctx.strokeRect(0,0,3200,2400);
    for(const c of cores()){
      const ally=!!c.canManage,rad=610;
      circle(c.x,c.y,rad,ally?'#6fe4a108':'#f7797905',ally?'#86eeb029':'#ff747427',2);
      if(ally)circle(c.x,c.y,rad+Math.sin(time*.0009)*5,null,'#8ce6be21',1);
    }
  }
  function tree(r,t){const x=r.x,y=r.y;circle(x+8,y+10,31,'#071b13aa');circle(x,y+7,11,'#654d35');
    for(let i=0;i<5;i++){const a=i*2*Math.PI/5+.2;circle(x+Math.cos(a)*18,y+Math.sin(a)*16-7,20,i%2?'#347d4e':'#418b56','#215d3c',2);}
    circle(x,y-13,19,'#4eaa61','#286b45',2);circle(x-6,y-18,7,'#65b87455');circle(x+9,y-13,3,'#a4e5a044');
    if(r.hp<r.maxHp)hpBar(x,y-49,43,r.hp/r.maxHp,'#ccda7b');
  }
  function rock(r){const x=r.x,y=r.y;circle(x+7,y+9,27,'#051d1c55');polygon([[x-29,y-7],[x-10,y-27],[x+17,y-23],[x+31,y+4],[x+15,y+22],[x-13,y+23],[x-31,y+8]],'#647e79','#31574e');
    polygon([[x-28,y-7],[x-10,y-27],[x+17,y-23],[x+2,y-1],[x-10,y+9]],'#89a09a');polygon([[x+17,y-23],[x+31,y+4],[x+15,y+22],[x+2,y-1]],'#506e67');
    ctx.strokeStyle='#aec6b966';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(x-4,y-18);ctx.lineTo(x-10,y-5);ctx.lineTo(x-3,y+7);ctx.stroke();
    if(r.hp<r.maxHp)hpBar(x,y-35,43,r.hp/r.maxHp);
  }
  function crystal(r,t){const x=r.x,y=r.y;circle(x+5,y+5,30,'#0b292899');circle(x,y,26,'#86dbb921');polygon([[x-13,y+13],[x-19,y-15],[x-4,y-26],[x+12,y-5],[x+4,y+19]],'#71d9ca','#b1fff1');
    polygon([[x-4,y-26],[x+12,y-5],[x+4,y+19],[x-4,y+8]],'#288f9a');polygon([[x+5,y+12],[x+16,y-13],[x+25,y],[x+18,y+20]],'#43abb4');
    circle(x,y,25+Math.sin(t*.004+r.id)*2,null,'#97e5c33b',2);
    if(r.hp<r.maxHp)hpBar(x,y-38,43,r.hp/r.maxHp);
  }
  function drawBuilding(b,t,ghost=false){const {x,y,type,level}=b;const alpha=ghost?.5:1;ctx.save();ctx.globalAlpha=alpha;
    circle(x+5,y+10,type==='core'?45:33,'#071b14ac');
    if(type==='core'){
      circle(x,y,70+Math.sin(t*.003)*4,'#73f6d808','#89ffe217',2);
      polygon([[x-39,y-30],[x+39,y-30],[x+39,y+31],[x-39,y+31]],'#304a45','#9ab8a5');
      rounded(x-30,y-23,60,46,5,'#132b29');
      ctx.strokeStyle='#5fe2ba';ctx.lineWidth=3;ctx.strokeRect(x-22,y-16,44,31);
      ctx.shadowBlur=18;ctx.shadowColor='#70ffdb';polygon([[x,y-35],[x+24,y],[x,y+35],[x-24,y]],'#7ee7ce','#b4ffea');ctx.shadowBlur=0;
      polygon([[x,y-35],[x,y+35],[x-24,y]],'#38a7a3');polygon([[x,y-35],[x+24,y],[x,y+35]],'#8af9cd');
      circle(x,y,4,'#f5ffed');
    }else if(type==='wall'){
      rounded(x-24,y-25,48,51,6,'#445144');rounded(x-21,y-23,42,46,4,'#9a825d');
      rounded(x-21,y-23,42,7,3,'#cbb78a');rounded(x-21,y+12,42,7,3,'#5b634b');
      ctx.strokeStyle='#594f3e';ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(x-4,y-20);ctx.lineTo(x-4,y+21);ctx.moveTo(x-21,y+1);ctx.lineTo(x+21,y+1);ctx.stroke();
    }else if(type==='turret'){
      circle(x,y,30,'#304740','#95ac98',3);circle(x,y,23,'#637f74');
      ctx.save();ctx.translate(x,y);ctx.rotate((t*.00017+b.id)%(.35*Math.PI)-.25);
      rounded(0,-7,35,14,4,'#b6ac75');rounded(11,-4,22,8,2,'#293e3c');ctx.restore();
      circle(x,y,16,'#315b55','#8fd6af',3);circle(x,y,6,'#b0dec0');
      for(let i=0;i<4;i++){const a=i*Math.PI/2;circle(x+Math.cos(a)*23,y+Math.sin(a)*23,3,'#e5c577');}
    }else if(type==='mine'){
      rounded(x-26,y-25,52,52,7,'#4a5342');rounded(x-21,y-20,42,42,6,'#a07e48');
      rounded(x-14,y-13,28,26,5,'#2f4c43');ctx.shadowColor='#ffc45e';ctx.shadowBlur=12;
      polygon([[x,y-17],[x+13,y],[x,y+17],[x-13,y]],'#ffd56b','#fff1ad');ctx.shadowBlur=0;
      for(let i=0;i<4;i++)circle(x+Math.cos(i*Math.PI/2)*20,y+Math.sin(i*Math.PI/2)*20,3,'#e7d295');
    }else if(type==='medic'){
      rounded(x-26,y-25,52,50,9,'#276458');rounded(x-21,y-20,42,40,7,'#3b9c7f');
      rounded(x-6,y-15,12,30,2,'#e5fff2');rounded(x-15,y-6,30,12,2,'#e5fff2');
      circle(x,y,28,null,'#a9ffee',2);
    }else if(type==='frost'){
      circle(x,y,29,'#2a5460','#8fe8fb',3);circle(x,y,21,'#3c8da4','#b6f5ff',3);
      for(let i=0;i<6;i++){const a=i*Math.PI/3+t*.0003;ctx.strokeStyle='#dbffff';ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(x+Math.cos(a)*6,y+Math.sin(a)*6);ctx.lineTo(x+Math.cos(a)*20,y+Math.sin(a)*20);ctx.stroke();}
      circle(x,y,7,'#c9fbff');
    }else if(type==='tesla'){
      circle(x,y,30,'#284352','#88f0ff',3);circle(x,y,22,'#2b7080','#9affed',2);
      for(let i=0;i<4;i++){const a=i*Math.PI/2+t*.0004;
        polygon([[x+Math.cos(a)*6,y+Math.sin(a)*6],[x+Math.cos(a+.4)*21,y+Math.sin(a+.4)*21],[x+Math.cos(a-.18)*25,y+Math.sin(a-.18)*25]],'#b7faff');}
      circle(x,y,8,'#efffff','#a0f7ff',2);
    }else if(type==='flame'){
      circle(x,y,30,'#583e31','#df9c67',3);circle(x,y,23,'#723e31','#f9bc6b',2);
      for(let i=0;i<4;i++){const a=i*Math.PI/2;circle(x+Math.cos(a)*17,y+Math.sin(a)*17,5,'#cb7446');}
      polygon([[x-10,y-6],[x,y-27],[x+10,y-6],[x+3,y+16],[x-5,y+14]],'#ffab53','#ffe0a0');
      circle(x,y+4,7,'#fff2ba');
    }else if(type==='mortar'){
      circle(x,y,30,'#364347','#e0b67a',3);circle(x,y,23,'#556469','#c2a77a',2);
      ctx.save();ctx.translate(x,y);ctx.rotate(-.8);rounded(-7,-25,14,40,5,'#182d32');rounded(-10,-27,20,13,4,'#c7a66b');ctx.restore();
      circle(x,y+8,9,'#a0c8bf','#294144',2);
    }else if(type==='spike'){
      rounded(x-23,y-23,46,46,4,'#40554b');rounded(x-19,y-19,38,38,3,'#738d7b');
      for(let i=-1;i<=1;i++)for(let j=-1;j<=1;j++){const px=x+i*12,py=y+j*12;
        polygon([[px-7,py+6],[px,py-12],[px+7,py+6]],'#d6dbb1','#4d6e68');}
    }
    if(level>1){ctx.fillStyle='#e5c06f';ctx.font='bold 11px Segoe UI';ctx.textAlign='center';ctx.fillText('✦'.repeat(level-1),x,y-37);}
    if(type==='core'&&!ghost){
      ctx.fillStyle=b.canManage?'#b6ffe3':'#ffbfaa';ctx.font='bold 12px Segoe UI';ctx.textAlign='center';
      ctx.shadowBlur=5;ctx.shadowColor='#04221d';ctx.fillText((b.ownerName||'База').slice(0,18),x,y-74);ctx.shadowBlur=0;
    }
    if(!ghost&&hitFlash.get('b'+b.id)>t){circle(x,y,type==='core'?46:31,'#fff0cc24','#fff0cc80',3);}
    if(!ghost&&b.hp<b.maxHp)hpBar(x,y-(type==='core'?53:37),44,b.hp/b.maxHp);
    ctx.restore();
  }
  function player(p,t){const {x,y}=p;ctx.save();ctx.globalAlpha=p.alive?1:.3;
    const moving=settings.effects&&motionUntil.get('p'+p.id)>t;const step=moving?Math.sin(t*.018+p.id)*2.8:0;
    circle(x+5,y+9,24,'#0a2018aa');
    ctx.translate(0,step);
    ctx.save();ctx.translate(x,y);ctx.rotate(p.aim||0);
    rounded(-19,-14,36,30,12,p.id===playerId?'#547c6b':'#526b83');
    rounded(-14,-16,24,31,8,p.id===playerId?'#95cbaa':'#9cb6ce');
    rounded(12,-5,22,10,5,'#d3b482');rounded(25,-13,7,24,2,'#d6e0c3');
    circle(-7,-8,14,'#e9ca9d','#755b47',3);rounded(-17,-19,19,11,4,'#24483c');
    ctx.restore();
    if(hitFlash.get('p'+p.id)>t)circle(x,y,28,'#ff9a7b34','#ffddc2b9',3);
    if(p.id===playerId)circle(x,y,30,null,'#bcf2d74a',2);
    if(p.pulsing){circle(x,y,205,'#83e7ee15','#8dfcf5a6',5);circle(x,y,125,null,'#c8fff7c0',2);}
    if(p.hp<p.maxHp)hpBar(x,y-40,42,p.hp/p.maxHp,p.hp>35?'#8ae2ad':'#e59071');
    ctx.fillStyle='#e9fff1';ctx.font='700 11px Segoe UI';ctx.textAlign='center';ctx.shadowColor='#00130d';ctx.shadowBlur=5;ctx.fillText(p.name,x,y-49);ctx.shadowBlur=0;ctx.restore();
  }
  function enemy(e,t){const {x,y,big}=e;const boss=e.kind==='boss';const r=boss?38:e.kind==='tank'?31:big?25:e.kind==='runner'?15:e.kind==='spitter'?18:e.kind==='sapper'?23:e.kind==='shaman'?22:e.kind==='berserker'?25:19;
    circle(x+5,y+8,r+3,'#071e1588');ctx.save();ctx.translate(x,y);ctx.rotate(Math.sin(t*.005+e.id)*.08);
    circle(0,0,r,boss?'#8c4e67':e.kind==='berserker'?'#b03e4c':e.kind==='shaman'?'#665b9d':e.kind==='sapper'?'#cc7946':e.kind==='raider'?'#9b5547':e.kind==='spitter'?'#9b9b3c':e.kind==='tank'?'#66717d':e.kind==='runner'?'#69a98d':big?'#637745':'#4a8060',boss?'#f9a6b1':'#213f31',boss?5:3);circle(-6,-3,5,'#c3e9a0');circle(6,-3,5,'#c3e9a0');
    circle(-5,-3,2,'#251d1b');circle(7,-3,2,'#251d1b');
    ctx.strokeStyle='#21362d';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(-4,8);ctx.lineTo(5,8);ctx.stroke();
    if(e.kind==='berserker'){circle(0,11,10,'#9e3d4a','#ed7f70',2);circle(0,11,4,'#ffcc93');}
    if(e.kind==='shaman'){circle(0,12,9,'#8d7dda','#c5baf0',2);circle(0,12,4,'#f3ffdc');}
    if(e.kind==='sapper'){circle(0,11,9,'#8b4335','#e3a968',2);circle(0,11,4,'#f8cf8c');}
    if(e.kind==='spitter'){circle(0,11,6,'#eaf392','#94a832',2);circle(0,11,2,'#fffce1');}
    if(e.kind==='tank'){circle(-r*.45,-r*.45,11,'#a5b5b4','#343d43',3);circle(r*.5,-r*.55,10,'#a5b5b4','#343d43',3);}
    if(big){circle(-r*.6,-r*.5,7,boss?'#ce7787':'#789552');circle(r*.6,-r*.5,6,boss?'#ce7787':'#789552');}
    if(boss){ctx.fillStyle='#fff0e4';ctx.textAlign='center';ctx.font='bold 12px Segoe UI';ctx.fillText('БОСС',0,-r-21);}
    if(e.slowed)circle(0,0,r+6,null,'#92e9ffb9',3);
    if(e.burning)circle(0,0,r+7,null,'#ffad59b9',2);
    if(hitFlash.get('e'+e.id)>t)circle(0,0,r+3,'#fff1d426','#fff2d5a8',3);
    ctx.restore();if(e.hp<e.maxHp)hpBar(x,y-r-17,46,e.hp/e.maxHp,'#e9a57a');
  }
  function drawGhost(t){const p=me();if(!p||tool===0||tool===6||helpOpen)return;const pt=worldAtPointer();const x=Math.round(pt.x/54)*54,y=Math.round(pt.y/54)*54;
    const r=tools[tool];let can=dist(p,{x,y})<275;
    if(r.id==='core'){
      if(cores().length>=(state.maxBases||5)||cores().some(c=>dist(c,{x,y})<1260))can=false;
      if(cores().some(c=>c.canManage&&((p.teamId&&c.teamId===p.teamId)||(!p.teamId&&!c.teamId))))can=false;
    }else{
      const nearest=cores().slice().sort((a,b)=>dist(a,{x,y})-dist(b,{x,y}))[0];
      if(!nearest||!nearest.canManage||dist(nearest,{x,y})>610)can=false;
    }
    if(state.buildings.some(b=>dist(b,{x,y})<55)||state.resources.some(n=>dist(n,{x,y})<52))can=false;
    circle(x,y,38,can?'#79ffd22b':'#ff797928',can?'#6df3b0':'#e06e6e',2);drawBuilding({x,y,type:r.id,level:1,hp:1,maxHp:1,id:0},t,true);
    ctx.fillStyle=can?'#b4f8d3':'#ff9999';ctx.font='bold 12px Segoe UI';ctx.textAlign='center';ctx.fillText(can?'ЛКМ · Построить':'Нельзя строить',x,y-55);
  }
  function drawNight(t){if((state?.baseStatus?.phase||state?.phase)!=='night')return;
    ctx.save();ctx.setTransform(dpr,0,0,dpr,0,0);ctx.fillStyle='rgba(7,12,34,.35)';ctx.fillRect(0,0,sw,sh);
    const c=core();if(c){const x=c.x-cam.x,y=c.y-cam.y;const grad=ctx.createRadialGradient(x,y,0,x,y,275);
      grad.addColorStop(0,'#58d9ad2d');grad.addColorStop(1,'#58d9ad00');ctx.fillStyle=grad;ctx.fillRect(x-275,y-275,550,550);}
    ctx.restore();
  }
  function renderParticles(dt){
    for(let i=sparks.length-1;i>=0;i--){const s=sparks[i];s.life-=dt;if(s.life<=0){sparks.splice(i,1);continue;}
      if(s.type==='swing'){ctx.save();ctx.strokeStyle=`rgba(237,248,193,${s.life/s.total})`;ctx.lineWidth=5;ctx.beginPath();ctx.arc(s.x,s.y,27,s.angle-.8,s.angle+.7);ctx.stroke();ctx.restore();}
    }
    ctx.save();ctx.font='bold 16px Segoe UI';ctx.textAlign='center';ctx.lineWidth=3;ctx.strokeStyle='#0b1c18';
    for(let i=floaters.length-1;i>=0;i--){const f=floaters[i];f.life-=dt;
      if(f.life<=0){floaters.splice(i,1);continue;}
      const progress=1-f.life/f.total,y=f.y-progress*38;
      ctx.globalAlpha=Math.min(1,f.life/.25);ctx.strokeText(f.value,f.x,y);ctx.fillStyle=f.color;ctx.fillText(f.value,f.x,y);
    }
    ctx.restore();
  }
  function drawCrosshair(){if(!started||helpOpen)return;ctx.save();ctx.setTransform(dpr,0,0,dpr,0,0);ctx.strokeStyle=tool===0?'#e6ffdd':'#f4e1a2';ctx.lineWidth=1.6;ctx.beginPath();ctx.arc(pointer.x,pointer.y,9,0,6.29);ctx.moveTo(pointer.x-15,pointer.y);ctx.lineTo(pointer.x-5,pointer.y);ctx.moveTo(pointer.x+5,pointer.y);ctx.lineTo(pointer.x+15,pointer.y);ctx.moveTo(pointer.x,pointer.y-15);ctx.lineTo(pointer.x,pointer.y-5);ctx.moveTo(pointer.x,pointer.y+5);ctx.lineTo(pointer.x,pointer.y+15);ctx.stroke();ctx.restore();}
  function draw(t){const dt=Math.min(.06,(t-lastFrame)/1000);lastFrame=t;
    ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,sw,sh);
    const p=me();if(p){targetCam.x=p.x-sw/2;targetCam.y=p.y-sh/2;
      cam.x+= (targetCam.x-cam.x)*(settings.smooth?Math.min(1,dt*9):1);cam.y+=(targetCam.y-cam.y)*(settings.smooth?Math.min(1,dt*9):1);
      cam.x=clamp(cam.x,0,Math.max(0,3200-sw));cam.y=clamp(cam.y,0,Math.max(0,2400-sh));}
    ctx.save();if(settings.effects&&cameraKick>.01){ctx.translate(Math.sin(t*.13)*cameraKick,Math.cos(t*.11)*cameraKick*.6);cameraKick=Math.max(0,cameraKick-dt*35);}
    ctx.translate(-cam.x,-cam.y);renderGround(t);
    if(state){
      for(const r of state.resources){if(!visible(r.x,r.y))continue;if(r.type==='tree')tree(r,t);else if(r.type==='rock')rock(r);else crystal(r,t);}
      const things=[...state.buildings.map(x=>({...x,kind:'b'})),...state.enemies.map(x=>({...x,kind:'e'})),...state.players.map(x=>({...x,kind:'p'}))].sort((a,b)=>a.y-b.y);
      for(const x of things){if(!visible(x.x,x.y))continue;if(x.kind==='b')drawBuilding(x,t);else if(x.kind==='e')enemy(x,t);else player(x,t);}
      for(const b of state.bullets){ctx.strokeStyle=b.kind==='dash'?'#9fffe6':b.kind==='heal'?'#c9acff':b.kind==='flame'?'#ff7b46':b.kind==='flare'?'#ffb85b':b.kind==='acid'?'#c4f16a':b.kind==='tesla'?'#8bf9ff':b.kind==='mortar'?'#ffb777':b.kind==='shotgun'?'#ffe2aa':b.kind==='arrow'?'#b2f8ff':'#ffd985';ctx.lineWidth=b.kind==='flame'?6:b.kind==='shotgun'?5:b.kind==='mortar'?7:b.kind==='tesla'?4:3;ctx.shadowColor=b.kind==='acid'?'#b3eb62':'#ffe49b';ctx.shadowBlur=12;ctx.beginPath();ctx.moveTo(b.x,b.y);ctx.lineTo(b.tx,b.ty);ctx.stroke();ctx.shadowBlur=0;}
      drawGhost(t);if(settings.effects)renderParticles(dt);else{sparks.length=0;floaters.length=0;cameraKick=0;hitFlash.clear();motionUntil.clear();}
    }
    ctx.restore();drawNight(t);drawCrosshair();
    if(t-lastUI>110){updateUI();lastUI=t;}
    requestAnimationFrame(draw);
  }
  function updateUI(){const p=me();if(!p||!state)return;
    const inv=p.inventory||{};
    const hpRatio=p.maxHp>0?p.hp/p.maxHp:1;document.getElementById('vignette').classList.toggle('critical-health',p.alive&&hpRatio<.3);
    $('qtyMedkit').textContent=inv.medkit||0;$('qtyRepairkit').textContent=inv.repairkit||0;$('qtyBolts').textContent=inv.bolts||0;$('qtyFlare').textContent=inv.flare||0;$('qtyShells').textContent=inv.shells||0;
    el.weaponToggle.textContent=weaponMode==='shotgun'?`🔫 ДРОБОВИК · ${inv.shells||0} < V >`:'🏹 АРБАЛЕТ · V';
    for(const b of el.craftPanel.querySelectorAll('[data-craft]')){
      const r={medkit:{wood:15,stone:10,gold:5},repairkit:{wood:25,stone:15,gold:0},bolts:{wood:8,stone:6,gold:0},flare:{wood:12,stone:8,gold:8},shells:{wood:10,stone:14,gold:7}}[b.dataset.craft];
      b.disabled=!p.alive||p.wood<r.wood||p.stone<r.stone||p.gold<r.gold;
    }
    for(const b of el.craftPanel.querySelectorAll('[data-use]'))b.disabled=!p.alive||!inv[b.dataset.use];
    const stats=state.baseStats;
    if(baseStatsOpen){
      const labels=stats?[['Имя базы',stats.ownerName],['Уровень маяка',stats.level+' / 3'],['Прочность маяка',stats.coreHp+' / '+stats.coreMaxHp],['Постройки',stats.buildings+' / 65'],['Отбитые волны',stats.wavesCleared],['Уничтожено зомби',stats.zombiesDefeated],['Потеряно сооружений',stats.buildingsLost],['Получено урона',stats.damageTaken]]:[];
      $('baseStatsContent').replaceChildren(...labels.map(([label,value])=>{const row=document.createElement('div');row.className='stat-row';const key=document.createElement('span');key.textContent=label;const val=document.createElement('strong');val.textContent=String(value);row.append(key,val);return row;}));
      $('baseStatsEmpty').classList.toggle('hidden',!!stats);
    }
    const team=state.myTeam;
    el.teamNoGroup.classList.toggle('hidden',!!team);el.teamHasGroup.classList.toggle('hidden',!team);
    el.chatTeam.disabled=!team;if(!team)el.chatTeam.checked=false;
    if(team){
      el.teamTitle.textContent=team.name;el.teamInvite.textContent=team.code;
      const teammates=state.players.filter(q=>q.teamId===team.id&&q.id!==p.id);
      el.teamMembers.replaceChildren(...team.members.map(m=>{
        const line=document.createElement('div');line.className='team-member';const name=document.createElement('strong');name.textContent=m.name+' '+(m.online?'●':'○');line.append(name);
        const online=teammates.find(q=>q.name===m.name);if(online){
          const actions=document.createElement('div');actions.className='trade-buttons';
          for(const [resource,label] of [['wood','🪵'],['stone','🪨'],['gold','✦']]){
            const b=document.createElement('button');b.textContent=label+' 25';b.dataset.trade=resource;b.dataset.target=online.id;
            b.disabled=p[resource]<25||dist(p,online)>275;actions.append(b);
          }line.append(actions);
        }return line;
      }));
    }
    const tech=state.technologies||{armor:0,power:0,harvest:0},owned=core();
    $('researchNotice').textContent=owned?`Ваш маяк: уровень ${owned.level}. Личные ресурсы тратятся на улучшения общей базы.`:'Для исследований постройте собственный маяк.';
    for(const key of ['armor','power','harvest']){
      const level=tech[key]||0,cost={wood:35+level*25,stone:30+level*25,gold:20+level*25};
      const name={armor:'techArmor',power:'techPower',harvest:'techHarvest'}[key];$(name).textContent=`${level}/3`;
      const btn=el.researchPanel.querySelector(`[data-research="${key}"]`);
      btn.textContent=level>=3?'ИЗУЧЕНО':`Изучить · ${cost.wood} 🪵 / ${cost.stone} 🪨 / ${cost.gold} ✦`;
      btn.disabled=!owned||!p.alive||level>=3||owned.level<level+1||p.wood<cost.wood||p.stone<cost.stone||p.gold<cost.gold;
    }
    const a=state.myAchievements||{earned:[],stats:{},kills:0};
    const definitions=[
      ['gatherer','🪓','Первый запас','Добудьте ресурсы 20 ударами','harvested',20,50],
      ['engineer','🏰','Архитектор','Постройте 8 сооружений','built',8,90],
      ['hunter','⚔️','Охотник','Уничтожьте 10 зомби','kills',10,75],
      ['artisan','🛠️','Мастерская','Выполните 5 операций крафта','crafted',5,65],
      ['defender','🏆','Ветеран обороны','Отбейте третью волну','bestWave',3,120]
    ];
    if(achievementsOpen){el.achievementList.replaceChildren(...definitions.map(([key,icon,title,description,field,goal,reward])=>{
      const done=a.earned.includes(key),value=field==='kills'?a.kills:(a.stats[field]||0);
      const item=document.createElement('div');item.className='achievement-row'+(done?' earned':'');
      const heading=document.createElement('strong');heading.textContent=icon+' '+title+(done?' · ВЫПОЛНЕНО':'');
      const info=document.createElement('small');info.textContent=description+` · ${Math.min(value,goal)}/${goal} · награда ${reward} ✦`;
      const track=document.createElement('div');track.className='achievement-track';
      const fill=document.createElement('div');fill.style.width=Math.min(100,value/goal*100)+'%';track.append(fill);
      item.append(heading,info,track);return item;
    }));}
    $('achievementCount').textContent=`${a.earned.length} / ${definitions.length} получено`;
    $('biomeInfo').textContent=({forest:'🌲 ЛЕС · +3 древесины с дерева',marsh:'🧪 БОЛОТО · +2 золота с кристаллов',highlands:'⛰ ГОРЫ · +4 камня с руды'})[state.biome]||'🌲 ЛЕС';
    el.wood.textContent=p.wood.toLocaleString('ru');el.stone.textContent=p.stone.toLocaleString('ru');el.gold.textContent=p.gold.toLocaleString('ru');
    el.hp.textContent=`${Math.max(0,p.hp)} / ${p.maxHp}`;el.hpBar.style.width=clamp(p.hp/p.maxHp*100,0,100)+'%';
    const skillLabels={power:['Z','Урон'],vitality:['X','HP'],speed:['C','Бег']};
    for(const button of el.skills.querySelectorAll('[data-skill]')){
      const sk=button.dataset.skill,lvl=p.skills?.[sk]||0;
      button.querySelector('.skill-name').textContent=`${skillLabels[sk][0]} · ${skillLabels[sk][1]} · ${lvl}/3`;
      button.querySelector('.skill-cost').textContent=lvl>=3?'МАКС':`${({power:30,vitality:35,speed:40})[sk]+lvl*25} ✦`;
      button.disabled=lvl>=3||p.gold<({power:30,vitality:35,speed:40})[sk]+lvl*25;
    }
    el.records.replaceChildren(...(state.records||[]).slice(0,3).map((r,i)=>{const x=document.createElement('div');x.className='record-line';x.textContent=`${i+1}. ${r.name} · ${Number(r.score).toLocaleString('ru')}`;return x;}));
    el.pulseTimer.textContent=p.pulseCooldown?`${p.pulseCooldown} с`:'10 ✦';
    el.pulse.disabled=!!p.pulseCooldown||p.gold<10||!p.alive;
    el.dashTimer.textContent=p.dashCooldown?`${p.dashCooldown} с`:'ГОТОВ';
    el.dash.disabled=!!p.dashCooldown||!p.alive;
    el.info.textContent=`${p.name} · ${p.kills} убийств · ${p.score} очков`;el.online.textContent=`· ${state.players.length}/16 · баз ${state.baseCount||0}/${state.maxBases||5}`;
    const c=core();let total=42;const timing=state.baseStatus||{phase:'waiting',wave:0,remaining:0,enemies:0};
    if(timing.paused){el.waveTitle.textContent='⏸ БАЗА НА ПАУЗЕ';el.waveClock.textContent='—';el.waveDesc.textContent='Нет защитников в сети';}
    else if(timing.phase==='waiting'){el.waveTitle.textContent='ОЖИДАНИЕ';el.waveClock.textContent='—';el.waveDesc.textContent='Постройте маяк для старта';}
    else if(timing.phase==='day'){el.waveTitle.textContent='☀ ДЕНЬ · ПОДГОТОВКА';el.waveClock.textContent=String(timing.remaining).padStart(2,'0')+' с';el.waveDesc.textContent=`Следующая волна: ${timing.wave+1}`;total=43;}
    else {el.waveTitle.textContent=`☾ НОЧЬ · ВОЛНА ${timing.wave}`;el.waveClock.textContent=String(timing.remaining).padStart(2,'0')+' с';el.waveDesc.textContent=`Зомби на карте: ${timing.enemies}`;total=42;}
    el.timeBar.style.width=clamp(timing.phase==='waiting'?100:timing.remaining/total*100,0,100)+'%';
    el.timeBar.style.background=timing.paused?'#8aa6a0':timing.phase==='night'?'#f2ad74':'#79ebbe';
    if(!c){el.missionTitle.textContent='Основать собственную базу';el.missionDesc.textContent='Нажмите 2 и разместите маяк в свободной зоне — не ближе 1260 единиц к чужим базам. Ночью зомби атакуют каждый маяк.';}
    else if(!state.buildings.some(b=>b.type==='turret'&&b.baseId===c.id)){el.missionTitle.textContent='Постройте турель';el.missionDesc.textContent='Соберите древесину и камень, затем нажмите 4. Турель будет защищать маяк автоматически.';}
    else if(!state.buildings.some(b=>b.type==='mine'&&b.baseId===c.id)){el.missionTitle.textContent='Создайте генератор';el.missionDesc.textContent='Нажмите 5, чтобы построить генератор золота. Оно пригодится для улучшений.';}
    else{el.missionTitle.textContent=timing.phase==='night'?'Защитите Маяк!':'Укрепите оборону';el.missionDesc.textContent=timing.phase==='night'?'Уничтожайте зомби и чините повреждённые стены (F).':'Стройте стены и ловушки. Наведите мышь на постройку и нажмите E для улучшения.';}
    if(timing.phase==='night'&&state.enemies.some(e=>e.kind==='boss'&&e.baseId===timing.id)){el.waveDesc.textContent='⚠ БОСС В МИРЕ · Защитите маяк!';}
    if(timing.phase==='night'&&!timing.paused)document.querySelector('.wave-panel').style.borderColor='#ffb37c66';else document.querySelector('.wave-panel').style.borderColor='var(--line)';
    // One glance at the sector monitor shows each settlement's independent wave.
    el.baseList.replaceChildren(...(state.bases||[]).map(b=>{
      const row=document.createElement('div');row.className='base-row'+(b.id===timing.id?' active':'');
      const label=document.createElement('span');label.textContent=(b.canManage?'◆ ':'◇ ')+(b.ownerName||'База').slice(0,14);
      const status=document.createElement('b');status.textContent=b.paused?'⏸ Пауза':b.phase==='night'?`☾ ${b.wave} · ${b.enemies} зомби`:`☀ ${b.remaining} с`;
      row.append(label,status);return row;
    }));
    el.score.replaceChildren(...state.players.slice().sort((a,b)=>b.score-a.score).slice(0,5).map((p,i)=>{
      const row=document.createElement('div');row.className='rank-row';const rank=document.createElement('span'),name=document.createElement('span'),score=document.createElement('span');
      rank.className='rank-num';rank.textContent=String(i+1).padStart(2,'0');name.className='rank-name';name.textContent=p.name;score.className='rank-score';score.textContent=p.score.toLocaleString('ru');row.append(rank,name,score);return row;
    }));
    if(showMap)drawMinimap();
  }
  function drawMinimap(){if(!state)return;const w=mini.width,h=mini.height;mc.clearRect(0,0,w,h);mc.fillStyle='#17352b';mc.fillRect(0,0,w,h);
    for(let i=0;i<24;i++)for(let j=0;j<18;j++){const noise=hash(i*3,j*3),biome=biomeAt((i+.5)*3200/24,(j+.5)*2400/18);mc.fillStyle=biome==='marsh'?'#315b59':biome==='highlands'?'#626b61':noise>.5?'#234934':'#1c3d30';mc.fillRect(i*w/24,j*h/18,w/24+1,h/18+1);}
    const sx=x=>x/3200*w,sy=y=>y/2400*h;
    for(const r of state.resources){mc.fillStyle=r.type==='tree'?'#589668':r.type==='rock'?'#899891':'#66c9cf';mc.fillRect(sx(r.x),sy(r.y),1.8,1.8);}
    for(const c of cores()){
      const attack=state.bases?.find(b=>b.id===c.id)?.phase==='night';
      mc.strokeStyle=attack?'#ff9b70b3':c.canManage?'#77e4ae80':'#fb8a6d70';mc.beginPath();mc.arc(sx(c.x),sy(c.y),610/3200*w,0,Math.PI*2);mc.stroke();
    }
    for(const b of state.buildings){mc.fillStyle=b.type==='core'?(b.canManage?'#d6f9b8':'#ff9988'):'#dcbd78';mc.fillRect(sx(b.x)-1,sy(b.y)-1,3,3);}
    for(const z of state.enemies){mc.fillStyle=z.kind==='boss'?'#ffdf8b':'#fb7f73';const r=z.kind==='boss'?3:1;mc.fillRect(sx(z.x)-r,sy(z.y)-r,r*2+1,r*2+1);}
    for(const p of state.players){mc.fillStyle=p.id===playerId?'#fffec2':'#8df7df';mc.beginPath();mc.arc(sx(p.x),sy(p.y),p.id===playerId?3.3:2.2,0,Math.PI*2);mc.fill();}
    mc.strokeStyle='#8edfb15c';mc.strokeRect(sx(cam.x),sy(cam.y),sw/3200*w,sh/2400*h);
  }
  select(0);requestAnimationFrame(draw);
})();
