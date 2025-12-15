import { initFirebase } from "./firebase.js";
import { createAudio } from "./audio.js";
import { initMatchButton } from "./match.js";
import { StackGame, drawBoard, drawNext, COLS } from "./game.js";
import { CpuController } from "./cpu.js";
import { fitCanvases, initTouchControls } from "./touch.js";
import {
  joinLobby, watchRoom,
  roomRefs, setRoomState, publishMyState, subscribeOppState,
  pushEvent, subscribeEvents, tryCleanupRoom, hardDeleteRoom,
  releaseSlot, sweepLobbySlots
} from "./netplay.js";

const $ = (id)=>document.getElementById(id);

const ui = {
  cvMe: $("cvMe"),
  cvOpp: $("cvOpp"),
  oppTag: $("oppTag"),
  cvNext: $("cvNext"),

  score: $("score"),
  level: $("level"),
  effect: $("effect"),
  mode: $("mode"),

  comboNum: $("comboNum"),
  comboArea: $("comboArea"),

  overlay: $("overlay"),
  overlayTitle: $("overlayTitle"),
  overlayDesc: $("overlayDesc"),
  btnStartCpu: $("btnStartCpu"),
  btnRestart: $("btnRestart"),
  btnSound: $("btnSound"),
  btnMatch: $("btnMatch"),
  btnFull: $("btnFull"),
};

// --- Audio (BGM + SFX)
const audio = createAudio({ musicUrl: "./assets/arcade-music.mp3" });
function syncSoundIcon(){
  if(!ui.btnSound) return;
  ui.btnSound.textContent = audio.muted ? "🔇" : "🔊";
}
syncSoundIcon();
ui.btnSound?.addEventListener("click", ()=>{
  audio.gestureStart();
  audio.toggleMuted();
  syncSoundIcon();
});

// "매칭" 버튼: 언제든 새로고침 -> 대기자 있으면 다시 연결 시도
initMatchButton({ buttonEl: ui.btnMatch, audio });
// start/retry audio on user gestures (mobile: 첫 play()가 실패할 수 있어 재시도 필요)
window.addEventListener("pointerdown", ()=>audio.gestureStart(), { passive:true });
window.addEventListener("keydown", ()=>audio.gestureStart());

const boardColEl = document.getElementById("boardCol");
const playShellEl = document.getElementById("playShell");

// --- Micro FX (shake + flash)
function restartAnimClass(el, cls){
  if(!el) return;
  el.classList.remove(cls);
  // force reflow
  void el.offsetWidth;
  el.classList.add(cls);
}

function shake(kind){
  if(!playShellEl) return;
  const cls = kind === "strong" ? "shake-strong" : "shake-soft";
  playShellEl.classList.remove("shake-soft","shake-strong");
  restartAnimClass(playShellEl, cls);
  setTimeout(()=>{ playShellEl.classList.remove(cls); }, kind === "strong" ? 280 : 180);
}

function flash(kind){
  if(!boardColEl) return;
  const cls = kind === "bad" ? "flash-bad" : "flash-good";
  boardColEl.classList.remove("flash-good","flash-bad");
  restartAnimClass(boardColEl, cls);
  setTimeout(()=>{ boardColEl.classList.remove(cls); }, 220);
}

function bumpCombo(add){
  if(!ui.comboNum || !ui.comboArea) return;
  comboLines = Math.max(0, comboLines + (add||0));
  ui.comboNum.textContent = String(comboLines);
  ui.comboArea.classList.remove('comboPop');
  // force reflow for restart animation
  void ui.comboArea.offsetWidth;
  ui.comboArea.classList.add('comboPop');
}

function safeSetText(el, t){ if(el) el.textContent = t; }
function setStatus(s){ safeSetText(ui.status, s); }

// Fullscreen toggle (best-effort; iOS Safari may ignore)
function toggleFullscreen(){
  const doc = document;
  const el = document.documentElement;
  try{
    if(!doc.fullscreenElement){
      el.requestFullscreen?.();
    }else{
      doc.exitFullscreen?.();
    }
  }catch{}
}
ui.btnFull?.addEventListener("click", toggleFullscreen);

function showOverlay(title, desc, {showCpuBtn=false}={}){
  safeSetText(ui.overlayTitle, title);
  safeSetText(ui.overlayDesc, desc || "");
  ui.overlay.classList.remove("hidden");
  ui.btnStartCpu.style.display = showCpuBtn ? "" : "none";
}
function hideOverlay(){ ui.overlay.classList.add("hidden"); }

// Restart = reload
ui.btnRestart?.addEventListener("click", ()=>{
  try{ audio.gestureStart(); }catch{}
  audio.gestureStart();
  location.reload();
});

// --- Controls
function performAction(action){
  if(!meGame || meGame.dead || !started) return;

  // Audio starts only after a gesture; this call is safe even if blocked.
  audio.gestureStart();

  const now = Date.now();
  const invert = meGame._isInvertActive(now);
  const left = invert ? 1 : -1;
  const right = invert ? -1 : 1;

  if(action==="left"){
    if(meGame.move(left)) audio.sfx("move");
  }else if(action==="right"){
    if(meGame.move(right)) audio.sfx("move");
  }else if(action==="down"){
    meGame.softDrop(); audio.sfx("soft");
  }else if(action==="rotate"){
    if(meGame.rotate(1)) audio.sfx("rotate");
  }else if(action==="drop"){
    meGame.hardDrop(); audio.sfx("hard");
  }else if(action==="pause"){
    meGame.paused = !meGame.paused;
  }
}

let downHeld = false;
let downTimer = null;

function stopDownHold(){
  downHeld = false;
  if(downTimer){
    clearInterval(downTimer);
    downTimer = null;
  }
}

function onKey(e){
  if(e.code==="ArrowDown"){
    e.preventDefault();
    if(!downHeld){
      downHeld = true;
      performAction("down");
      downTimer = setInterval(()=>{
        // keep dropping while held
        if(!downHeld) return;
        performAction("down");
      }, 30);
    }
    return;
  }

  if(e.repeat) return;
  if(e.code==="ArrowLeft") performAction("left");
  else if(e.code==="ArrowRight") performAction("right");
  else if(e.code==="ArrowUp") performAction("rotate");
  else if(e.code==="Space"){ e.preventDefault(); performAction("drop"); }
  else if(e.code==="KeyP") performAction("pause");
}


document.addEventListener("keydown", onKey);
document.addEventListener("keyup", (e)=>{ if(e.code==="ArrowDown") stopDownHold(); });
window.addEventListener("blur", stopDownHold);
initTouchControls(ui.cvMe, performAction);


// 요청: 기존 20행에서 +3행 고정
let playRows = 23;
// --- Responsive sizing
function fit(){
  fitCanvases(ui.cvMe, ui.cvOpp, ui.cvNext, playRows);
}
window.addEventListener("resize", fit);
window.addEventListener("orientationchange", fit);
fit();

// --- Effects
function linesToGarbage(c){
  // Classic-like: 1=0, 2=1, 3=2, 4=4
  if(c===2) return 1;
  if(c===3) return 2;
  if(c>=4) return 4;
  return 0;
}
function applyGarbageTo(game, n){
  if(!game || !n) return;
  game.addGarbage(n|0);
}

// --- Runtime
let fb=null, db=null, api=null;
let mode = "init"; // online|cpu
let roomId="", pid="", oppPid="";
let hbTimer=null;
let lobbyId="";
let mySlot=null;
let comboLines=0;
let roomUnsub=null, oppUnsub=null, evUnsub=null;
let metaRef=null, playersRef=null, statesRef=null, eventsRef=null;

let started=false;
let raf=0;
let meGame=null;
let cpuGame=null;
let cpuCtl=null;
let oppLastBoard=null;
let seenEvents=new Set();
let waitTimer=null, waitRemain=0;
let cleanupTimer=null;

function updateHud(){
  if(!meGame) return;
  safeSetText(ui.score, String(meGame.score));
  safeSetText(ui.level, String(meGame.level));
  const now = Date.now();
  const e = [];
  if(meGame._isShrinkActive(now)) e.push("축소");
  if(meGame._isInvertActive(now)) e.push("반전");
  if(meGame._isBigNextActive(now)) e.push("NEXT확대");
  safeSetText(ui.effect, e.length?e.join(", "):"-");
}

function render(){
  const ctxMe = ui.cvMe.getContext("2d");
  const ctxOpp = ui.cvOpp.getContext("2d");
  const ctxNext = ui.cvNext.getContext("2d");

  const cellMe = Math.floor(ui.cvMe.width / COLS);
  const cellOpp = Math.floor(ui.cvOpp.width / COLS);

  if(meGame){
    const now = Date.now();
    // shrink effect: scale only the main board column
    if(boardColEl){
      if(meGame._isShrinkActive(now)){
        boardColEl.style.transformOrigin = "top left";
        boardColEl.style.transform = "scale(0.86)";
      }else{
        boardColEl.style.transform = "none";
      }
    }
    drawBoard(ctxMe, meGame.snapshot(), cellMe);
    const mult = meGame._isBigNextActive(now) ? 1.55 : 1;
    const cellNext = Math.floor((ui.cvNext.width / 4) * mult);
    drawNext(ctxNext, meGame.next, cellNext);
  }

  if(oppLastBoard){
    drawBoard(ctxOpp, oppLastBoard, cellOpp, { ghost:true });
  }else{
    ctxOpp.clearRect(0,0,ui.cvOpp.width,ui.cvOpp.height);
  }
}

function startLoop(){
  if(started) return;
  started = true;
  hideOverlay();
  safeSetText(ui.mode, mode==="online"?"온라인":"PC");

  let lastTs = performance.now();
  const sendEvery = 120;
  let sendAcc = 0;

  const frame = (ts)=>{
    const dt = ts - lastTs; lastTs = ts;

    if(meGame) meGame.tick(dt);

    if(mode==="cpu" && cpuGame){
      cpuCtl?.update(dt);
      cpuGame.tick(dt);
      oppLastBoard = cpuGame.snapshot();
  comboLines = 0;
  bumpCombo(0);

      const c2 = cpuGame.lastCleared || 0;
      if(c2>0){
        cpuGame.lastCleared = 0;
        const atk = linesToGarbage(c2);
        if(atk){
          applyGarbageTo(meGame, atk);
          // 받는 쪽 이펙트
          shake("strong");
          flash("bad");
          audio.sfx("attackHit");
        }
      }
    }

    updateHud();

    // my attacks
    const c = meGame?.lastCleared || 0;
    if(c>0){
      meGame.lastCleared = 0;
      const atk = linesToGarbage(c);
      bumpCombo(c);
      // 줄 지울 때마다 이펙트
      shake("soft");
      flash("good");
      audio.sfx("clear");
      if(atk){
        audio.sfx("attackSend");
        if(mode==="online" && oppPid){
          pushEvent({ api, eventsRef, event:{ from: pid, kind:"garbage", payload: { n: atk } } }).catch(()=>{});
        }else if(mode==="cpu" && cpuGame){
          applyGarbageTo(cpuGame, atk);
        }
      }
    }

    // online publish
    if(mode==="online"){
      sendAcc += dt;
      if(sendAcc >= sendEvery && meGame && pid){
        sendAcc = 0;
        publishMyState({
          api, statesRef, pid,
          state:{ board: meGame.snapshot(), score: meGame.score, level: meGame.level, dead: !!meGame.dead }
        }).catch(()=>{});
      }
    }

    // end conditions
    if(meGame?.dead){ endGame(false); return; }
    if(mode==="cpu" && cpuGame?.dead){ endGame(true); return; }

    render();
    raf = requestAnimationFrame(frame);
  };

  raf = requestAnimationFrame(frame);
}

function clearWait(){
  if(waitTimer){ clearInterval(waitTimer); waitTimer=null; }
}

function startWaitCountdown(seconds){
  clearWait();
  waitRemain = seconds;
  showOverlay("상대 대기…", `남은 시간: ${waitRemain}초 (없으면 PC 대전)`, {showCpuBtn:true});
  ui.btnStartCpu.onclick = ()=>startCpuMode("PC 대전");

  waitTimer = setInterval(()=>{
    waitRemain -= 1;
    if(waitRemain <= 0){
      clearWait();
      startCpuMode("20초 경과: PC 대전");
      return;
    }
    safeSetText(ui.overlayDesc, `남은 시간: ${waitRemain}초 (없으면 PC 대전)`);
  }, 1000);
}

function startCpuMode(reason){
  try{ audio.gestureStart(); }catch{}
  // online에서 PC로 전환 시: 방 점유를 풀어 다음 사용자 매칭이 막히지 않도록 best-effort 정리
  if(mode==="online" && api && db && roomId && pid && playersRef && metaRef){
    try{ api.remove(api.child(playersRef, pid)).catch(()=>{}); }catch{}
    try{ if(statesRef) api.remove(api.child(statesRef, pid)).catch(()=>{}); }catch{}
    try{
      api.runTransaction(metaRef, (m)=>{
        if(!m || !m.joined) return m;
        if(m.joined[pid]) delete m.joined[pid];
        m.updatedAt = Date.now();
        return m;
      }).catch(()=>{});
    }catch{}
    // also release lobby slot and delete room so /signals does not linger
    try{ if(lobbyId) releaseSlot({db, api, lobbyId, slot: mySlot}).catch(()=>{}); }catch{}
    try{ hardDeleteRoom({db, api, roomId}).catch(()=>{}); }catch{}

  }

  mode = "cpu";
  if(ui.oppTag) ui.oppTag.textContent = "Offline";
  setStatus(reason);
  clearWait();
  roomUnsub?.(); roomUnsub=null;
  oppUnsub?.(); oppUnsub=null;
  evUnsub?.(); evUnsub=null;

  meGame = new StackGame(((Math.random()*2**32)>>>0), playRows||20);
  cpuGame = new StackGame(((Math.random()*2**32)>>>0), playRows||20);
  cpuCtl = new CpuController(cpuGame);
  oppLastBoard = cpuGame.snapshot();
  comboLines = 0;
  bumpCombo(0);
  safeSetText(ui.mode, "PC");
  startLoop();
}

async function endGame(won){
  if(!started) return;
  started = false;
  cancelAnimationFrame(raf);

  const title = won ? "승리!" : "패배…";
  audio.sfx(won ? "win" : "lose");
  showOverlay(title, "", {showCpuBtn:false});

  if(mode==="online" && api && metaRef && pid){
    // write result (best-effort)
    try{
      await api.runTransaction(metaRef, (m)=>{
        if(m===null) return m;
        if(m.result && m.result.winner) return m;
        m.state = "ended";
        m.result = { winner: won ? pid : (oppPid||""), at: Date.now() };
        m.updatedAt = Date.now();
        return m;
      });
    }catch{}

    // hard delete after a short delay (no record remains)
    if(cleanupTimer) clearTimeout(cleanupTimer);
    cleanupTimer = setTimeout(()=>{
      hardDeleteRoom({db, api, roomId}).catch(()=>{});
      if(lobbyId){ releaseSlot({db, api, lobbyId, slot: mySlot}).catch(()=>{}); }
    }, 350);
  }
}

// --- Online flow
// 동일 주소(도메인+경로)로 접속한 사람들을 2명씩 자동 매칭
function stableLobbyId(){
  const s = location.origin + location.pathname;
  // FNV-1a 32-bit
  let h = 0x811c9dc5;
  for(let i=0;i<s.length;i++){
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // base36, short
  return "stackga_" + (h>>>0).toString(36);
}

async function enterRoom(rid, joined){
  roomId = rid;
  pid = joined.pid;
  hbTimer = joined.hbTimer;

  const refs = roomRefs({db, api, roomId});
  metaRef = refs.metaRef;
  playersRef = refs.playersRef;
  statesRef = refs.statesRef;
  eventsRef = refs.eventsRef;

  roomUnsub?.();
  roomUnsub = watchRoom({ db, api, roomId, onRoom: onRoomUpdate });

  evUnsub?.();
  evUnsub = subscribeEvents({ api, eventsRef, pid, onEvent: onEventRecv });
}

function onRoomUpdate(room){
  if(mode!=="online") return;
  if(!room || !room.meta){
    startCpuMode("방 없음: PC 대전");
    return;
  }

  const meta = room.meta;
  const players = room.players || {};
  const ids = Object.keys(players);

  const others = ids.filter(x=>x!==pid);
  oppPid = others[0] || "";

  // show connection
  setStatus(ids.length>=2 ? "연결됨" : "연결 대기…");

  if(ids.length===1 && !started) startWaitCountdown(20);

  if(ids.length===2 && meta.state === "open"){
    setRoomState({ api, metaRef }, "playing").catch(()=>{});
  }

  if(ids.length===2 && meta.state === "playing" && !started){
    clearWait();
    mode = "online";
    safeSetText(ui.mode, "온라인");
    if(ui.oppTag) ui.oppTag.textContent = "Player";

    // rows는 고정(23행). seed만 동일하게 맞춤.
    meGame = new StackGame(((meta.seed>>>0) || 1), playRows);
    fit();
    oppLastBoard = null;
    comboLines = 0;
    bumpCombo(0);
    seenEvents.clear();

    oppUnsub?.();
    oppUnsub = subscribeOppState({ api, statesRef, pid, onOpp: onOppState });

    startLoop();
  }

  if(meta.state === "ended"){
    clearWait();
    if(started){
      const won = meta?.result?.winner === pid;
      showOverlay(won?"승리!":"패배…", "", {showCpuBtn:false});
      started = false;
      cancelAnimationFrame(raf);
    }
    // cleanup soon
    if(cleanupTimer) clearTimeout(cleanupTimer);
    cleanupTimer = setTimeout(()=>{ hardDeleteRoom({db, api, roomId}).catch(()=>{}); }, 350);
  }
}

function onOppState(res){
  if(mode!=="online") return;
  if(!res){ oppLastBoard=null; return; }
  oppLastBoard = res.state?.board || null;
  if(res.state?.dead && meGame && !meGame.dead){
    endGame(true);
  }
}

function onEventRecv({key, ev}){
  if(seenEvents.has(key)) return;
  seenEvents.add(key);
  if(ev.kind === "garbage"){
    applyGarbageTo(meGame, (ev.payload && ev.payload.n) || 0);
    // 공격 들어올 때 이펙트
    shake("strong");
    flash("bad");
    audio.sfx("attackHit");
  }
  // consume/delete immediately to avoid logs
  try{
    api.remove(api.child(eventsRef, key)).catch(()=>{});
  }catch{}
}

async function boot(){
  // Firebase init (실패해도 게임은 돌아가야 함)
  try{
    fb = initFirebase();
    db = fb.db;
    api = fb.api;
  }catch(e){
    setStatus("오프라인: Firebase 설정 확인");
    startCpuMode("오프라인: PC 대전");
    return;
  }

  try{
    lobbyId = stableLobbyId();
    // sweep stale rooms/slots (best-effort)
    try{ await sweepLobbySlots({db, api, lobbyId, maxTeams: 10}); }catch{}

    setStatus("연결 중…");
    mode = "online";
    safeSetText(ui.mode, "온라인");
    if(ui.oppTag) ui.oppTag.textContent = "Player";

    const joined = await joinLobby({db, api, lobbyId, name: "Player", maxTeams: 10});
    mySlot = joined.slot;
    await enterRoom(joined.roomId, joined);
    // periodic sweep so crashed sessions do not leave data behind
    setInterval(()=>{ try{ sweepLobbySlots({db, api, lobbyId, maxTeams:10}).catch(()=>{}); }catch{} }, 20000);

  }catch(e){
    // rules/설정 오류거나 10팀 가득이면 PC로
    startCpuMode("연결 실패: PC 대전");
  }
}

// best-effort cleanup on exit
let _exitCleaned = false;
function bestEffortExitCleanup(){
  if(_exitCleaned) return;
  _exitCleaned = true;
  try{ if(hbTimer) clearInterval(hbTimer); }catch{}
  try{ clearWait(); }catch{}
  if(mode==="online" && db && api && roomId){
    // 최소한 내 흔적(players/states)은 즉시 제거(best-effort)
    try{ if(playersRef && pid) api.remove(api.child(playersRef, pid)).catch(()=>{}); }catch{}
    try{ if(statesRef && pid) api.remove(api.child(statesRef, pid)).catch(()=>{}); }catch{}
    tryCleanupRoom({db, api, roomId}).catch(()=>{});
    try{ if(lobbyId) releaseSlot({db, api, lobbyId, slot: mySlot}).catch(()=>{}); }catch{}
  }

  // 추가: 모드와 상관없이 mm가 비어있으면 제거(prune) 시도
  try{ if(db && api && lobbyId) releaseSlot({db, api, lobbyId, slot: null}).catch(()=>{}); }catch{}
}

// Mobile browsers are more reliable with pagehide/visibilitychange than beforeunload.
window.addEventListener("beforeunload", bestEffortExitCleanup);
window.addEventListener("pagehide", bestEffortExitCleanup);
document.addEventListener("visibilitychange", ()=>{
  if(document.visibilityState === "hidden") bestEffortExitCleanup();
});

boot();
