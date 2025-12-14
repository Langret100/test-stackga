import { makeId, nowMs } from "./firebase.js";

/**
 * 멀티 매칭(같은 링크로 여러 팀):
 * - 공유 링크는 ?lobby=XXXX 하나만 포함
 * - 접속자는 lobbies/{lobbyId}/slots/0..9 를 순서대로 확인하며,
 *   비어있거나(방 없음) / 현재 1명만 있는 방에 먼저 들어가 2인방을 구성합니다.
 * - 실제 게임 데이터는 rooms/{roomKey} 아래에 저장(2명 제한)
 * - 한 게임이 끝나면 rooms/{roomKey}는 삭제되어 기록이 남지 않습니다.
 * - 다음 접속자는 같은 slot의 동일 roomKey를 재사용하되(없으면 자동 재생성) 새 게임으로 시작됩니다.
 */

export function buildInvite(url, lobbyId){
  const full = url.includes("?") ? `${url}&lobby=${lobbyId}` : `${url}?lobby=${lobbyId}`;
  const qrText = `쌓기게임 초대 (0/2)\n${full}`;
  return { full, qrText };
}

export async function createLobby({db, api}){
  const lobbyId = makeId(10);
  const lobbyRef = api.ref(db, `lobbies/${lobbyId}`);
  await api.set(lobbyRef, {
    createdAt: nowMs(),
    updatedAt: api.serverTimestamp(),
    version: 1
  });
  return { lobbyId };
}

async function ensureLobby({db, api, lobbyId}){
  const lobbyRef = api.ref(db, `lobbies/${lobbyId}`);
  await api.runTransaction(lobbyRef, (lobby)=>{
    if(lobby === null){
      return { createdAt: Date.now(), updatedAt: Date.now(), version: 1 };
    }
    lobby.updatedAt = Date.now();
    lobby.version = lobby.version || 1;
    return lobby;
  });
}

async function getOrCreateRoomKeyForSlot({db, api, lobbyId, slot}){
  const slotRef = api.ref(db, `lobbies/${lobbyId}/slots/${slot}`);
  const tx = await api.runTransaction(slotRef, (v)=>{
    if(v === null){
      return {
        roomKey: makeId(10),
        createdAt: Date.now()
      };
    }
    // 그대로 유지
    return v;
  });
  const val = tx.snapshot.exists() ? tx.snapshot.val() : null;
  if(!val || !val.roomKey) throw new Error("방 슬롯 생성 실패");
  return val.roomKey;
}

/**
 * 방 입장(2명 제한). 방이 없으면 자동 생성.
 * @returns { pid, hbTimer, seed }
 */
export async function joinRoom({db, api, roomId, name, seed}){
  const pid = makeId(8);
  const playerRef = api.ref(db, `rooms/${roomId}/players/${pid}`);

  await api.runTransaction(api.ref(db, `rooms/${roomId}`), (room) => {
    // 방이 없으면 만들어서 1번 플레이어로 입장 허용
    if(room === null){
      room = {
        createdAt: Date.now(),
        updatedAt: Date.now(),
        seed: (seed ?? ((Math.random()*2**32)>>>0)),
        state: "open",
        players: {},
        result: null
      };
    }

    if(room.state && room.state !== "open" && room.state !== "playing") return room;

    room.players = room.players || {};
    const count = Object.keys(room.players).length;
    if(count >= 2) return room;

    room.players[pid] = {
      name: name || "Player",
      joinedAt: Date.now(),
      lastSeen: Date.now(),
      effect: "-",
      alive: true
    };
    room.updatedAt = Date.now();
    return room;
  });

  const snap = await api.get(api.ref(db, `rooms/${roomId}`));
  if(!snap.exists()) throw new Error("방을 찾을 수 없습니다.");
  const room = snap.val();
  const players = room.players || {};
  const isIn = !!players[pid];
  if(!isIn) throw new Error("방이 가득 찼습니다(2/2).");

  // onDisconnect 처리: 나가면 내 노드 제거
  const disc = api.onDisconnect(playerRef);
  await disc.remove();

  // heartbeat
  const hbRef = api.ref(db, `rooms/${roomId}/players/${pid}/lastSeen`);
  const hbTimer = setInterval(()=>api.set(hbRef, Date.now()).catch(()=>{}), 15000);

  return { pid, hbTimer, seed: (room.seed>>>0) };
}

/**
 * 같은 lobby 링크로 들어온 사용자들을 0..maxTeams-1 슬롯에 자동 배치합니다.
 * - 가능한 방이 있으면 즉시 배치
 * - 모든 방이 2/2면 에러(호출 측에서 PC 대전 fallback 처리)
 */
export async function joinLobby({db, api, lobbyId, name, maxTeams=10}){
  await ensureLobby({db, api, lobbyId});

  for(let slot=0; slot<maxTeams; slot++){
    const roomKey = await getOrCreateRoomKeyForSlot({db, api, lobbyId, slot});
    try{
      const j = await joinRoom({db, api, roomId: roomKey, name});
      return { roomId: roomKey, slot, ...j };
    }catch(e){
      const msg = String(e?.message||e||"");
      // 2/2면 다음 슬롯 시도
      if(msg.includes("2/2")) continue;
      // 그 외 오류는 바로 던지기
      throw e;
    }
  }
  throw new Error("현재 모든 방이 사용 중입니다(10팀). 잠시 후 다시 시도해주세요.");
}

export function watchRoom({db, api, roomId, onRoom}){
  const roomRef = api.ref(db, `rooms/${roomId}`);
  const unsub = api.onValue(roomRef, (snap)=>{
    onRoom(snap.exists()?snap.val():null);
  });
  return ()=>{ try{ unsub(); }catch{} };
}

export function roomRefs({db, api, roomId}){
  return {
    roomRef: api.ref(db, `rooms/${roomId}`),
    playersRef: api.ref(db, `rooms/${roomId}/players`),
    statesRef: api.ref(db, `rooms/${roomId}/states`),
    eventsRef: api.ref(db, `rooms/${roomId}/events`)
  };
}

export async function setRoomState({api, roomRef}, state){
  await api.update(roomRef, { state, updatedAt: Date.now() });
}

export async function publishMyState({api, statesRef, pid, state}){
  // state: { board, score, level, dead, effect }
  await api.set(api.ref(statesRef, pid), { ...state, t: Date.now() });
}

export function subscribeOppState({api, statesRef, pid, onOpp}){
  const unsub = api.onValue(statesRef, (snap)=>{
    if(!snap.exists()) return;
    const all = snap.val() || {};
    const keys = Object.keys(all).filter(k=>k!==pid);
    if(keys.length===0) return;
    // 상대는 1명만
    onOpp({ pid: keys[0], state: all[keys[0]] });
  });
  return ()=>{ try{ unsub(); }catch{} };
}

export async function pushEvent({api, eventsRef, pid, event}){
  // event: { type, payload }
  await api.push(eventsRef, { from: pid, ...event, t: Date.now() });
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

export async function tryCleanupRoom({db, api, roomId, pid}){
  // attempt to delete room if no players left
  const playersRef = api.ref(db, `rooms/${roomId}/players`);
  const roomRef = api.ref(db, `rooms/${roomId}`);
  const snap = await api.get(playersRef);
  const players = snap.exists()? snap.val(): {};
  if(!players || Object.keys(players).length===0){
    await api.remove(roomRef).catch(()=>{});
    return true;
  }

  // stale player cleanup (best-effort)
  const now = Date.now();
  let changed = false;
  for(const k of Object.keys(players)){
    const p = players[k];
    if(!p) continue;
    const last = p.lastSeen || 0;
    if(now - last > 60000){
      await api.remove(api.ref(db, `rooms/${roomId}/players/${k}`)).catch(()=>{});
      changed = true;
    }
  }
  if(changed){
    const snap2 = await api.get(playersRef);
    const p2 = snap2.exists()?snap2.val():{};
    if(!p2 || Object.keys(p2).length===0){
      await api.remove(roomRef).catch(()=>{});
      return true;
    }
  }
  return false;
}
