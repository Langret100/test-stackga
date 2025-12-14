import { initFirebase } from "./firebase.js";
import { StackGame, drawBoard, drawNext, COLS } from "./game.js";
import { CpuController } from "./cpu.js";
import { fitCanvases, initTouchControls } from "./touch.js";
import {
  buildInvite, createLobby, joinLobby, watchRoom,
  roomRefs, setRoomState, publishMyState, subscribeOppState,
  pushEvent, subscribeEvents, tryCleanupRoom, hardDeleteRoom
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

  score: $("score"),
  level: $("level"),
  effect: $("effect"),
  mode: $("mode"),

  overlay: $("overlay"),
  overlayTitle: $("overlayTitle"),
  overlayDesc: $("overlayDesc"),
  btnStartCpu: $("btnStartCpu"),
  btnRestart: $("btnRestart"),
};

const boardColEl = document.getElementById("boardCol");

function safeSetText(el, t){ if(el) el.textContent = t; }
function setStatus(s){ safeSetText(ui.status, s); }

function showOverlay(title, desc, {showCpuBtn=false}={}){
  safeSetText(ui.overlayTitle, title);
  safeSetText(ui.overlayDesc, desc || "");
  ui.overlay.classList.remove("hidden");
  ui.btnStartCpu.style.display = showCpuBtn ? "" : "none";
}
function hideOverlay(){ ui.overlay.classList.add("hidden"); }

function copyText(t){
  navigator.clipboard.writeText(t).catch(()=>{});
}
ui.btnCopyUrl?.addEventListener("click", ()=>copyText(ui.inviteUrl.textContent.trim()));
ui.btnCopyText?.addEventListener("click", ()=>copyText(ui.qrText.textContent.trim()));
ui.btnRestart?.addEventListener("click", ()=>{
  const u = new URL(location.href);
  u.searchParams.delete("lobby");
  location.href = u.origin + u.pathname;
});

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
  else if(action==="pause") meGame.paused = !meGame.paused;
}

function onKey(e){
  if(e.repeat) return;
  if(e.code==="ArrowLeft") performAction("left");
  else if(e.code==="ArrowRight") performAction("right");
  else if(e.code==="ArrowDown") performAction("down");
  else if(e.code==="ArrowUp") performAction("rotate");
  else if(e.code==="Space"){ e.preventDefault(); performAction("drop"); }
  else if(e.code==="KeyP") performAction("pause");
}

document.addEventListener("keydown", onKey);
initTouchControls(ui.cvMe, performAction);

// --- Responsive sizing
function fit(){ fitCanvases(ui.cvMe, ui.cvOpp, ui.cvNext); }
window.addEventListener("resize", fit);
window.addEventListener("orientationchange", fit);
fit();

// --- Effects
function linesToAttack(c){
  if(c===1) return { kind:"shrink", ms:3000 };
  if(c===2) return { kind:"invert", ms:2000 };
  if(c>=3) return { kind:"bignext", ms:3000 };
  return null;
}
function applyAttackTo(game, a){
  if(!game) return;
  if(a.kind==="shrink") game.applyEffect("shrink", a.ms||3000);
  if(a.kind==="invert") game.applyEffect("invert", a.ms||2000);
  if(a.kind==="bignext") game.applyEffect("bignext", a.ms||3000);
}

// --- Runtime
let fb=null, db=null, api=null;
let mode = "init"; // online|cpu
let roomId="", pid="", oppPid="";
let hbTimer=null;
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

      const c2 = cpuGame.lastCleared || 0;
      if(c2>0){
        cpuGame.lastCleared = 0;
        const atk = linesToAttack(c2);
        if(atk) applyAttackTo(meGame, atk);
      }
    }

    updateHud();

    // my attacks
    const c = meGame?.lastCleared || 0;
    if(c>0){
      meGame.lastCleared = 0;
      const atk = linesToAttack(c);
      if(atk){
        if(mode==="online" && oppPid){
          pushEvent({ api, eventsRef, event:{ from: pid, kind:"attack", payload: atk } }).catch(()=>{});
        }else if(mode==="cpu" && cpuGame){
          applyAttackTo(cpuGame, atk);
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
  // online에서 PC로 전환 시: 방 점유를 풀어 다음 사용자 매칭이 막히지 않도록 best-effort 정리
  if(mode==="online" && api && db && roomId && pid && playersRef && metaRef){
    try{ api.remove(api.child(playersRef, pid)).catch(()=>{}); }catch{}
    try{
      api.runTransaction(metaRef, (m)=>{
        if(!m || !m.joined) return m;
        if(m.joined[pid]) delete m.joined[pid];
        m.updatedAt = Date.now();
        return m;
      }).catch(()=>{});
    }catch{}
  }

  mode = "cpu";
  setStatus(reason);
  clearWait();
  roomUnsub?.(); roomUnsub=null;
  oppUnsub?.(); oppUnsub=null;
  evUnsub?.(); evUnsub=null;

  meGame = new StackGame((Math.random()*2**32)>>>0);
  cpuGame = new StackGame((Math.random()*2**32)>>>0);
  cpuCtl = new CpuController(cpuGame);
  oppLastBoard = cpuGame.snapshot();
  safeSetText(ui.mode, "PC");
  startLoop();
}

async function endGame(won){
  if(!started) return;
  started = false;
  cancelAnimationFrame(raf);

  const title = won ? "승리!" : "패배…";
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
    }, 1500);
  }
}

// --- Online flow
function qsLobby(){
  const u = new URL(location.href);
  return u.searchParams.get("lobby") || "";
}

function setInvite(lobbyId){
  ui.inviteSection.hidden = false;
  const url = location.origin + location.pathname;
  const inv = buildInvite(url, lobbyId);
  safeSetText(ui.inviteUrl, inv.full);
  safeSetText(ui.qrText, inv.qrText);
  safeSetText(ui.inviteHint, "QR은 ‘QR용 문구’를 그대로 넣어 만들면, 스캔 시 대화방에 문구+링크가 그대로 올라갑니다.");
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

    meGame = new StackGame((meta.seed>>>0) || 1);
    oppLastBoard = null;
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
    cleanupTimer = setTimeout(()=>{ hardDeleteRoom({db, api, roomId}).catch(()=>{}); }, 1500);
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
  if(ev.kind === "attack"){
    applyAttackTo(meGame, ev.payload || {});
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

  const lobby = qsLobby();
  try{
    let lobbyId = lobby;
    if(!lobbyId){
      const c = await createLobby({db, api});
      lobbyId = c.lobbyId;
      setInvite(lobbyId);
      // URL에 lobby 파라미터 붙여서 갱신 (동일 링크 공유)
      const u = new URL(location.href);
      u.searchParams.set("lobby", lobbyId);
      history.replaceState({}, "", u.toString());
    }

    setStatus("연결 중…");
    mode = "online";
    safeSetText(ui.mode, "온라인");

    const joined = await joinLobby({db, api, lobbyId, name: "Player", maxTeams: 10});
    await enterRoom(joined.roomId, joined);

  }catch(e){
    // rules/설정 오류거나 10팀 가득이면 PC로
    startCpuMode("연결 실패: PC 대전");
  }
}

// best-effort cleanup on exit
window.addEventListener("beforeunload", ()=>{
  try{ if(hbTimer) clearInterval(hbTimer); }catch{}
  try{ clearWait(); }catch{}
  if(mode==="online" && db && api && roomId){
    tryCleanupRoom({db, api, roomId}).catch(()=>{});
  }
});

boot();
