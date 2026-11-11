// .env 파일(ANTHROPIC_API_KEY 등)을 환경 변수로 불러옵니다. 파일이 없으면 건너뜁니다.
try { process.loadEnvFile(require('path').join(__dirname, '.env')); } catch (e) { if (e.code !== 'ENOENT') console.error('.env 읽기 실패:', e.message); }
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json({limit:'32kb'}));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/api/ai', require('./ai-games'));

// 계정/전적은 서버의 users.json에 영구 저장됩니다. 비밀번호 원문은 저장하지 않습니다.
const DB_FILE = path.join(__dirname, 'users.json');
const SECRET_FILE = path.join(__dirname, '.literlover-auth-secret');
if (!fs.existsSync(SECRET_FILE)) fs.writeFileSync(SECRET_FILE, crypto.randomBytes(48).toString('hex'), {mode:0o600});
const AUTH_SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();
let db = { users: {} };
try { if (fs.existsSync(DB_FILE)) db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { console.error('users.json 읽기 실패:', e.message); }
if (!db || typeof db.users !== 'object' || !db.users) db = {users:{}};
function saveDb(){ const tmp=DB_FILE+'.tmp'; fs.writeFileSync(tmp, JSON.stringify(db,null,2), {mode:0o600}); fs.renameSync(tmp,DB_FILE); }
function userKey(name){ return String(name||'').toLocaleLowerCase('ko-KR'); }
function safeUser(u){return {username:u.username,createdAt:u.createdAt,stats:u.stats||{games:0,wins:0,losses:0,draws:0,bestScore:0}};}
function makeToken(username){const payload=Buffer.from(JSON.stringify({u:userKey(username),exp:Date.now()+30*24*60*60*1000})).toString('base64url');const sig=crypto.createHmac('sha256',AUTH_SECRET).update(payload).digest('base64url');return payload+'.'+sig;}
function authUser(token){try{const [payload,sig]=String(token||'').split('.');if(!payload||!sig)return null;const expected=crypto.createHmac('sha256',AUTH_SECRET).update(payload).digest();const got=Buffer.from(sig,'base64url');if(got.length!==expected.length||!crypto.timingSafeEqual(got,expected))return null;const data=JSON.parse(Buffer.from(payload,'base64url').toString());if(!data.u||data.exp<Date.now())return null;return db.users[data.u]||null;}catch(_){return null;}}
function bearer(req){return (req.headers.authorization||'').startsWith('Bearer ')?req.headers.authorization.slice(7):'';}
function requireAuth(req,res,next){const u=authUser(bearer(req));if(!u)return res.status(401).json({message:'로그인이 만료되었습니다. 다시 로그인해 주세요.'});req.user=u;next();}
function validCredentials(username,password){if(typeof username!=='string'||!/^[가-힣A-Za-z0-9_-]{3,18}$/.test(username))return '아이디는 한글·영문·숫자·밑줄·하이픈으로 3~18자여야 합니다.';if(typeof password!=='string'||password.length<6||password.length>128)return '비밀번호는 6~128자로 입력해 주세요.';return null;}
function hashPassword(password,salt){return crypto.scryptSync(password,salt,64).toString('hex');}
app.post('/api/register',(req,res)=>{
  const {username,password}=req.body||{};const err=validCredentials(username,password);if(err)return res.status(400).json({message:err});
  const key=userKey(username);if(db.users[key])return res.status(409).json({message:'이미 사용 중인 아이디입니다.'});
  const salt=crypto.randomBytes(16).toString('hex');const user={username,salt,passwordHash:hashPassword(password,salt),createdAt:new Date().toISOString(),stats:{games:0,wins:0,losses:0,draws:0,bestScore:0},records:[]};db.users[key]=user;saveDb();res.json({token:makeToken(username),user:safeUser(user)});
});
app.post('/api/login',(req,res)=>{
  const {username,password}=req.body||{};if(typeof username!=='string'||typeof password!=='string')return res.status(400).json({message:'아이디와 비밀번호를 입력해 주세요.'});
  const user=db.users[userKey(username)];if(!user)return res.status(401).json({message:'아이디 또는 비밀번호가 올바르지 않습니다.'});
  const got=Buffer.from(hashPassword(password,user.salt),'hex'),want=Buffer.from(user.passwordHash,'hex');if(got.length!==want.length||!crypto.timingSafeEqual(got,want))return res.status(401).json({message:'아이디 또는 비밀번호가 올바르지 않습니다.'});
  res.json({token:makeToken(user.username),user:safeUser(user)});
});
app.get('/api/me',requireAuth,(req,res)=>res.json({user:safeUser(req.user)}));
app.get('/api/records',requireAuth,(req,res)=>res.json({stats:req.user.stats||{},records:req.user.records||[]}));
app.post('/api/logout',(_req,res)=>res.json({ok:true}));
function addRecord(user, record){
  if(!user)return;const stats=user.stats||(user.stats={games:0,wins:0,losses:0,draws:0,bestScore:0});
  stats.games=(stats.games||0)+1;const result=record.result;
  if(result==='win')stats.wins=(stats.wins||0)+1;else if(result==='loss')stats.losses=(stats.losses||0)+1;else if(result==='draw')stats.draws=(stats.draws||0)+1;
  if(Number.isFinite(Number(record.score)))stats.bestScore=Math.max(stats.bestScore||0,Number(record.score));
  user.records=user.records||[];user.records.unshift({...record,date:new Date().toISOString().slice(0,10)});user.records=user.records.slice(0,100);saveDb();
}
app.post('/api/record',requireAuth,(req,res)=>{
  const b=req.body||{};const score=Number(b.score);if(!Number.isFinite(score))return res.status(400).json({message:'점수 형식이 올바르지 않습니다.'});
  const result=String(b.result||'');const outcome=result==='YOU WIN'||result==='QUIZ COMPLETE'?'win':result==='AI WIN'?'loss':'played';
  addRecord(req.user,{mode:['single','ai'].includes(b.mode)?b.mode:'single',modeLabel:b.mode==='ai'?'AI 대전':'싱글',topic:String(b.topic||'').slice(0,40),score,aiScore:Number(b.aiScore)||0,correct:Number(b.correct)||0,attempts:Number(b.attempts)||0,result:outcome,resultLabel:result});
  res.json({ok:true,stats:req.user.stats});
});

// 로그인 없이 게스트도 온라인 대전에 참가할 수 있습니다.
// 로그인 계정이 있으면 계정 정보를 사용하고, 없으면 연결별 임시 게스트 ID를 사용합니다.
io.use((socket,next)=>{
  const u=authUser(socket.handshake.auth&&socket.handshake.auth.token);
  if(u){
    socket.data.accountKey=userKey(u.username);
    socket.data.accountName=u.username;
  } else {
    const guestName=String(socket.handshake.auth&&socket.handshake.auth.name||'플레이어').trim().slice(0,18)||'플레이어';
    socket.data.accountKey='guest:'+socket.id;
    socket.data.accountName=guestName;
  }
  next();
});
const rooms = new Map();
function recordOnlineResult(r, scores, mode){
  if(!r||r.recorded)return;r.recorded=true;
  const max=Math.max(...scores), winners=scores.map((v,i)=>v===max?i:-1).filter(i=>i>=0);
  r.players.forEach((p,i)=>{const u=db.users[p.userKey];if(!u)return;const outcome=winners.length>1?'draw':(winners[0]===i?'win':'loss');addRecord(u,{mode,modeLabel:mode==='dots'?'온라인 도트 앤 박스':mode==='twenty'?'온라인 스무고개':'온라인 퀴즈',topic:r.topic||'가짜 판별',score:scores[i],opponent:r.players[1-i]?.name||'',result:outcome,resultLabel:outcome==='win'?'승리':outcome==='loss'?'패배':'무승부'});});
}
function code(){ let s=''; do { s=String(Math.floor(100000+Math.random()*900000)); } while(rooms.has(s)); return s; }
function publicRoom(r){ return {code:r.code, players:r.players.map(p=>({id:p.id, name:p.name, score:p.score})), started:r.started, topic:r.topic, mode:r.mode}; }
// 점수는 이름이 아니라 소켓 ID로 구분한다. (이름이 같거나 입력창 이름과 다르면 "나"와 "상대"가 뒤바뀌기 때문)
function emitScores(r){ io.to(r.code).emit('game:scores', r.players.map(p=>({id:p.id, name:p.name, score:p.score}))); }
function newDots(){return {size:4, lines:{}, boxes:Array.from({length:4},()=>Array(4).fill(-1)), turn:0, scores:[0,0], finished:false};}
function dotsFor(r, playerId){const you=r.players.findIndex(p=>p.id===playerId);return {...r.dots,you};}
function emitDots(r){r.players.forEach(p=>io.to(p.id).emit(r.dots.finished?'dots:ended':'dots:state',dotsFor(r,p.id)));}
// 온라인 스무고개: Claude가 비밀 키워드를 정하고 진행하며, 두 플레이어가 번갈아 최대 10번씩 질문·정답 도전을 한다.
const AIG=require('./ai-games').twenty, TW_TURNS=10;
function newTwenty(first){return {kw:null, starter:first, turn:first, left:[TW_TURNS,TW_TURNS], log:[], busy:false, finished:false, winner:-1};}
function twentyFor(r, playerId){
  const t=r.twenty, you=r.players.findIndex(p=>p.id===playerId);
  return {you, names:r.players.map(p=>p.name), max:TW_TURNS, ready:!!t.kw, field:t.kw?t.kw.field:'', pattern:t.kw?AIG.pattern(t.kw.word):'', turn:t.turn, left:t.left, log:t.log, busy:t.busy, finished:t.finished, winner:t.winner, reveal:t.finished&&t.kw?{word:t.kw.word,desc:t.kw.desc}:null};
}
function emitTwenty(r){r.players.forEach(p=>io.to(p.id).emit('twenty:state',twentyFor(r,p.id)));}
function finishTwenty(r, winner){
  const t=r.twenty; t.finished=true; t.winner=winner; if(winner>=0)r.players[winner].score++;
  recordOnlineResult(r,r.players.map((_,i)=>i===winner?1:0),'twenty');
  emitScores(r);
}
// 새 판 시작: Claude가 키워드를 고른다. 실패하면 준비된 키워드를 쓴다.
async function startTwentyRound(r, t){
  let kw; try{kw=await AIG.generateKeyword();}catch(e){console.error('온라인 스무고개 키워드 생성 실패, 준비된 목록 사용:',e.message);kw=AIG.pickFallbackKeyword();}
  AIG.rememberWord(kw.word);
  if(r.twenty!==t)return; t.kw=kw; emitTwenty(r);
}
function boxEdges(row,col){return [`h-${row}-${col}`,`h-${row+1}-${col}`,`v-${row}-${col}`,`v-${row}-${col+1}`];}
io.on('connection', socket => {
  socket.on('room:create', ({name, topic, mode}={}) => {
    const c=code(); const chosenMode=mode==='dots'?'dots':mode==='twenty'?'twenty':'quiz'; if(chosenMode==='twenty')topic='스무고개';
    const r={code:c, host:socket.id, players:[{id:socket.id,userKey:socket.data.accountKey,name:socket.data.accountName,score:0}], started:false, topic:topic||'문해력', mode:chosenMode, question:null, answered:{}, dots:null, recorded:false};
    rooms.set(c,r); socket.join(c); socket.data.room=c; socket.emit('room:created',publicRoom(r));
  });
  socket.on('room:join', ({code:c,name,mode}={}) => {
    c=String(c||'').trim(); const r=rooms.get(c);
    if(!r){socket.emit('room:error','방 코드를 찾을 수 없습니다.');return;}
    if(r.players.length>=2){socket.emit('room:error','이 방은 이미 두 명이 가득 찼습니다.');return;}
    if(r.started){socket.emit('room:error','이미 게임이 시작된 방입니다.');return;}
    r.players.push({id:socket.id,userKey:socket.data.accountKey,name:socket.data.accountName,score:0}); socket.join(c); socket.data.room=c;
    io.to(c).emit('room:update',publicRoom(r)); io.to(c).emit('room:ready', {room:publicRoom(r)});
  });
  socket.on('game:start', () => {
    const r=rooms.get(socket.data.room); if(!r||r.host!==socket.id||r.players.length!==2)return;
    if(r.started&&!(r.mode==='dots'&&r.dots&&r.dots.finished)&&!(r.mode==='twenty'&&r.twenty&&r.twenty.finished))return; // 도트 앤 박스·스무고개는 끝난 뒤 한 판 더 가능
    if(r.mode==='twenty'&&!AIG.isConfigured()){socket.emit('room:error','온라인 스무고개는 Claude 진행자가 필요해요. 서버의 .env에 ANTHROPIC_API_KEY를 넣어 주세요.');return;}
    const rematch=r.mode==='twenty'&&r.started; // 스무고개 재대결은 승수를 유지하고 먼저 묻는 사람만 바꾼다
    r.started=true; r.recorded=false; r.over=false; if(!rematch)r.players.forEach(p=>p.score=0); r.question=null; r.answered={};
    if(r.mode==='dots')r.dots=newDots();
    if(r.mode==='twenty'){r.round=rematch?(r.round||0)+1:0;r.twenty=newTwenty(r.round%2);startTwentyRound(r,r.twenty);}
    io.to(r.code).emit('game:started',publicRoom(r));
    if(r.mode==='dots')emitDots(r);
    if(r.mode==='twenty'){emitScores(r);emitTwenty(r);}
  });
  // 스무고개: 현재 차례인 플레이어가 질문 또는 정답 도전을 하면 Claude 진행자가 답한다.
  socket.on('twenty:turn', async ({kind,text}={}) => {
    const r=rooms.get(socket.data.room); if(!r||!r.started||r.mode!=='twenty'||!r.twenty)return;
    const t=r.twenty, me=r.players.findIndex(p=>p.id===socket.id);
    if(t.finished||!t.kw||t.busy||me!==t.turn||t.left[me]<=0)return;
    const guess=kind==='guess', q=String(text||'').trim().slice(0,guess?30:100); if(!q)return;
    t.busy=true; emitTwenty(r);
    try{
      const entry={who:me,kind:guess?'guess':'question',text:q};
      if(guess){entry.correct=await AIG.judgeGuess(t,q);entry.answer=entry.correct?'정답':'오답';}
      else Object.assign(entry,await AIG.hostAnswer(t,q));
      if(r.twenty!==t)return;
      t.log.push(entry); t.left[me]--;
      if(entry.correct)finishTwenty(r,me);
      else if(t.left[0]<=0&&t.left[1]<=0)finishTwenty(r,-1);
      else t.turn=t.left[1-me]>0?1-me:me;
    }catch(e){console.error('온라인 스무고개 진행 실패:',e.message);socket.emit('room:error','Claude 진행자에게 문제가 생겼어요. 다시 시도해 주세요.');}
    finally{t.busy=false; if(r.twenty===t)emitTwenty(r);}
  });
  // 온라인 도트 앤 박스 비밀 코드: 현재 플레이어가 15칸을 차지하고 마지막 한 칸만 남긴다.
  // 서버에서 상태를 변경하고 양쪽에 브로드캐스트해 화면 불일치를 방지한다.
  socket.on('dots:cheat', () => {
    const r=rooms.get(socket.data.room);
    if(!r||!r.started||r.mode!=='dots'||!r.dots||r.dots.finished)return;
    const playerIndex=r.players.findIndex(p=>p.id===socket.id);
    if(playerIndex<0)return;
    const n=r.dots.size;
    r.dots.lines={};
    for(let row=0;row<=n;row++)for(let col=0;col<n;col++){
      const key=`h-${row}-${col}`;
      if(!(row===n&&col===n-1))r.dots.lines[key]=playerIndex;
    }
    for(let row=0;row<n;row++)for(let col=0;col<=n;col++)r.dots.lines[`v-${row}-${col}`]=playerIndex;
    r.dots.boxes=Array.from({length:n},(_,row)=>Array.from({length:n},(_,col)=>(row===n-1&&col===n-1)?-1:playerIndex));
    r.dots.scores=Array.from({length:r.players.length},(_,i)=>i===playerIndex?n*n-1:0);
    r.dots.turn=playerIndex;
    r.dots.finished=false;
    r.players.forEach((p,i)=>p.score=r.dots.scores[i]);
    emitDots(r);
    emitScores(r);
  });
  socket.on('dots:line', ({line}={}) => {
    const r=rooms.get(socket.data.room); if(!r||!r.started||r.mode!=='dots'||!r.dots||r.dots.finished)return;
    const playerIndex=r.players.findIndex(p=>p.id===socket.id);if(playerIndex<0||playerIndex!==r.dots.turn)return;
    if(typeof line!=='string'||r.dots.lines[line]!==undefined)return;
    const m=line.match(/^([hv])-(\d+)-(\d+)$/);if(!m)return;
    const [,dir,rs,cs]=m,row=Number(rs),col=Number(cs),n=r.dots.size;
    if((dir==='h'&&(row<0||row>n||col<0||col>=n))||(dir==='v'&&(row<0||row>=n||col<0||col>n)))return;
    r.dots.lines[line]=playerIndex;
    let got=0;
    for(let br=0;br<n;br++)for(let bc=0;bc<n;bc++)if(r.dots.boxes[br][bc]===-1&&boxEdges(br,bc).every(k=>r.dots.lines[k]!==undefined)){r.dots.boxes[br][bc]=playerIndex;r.dots.scores[playerIndex]++;got++;}
    r.players.forEach((p,i)=>p.score=r.dots.scores[i]);
    if(!got)r.dots.turn=1-playerIndex;
    r.dots.finished=r.dots.boxes.every(row=>row.every(x=>x!==-1));
    if(r.dots.finished)recordOnlineResult(r,r.dots.scores,'dots');
    emitDots(r);emitScores(r);
  });
  socket.on('game:question', data => {
    const r=rooms.get(socket.data.room); if(!r||r.mode!=='quiz'||r.host!==socket.id||!r.started)return;
    if(!data||!Array.isArray(data.options)||data.options.length!==2)return;
    r.question={id:String(data.id),text:String(data.text||'').slice(0,1000),options:data.options.map(x=>String(x).slice(0,300)),correct:Number(data.correct)===1?1:0,explain:String(data.explain||'').slice(0,1000)}; r.answered={};
    io.to(r.code).emit('game:question',{id:r.question.id,text:r.question.text,options:r.question.options});
  });
  socket.on('game:answer', ({id,index}={}) => {
    const r=rooms.get(socket.data.room); if(!r||r.mode!=='quiz'||!r.started||!r.question||r.question.done||r.question.id!==String(id)||r.answered[socket.id]!==undefined)return;
    if(!r.players.some(p=>p.id===socket.id))return;
    const choice=Number(index); if(choice!==0&&choice!==1&&choice!==-1)return; // -1: 보기가 바닥에 닿아 시간 초과(오답)
    const correct=choice===r.question.correct;
    r.answered[socket.id]={choice,correct};
    // 먼저 정답을 맞힌 사람만 +10점을 얻고 그 문제는 바로 끝난다. 오답·시간 초과는 -10점.
    const p=r.players.find(p=>p.id===socket.id); p.score += correct?10:-10;
    socket.emit('game:answer-result',{correct,score:p.score});
    emitScores(r);
    if(correct||r.players.every(p=>r.answered[p.id]!==undefined)){
      r.question.done=true;
      // 100점 이상인 사람 중 점수가 가장 높은 한 명이 승자. 동점이면 승부가 날 때까지 계속한다.
      const top=Math.max(...r.players.map(p=>p.score)), leaders=r.players.filter(p=>p.score===top);
      const winner=top>=100&&leaders.length===1?leaders[0]:null;
      r.over=!!winner;
      if(winner)recordOnlineResult(r,r.players.map(p=>p.score),'quiz');
      io.to(r.code).emit('game:round-complete',{firstId:correct?socket.id:null,answers:r.players.map(p=>({id:p.id,name:p.name,choice:r.answered[p.id]?r.answered[p.id].choice:null,correct:!!(r.answered[p.id]&&r.answered[p.id].correct)})),correctIndex:r.question.correct,explain:r.question.explain,winner:winner?winner.name:null,winnerId:winner?winner.id:null});
    }
  });
  socket.on('game:next',()=>{const r=rooms.get(socket.data.room);if(r&&r.mode==='quiz'&&r.host===socket.id&&r.started){if(r.over){r.over=false;r.players.forEach(p=>p.score=0);r.recorded=false;emitScores(r);}io.to(r.code).emit('game:next-request');}});
  socket.on('room:leave',()=>leave(socket));
  socket.on('disconnect',()=>leave(socket));
  function leave(s){const c=s.data.room;if(!c)return;const r=rooms.get(c);s.data.room=null;if(!r)return;rooms.delete(c);io.to(c).emit('room:closed','상대방 연결이 종료되어 방이 닫혔습니다.');}
});
const port=process.env.PORT||3000; server.listen(port,'0.0.0.0',()=>{console.log(`ACID RAIN listening on ${port}`);const c=require('./claude');console.log(c.isConfigured()?`Claude 연결 준비 완료 (${c.config().model})`:'Claude API 키 없음: .env의 ANTHROPIC_API_KEY를 채우면 AI 대전이 켜집니다.');});
