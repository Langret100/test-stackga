import { initFirebase } from "./firebase.js";
import { StackGame, drawBoard, drawNext, COLS } from "./game.js";
import { CpuController } from "./cpu.js";
import { fitCanvases, initTouchControls } from "./touch.js";
import {
  buildInvite, createLobby, joinLobby, watchRoom,
  roomRefs, setRoomState, publishMyState, subscribeOppState,
  pushEvent, subscribeEvents, tryCleanupRoom
} from "./netplay.js";

const $ = (id)=>document.getElementById(id);

const ui = {
  status: $("status"),
  inviteSection: $("invite"),
  inviteUrl: $("inviteUrl"),
  qrText: $("qrText"),
  btnCopyUrl: $("btnCopyUrl"),
  btnCopyText: $("btnCopyText"),
  inviteHint: $("inviteHint"),

  cvMe: $("cvMe"),
  cvOpp: $("cvOpp"),
  cvNext: $("cvNext"),
  meBox: $("meBox"),
  score: $("score"),
  level: $("level"),
  effect: $("effect"),
  mode: $("mode"),
  log: $("log"),
  


  overlay: $("overlay"),
  overlayTitle: $("overlayTitle"),
  overlayDesc: $("overlayDesc"),
  btnStartCpu: $("btnStartCpu"),
  btnRestart: $("btnRestart"),
};

const log = (msg)=>{
  const t = new Date().toLocaleTimeString();
  ui.log.innerText = `[${t}] ${msg}\n` + ui.log.innerText;
};

function setStatus(s){ ui.status.textContent = s; }

function showOverlay(title, desc, {showCpuBtn=false}={}){
  ui.overlayTitle.textContent = title;
  ui.overlayDesc.textContent = desc || "";
  ui.overlay.classList.remove("hidden");
  ui.btnStartCpu.style.display = showCpuBtn ? "" : "none";
}
function hideOverlay(){ ui.overlay.classList.add("hidden"); }

function copyText(t){
  navigator.clipboard.writeText(t).then(()=>log("복사 완료")).catch(()=>log("복사 실패(브라우저 권한 확인)"));
}

ui.btnCopyUrl.addEventListener("click", ()=>copyText(ui.inviteUrl.textContent.trim()));
ui.btnCopyText.addEventListener("click", ()=>copyText(ui.qrText.textContent.trim()));
ui.btnRestart.addEventListener("click", ()=>{
  // room 파라미터 제거 후 새로고침
  const u = new URL(location.href);
  u.searchParams.delete("room");
  location.href = u.origin + u.pathname;
});

// --- Effects (player visuals only)
function applyShrink(active){
  ui.meBox.style.transformOrigin = "50% 20%";
  ui.meBox.style.transform = active ? "scale(0.82)" : "scale(1)";
}

function linesToAttack(c){
  if(c===1) return { kind:"shrink", ms:3000 };
  if(c===2) return { kind:"invert", ms:2000 };
  if(c>=3) return { kind:"bignext", ms:3000 };
  return null;
}

// --- Runtime state
let fb=null, db=null, api=null;

let mode = "init"; // online|cpu|offline
let roomId = "";
let pid = "";
let oppPid = "";
let hbTimer = null;

let roomUnsub = null;
let oppUnsub = null;
let evUnsub = null;

let roomRef=null, statesRef=null, eventsRef=null;
let started = false;
let raf = 0;
let lastTs = 0;
let seenEvents = new Set();

let meGame=null;
let cpuGame=null;
let cpuCtl=null;
let oppLastBoard=null;
let waitTimer=null;
let waitRemain = 0;

// --- Controls
function performAction(action){
  if(!meGame || meGame.dead || !started) return;

  const now = Date.now();
  const invert = meGame._isInvertActive(now);
  const left = invert ? 1 : -1;
  const right = invert ? -1 : 1;

  if(action==="left") meGame.move(left);
  else if(action==="right") meGame.move(right);
  else if(action==="down") meGame.softDrop();
  else if(action==="rotate") meGame.rotate(1);
  else if(action==="drop") meGame.hardDrop();
  else if(action==="pause"){ meGame.paused = !meGame.paused; log(meGame.paused?"일시정지":"재개"); }
}

function readControls(e){
  if(e.repeat) return;
  if(e.code==="ArrowLeft") performAction("left");
  else if(e.code==="ArrowRight") performAction("right");
  else if(e.code==="ArrowDown") performAction("down");
  else if(e.code==="ArrowUp") performAction("rotate");
  else if(e.code==="Space"){ e.preventDefault(); performAction("drop"); }
  else if(e.code==="KeyP") performAction("pause");
}

document.addEventListener("keydown", readControls);
initTouchControls(ui.cvMe, performAction);

// --- Responsive canvas sizing
function _fit(){ fitCanvases(ui.cvMe, ui.cvOpp, ui.cvNext); }
window.addEventListener("resize", _fit);
window.addEventListener("orientationchange", _fit);
_fit();

// --- Rendering / Loop
function render(){
  const ctxMe = ui.cvMe.getContext("2d");
  const ctxOpp = ui.cvOpp.getContext("2d");
  const ctxNext = ui.cvNext?.getContext("2d");
  const cellMe = Math.floor(ui.cvMe.width / COLS);
  const cellOpp = Math.floor(ui.cvOpp.width / COLS);

  if(meGame){
    drawBoard(ctxMe, meGame.snapshot(), cellMe);
    if(ctxNext){
      const cellNext = Math.floor(ui.cvNext.width / 4);
      drawNext(ctxNext, meGame.next, cellNext);
    }
    applyShrink(meGame._isShrinkActive(Date.now()));
  }

  if(oppLastBoard){
    drawBoard(ctxOpp, oppLastBoard, cellOpp, { ghost:true });
  }else{
    ctxOpp.clearRect(0,0,ui.cvOpp.width,ui.cvOpp.height);
    ctxOpp.fillStyle="rgba(0,0,0,0.20)";
    ctxOpp.fillRect(0,0,ui.cvOpp.width,ui.cvOpp.height);
  }
}

function updateHud(){
  if(!meGame) return;
  ui.score.textContent = String(meGame.score);
  ui.level.textContent = String(meGame.level);

  const now = Date.now();
  const e = [];
  if(meGame._isShrinkActive(now)) e.push("화면축소");
  if(meGame._isInvertActive(now)) e.push("좌우반전");
  if(meGame._isBigNextActive(now)) e.push("다음블럭확대");
  ui.effect.textContent = e.length? e.join(", ") : "-";
}

function startLoop(){
  if(started) return;
  started = true;
  hideOverlay();
  lastTs = performance.now();

  // online publish throttle
  const sendEvery = 120;
  let sendAcc = 0;

  function frame(ts){
    const dt = ts - lastTs; lastTs = ts;

    if(meGame) meGame.tick(dt);

    if(mode === "cpu" && cpuGame){
      cpuCtl?.update(dt);
      cpuGame.tick(dt);
      oppLastBoard = cpuGame.snapshot();

      // CPU attacks
      const c2 = cpuGame.lastCleared || 0;
      if(c2>0){
        cpuGame.lastCleared = 0;
        const atk = linesToAttack(c2);
        if(atk){
          applyAttackTo(meGame, atk);
          log(`피격: ${atk.kind}`);
        }
      }
    }

    updateHud();

    // handle my attack
    const c = meGame?.lastCleared || 0;
    if(c>0){
      meGame.lastCleared = 0;
      const atk = linesToAttack(c);
      if(atk){
        if(mode === "online" && oppPid){
          pushEvent({ api, eventsRef, from: pid, to: oppPid, kind:"attack", payload: atk }).catch(()=>{});
          log(`공격 발동: ${atk.kind}`);
        }
        if(mode === "cpu" && cpuGame){
          applyAttackTo(cpuGame, atk);
          log(`공격 발동: ${atk.kind}`);
        }
      }
    }

    // online publish state
    if(mode === "online"){
      sendAcc += dt;
      if(sendAcc >= sendEvery && meGame && pid){
        sendAcc = 0;
        publishMyState({
          api,
          statesRef,
          pid,
          state: {
            board: meGame.snapshot(),
            score: meGame.score,
            level: meGame.level,
            dead: !!meGame.dead,
            effect: ui.effect.textContent
          }
        }).catch(()=>{});
      }
    }

    // end conditions
    if(meGame?.dead){
      endGame(false);
      return;
    }
    if(mode==="cpu" && cpuGame?.dead){
      endGame(true);
      return;
    }

    render();
    raf = requestAnimationFrame(frame);
  }

  raf = requestAnimationFrame(frame);
}

function applyAttackTo(game, a){
  if(!game) return;
  if(a.kind==="shrink") game.applyEffect("shrink", a.ms||3000);
  if(a.kind==="invert") game.applyEffect("invert", a.ms||2000);
  if(a.kind==="bignext") game.applyEffect("bignext", a.ms||3000);
}

async function endGame(won){
  if(!started) return;
  started = false;
  cancelAnimationFrame(raf);

  const title = won ? "승리!" : "패배…";
  const desc = mode==="online"
    ? (won ? "상대가 먼저 탑아웃 했습니다." : "블록이 위까지 쌓였습니다.")
    : (won ? "PC가 먼저 탑아웃 했습니다." : "블록이 위까지 쌓였습니다.");

  showOverlay(title, desc, {showCpuBtn:false});

  // online: write result best-effort
  if(mode==="online" && api && roomRef && pid && oppPid){
    try{
      await api.runTransaction(roomRef, (room)=>{
        if(room===null) return room;
        room.result = room.result || {};
        if(room.result.winner) return room;
        room.result = { winner: won ? pid : oppPid, at: Date.now() };
        room.state = "ended";
        return room;
      });
    }catch{}
  }
}

// --- Online room flow
function qsLobby(){
  const u = new URL(location.href);
  return u.searchParams.get("lobby") || "";
}

function setInvite(lobbyId){
  ui.inviteSection.hidden = false;
  const url = location.origin + location.pathname;
  const inv = buildInvite(url, lobbyId);
  ui.inviteUrl.textContent = inv.full;
  ui.qrText.textContent = inv.qrText;
  ui.inviteHint.textContent = "QR은 위 ‘QR용 문구’를 그대로 넣어 만들면, 스캔 시 대화방에 문구+링크가 그대로 올라갑니다.";
}

async function enterRoom(rid, joined){
  roomId = rid;
  const refs = roomRefs({db, api, roomId});
  roomRef = refs.roomRef;
  statesRef = refs.statesRef;
  eventsRef = refs.eventsRef;

  // room watch
  if(roomUnsub) roomUnsub();
  roomUnsub = watchRoom({ db, api, roomId, onRoom: onRoomUpdate });

  // already joined by joinLobby()
  pid = joined.pid;
  hbTimer = joined.hbTimer;
  log(`방 참가 완료. 내 id=${pid}`);

  // events
  if(evUnsub) evUnsub();
  evUnsub = subscribeEvents({ api, eventsRef, pid, onEvent:onEvents });
}

function startWaitCountdown(seconds){
  clearWaitCountdown();
  waitRemain = seconds;
  showOverlay("상대 대기 중…", `남은 시간: ${waitRemain}초 (20초 내에 없으면 PC 대전)`, {showCpuBtn:true});
  ui.btnStartCpu.onclick = ()=>startCpuMode("버튼으로 PC 대전 시작");

  waitTimer = setInterval(()=>{
    waitRemain -= 1;
    if(waitRemain <= 0){
      clearWaitCountdown();
      startCpuMode("20초 경과: PC 대전 시작");
      return;
    }
    ui.overlayDesc.textContent = `남은 시간: ${waitRemain}초 (20초 내에 없으면 PC 대전)`;
  }, 1000);
}

function clearWaitCountdown(){
  if(waitTimer){ clearInterval(waitTimer); waitTimer=null; }
}

function onRoomUpdate(room){
  if(mode!=="online") return;
  if(!room){
    // room deleted => fallback
    startCpuMode("방이 삭제되어 PC 대전으로 전환");
    return;
  }
  const players = room.players || {};
  const ids = Object.keys(players);

  // opponent
  const others = ids.filter(x=>x!==pid);
  oppPid = others[0] || "";
  ui.oppName.textContent = oppPid ? (players[oppPid]?.name || "Opponent") : "-";

  // waiting -> start countdown for host/joiner 모두(2명 되면 자동 시작)
  if(ids.length===1 && !started){
    startWaitCountdown(20);
  }

  // auto start when 2 players
  if(ids.length===2 && room.state==="open"){
    setRoomState({api, roomRef}, "playing").catch(()=>{});
  }
  if(ids.length===2 && room.state==="playing" && !started){
    clearWaitCountdown();
    meGame = new StackGame(((room.seed>>>0) || 1) ^ (pid?pid.length:1));
    oppLastBoard = null;
    ui.mode.textContent = "온라인";
    mode = "online";

    // subscribe opponent state
    if(oppUnsub) oppUnsub();
    if(oppPid){
      oppUnsub = subscribeOppState({ api, statesRef, oppPid, onState:onOppState });
    }

    log("2명 모집 완료. 온라인 대전 시작!");
    startLoop();
  }

  // ended result
  if(room.state==="ended" && room.result && room.result.winner && started){
    const won = room.result.winner === pid;
    showOverlay(won?"승리!":"패배…", "결과가 확정되었습니다.", {showCpuBtn:false});
    started = false;
    cancelAnimationFrame(raf);
  }
}

function onOppState(s){
  if(mode!=="online") return;
  if(!s){ oppLastBoard=null; return; }
  oppLastBoard = s.board || null;
  if(s.dead && meGame && !meGame.dead){
    endGame(true);
  }
}

function onEvents(events){
  if(mode!=="online") return;
  for(const [k, ev] of Object.entries(events||{})){
    if(seenEvents.has(k)) continue;
    seenEvents.add(k);
    if(!ev || ev.to !== pid) continue;
    if(ev.kind==="attack"){
      applyAttackTo(meGame, ev.payload||{});
      log(`피격: ${(ev.payload||{}).kind||"attack"}`);
    }
    api.remove(api.ref(eventsRef, k)).catch(()=>{});
  }
}

async function cleanupOnline(){
  clearWaitCountdown();
  if(roomUnsub) roomUnsub(); roomUnsub=null;
  if(oppUnsub) oppUnsub(); oppUnsub=null;
  if(evUnsub) evUnsub(); evUnsub=null;
  try{ if(hbTimer) clearInterval(hbTimer); }catch{}

  // best-effort remove my nodes
  try{
    if(api && db && roomId && pid){
      await api.remove(api.ref(db, `rooms/${roomId}/players/${pid}`)).catch(()=>{});
      await api.remove(api.ref(db, `rooms/${roomId}/states/${pid}`)).catch(()=>{});
    }
  }catch{}
}

// --- CPU mode
async function startCpuMode(reason){
  if(mode==="cpu") return;
  log(`PC 대전: ${reason}`);
  ui.mode.textContent = "PC";
  ui.oppName.textContent = "PC";

  // stop online listeners + delete room best-effort
  if(mode==="online"){
    await cleanupOnline();
    try{
      if(api && db && roomId && pid){
        await tryCleanupRoom({db, api, roomId, pid}).catch(()=>{});
        // 바로 지워버리기(기록 남기지 않기)
        await api.remove(api.ref(db, `rooms/${roomId}`)).catch(()=>{});
      }
    }catch{}
  }

  mode = "cpu";
  roomId = ""; pid = ""; oppPid = "";
  oppLastBoard = null;
  seenEvents.clear();

  const seed = (Math.random()*2**32)>>>0;
  meGame = new StackGame(seed ^ 0xA5A5A5A5);
  cpuGame = new StackGame(seed ^ 0x5A5A5A5A);
  cpuCtl = new CpuController(cpuGame, seed ^ 0x12345678);

  showOverlay("PC 대전 시작", "잠시 후 자동으로 시작됩니다.", {showCpuBtn:false});
  setTimeout(()=>startLoop(), 500);
}

// --- Boot
ui.mode.textContent = "-";
setStatus("초기화 중…");

let firebaseReady = false;
try{
  fb = initFirebase();
  db = fb.db; api = fb.api;
  firebaseReady = true;
  setStatus("Firebase 준비됨");
}catch(e){
  console.warn(e);
  firebaseReady = false;
  setStatus("Firebase 미설정: 1인(PC) 모드로 실행");
}

if(!firebaseReady){
  ui.inviteSection.hidden = true;
  startCpuMode("Firebase 미설정");
}else{
  // online first: room 있으면 참가, 없으면 생성+초대
  (async ()=>{
    try{
      mode = "online";
      ui.mode.textContent = "온라인";

      const lid = qsLobby();
      let lobbyId = lid;

      if(lobbyId){
        ui.inviteSection.hidden = true;
        setStatus("매칭 중…");
        showOverlay("매칭 중…", "상대를 찾는 중입니다. (같은 링크에서 최대 10팀 동시 진행)", {showCpuBtn:true});
        ui.btnStartCpu.onclick = ()=>startCpuMode("버튼으로 PC 대전 시작");

        const j = await joinLobby({db, api, lobbyId, name:"Player", maxTeams:10});
        await enterRoom(j.roomId, j);
        setStatus(`매칭 완료: 팀 ${j.slot+1}/10`);
      }else{
        setStatus("초대 생성 중…");
        showOverlay("초대 생성 중…", "잠시만 기다려 주세요.", {showCpuBtn:false});

        const r = await createLobby({db, api});
        lobbyId = r.lobbyId;
        setInvite(lobbyId);

        // URL에 lobby 자동 반영(공유용)
        const u = new URL(location.href);
        u.searchParams.set("lobby", lobbyId);
        history.replaceState({}, "", u.toString());

        setStatus("매칭 중…");
        showOverlay("매칭 중…", "상대를 찾는 중입니다. (같은 링크에서 최대 10팀 동시 진행)", {showCpuBtn:true});
        ui.btnStartCpu.onclick = ()=>startCpuMode("버튼으로 PC 대전 시작");

        const j = await joinLobby({db, api, lobbyId, name:"Player", maxTeams:10});
        await enterRoom(j.roomId, j);

        setStatus("초대 생성 완료");
        log("초대가 생성되었습니다. 상대에게 링크 또는 QR용 문구를 공유하세요.");
      }
    }catch(e){
      console.error(e);
      setStatus("연결 실패: PC 대전으로 전환");
      startCpuMode(String(e?.message||e||"연결 실패"));
    }
  })();
}
