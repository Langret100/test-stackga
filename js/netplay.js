import { makeId, nowMs } from "./firebase.js";

/**
 * Firebase Rules(사용자 제공) 제약:
 * - root read/write 금지
 * - socialChatRooms/{roomId}/{msgId} 와 signals/{roomId}/{signalId} 만 read/write 허용
 *
 * 따라서 이 게임은 실시간 데이터를 signals 아래의 2-depth(이하)에서만 다룹니다.
 * (signals/{roomId}/meta, players, states, events)
 */

const LOBBY_MM_PATH = (lobbyId)=>`signals/${lobbyId}/mm`;
const SLOT_PATH = (lobbyId, slot)=>`signals/${lobbyId}/mm/slots/${slot}`;
const META_PATH = (roomId)=>`signals/${roomId}/meta`;
const PLAYERS_PATH = (roomId)=>`signals/${roomId}/players`;
const STATES_PATH = (roomId)=>`signals/${roomId}/states`;
const EVENTS_PATH = (roomId)=>`signals/${roomId}/events`;

export function buildInvite(url, lobbyId){
  const full = url.includes("?") ? `${url}&lobby=${lobbyId}` : `${url}?lobby=${lobbyId}`;
  const qrText = `쌓기게임 초대 (0/2)\n${full}`;
  return { full, qrText };
}

export async function createLobby({db, api}){
  const lobbyId = makeId(10);
  const mmRef = api.ref(db, LOBBY_MM_PATH(lobbyId));
  await api.set(mmRef, {
    createdAt: nowMs(),
    updatedAt: api.serverTimestamp(),
    version: 1,
    slots: {}
  });
  return { lobbyId };
}

async function ensureLobby({db, api, lobbyId}){
  const mmRef = api.ref(db, LOBBY_MM_PATH(lobbyId));
  await api.runTransaction(mmRef, (mm)=>{
    if(mm === null){
      return { createdAt: Date.now(), updatedAt: Date.now(), version: 1, slots: {} };
    }
    mm.updatedAt = Date.now();
    mm.version = mm.version || 1;
    mm.slots = mm.slots || {};
    return mm;
  });
}

async function getOrCreateRoomKeyForSlot({db, api, lobbyId, slot}){
  const slotRef = api.ref(db, SLOT_PATH(lobbyId, slot));
  const tx = await api.runTransaction(slotRef, (v)=>{
    if(v === null){
      return { roomKey: makeId(10), createdAt: Date.now(), lastAssignedAt: Date.now() };
    }
    v.lastAssignedAt = Date.now();
    return v;
  });
  const val = tx.snapshot.exists() ? tx.snapshot.val() : null;
  if(!val || !val.roomKey) throw new Error("방 슬롯 생성 실패");
  return val.roomKey;
}

/**
 * 방 입장(2명 제한)
 * - meta.joined 에 pid 2개까지 허용
 * - players/{pid} 노드는 onDisconnect로 자동 제거
 */
export async function joinRoom({db, api, roomId, name, seed}){
  const pid = makeId(8);
  const metaRef = api.ref(db, META_PATH(roomId));
  const playersRef = api.ref(db, PLAYERS_PATH(roomId));
  const playerRef = api.ref(db, `${PLAYERS_PATH(roomId)}/${pid}`);
  const myStateRef = api.ref(db, `${STATES_PATH(roomId)}/${pid}`);

  const randomSeed = (seed ?? ((Math.random()*2**32)>>>0)) >>> 0;
  // 요청: 20행 기준 +3행 고정
  const desiredRows = 23;

  let joined = false;
  for(let attempt=0; attempt<2; attempt++){
    const tx = await api.runTransaction(metaRef, (meta)=>{
      if(meta === null){
        meta = {
          createdAt: Date.now(),
          updatedAt: Date.now(),
          seed: randomSeed,
          rows: desiredRows,
          state: "open",
          result: null,
          joined: {}
        };
      }
      meta.updatedAt = Date.now();
      meta.state = meta.state || "open";
      meta.seed = (meta.seed===undefined || meta.seed===null) ? randomSeed : (meta.seed>>>0);
      // rows는 항상 23으로 맞춤(공정/동일 화면)
      meta.rows = desiredRows;
      meta.joined = meta.joined || {};

      if(meta.state !== "open" && meta.state !== "playing") return meta;
      if(meta.joined[pid]) return meta;
      if(Object.keys(meta.joined).length >= 2) return meta;

      meta.joined[pid] = true;
      return meta;
    });

    const meta = tx.snapshot.exists() ? tx.snapshot.val() : null;
    if(meta && meta.joined && meta.joined[pid]){ joined = true; break; }

    // stale cleanup: players 모두 비었으면 meta 초기화 후 1회 재시도
    try{
      const ps = await api.get(playersRef);
      const players = ps.exists() ? (ps.val() || {}) : {};
      const now = Date.now();
      let live = 0;
      for(const k of Object.keys(players)){
        const last = players[k]?.lastSeen || 0;
        if(now - last <= 65000) live += 1;
      }
      if(live === 0){
        await api.remove(metaRef).catch(()=>{});
        continue;
      }
    }catch{}

    break;
  }

  if(!joined) throw new Error("방이 가득 찼습니다(2/2).");

  await api.set(playerRef, {
    name: name || "Player",
    joinedAt: Date.now(),
    lastSeen: Date.now(),
    alive: true
  });

  // Disconnect cleanup
  try{ await api.onDisconnect(playerRef).remove(); }catch{}
  try{ await api.onDisconnect(myStateRef).remove(); }catch{}

  // heartbeat
  const hbRef = api.ref(db, `${PLAYERS_PATH(roomId)}/${pid}/lastSeen`);
  const hbTimer = setInterval(()=>api.set(hbRef, Date.now()).catch(()=>{}), 15000);

  // final seed
  const metaSnap = await api.get(metaRef);
  const meta = metaSnap.exists() ? metaSnap.val() : null;
  const finalSeed = ((meta?.seed>>>0) || randomSeed || 1);

  return { pid, hbTimer, seed: finalSeed };
}

export async function joinLobby({db, api, lobbyId, name, maxTeams=10}){
  await ensureLobby({db, api, lobbyId});

  for(let slot=0; slot<maxTeams; slot++){
    const roomKey = await getOrCreateRoomKeyForSlot({db, api, lobbyId, slot});
    try{
      const j = await joinRoom({db, api, roomId: roomKey, name});
      return { roomId: roomKey, slot, ...j };
    }catch(e){
      const msg = String(e?.message||e||"");
      if(msg.includes("2/2")) continue;
      throw e;
    }
  }
  throw new Error("현재 모든 방이 사용 중입니다(10팀). 잠시 후 다시 시도해주세요.");
}

export function roomRefs({db, api, roomId}){
  return {
    metaRef: api.ref(db, META_PATH(roomId)),
    playersRef: api.ref(db, PLAYERS_PATH(roomId)),
    statesRef: api.ref(db, STATES_PATH(roomId)),
    eventsRef: api.ref(db, EVENTS_PATH(roomId))
  };
}

/**
 * meta + players 를 따로 구독해서 합친 room 객체를 넘깁니다.
 * (signals/{roomId} 루트는 rules 상 read 불가일 수 있음)
 */
export function watchRoom({db, api, roomId, onRoom}){
  const metaRef = api.ref(db, META_PATH(roomId));
  const playersRef = api.ref(db, PLAYERS_PATH(roomId));

  let meta = null;
  let players = null;

  const emit = ()=>{
    if(meta===null && players===null) return onRoom(null);
    onRoom({ meta: meta || null, players: players || {} });
  };

  const unsubMeta = api.onValue(metaRef, (snap)=>{ meta = snap.exists()?snap.val():null; emit(); });
  const unsubPlayers = api.onValue(playersRef, (snap)=>{ players = snap.exists()?snap.val():{}; emit(); });

  return ()=>{ try{ unsubMeta(); }catch{} try{ unsubPlayers(); }catch{} };
}

export async function setRoomState({api, metaRef}, state){
  await api.update(metaRef, { state, updatedAt: Date.now() });
}

export async function publishMyState({api, statesRef, pid, state}){
  // NOTE: firebase modular ref()는 (db, path) 형태가 기본이라
  // Reference+child는 child()를 사용합니다.
  await api.set(api.child(statesRef, pid), { ...state, t: Date.now() });
}

export function subscribeOppState({api, statesRef, pid, onOpp}){
  const unsub = api.onValue(statesRef, (snap)=>{
    if(!snap.exists()) return;
    const all = snap.val() || {};
    const keys = Object.keys(all).filter(k=>k!==pid);
    if(keys.length===0) return;
    onOpp({ pid: keys[0], state: all[keys[0]] });
  });
  return ()=>{ try{ unsub(); }catch{} };
}

export async function pushEvent({api, eventsRef, event}){
  await api.push(eventsRef, { ...event, t: Date.now() });
}

export function subscribeEvents({api, eventsRef, pid, onEvent}){
  const unsub = api.onValue(eventsRef, (snap)=>{
    if(!snap.exists()) return;
    const all = snap.val() || {};
    for(const k of Object.keys(all)){
      const ev = all[k];
      if(!ev || ev.from === pid) continue;
      onEvent({ key: k, ev });
    }
  });
  return ()=>{ try{ unsub(); }catch{} };
}

/**
 * 기록 남기지 않기: 방 관련 노드들을 개별 삭제
 */
export async function hardDeleteRoom({db, api, roomId}){
  await Promise.all([
    api.remove(api.ref(db, META_PATH(roomId))).catch(()=>{}),
    api.remove(api.ref(db, PLAYERS_PATH(roomId))).catch(()=>{}),
    api.remove(api.ref(db, STATES_PATH(roomId))).catch(()=>{}),
    api.remove(api.ref(db, EVENTS_PATH(roomId))).catch(()=>{})
  ]);
}

/**
 * 플레이어가 0명이면 방 데이터 삭제(best-effort)
 */
export async function tryCleanupRoom({db, api, roomId}){
  const playersRef = api.ref(db, PLAYERS_PATH(roomId));
  const snap = await api.get(playersRef);
  const players = snap.exists()? snap.val(): {};

  if(!players || Object.keys(players).length===0){
    await hardDeleteRoom({db, api, roomId});
    return true;
  }

  // stale player cleanup (best-effort)
  const now = Date.now();
  let changed = false;
  for(const k of Object.keys(players)){
    const p = players[k];
    const last = p?.lastSeen || 0;
    if(now - last > 60000){
      await api.remove(api.ref(db, `${PLAYERS_PATH(roomId)}/${k}`)).catch(()=>{});
      changed = true;
    }
  }

  if(changed){
    const snap2 = await api.get(playersRef);
    const p2 = snap2.exists()?snap2.val():{};
    if(!p2 || Object.keys(p2).length===0){
      await hardDeleteRoom({db, api, roomId});
      return true;
    }
  }

  return false;
}


/**
 * 슬롯 해제: 로비 mm/slots/{slot} 제거 + (가능하면) 로비 mm 자체도 비우기
 */
export async function releaseSlot({db, api, lobbyId, slot}){
  if(lobbyId===undefined || lobbyId===null) return;
  // slot이 없으면 "슬롯 제거"는 스킵하고, mm prune만 시도
  if(slot!==undefined && slot!==null){
    await api.remove(api.ref(db, SLOT_PATH(lobbyId, slot))).catch(()=>{});
  }
  // prune mm if all slots empty
  try{
    const slotsRef = api.ref(db, `${LOBBY_MM_PATH(lobbyId)}/slots`);
    const s = await api.get(slotsRef);
    const v = s.exists()? (s.val()||{}) : {};
    const any = Object.keys(v).some(k=>v[k] && v[k].roomKey);
    if(!any){
      await api.remove(api.ref(db, LOBBY_MM_PATH(lobbyId))).catch(()=>{});
    }
  }catch{}
}

/**
 * 로비 슬롯 정리: 비어있는/죽은 방을 삭제하고 슬롯도 비웁니다 (best-effort)
 */
export async function sweepLobbySlots({db, api, lobbyId, maxTeams=10}){
  const slotsRef = api.ref(db, `${LOBBY_MM_PATH(lobbyId)}/slots`);
  const snap = await api.get(slotsRef);
  const slots = snap.exists()? (snap.val()||{}) : {};
  const now = Date.now();

  for(let slot=0; slot<maxTeams; slot++){
    const sv = slots?.[slot];
    const roomKey = sv?.roomKey;
    if(!roomKey) continue;

    // Check players
    let players = null;
    try{
      const ps = await api.get(api.ref(db, PLAYERS_PATH(roomKey)));
      players = ps.exists()? (ps.val()||{}) : {};
    }catch{ players = null; }

    const keys = players ? Object.keys(players) : [];
    // determine liveness by heartbeat
    let live = 0;
    if(players){
      for(const k of keys){
        const last = players[k]?.lastSeen || 0;
        if(now - last <= 65000) live++;
      }
    }
    const assignedAt = sv?.lastAssignedAt || sv?.createdAt || 0;
    const stale = assignedAt && (now - assignedAt > 120000); // 2min
    const empty = !players || keys.length===0 || live===0;

    if(empty && stale){
      // delete room children + clear slot
      await hardDeleteRoom({db, api, roomId: roomKey}).catch(()=>{});
      await api.remove(api.ref(db, SLOT_PATH(lobbyId, slot))).catch(()=>{});
    }
  }

  // prune mm if nothing left
  try{
    const snap2 = await api.get(slotsRef);
    const v2 = snap2.exists()? (snap2.val()||{}) : {};
    const any = Object.keys(v2).some(k=>v2[k] && v2[k].roomKey);
    if(!any){
      await api.remove(api.ref(db, LOBBY_MM_PATH(lobbyId))).catch(()=>{});
    }
  }catch{}
}
