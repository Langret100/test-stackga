/**
 * Firebase 실시간 멀티플레이 서비스
 * stackga 프로젝트의 netplay.js 구조를 TypeScript로 이식
 */

// Firebase 설정 (stackga 프로젝트와 동일 DB 재사용)
const FIREBASE_CONFIG = {
  apiKey: "__FIREBASE_API_KEY__",
  authDomain: "web-ghost-c447b.firebaseapp.com",
  databaseURL: "https://web-ghost-c447b-default-rtdb.firebaseio.com",
  projectId: "web-ghost-c447b",
  storageBucket: "web-ghost-c447b.firebasestorage.app",
  messagingSenderId: "198377381878",
  appId: "1:198377381878:web:83b56b1b4d63138d27b1d7"
};

// Firebase CDN 모듈 타입
type FirebaseDB = any;
type FirebaseAPI = any;

let _db: FirebaseDB | null = null;
let _api: FirebaseAPI | null = null;
let _initialized = false;

export interface FirebaseServices {
  db: FirebaseDB;
  api: FirebaseAPI;
}

export async function initFirebase(): Promise<FirebaseServices | null> {
  if (_initialized && _db && _api) return { db: _db, api: _api };
  try {
    const { initializeApp } = await import("https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js" as any);
    const {
      getDatabase, ref, set, get, update, remove,
      onValue, onDisconnect, serverTimestamp, push, child, runTransaction, off
    } = await import("https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js" as any);

    const cfg = (typeof window !== 'undefined' && (window as any).MATH_FIREBASE_CONFIG)
      ? (window as any).MATH_FIREBASE_CONFIG
      : FIREBASE_CONFIG;

    const app = initializeApp(cfg, 'math-slingshot-' + Date.now());
    _db = getDatabase(app);
    _api = { ref, set, get, update, remove, onValue, onDisconnect, serverTimestamp, push, child, runTransaction, off };
    _initialized = true;
    return { db: _db, api: _api };
  } catch (e) {
    console.error('Firebase init failed:', e);
    return null;
  }
}

// ── Path helpers ──────────────────────────────────────────────────────────────
const LOBBY_PATH  = (lid: string) => `signals/${lid}/mm`;
const SLOT_PATH   = (lid: string, slot: number) => `signals/${lid}/mm/slots/${slot}`;
const META_PATH   = (rid: string) => `signals/${rid}/meta`;
const PLAYERS_PATH= (rid: string) => `signals/${rid}/players`;
const STATES_PATH = (rid: string) => `signals/${rid}/states`;

function makeId(len = 10): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const arr = new Uint32Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr, v => chars[v % chars.length]).join('');
}

export function stableLobbyId(suffix = 'mathslng'): string {
  const s = (typeof location !== 'undefined' ? location.origin + location.pathname : 'math-slingshot') + suffix;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return 'mathslng_' + (h >>> 0).toString(36);
}

async function ensureLobby({ db, api, lobbyId }: FirebaseServices & { lobbyId: string }) {
  const mmRef = api.ref(db, LOBBY_PATH(lobbyId));
  await api.runTransaction(mmRef, (mm: any) => {
    if (mm === null) return { createdAt: Date.now(), updatedAt: Date.now(), version: 1, slots: {} };
    mm.updatedAt = Date.now();
    mm.slots = mm.slots || {};
    return mm;
  });
}

async function getOrCreateRoomKey({ db, api, lobbyId, slot }: FirebaseServices & { lobbyId: string; slot: number }): Promise<string> {
  const slotRef = api.ref(db, SLOT_PATH(lobbyId, slot));
  const tx = await api.runTransaction(slotRef, (v: any) => {
    if (v === null) return { roomKey: makeId(10), createdAt: Date.now(), lastAssignedAt: Date.now() };
    v.lastAssignedAt = Date.now();
    return v;
  });
  const val = tx.snapshot.exists() ? tx.snapshot.val() : null;
  if (!val?.roomKey) throw new Error('슬롯 생성 실패');
  return val.roomKey;
}

export interface JoinResult {
  pid: string;
  hbTimer: ReturnType<typeof setInterval>;
  seed: number;
  roomId: string;
  slot: number;
}

async function joinRoom({ db, api, roomId, name }: FirebaseServices & { roomId: string; name?: string }): Promise<Omit<JoinResult, 'roomId' | 'slot'>> {
  const pid = makeId(8);
  const metaRef   = api.ref(db, META_PATH(roomId));
  const playerRef = api.ref(db, `${PLAYERS_PATH(roomId)}/${pid}`);
  const myStateRef= api.ref(db, `${STATES_PATH(roomId)}/${pid}`);
  const randomSeed = (Math.random() * 2 ** 32) >>> 0;

  let joined = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const tx = await api.runTransaction(metaRef, (meta: any) => {
      if (meta === null) meta = { createdAt: Date.now(), updatedAt: Date.now(), seed: randomSeed, state: 'open', joined: {} };
      meta.updatedAt  = Date.now();
      meta.state      = meta.state || 'open';
      meta.seed       = (meta.seed === undefined || meta.seed === null) ? randomSeed : (meta.seed >>> 0);
      meta.joined     = meta.joined || {};
      if (meta.state !== 'open' && meta.state !== 'playing') return meta;
      if (meta.joined[pid]) return meta;
      if (Object.keys(meta.joined).length >= 2) return meta;
      meta.joined[pid] = true;
      return meta;
    });
    const meta = tx.snapshot.exists() ? tx.snapshot.val() : null;
    if (meta?.joined?.[pid]) { joined = true; break; }

    try {
      const ps = await api.get(api.ref(db, PLAYERS_PATH(roomId)));
      const players = ps.exists() ? (ps.val() || {}) : {};
      const now = Date.now();
      const live = Object.keys(players).filter((k: string) => (now - (players[k]?.lastSeen || 0)) <= 65000).length;
      if (live === 0) { await api.remove(metaRef).catch(() => {}); continue; }
    } catch {}
    break;
  }
  if (!joined) throw new Error('방 가득(2/2)');

  await api.set(playerRef, { name: name || 'Player', joinedAt: Date.now(), lastSeen: Date.now(), alive: true });
  try { await api.onDisconnect(playerRef).remove(); } catch {}
  try { await api.onDisconnect(myStateRef).remove(); } catch {}

  const hbTimer = setInterval(() => api.set(api.ref(db, `${PLAYERS_PATH(roomId)}/${pid}/lastSeen`), Date.now()).catch(() => {}), 15000);

  const metaSnap = await api.get(metaRef);
  const finalMeta = metaSnap.exists() ? metaSnap.val() : null;
  const seed = ((finalMeta?.seed >>> 0) || randomSeed || 1);

  return { pid, hbTimer, seed };
}

export async function joinLobby(svc: FirebaseServices & { lobbyId: string; name?: string; maxTeams?: number }): Promise<JoinResult> {
  const { lobbyId, maxTeams = 10 } = svc;
  await ensureLobby({ ...svc, lobbyId });

  for (let slot = 0; slot < maxTeams; slot++) {
    const roomKey = await getOrCreateRoomKey({ ...svc, lobbyId, slot });
    try {
      const j = await joinRoom({ ...svc, roomId: roomKey });
      return { ...j, roomId: roomKey, slot };
    } catch (e: any) {
      if (String(e?.message || '').includes('2/2')) continue;
      throw e;
    }
  }
  throw new Error('모든 방 사용 중');
}

// ── Room watching ─────────────────────────────────────────────────────────────
export interface RoomData {
  meta: any;
  players: Record<string, any>;
}

export function watchRoom(svc: FirebaseServices & { roomId: string; onRoom: (r: RoomData | null) => void }) {
  const { db, api, roomId, onRoom } = svc;
  let meta: any = null, players: any = null;
  const emit = () => onRoom(meta === null && players === null ? null : { meta: meta || null, players: players || {} });
  const u1 = api.onValue(api.ref(db, META_PATH(roomId)),    (s: any) => { meta    = s.exists() ? s.val() : null; emit(); });
  const u2 = api.onValue(api.ref(db, PLAYERS_PATH(roomId)), (s: any) => { players = s.exists() ? s.val() : {};   emit(); });
  return () => { try { u1(); } catch {} try { u2(); } catch {} };
}

export async function setRoomState(svc: FirebaseServices & { roomId: string }, state: string) {
  const { db, api, roomId } = svc;
  await api.update(api.ref(db, META_PATH(roomId)), { state, updatedAt: Date.now() });
}

// ── State sync ────────────────────────────────────────────────────────────────
export async function publishMyState(svc: FirebaseServices & { roomId: string; pid: string; state: any }) {
  const { db, api, roomId, pid, state } = svc;
  await api.set(api.ref(db, `${STATES_PATH(roomId)}/${pid}`), { ...state, t: Date.now() });
}

export function subscribeOppState(svc: FirebaseServices & { roomId: string; pid: string; onOpp: (r: any) => void }) {
  const { db, api, roomId, pid, onOpp } = svc;
  const unsub = api.onValue(api.ref(db, STATES_PATH(roomId)), (snap: any) => {
    if (!snap.exists()) return;
    const all = snap.val() || {};
    const keys = Object.keys(all).filter((k: string) => k !== pid);
    if (keys.length === 0) return;
    onOpp({ pid: keys[0], state: all[keys[0]] });
  });
  return () => { try { unsub(); } catch {} };
}

// ── Cleanup ───────────────────────────────────────────────────────────────────
export async function removePlayer(svc: FirebaseServices & { roomId: string; pid: string }) {
  const { db, api, roomId, pid } = svc;
  await Promise.all([
    api.remove(api.ref(db, `${PLAYERS_PATH(roomId)}/${pid}`)).catch(() => {}),
    api.remove(api.ref(db, `${STATES_PATH(roomId)}/${pid}`)).catch(() => {}),
  ]);
}

export async function sweepLobbySlots(svc: FirebaseServices & { lobbyId: string; maxTeams?: number }) {
  const { db, api, lobbyId, maxTeams = 10 } = svc;
  const slotsRef = api.ref(db, `${LOBBY_PATH(lobbyId)}/slots`);
  try {
    const snap = await api.get(slotsRef);
    const slots = snap.exists() ? (snap.val() || {}) : {};
    const now = Date.now();
    for (let slot = 0; slot < maxTeams; slot++) {
      const sv = slots?.[slot];
      const roomKey = sv?.roomKey;
      if (!roomKey) continue;
      try {
        const ps = await api.get(api.ref(db, PLAYERS_PATH(roomKey)));
        const players = ps.exists() ? (ps.val() || {}) : {};
        const live = Object.keys(players).filter((k: string) => (now - (players[k]?.lastSeen || 0)) <= 65000).length;
        const stale = sv?.lastAssignedAt && (now - sv.lastAssignedAt > 120000);
        if (live === 0 && stale) {
          await Promise.all([
            PLAYERS_PATH, META_PATH, STATES_PATH
          ].map(fn => api.remove(api.ref(db, fn(roomKey))).catch(() => {})));
          await api.remove(api.ref(db, SLOT_PATH(lobbyId, slot))).catch(() => {});
        }
      } catch {}
    }
  } catch {}
}
