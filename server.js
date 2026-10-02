'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const chars = require('./roster');

const PORT = Number(process.env.PORT || 8080);
const TURN_SECONDS = 12;
const ROOM_TTL_MS = 30 * 60 * 1000;
const rooms = new Map();
const sessions = new Map();
const bySocket = new WeakMap();
const sockets = new Set();
const charMap = new Map(chars.map(c => [c.id, c]));

const MIME = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.webmanifest':'application/manifest+json; charset=utf-8','.svg':'image/svg+xml'};
const publicDir = path.join(__dirname, 'public');

function cleanName(v){
  const x = String(v || 'Jogador').replace(/[^\p{L}\p{N}_ -]/gu,'').trim().slice(0,18);
  return x || 'Jogador';
}
function roomCode(){
  const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let x=''; do { x=''; for(let i=0;i<6;i++) x+=alphabet[crypto.randomInt(alphabet.length)]; } while(rooms.has(x));
  return x;
}
function token(){ return crypto.randomBytes(24).toString('base64url'); }
function playerId(){ return crypto.randomBytes(8).toString('hex'); }
function wsSend(ws,msg){
  if(!ws || ws.destroyed) return;
  const payload=Buffer.from(JSON.stringify(msg));
  let head;
  if(payload.length<126) head=Buffer.from([0x81,payload.length]);
  else if(payload.length<65536){ head=Buffer.alloc(4);head[0]=0x81;head[1]=126;head.writeUInt16BE(payload.length,2); }
  else { head=Buffer.alloc(10);head[0]=0x81;head[1]=127;head.writeBigUInt64BE(BigInt(payload.length),2); }
  ws.write(Buffer.concat([head,payload]));
}
function send(ws,msg){ if(ws && !ws.destroyed && ws._isWebSocket) wsSend(ws,msg); }

function broadcast(room,msg){ for(const p of room.players) send(p.ws,msg); }
function characterFor(id){ return charMap.get(id) || chars.find(c=>c.rarity==='comum') || chars[0]; }
function publicPlayer(p, selfToken){
  const c=characterFor(p.character);
  return {id:p.id,nickname:p.nickname,character:p.character,characterName:c.name,hp:p.hp,maxHp:p.maxHp,cooldowns:p.cooldowns,skills:c.skills.map((s,i)=>({name:s[0],damage:Number(s[1])||0,cooldown:Number(s[2])||1,crit:s[3]||0,description:'Ataque '+s[0]+'.',index:i})),actionSubmitted:!!p.action,connected:!!p.ws, selfToken:p.token===selfToken};
}
function lobbyPayload(room,p){
  return {type:'lobby',room:room.code,mode:room.mode,maxPlayers:2,host:p.id===room.hostId,players:room.players.map(x=>({id:x.id,nickname:x.nickname,character:x.character,characterName:characterFor(x.character).name,connected:!!x.ws})),selfId:p.id};
}
function battlePayload(room,p){
  return {type:'battle',room:room.code,mode:room.mode,phase:room.phase,turn:room.turn,timeLeft:Math.max(0,Math.ceil((room.turnDeadline-Date.now())/1000)),turnResolved:!!p.action,players:room.players.map(x=>publicPlayer(x,p.token)),selfToken:p.token};
}
function broadcastLobby(room){ room.players.forEach(p=>send(p.ws,lobbyPayload(room,p))); }
function broadcastBattle(room){ room.players.forEach(p=>send(p.ws,battlePayload(room,p))); }
function error(ws,message){ send(ws,{type:'error',message}); }
function event(room,message){ broadcast(room,{type:'event',message}); }

function makePlayer(ws,msg){
  const c=characterFor(msg.character);
  return {id:playerId(),token:token(),ws,nickname:cleanName(msg.nickname),character:c.id,hp:c.hp,maxHp:c.hp,cooldowns:c.skills.map(()=>0),action:null,connectedAt:Date.now()};
}
function resetCombat(room){
  room.players.forEach(p=>{ const c=characterFor(p.character); p.hp=c.hp;p.maxHp=c.hp;p.cooldowns=c.skills.map(()=>0);p.action=null; });
  room.turn=1;room.phase='turn';room.turnDeadline=Date.now()+TURN_SECONDS*1000; clearTimeout(room.timer);room.timer=setTimeout(()=>resolveTurn(room),TURN_SECONDS*1000+80);
}
function startRoom(room,requester){
  if(requester.id!==room.hostId) return error(requester.ws,'Somente o líder pode iniciar.');
  if(room.players.length!==2) return error(requester.ws,'A partida 1v1 precisa de 2 jogadores.');
  if(room.phase!=='lobby') return;
  room.phase='turn';resetCombat(room);event(room,'⚔️ Partida iniciada! As ações são escolhidas simultaneamente.');broadcastBattle(room);
}
function validateAction(p,msg){
  if(!p||!p.ws||p.action) return false;
  if(msg.action==='skip') return {kind:'skip'};
  if(msg.action!=='skill') return false;
  const i=Number(msg.skill); const c=characterFor(p.character);
  if(!Number.isInteger(i)||i<0||i>=c.skills.length) return false;
  if((p.cooldowns[i]||0)>0) return false;
  // Precision is intentionally bounded. The server owns all actual damage values.
  const precision = msg.quality===2 ? 2 : 1;
  return {kind:'skill',skill:i,precision};
}
function resolveTurn(room){
  if(!room || room.phase!=='turn') return;
  clearTimeout(room.timer);
  for(const p of room.players){ if(!p.action) p.action={kind:'skip',timeout:true}; }
  const a=room.players[0], b=room.players[1];
  const events=[];
  for(const p of room.players) p.cooldowns=p.cooldowns.map(v=>Math.max(0,v-1));

  // Resolve both choices from the same pre-damage snapshot. A player can therefore
  // finish a simultaneous attack even if the other player's attack would kill them.
  const pending=[];
  for(const attacker of [a,b]){
    const defender=attacker===a?b:a, act=attacker.action;
    if(!act || act.kind!=='skill' || attacker.hp<=0) continue;
    const c=characterFor(attacker.character), sk=c.skills[act.skill];
    if(!sk || (attacker.cooldowns[act.skill]||0)>0) continue;
    let damage=Number(sk[1])||0;
    if(act.precision===2) damage=Math.round(damage*2);
    pending.push({attacker,defender,skill:sk,damage,critical:act.precision===2});
  }
  for(const hit of pending){
    hit.defender.hp=Math.max(0,hit.defender.hp-hit.damage);
    events.push({attacker:hit.attacker.id,defender:hit.defender.id,skill:hit.skill[0],damage:hit.damage,critical:hit.critical});
  }
  // Set cooldowns after all damage is applied, preserving simultaneous resolution.
  for(const hit of pending){
    const idx=hit.attacker.action.skill;
    hit.attacker.cooldowns[idx]=Math.max(1,Number(hit.skill[2])||1);
  }
  const dead=room.players.filter(p=>p.hp<=0);
  if(dead.length){
    const winner=room.players.find(p=>p.hp>0);
    room.phase='ended';room.winnerId=winner?.id||null;room.endReason=winner?'HP chegou a zero.':'Ambos chegaram a zero.';
    room.players.forEach(p=>send(p.ws,{type:'ended',room:room.code,mode:room.mode,phase:'ended',turn:room.turn,players:room.players.map(x=>publicPlayer(x,p.token)),selfToken:p.token,winnerToken:winner?.token||null,endReason:room.endReason,events}));
    return;
  }
  room.turn++;
  room.players.forEach(p=>p.action=null);
  room.turnDeadline=Date.now()+TURN_SECONDS*1000;
  room.timer=setTimeout(()=>resolveTurn(room),TURN_SECONDS*1000+80);
  room.lastEvents=events;
  broadcastBattle(room);
}
function leaveRoom(p){
  const room=p.room;if(!room)return;
  p.ws=null;p.room=null;
  if(room.phase==='lobby'){
    room.players=room.players.filter(x=>x!==p);
    if(room.hostId===p.id) room.hostId=room.players[0]?.id||null;
    if(room.players.length===0){clearTimeout(room.timer);rooms.delete(room.code);return;}
    broadcastLobby(room);return;
  }
  // During a match, give the opponent the win rather than leaving a ghost game.
  if(room.phase==='turn'){
    room.phase='ended';clearTimeout(room.timer);const winner=room.players.find(x=>x.id!==p.id&&x.ws);room.winnerId=winner?.id||null;room.endReason='O oponente saiu da partida.';
    room.players.forEach(x=>send(x.ws,{type:'ended',room:room.code,mode:room.mode,phase:'ended',turn:room.turn,players:room.players.map(y=>publicPlayer(y,x.token)),selfToken:x.token,winnerToken:winner?.token||null,endReason:room.endReason}));
  }
}
function handle(ws,msg){
  if(!msg || typeof msg!=='object') return;
  if(msg.type==='create'){
    if(bySocket.has(ws)) return error(ws,'Você já está conectado a uma sessão.');
    if(msg.mode && msg.mode!=='1v1') return error(ws,'Nesta versão, o modo online totalmente implementado é 1v1.');
    const room={code:roomCode(),mode:'1v1',players:[],hostId:null,phase:'lobby',turn:0,timer:null,createdAt:Date.now()};
    const p=makePlayer(ws,msg);p.room=room;room.players.push(p);room.hostId=p.id;rooms.set(room.code,room);sessions.set(p.token,p);bySocket.set(ws,p);
    send(ws,{type:'welcome',token:p.token,room:room.code});broadcastLobby(room);return;
  }
  if(msg.type==='join'){
    const room=rooms.get(String(msg.room||'').toUpperCase());
    if(!room) return error(ws,'Sala não encontrada.');
    if(room.phase!=='lobby') return error(ws,'A partida já começou.');
    if(room.players.length>=2) return error(ws,'Sala cheia.');
    const p=makePlayer(ws,msg);p.room=room;room.players.push(p);sessions.set(p.token,p);bySocket.set(ws,p);
    send(ws,{type:'welcome',token:p.token,room:room.code});broadcastLobby(room);return;
  }
  if(msg.type==='reconnect'){
    const p=sessions.get(String(msg.token||''));
    if(!p||!p.room||p.room.code!==String(msg.room||'').toUpperCase()) return error(ws,'Sessão de reconexão inválida.');
    p.ws=ws;bySocket.set(ws,p);send(ws,{type:'welcome',token:p.token,room:p.room.code});
    if(p.room.phase==='lobby') broadcastLobby(p.room); else if(p.room.phase==='turn') broadcastBattle(p.room); else send(ws,{type:'ended',room:p.room.code,mode:p.room.mode,phase:'ended',turn:p.room.turn,players:p.room.players.map(x=>publicPlayer(x,p.token)),selfToken:p.token,winnerToken:p.room.winnerId? p.room.players.find(x=>x.id===p.room.winnerId)?.token:null,endReason:p.room.endReason});return;
  }
  const p=bySocket.get(ws);if(!p) return error(ws,'Conecte-se primeiro.');
  if(msg.type==='start') return startRoom(p.room,p);
  if(msg.type==='leave') return leaveRoom(p);
  if(msg.type==='action'){
    const room=p.room;if(!room||room.phase!=='turn')return error(ws,'A partida não está aceitando ações.');
    if(p.action)return error(ws,'Sua ação deste turno já foi enviada.');
    const act=validateAction(p,msg);if(!act)return error(ws,'Ação inválida ou habilidade em recarga.');
    p.action=act;broadcastBattle(room);
    if(room.players.every(x=>x.action))resolveTurn(room);
    return;
  }
  if(msg.type==='pong')return;
}

const server=http.createServer((req,res)=>{
  let u=new URL(req.url,'http://localhost');
  if(u.pathname==='/health'){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({ok:true,rooms:rooms.size,players:[...rooms.values()].reduce((n,r)=>n+r.players.length,0)}));}
  let file=u.pathname==='/'?path.join(publicDir,'index.html'):path.join(publicDir,u.pathname.replace(/^\//,''));
  if(!file.startsWith(publicDir)) return res.writeHead(403).end();
  fs.readFile(file,(err,data)=>{if(err){res.writeHead(404);return res.end('Not found')}res.writeHead(200,{'content-type':MIME[path.extname(file)]||'application/octet-stream','cache-control':'no-store'});res.end(data)});
});
function acceptWebSocket(socket,head){
  const key=socket._upgradeKey;
  const accept=crypto.createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
  socket._isWebSocket=true;socket._buffer=head||Buffer.alloc(0);sockets.add(socket);
  socket.on('data',chunk=>{socket._buffer=Buffer.concat([socket._buffer,chunk]);readFrames(socket)});
  socket.on('close',()=>{sockets.delete(socket);const p=bySocket.get(socket);if(p){p.ws=null;if(p.room&&p.room.phase==='lobby'){if(p.room.hostId===p.id)p.room.hostId=p.room.players.find(x=>x.ws)?.id||p.room.hostId;broadcastLobby(p.room)}else if(p.room&&p.room.phase==='turn')event(p.room,`${p.nickname} desconectou. Reconectando...`);}});
  socket.on('error',()=>socket.destroy());
  if(socket._buffer.length) readFrames(socket);
}
function readFrames(socket){
  let b=socket._buffer;
  while(b.length>=2){
    const b1=b[0],b2=b[1]; const opcode=b1&15; const masked=!!(b2&128); let len=b2&127,off=2;
    if(len===126){if(b.length<4)break;len=b.readUInt16BE(2);off=4;}
    else if(len===127){if(b.length<10)break;const n=b.readBigUInt64BE(2);if(n>BigInt(1e7)){socket.destroy();return;}len=Number(n);off=10;}
    if(!masked){socket.destroy();return;}
    if(b.length<off+4+len)break;
    const mask=b.subarray(off,off+4);off+=4;const data=Buffer.alloc(len);for(let i=0;i<len;i++)data[i]=b[off+i]^mask[i%4];b=b.subarray(off+len);
    if(opcode===1){try{handle(socket,JSON.parse(data.toString('utf8')))}catch(e){console.error(e);error(socket,'Mensagem inválida.')}}
    else if(opcode===8){socket.end();return;}
    else if(opcode===9){const pong=Buffer.from([0x8A,data.length,...data]);socket.write(pong);}
  }
  socket._buffer=b;
}
server.on('upgrade',(req,socket,head)=>{
  if(req.url!=='/ws'){socket.destroy();return;}
  const key=req.headers['sec-websocket-key'];
  if(!key){socket.destroy();return;}
  socket._upgradeKey=key;acceptWebSocket(socket,head);
});
setInterval(()=>{
  const now=Date.now();
  for(const [code,r] of rooms){
    if(now-r.createdAt>ROOM_TTL_MS){clearTimeout(r.timer);rooms.delete(code);for(const p of r.players){sessions.delete(p.token);if(p.ws)send(p.ws,{type:'error',message:'Sala expirada.'});}}
    else for(const p of r.players) if(p.ws) send(p.ws,{type:'ping'});
  }
},15000);
server.listen(PORT,()=>console.log(`Anime Battle online em http://localhost:${PORT}`));
