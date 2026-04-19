/**
 * 매스 슬링샷 — 구구단/나눗셈 학습용 버블 슈터
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Point, Bubble, Particle, BubbleColor, GameMode } from '../types';
import { Loader2, Trophy, Zap, RefreshCw, X, Users, Infinity as InfinityIcon } from 'lucide-react';
import {
  initFirebase, joinLobby, watchRoom, setRoomState,
  publishMyState, subscribeOppState, removePlayer,
  sweepLobbySlots, stableLobbyId, JoinResult, FirebaseServices
} from '../services/firebaseService';

// ─── Constants ────────────────────────────────────────────────────────────────
const PINCH_THRESHOLD         = 0.12;
const BUBBLE_RADIUS_MAX       = 29;
const BUBBLE_RADIUS_MIN       = 18;
const GRID_COLS               = 11;
const MAX_BUBBLES_PER_ROW     = 6;
const INIT_ROWS               = 2;
const GRID_ROWS               = 8;
const SLINGSHOT_BOTTOM_OFFSET = 260; // 큐UI(90) + 구슬2개(~120) + 여유(50)

// 화면 너비에 맞는 구슬 반지름 계산 (모바일 대응)
const calcRadius = (width: number): number => {
  // GRID_COLS=11칸 + 양쪽 여백이 r씩 → 전체 = (11*2 + 1)*r = 23r
  const r = Math.floor(width / 23);
  return Math.max(BUBBLE_RADIUS_MIN, Math.min(BUBBLE_RADIUS_MAX, r));
};
// 렌더링 시 동적으로 쓸 수 있도록 전역 캐시
let BUBBLE_RADIUS = BUBBLE_RADIUS_MAX;
let ROW_HEIGHT = BUBBLE_RADIUS * Math.sqrt(3);
const MAX_DRAG_DIST           = 180;
const MIN_FORCE_MULT          = 0.18;
const MAX_FORCE_MULT          = 0.54;
const MAX_PARTICLES           = 150;
const FALL_GRAVITY            = 0.45;
const QUEUE_SIZE              = 3; // 다음 구슬 큐 크기

const getDropInterval = (elapsedMs: number): number => {
  const periods = Math.floor(elapsedMs / 20000);
  return Math.max(7000, 12000 - periods * 1000);
};

// ─── Math data ────────────────────────────────────────────────────────────────
const ANSWER_COLOR_MAP: Record<number, BubbleColor> = {
  6:'red', 8:'blue', 9:'green', 12:'yellow',
  15:'purple', 16:'orange', 18:'red', 24:'blue', 27:'green', 36:'yellow',
};
const EXPRESSION_POOL: Record<number, string[]> = {
  6:  ['2×3','3×2','6÷1','6'],
  8:  ['2×4','4×2','8÷2','8'],
  9:  ['3×3','9÷1','9'],
  12: ['3×4','4×3','2×6','12'],
  15: ['3×5','5×3','15÷3','15'],
  16: ['4×4','2×8','8×2','16'],
  18: ['3×6','6×3','2×9','18'],
  24: ['4×6','6×4','3×8','24'],
  27: ['3×9','9×3','27÷3','27'],
  36: ['4×9','9×4','6×6','36'],
};
const ANSWER_POOL = [6,8,9,12,15,16,18,24,27,36];
const COLOR_CONFIG: Record<BubbleColor, {hex:string;dark:string;points:number;label:string}> = {
  red:    {hex:'#ff6b6b',dark:'#c0392b',points:100,label:'빨강'},
  blue:   {hex:'#4fc3f7',dark:'#0277bd',points:150,label:'파랑'},
  green:  {hex:'#81c784',dark:'#2e7d32',points:200,label:'초록'},
  yellow: {hex:'#fff176',dark:'#f57f17',points:250,label:'노랑'},
  purple: {hex:'#ce93d8',dark:'#6a1b9a',points:300,label:'보라'},
  orange: {hex:'#ffb74d',dark:'#e65100',points:350,label:'주황'},
};

interface FallingBubble { x:number;y:number;vy:number;color:BubbleColor;expression:string;alpha:number; }
// 구슬 큐 아이템
interface BubbleQueueItem { answer:number; color:BubbleColor; expression:string; }

// ─── Helpers ──────────────────────────────────────────────────────────────────
const adj = (color:string, amt:number) => {
  const hex=color.replace('#','');
  const c=(o:number)=>Math.max(0,Math.min(255,parseInt(hex.slice(o,o+2),16)+amt));
  return '#'+[c(0),c(2),c(4)].map(v=>v.toString(16).padStart(2,'0')).join('');
};
const rndExpr = (a:number) => {
  const p=EXPRESSION_POOL[a]||[String(a)];
  return p[Math.floor(Math.random()*p.length)];
};
const rndAnswer = () => ANSWER_POOL[Math.floor(Math.random()*ANSWER_POOL.length)];
const makeQueueItem = (): BubbleQueueItem => {
  const ans = rndAnswer();
  return { answer:ans, color:ANSWER_COLOR_MAP[ans]||'red', expression:rndExpr(ans) };
};

// ─── Marble sprite cache (오프스크린 캔버스 캐시 — 색+반지름 조합당 1회 생성) ────
const marbleCache = new Map<string, HTMLCanvasElement>();
const getMarbleSprite = (r:number, color:BubbleColor, isHard:boolean): HTMLCanvasElement => {
  const key = `${r}_${color}_${isHard?1:0}`;
  const cached = marbleCache.get(key);
  if(cached) return cached;

  const pad = 10; // 그림자 번짐 여유
  const size = (r + pad) * 2;
  const oc = document.createElement('canvas');
  oc.width = size; oc.height = size;
  const oc2 = oc.getContext('2d')!;
  const cx = size/2, cy = size/2;

  const cfg = COLOR_CONFIG[color];
  const base = isHard ? '#5c5c7a' : cfg.hex;
  const dark = isHard ? '#2a2a44' : cfg.dark;

  // 그림자 (캐시 안에서 한 번만)
  oc2.shadowColor = `${dark}99`;
  oc2.shadowBlur = 6;
  oc2.shadowOffsetX = 2;
  oc2.shadowOffsetY = 3;

  // 본체 그라데이션
  const g = oc2.createRadialGradient(cx-r*.3, cy-r*.3, r*.05, cx, cy, r);
  g.addColorStop(0,'#ffffff'); g.addColorStop(0.2, adj(base,50));
  g.addColorStop(0.7, base); g.addColorStop(1, dark);
  const sphereAlpha = isHard ? 0.82 : 0.78;
  oc2.globalAlpha = sphereAlpha;
  oc2.beginPath(); oc2.arc(cx,cy,r,0,Math.PI*2); oc2.fillStyle=g; oc2.fill();

  // 그림자 끄고 테두리/하이라이트
  oc2.shadowColor = 'transparent'; oc2.shadowBlur = 0; oc2.shadowOffsetX = 0; oc2.shadowOffsetY = 0;
  oc2.strokeStyle=dark+'66'; oc2.lineWidth=1; oc2.stroke();

  // 하이라이트
  const hg = oc2.createRadialGradient(cx-r*.32, cy-r*.38, 0, cx-r*.2, cy-r*.2, r*.5);
  hg.addColorStop(0,'rgba(255,255,255,0.7)'); hg.addColorStop(1,'rgba(255,255,255,0)');
  oc2.beginPath(); oc2.arc(cx,cy,r,0,Math.PI*2); oc2.fillStyle=hg; oc2.fill();

  marbleCache.set(key, oc);
  return oc;
};

// ─── Marble drawing ───────────────────────────────────────────────────────────
const drawMarble = (
  ctx:CanvasRenderingContext2D,
  x:number,y:number,r:number,
  color:BubbleColor,expression:string,
  isHard:boolean,alpha=1.0,sx=0,sy=0
) => {
  const cx=x+sx, cy=y+sy;
  const sprite = getMarbleSprite(r, color, isHard);
  const size = sprite.width;

  ctx.save();
  if(alpha<1) ctx.globalAlpha=alpha;
  ctx.drawImage(sprite, cx - size/2, cy - size/2);

  // 텍스트 (매번 그려야 하지만 shadowBlur 없이)
  const cfg = COLOR_CONFIG[color];
  const dark = isHard ? '#2a2a44' : cfg.dark;
  ctx.globalAlpha = alpha;
  const len=expression.length;
  const fs=len<=2?r*.78:len<=4?r*.60:len<=6?r*.50:r*.42;
  ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.font=`900 ${fs}px 'Arial Black',sans-serif`;
  ctx.strokeStyle=`${dark}99`; ctx.lineWidth=fs*.18; ctx.lineJoin='round';
  ctx.strokeText(expression,cx,cy+fs*.04);
  ctx.fillStyle=isHard?'rgba(210,210,255,0.95)':'rgba(255,255,255,0.95)';
  ctx.fillText(expression,cx,cy+fs*.04);
  ctx.restore();
};

// ─── Slingshot gradient cache ────────────────────────────────────────────────
let _slingshotCache: {ax:number;ay:number;poleG:CanvasGradient;lgG:CanvasGradient;rgG:CanvasGradient}|null = null;

// ─── Slingshot drawing (개선된 디자인) ───────────────────────────────────────
const drawSlingshot = (
  ctx:CanvasRenderingContext2D,
  anchor:Point, ball:Point, canvasH:number,
  isPinching:boolean, isFlying:boolean
) => {
  const ax=anchor.x, ay=anchor.y;

  // 그라데이션 캐시 (anchor 위치가 바뀌지 않으면 재사용)
  if(!_slingshotCache || _slingshotCache.ax!==ax || _slingshotCache.ay!==ay){
    const poleG=ctx.createLinearGradient(ax-6,0,ax+6,0);
    poleG.addColorStop(0,'#5d4037'); poleG.addColorStop(0.4,'#8d6e63'); poleG.addColorStop(1,'#4e342e');
    const lgG=ctx.createLinearGradient(ax,ay+38,ax-42,ay);
    lgG.addColorStop(0,'#6d4c41'); lgG.addColorStop(1,'#4e342e');
    const rgG=ctx.createLinearGradient(ax,ay+38,ax+42,ay);
    rgG.addColorStop(0,'#6d4c41'); rgG.addColorStop(1,'#4e342e');
    _slingshotCache={ax,ay,poleG,lgG,rgG};
  }
  const {poleG,lgG,rgG}=_slingshotCache;

  ctx.save();
  ctx.lineCap='round';
  // 나무 기둥
  ctx.strokeStyle=poleG; ctx.lineWidth=12;
  ctx.beginPath(); ctx.moveTo(ax,canvasH); ctx.lineTo(ax,ay+38); ctx.stroke();
  // 왼쪽 가지
  ctx.strokeStyle=lgG; ctx.lineWidth=9;
  ctx.beginPath(); ctx.moveTo(ax,ay+38); ctx.lineTo(ax-42,ay); ctx.stroke();
  // 오른쪽 가지
  ctx.strokeStyle=rgG; ctx.lineWidth=9;
  ctx.beginPath(); ctx.moveTo(ax,ay+38); ctx.lineTo(ax+42,ay); ctx.stroke();
  // 가지 끝 나무 마디
  ctx.fillStyle='#5d4037';
  ctx.beginPath(); ctx.arc(ax-42,ay,5,0,Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.arc(ax+42,ay,5,0,Math.PI*2); ctx.fill();
  ctx.restore();

  if(!isFlying){
    const band=isPinching?'#fdd835':'#bcaaa4';
    const bandW=isPinching?5:4;
    ctx.save();
    ctx.lineCap='round';
    ctx.strokeStyle=band; ctx.lineWidth=bandW;
    // 뒤 고무줄
    ctx.beginPath(); ctx.moveTo(ax-42,ay); ctx.lineTo(ball.x,ball.y); ctx.stroke();
    // 앞 고무줄
    ctx.beginPath(); ctx.moveTo(ball.x,ball.y); ctx.lineTo(ax+42,ay); ctx.stroke();
    ctx.restore();

    if(isPinching){
      ctx.save();
      ctx.fillStyle='rgba(101,67,33,0.6)';
      ctx.beginPath(); ctx.ellipse(ball.x,ball.y,BUBBLE_RADIUS+4,BUBBLE_RADIUS*0.6,0,0,Math.PI*2);
      ctx.fill(); ctx.restore();
    }
  }
};

const drawOpponentBoard = (
  ctx:CanvasRenderingContext2D,
  opp:{x:number;y:number;color:BubbleColor;expression:string}[],
  x:number,y:number,w:number,h:number
) => {
  ctx.save();
  ctx.fillStyle='rgba(10,10,30,0.85)'; ctx.strokeStyle='rgba(100,150,255,0.4)'; ctx.lineWidth=1.5;
  const rd=8;
  ctx.beginPath();
  ctx.moveTo(x+rd,y); ctx.lineTo(x+w-rd,y); ctx.quadraticCurveTo(x+w,y,x+w,y+rd);
  ctx.lineTo(x+w,y+h-rd); ctx.quadraticCurveTo(x+w,y+h,x+w-rd,y+h);
  ctx.lineTo(x+rd,y+h); ctx.quadraticCurveTo(x,y+h,x,y+h-rd);
  ctx.lineTo(x,y+rd); ctx.quadraticCurveTo(x,y,x+rd,y);
  ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.fillStyle='rgba(100,180,255,0.7)'; ctx.font='bold 10px sans-serif'; ctx.textAlign='center';
  ctx.fillText('상대방',x+w/2,y+14);
  ctx.beginPath(); ctx.rect(x+2,y+20,w-4,h-24); ctx.clip();
  const scale=(w-8)/500;
  for(const b of opp){
    const bx=x+4+b.x*scale,by=y+20+b.y*scale,br=Math.max(4,BUBBLE_RADIUS*scale*1.2);
    if(bx<x||bx>x+w||by<y+20||by>y+h) continue;
    drawMarble(ctx,bx,by,br,b.color,b.expression,false,0.9);
  }
  ctx.restore();
};

type MultiStatus = 'idle'|'searching'|'matched'|'playing';
type GamePhase   = 'start'|'countdown'|'playing'|'over';
type GameModeType = 'normal'|'endless'; // normal=기존, endless=무제한

// ─── Component ────────────────────────────────────────────────────────────────
const MathSlingshot: React.FC = () => {
  const videoRef         = useRef<HTMLVideoElement>(null);
  const canvasRef        = useRef<HTMLCanvasElement>(null);
  const gameContainerRef = useRef<HTMLDivElement>(null);

  const ballPos     = useRef<Point>({x:0,y:0});
  const ballVel     = useRef<Point>({x:0,y:0});
  const anchorPos   = useRef<Point>({x:0,y:0});
  const isPinching  = useRef(false);
  const isFlying    = useRef(false);
  const flightStart = useRef(0);
  const bubbles     = useRef<Bubble[]>([]);
  const particles   = useRef<Particle[]>([]);
  const fallingBubbles = useRef<FallingBubble[]>([]);
  const scoreRef    = useRef(0);

  // 발사 구슬 큐 (현재 + 다음 2개)
  const bubbleQueueRef = useRef<BubbleQueueItem[]>([]);

  const gameModeRef       = useRef<GameMode>('easy');
  const gameModeTypeRef   = useRef<GameModeType>('normal');
  const downLandCountRef  = useRef(0); // 아래로 실제 착지 횟수
  const gameStartTimeRef  = useRef(0);
  const lastDropTimeRef   = useRef(0);
  const isGameOverRef     = useRef(false);
  const dustParticles     = useRef<Particle[]>([]);
  const shakeTimeRef      = useRef(0);
  const gamePhaseRef      = useRef<GamePhase>('start');
  const waveOffsetRef     = useRef(0);
  const frameCountRef     = useRef(0);
  const rafRef            = useRef<number>(0);

  const touchActiveRef      = useRef(false);
  const touchPosRef         = useRef<Point>({x:0,y:0});
  // MediaPipe에서 추출한 최신 손 정보 (rAF 루프에서 사용)
  const latestHandPos       = useRef<Point|null>(null);
  const latestPinchDist     = useRef<number>(1.0);
  const latestLandmarks     = useRef<any>(null);
  // 손 위치 스무딩 (EMA)
  const smoothHandPos       = useRef<Point|null>(null);
  const smoothPinchDist     = useRef<number>(1.0);

  const fbRef           = useRef<FirebaseServices|null>(null);
  const joinResultRef   = useRef<JoinResult|null>(null);
  const multiStatusRef  = useRef<MultiStatus>('idle');
  const oppBubblesRef   = useRef<{x:number;y:number;color:BubbleColor;expression:string}[]>([]);
  const roomUnsubRef    = useRef<(()=>void)|null>(null);
  const oppUnsubRef     = useRef<(()=>void)|null>(null);
  const publishTimerRef = useRef<ReturnType<typeof setInterval>|null>(null);

  const [loading,           setLoading]          = useState(true);
  const [score,             setScore]            = useState(0);
  const [gameMode,          setGameMode]         = useState<GameMode>('easy');
  const [showHardNotif,     setShowHardNotif]    = useState(false);
  const [isGameOver,        setIsGameOver]       = useState(false);
  const [finalScore,        setFinalScore]       = useState(0);
  const [gamePhase,         setGamePhase]        = useState<GamePhase>('start');
  const [countdownNum,      setCountdownNum]     = useState(3);
  const [multiStatus,       setMultiStatus]      = useState<MultiStatus>('idle');
  const [showMatchedBanner, setShowMatchedBanner]= useState(false);
  const [gameModeType,      setGameModeType]     = useState<GameModeType>('normal');
  // 큐 UI용 state (렌더링용)
  const [queueDisplay,      setQueueDisplay]     = useState<BubbleQueueItem[]>([]);
  const [downLandCount,     setDownLandCount]    = useState(0);
  const [showCombo,         setShowCombo]        = useState(false);
  const [comboText,         setComboText]        = useState('');

  useEffect(()=>{ gameModeRef.current=gameMode; },[gameMode]);
  useEffect(()=>{ gamePhaseRef.current=gamePhase; },[gamePhase]);
  useEffect(()=>{ multiStatusRef.current=multiStatus; },[multiStatus]);
  useEffect(()=>{ gameModeTypeRef.current=gameModeType; },[gameModeType]);

  // ── 큐 초기화 ─────────────────────────────────────────────────────────────
  const initQueue = useCallback(()=>{
    const q = Array.from({length:QUEUE_SIZE+1}, makeQueueItem);
    bubbleQueueRef.current = q;
    setQueueDisplay(q.slice(1, QUEUE_SIZE+1)); // 다음 3개만 표시
  },[]);

  // 큐에서 구슬 하나 꺼내고 새 구슬 추가
  const dequeueAndRefill = useCallback(()=>{
    const q = bubbleQueueRef.current;
    q.shift();                     // 현재 구슬 소비
    q.push(makeQueueItem());       // 뒤에 새 구슬 추가
    bubbleQueueRef.current = [...q];
    setQueueDisplay(q.slice(1, QUEUE_SIZE+1));
  },[]);

  const currentBubble = () => bubbleQueueRef.current[0] || makeQueueItem();

  // ── Grid ──────────────────────────────────────────────────────────────────
  const getBubblePos = (row:number,col:number,width:number) => {
    const r=calcRadius(width);
    const rh=r*Math.sqrt(3);
    const xOffset=(width-GRID_COLS*r*2)/2+r;
    return {
      x: xOffset+col*(r*2)+(row%2!==0?r:0),
      y: r+row*rh,
    };
  };

  const makeRow = (row:number,width:number): Bubble[] => {
    const maxCols=row%2!==0?GRID_COLS-1:GRID_COLS;
    // 중앙 col 기준으로 후보 선택 (중앙 쪽 우선)
    const center=Math.floor(maxCols/2);
    const allCols=Array.from({length:maxCols},(_,i)=>i);
    // 중앙에서 가까운 순으로 정렬
    allCols.sort((a,b)=>Math.abs(a-center)-Math.abs(b-center));
    // 앞쪽(중앙 가까운) 8개 중에서 MAX_BUBBLES_PER_ROW개 랜덤 선택
    const pool=allCols.slice(0,Math.min(8,maxCols));
    for(let i=pool.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[pool[i],pool[j]]=[pool[j],pool[i]];}
    const chosen=pool.slice(0,MAX_BUBBLES_PER_ROW).sort((a,b)=>a-b);
    return chosen.map(c=>{
      const {x,y}=getBubblePos(row,c,width);
      const ans=rndAnswer();
      return {id:`${row}-${c}-${Date.now()}-${Math.random().toString(36).slice(2)}`,row,col:c,x,y,
        color:ANSWER_COLOR_MAP[ans]||'red',answer:ans,expression:rndExpr(ans),active:true};
    });
  };

  const isNeighbor=(a:Bubble,b:Bubble)=>{
    const dr=b.row-a.row,dc=b.col-a.col;
    if(Math.abs(dr)>1) return false;
    if(dr===0) return Math.abs(dc)===1;
    return a.row%2!==0?(dc===0||dc===1):(dc===-1||dc===0);
  };

  const dropFloatingBubbles=useCallback(()=>{
    const active=bubbles.current.filter(b=>b.active);
    if(active.length===0) return;
    // 가장 위에 있는 row를 천장 연결로 간주
    const minRow=Math.min(...active.map(b=>b.row));
    const connected=new Set<string>();
    const queue=active.filter(b=>b.row===minRow);
    queue.forEach(b=>connected.add(b.id));
    let qi=0;
    while(qi<queue.length){
      const cur=queue[qi++];
      active.filter(b=>!connected.has(b.id)&&isNeighbor(cur,b))
        .forEach(b=>{connected.add(b.id);queue.push(b);});
    }
    const toFall=active.filter(b=>!connected.has(b.id));
    toFall.forEach(b=>{
      b.active=false;
      fallingBubbles.current.push({x:b.x,y:b.y,vy:1+Math.random()*2,color:b.color,expression:b.expression,alpha:1.0});
    });
    if(toFall.length>0) bubbles.current=bubbles.current.filter(b=>b.active);
  },[]);

  const createDust=(cw:number,activeBubbles:Bubble[])=>{
    if(dustParticles.current.length>60) return;
    // 구슬이 있는 x 범위에서만 먼지 생성
    if(activeBubbles.length===0) return;
    const xs=activeBubbles.map(b=>b.x);
    const minX=Math.min(...xs)-BUBBLE_RADIUS;
    const maxX=Math.max(...xs)+BUBBLE_RADIUS;
    for(let i=0;i<20;i++){
      const px=minX+Math.random()*(maxX-minX);
      dustParticles.current.push({
        x:px, y:BUBBLE_RADIUS*2+Math.random()*8,
        vx:(Math.random()-.5)*2.5, vy:Math.random()*1.2+0.2,
        life:.6+Math.random()*.4, color:`hsl(${40+Math.random()*20},50%,65%)`,
      });
    }
  };

  const createExplosion=(x:number,y:number,color:string,big=false)=>{
    if(particles.current.length>MAX_PARTICLES) return;
    const n=big?20:12,sp=big?18:14;
    for(let i=0;i<n;i++) particles.current.push({x,y,vx:(Math.random()-.5)*sp,vy:(Math.random()-.5)*sp,life:1.0,color});
    for(let i=0;i<6;i++) particles.current.push({x,y,vx:(Math.random()-.5)*8,vy:-Math.random()*12-3,life:1.3,color:'#fff'});
  };

  const checkMatches=useCallback((start:Bubble)=>{
    const mult=gameModeRef.current==='hard'?1.5:1.0;
    let didExplode=false;

    // ── 규칙A: 같은 정답 → 닿은 구슬 2개면 즉시 터짐 (색 무관) ──
    // start와 인접한 구슬 중 같은 정답인 것 모두 수집 (BFS)
    const sameAns=new Set<string>([start.id]);
    const qa=[start]; let qi=0;
    while(qi<qa.length){
      const cur=qa[qi++];
      bubbles.current.filter(b=>b.active&&!sameAns.has(b.id)&&isNeighbor(cur,b)&&b.answer===start.answer)
        .forEach(b=>{sameAns.add(b.id);qa.push(b);});
    }
    if(sameAns.size>=2){
      let pts=0;
      sameAns.forEach(id=>{
        const b=bubbles.current.find(x=>x.id===id); if(!b||!b.active) return;
        b.active=false; createExplosion(b.x,b.y,COLOR_CONFIG[b.color].hex);
        pts+=COLOR_CONFIG[b.color].points;
      });
      bubbles.current=bubbles.current.filter(b=>b.active);
      scoreRef.current+=Math.floor(pts*mult); setScore(scoreRef.current);
      dropFloatingBubbles();
      didExplode=true;
    }

    if(didExplode) return;

    // ── 규칙B: 같은 색 3개 이상 연결 (정답 무관) ──
    const sameCol=new Set<string>([start.id]);
    const qc=[start]; qi=0;
    while(qi<qc.length){
      const cur=qc[qi++];
      bubbles.current.filter(b=>b.active&&!sameCol.has(b.id)&&isNeighbor(cur,b)&&b.color===start.color)
        .forEach(b=>{sameCol.add(b.id);qc.push(b);});
    }
    if(sameCol.size>=3){
      // ── 콤보 체크: 같은색 그룹 중 start와 색+정답 모두 같은 구슬이 있으면 Combo! ──
      const comboMatch=Array.from(sameCol).filter(id=>{
        const b=bubbles.current.find(x=>x.id===id);
        return b && b.id!==start.id && b.color===start.color && b.answer===start.answer;
      });
      const isCombo=comboMatch.length>0;

      if(isCombo){
        // 콤보: 그룹 + 주변 1칸 전부 폭발
        const toExp=new Set<string>(sameCol);
        sameCol.forEach(id=>{
          const b=bubbles.current.find(x=>x.id===id); if(!b) return;
          bubbles.current.filter(nb=>nb.active&&!toExp.has(nb.id)&&isNeighbor(b,nb))
            .forEach(nb=>toExp.add(nb.id));
        });
        let pts=0;
        toExp.forEach(id=>{
          const b=bubbles.current.find(x=>x.id===id); if(!b||!b.active) return;
          b.active=false; createExplosion(b.x,b.y,COLOR_CONFIG[b.color].hex,true);
          pts+=COLOR_CONFIG[b.color].points*2;
        });
        bubbles.current=bubbles.current.filter(b=>b.active);
        scoreRef.current+=Math.floor(pts*mult); setScore(scoreRef.current);
        // Combo! 배너
        setComboText('Combo! 🌟');
        setShowCombo(true);
        setTimeout(()=>setShowCombo(false),1500);
      } else {
        // 일반 색 매칭
        let pts=0;
        sameCol.forEach(id=>{
          const b=bubbles.current.find(x=>x.id===id); if(!b||!b.active) return;
          b.active=false; createExplosion(b.x,b.y,COLOR_CONFIG[b.color].hex);
          pts+=COLOR_CONFIG[b.color].points;
        });
        bubbles.current=bubbles.current.filter(b=>b.active);
        scoreRef.current+=Math.floor(pts*mult); setScore(scoreRef.current);
      }
      dropFloatingBubbles();
    }
  },[dropFloatingBubbles]);

  const addNewRow=(cw:number)=>{
    bubbles.current=bubbles.current.filter(b=>b.active);
    bubbles.current.forEach(b=>{b.row++;b.y+=ROW_HEIGHT;});
    const newBubbles=makeRow(0,cw);
    bubbles.current.push(...newBubbles);
    dropFloatingBubbles();
    // 구슬 있는 위치에서만 먼지
    createDust(cw, newBubbles);
  };

  const checkGameOver=(ch:number)=>{
    const r=calcRadius(canvasRef.current?.width||800);
    // 경계선 = 발사대(anchor) 보다 구슬 2개 반지름 위
    const slY=ch-SLINGSHOT_BOTTOM_OFFSET-r*2;
    if(bubbles.current.some(b=>b.active&&b.y+r>=slY)){
      isGameOverRef.current=true; setFinalScore(scoreRef.current);
      setIsGameOver(true); setGamePhase('over'); gamePhaseRef.current='over';
    }
  };

  // 무제한 모드: 구슬 다 깨면 새 3줄
  const checkEndlessRefill=(cw:number)=>{
    if(gameModeTypeRef.current!=='endless') return;
    if(bubbles.current.filter(b=>b.active).length===0){
      for(let r=0;r<INIT_ROWS;r++) bubbles.current.push(...makeRow(r,cw));
    }
  };

  const initGrid=useCallback((width:number)=>{
    const nb:Bubble[]=[];
    for(let r=0;r<INIT_ROWS;r++) nb.push(...makeRow(r,width));
    bubbles.current=[...nb]; particles.current=[]; dustParticles.current=[]; fallingBubbles.current=[];
    isGameOverRef.current=false; scoreRef.current=0;
    gameStartTimeRef.current=performance.now(); lastDropTimeRef.current=performance.now();
    shakeTimeRef.current=0; downLandCountRef.current=0; setDownLandCount(0);
    initQueue();
  },[initQueue]);

  // Multiplayer
  const startCountdown=(onDone:()=>void)=>{
    setGamePhase('countdown'); gamePhaseRef.current='countdown'; setCountdownNum(3);
    let c=3;
    const iv=setInterval(()=>{c--;setCountdownNum(c);if(c<=0){clearInterval(iv);onDone();}},1000);
  };

  const startMultiplayer=useCallback(async()=>{
    if(multiStatusRef.current==='searching'||multiStatusRef.current==='matched') return;
    setMultiStatus('searching'); multiStatusRef.current='searching';
    try{
      const fb=await initFirebase(); if(!fb){setMultiStatus('idle');return;}
      fbRef.current=fb;
      const lobbyId=stableLobbyId();
      try{await sweepLobbySlots({...fb,lobbyId,maxTeams:10});}catch{}
      const joined=await joinLobby({...fb,lobbyId,name:'Player',maxTeams:10});
      joinResultRef.current=joined;
      roomUnsubRef.current?.();
      roomUnsubRef.current=watchRoom({...fb,roomId:joined.roomId,onRoom:(room)=>{
        if(!room?.meta) return;
        const ids=Object.keys(room.players||{});
        if(ids.length===2&&room.meta.state==='open') setRoomState({...fb,roomId:joined.roomId},'playing').catch(()=>{});
        if(ids.length===2&&(room.meta.state==='open'||room.meta.state==='playing')&&multiStatusRef.current==='searching'){
          setMultiStatus('matched'); multiStatusRef.current='matched';
          setShowMatchedBanner(true); setTimeout(()=>setShowMatchedBanner(false),2000);
          const cw=canvasRef.current?.width||800; initGrid(cw); setScore(0); setIsGameOver(false);
          startCountdown(()=>{setGamePhase('playing');gamePhaseRef.current='playing';setMultiStatus('playing');multiStatusRef.current='playing';});
        }
      }});
      oppUnsubRef.current?.();
      oppUnsubRef.current=subscribeOppState({...fb,roomId:joined.roomId,pid:joined.pid,onOpp:(res)=>{
        if(!res?.state?.bubbles) return; oppBubblesRef.current=res.state.bubbles;
      }});
      if(publishTimerRef.current) clearInterval(publishTimerRef.current);
      publishTimerRef.current=setInterval(()=>{
        if(!fb||!joinResultRef.current) return;
        publishMyState({...fb,roomId:joined.roomId,pid:joined.pid,state:{
          bubbles:bubbles.current.filter(b=>b.active).map(b=>({x:b.x,y:b.y,color:b.color,expression:b.expression})),
          score:scoreRef.current,dead:isGameOverRef.current,
        }}).catch(()=>{});
      },500);
    }catch(e){console.error(e);setMultiStatus('idle');}
  },[initGrid]);

  const leaveMultiplayer=useCallback(()=>{
    roomUnsubRef.current?.(); roomUnsubRef.current=null;
    oppUnsubRef.current?.(); oppUnsubRef.current=null;
    if(publishTimerRef.current){clearInterval(publishTimerRef.current);publishTimerRef.current=null;}
    const fb=fbRef.current,jr=joinResultRef.current;
    if(fb&&jr) removePlayer({...fb,roomId:jr.roomId,pid:jr.pid}).catch(()=>{});
    if(jr?.hbTimer) clearInterval(jr.hbTimer);
    joinResultRef.current=null; fbRef.current=null;
    setMultiStatus('idle'); multiStatusRef.current='idle'; oppBubblesRef.current=[];
  },[]);

  const restartGame=useCallback(()=>{
    setIsGameOver(false); setScore(0); setGameMode('easy'); gameModeRef.current='easy';
    downLandCountRef.current=0; setDownLandCount(0); isGameOverRef.current=false;
    particles.current=[]; dustParticles.current=[]; fallingBubbles.current=[];
    initGrid(canvasRef.current?.width||800);
    setGamePhase('start'); gamePhaseRef.current='start';
  },[initGrid]);

  const handleStart=(mode:GameModeType='normal')=>{
    setGameModeType(mode); gameModeTypeRef.current=mode;
    startCountdown(()=>{
      // 실제 게임 시작 시점에 타이머 리셋 (카운트다운 시간 제외)
      gameStartTimeRef.current=performance.now();
      lastDropTimeRef.current=performance.now();
      shakeTimeRef.current=0;
      setGamePhase('playing');gamePhaseRef.current='playing';
    });
  };

  useEffect(()=>()=>{leaveMultiplayer();},[leaveMultiplayer]);

  // ─────────────────────────────────────────────────────────────────────────
  // MAIN GAME LOOP
  // ─────────────────────────────────────────────────────────────────────────
  useEffect(()=>{
    if(!videoRef.current||!canvasRef.current||!gameContainerRef.current) return;
    const video=videoRef.current,canvas=canvasRef.current,container=gameContainerRef.current;
    const ctx=canvas.getContext('2d',{willReadFrequently:false}); if(!ctx) return;

    // DPR을 1로 고정: 모바일에서 2x/3x dpr이 렌더링 부하를 2~3배 늘림
    // canvas CSS 크기 = 논리 크기, 실제 픽셀은 1:1로 고정
    const cw=container.clientWidth, ch=container.clientHeight;
    canvas.width=cw; canvas.height=ch;
    canvas.style.width=cw+'px'; canvas.style.height=ch+'px';
    BUBBLE_RADIUS=calcRadius(canvas.width);
    ROW_HEIGHT=BUBBLE_RADIUS*Math.sqrt(3);
    marbleCache.clear();
    _slingshotCache=null;
    anchorPos.current={x:canvas.width/2,y:canvas.height-SLINGSHOT_BOTTOM_OFFSET};
    ballPos.current={...anchorPos.current};
    initGrid(canvas.width);

    let camera:any=null,hands:any=null;

    // ── 웹캠 이미지를 별도 offscreen에 보관 (rAF와 분리) ──
    const camCanvas=document.createElement('canvas');
    camCanvas.width=canvas.width; camCanvas.height=canvas.height;
    const camCtx=camCanvas.getContext('2d');
    let camReady=false;

    const onResults=(results:any)=>{
      setLoading(false);
      // 웹캠 이미지만 offscreen에 업데이트 (게임 렌더링과 분리)
      if(results.image&&camCtx){
        camCanvas.width=canvas.width; camCanvas.height=canvas.height;
        camCtx.save();
        camCtx.translate(camCanvas.width,0); camCtx.scale(-1,1);
        camCtx.drawImage(results.image,0,0,camCanvas.width,camCanvas.height);
        camCtx.restore();
        camReady=true;
      }
      // 손 정보만 추출 (렌더링 없음)
      if(results.multiHandLandmarks?.length>0){
        const lm=results.multiHandLandmarks[0],idx=lm[8],thumb=lm[4];
        const hx=canvas.width-(idx.x+thumb.x)*canvas.width/2;
        const hy=(idx.y+thumb.y)*canvas.height/2;
        const ddx=idx.x-thumb.x,ddy=idx.y-thumb.y;
        const rawPinch=Math.sqrt(ddx*ddx+ddy*ddy);
        // EMA 스무딩: α=0.25 (낮을수록 더 부드럽지만 지연 증가)
        const ALPHA=0.25;
        if(smoothHandPos.current){
          smoothHandPos.current={
            x:smoothHandPos.current.x*(1-ALPHA)+hx*ALPHA,
            y:smoothHandPos.current.y*(1-ALPHA)+hy*ALPHA,
          };
        } else { smoothHandPos.current={x:hx,y:hy}; }
        smoothPinchDist.current=smoothPinchDist.current*(1-ALPHA)+rawPinch*ALPHA;
        latestHandPos.current=smoothHandPos.current;
        latestPinchDist.current=smoothPinchDist.current;
        latestLandmarks.current=lm;
      } else {
        latestHandPos.current=null;
        latestPinchDist.current=1.0;
        latestLandmarks.current=null;
      }
    };

    // ── rAF 기반 60fps 게임 루프 ──
    const gameLoop=(now:number)=>{
      rafRef.current=requestAnimationFrame(gameLoop);
      frameCountRef.current++;

      if(canvas.width!==container.clientWidth||canvas.height!==container.clientHeight){
        const cw=container.clientWidth, ch=container.clientHeight;
        canvas.width=cw; canvas.height=ch;
        canvas.style.width=cw+'px'; canvas.style.height=ch+'px';
        camCanvas.width=cw; camCanvas.height=ch;
        anchorPos.current={x:cw/2,y:ch-SLINGSHOT_BOTTOM_OFFSET};
        if(!isFlying.current&&!isPinching.current) ballPos.current={...anchorPos.current};
        BUBBLE_RADIUS=calcRadius(cw);
        ROW_HEIGHT=BUBBLE_RADIUS*Math.sqrt(3);
        marbleCache.clear();
        _slingshotCache=null;
      }

      ctx.clearRect(0,0,canvas.width,canvas.height);
      if(camReady){
        ctx.drawImage(camCanvas,0,0,canvas.width,canvas.height);
        ctx.fillStyle='rgba(18,18,18,0.85)';
      } else ctx.fillStyle='#121212';
      ctx.fillRect(0,0,canvas.width,canvas.height);

      const handPos=latestHandPos.current;
      const pinchDist=latestPinchDist.current;
      const lm=latestLandmarks.current;

      // 손 랜드마크 그리기 (offscreen에서 복사한 프레임 위에)
      if(lm&&window.drawConnectors&&window.drawLandmarks){
        ctx.save();
        ctx.globalAlpha=0.45;
        ctx.translate(canvas.width,0); ctx.scale(-1,1);
        window.drawConnectors(ctx,lm,window.HAND_CONNECTIONS,{color:'#4a7fff',lineWidth:1});
        window.drawLandmarks(ctx,lm,{color:'#88aaff',lineWidth:1,radius:1.5});
        ctx.restore();
        ctx.globalAlpha=1.0;
      }
      if(handPos){
        ctx.beginPath(); ctx.arc(handPos.x,handPos.y,14,0,Math.PI*2);
        ctx.strokeStyle=pinchDist<PINCH_THRESHOLD?'rgba(100,220,100,0.9)':'rgba(255,255,255,0.6)';
        ctx.lineWidth=2; ctx.stroke();
        if(pinchDist<PINCH_THRESHOLD){
          ctx.beginPath(); ctx.arc(handPos.x,handPos.y,6,0,Math.PI*2);
          ctx.fillStyle='rgba(100,220,100,0.7)'; ctx.fill();
        }
      }

      const isPlaying=gamePhaseRef.current==='playing';
      const isHard=gameModeRef.current==='hard';
      const isEndless=gameModeTypeRef.current==='endless';

      // ── Row drop (무제한 모드는 없음) ──
      if(isPlaying&&!isGameOverRef.current&&!isEndless){
        const elapsed=now-gameStartTimeRef.current,interval=getDropInterval(elapsed);
        const sinceLast=now-lastDropTimeRef.current;
        const timeLeft=interval-sinceLast;
        // 2초 전부터 shake 시작 — 한 번만 세팅
        if(timeLeft<=2000&&timeLeft>0&&shakeTimeRef.current===0){
          shakeTimeRef.current=now;
        }
        if(sinceLast>=interval){
          lastDropTimeRef.current=now; addNewRow(canvas.width);
          shakeTimeRef.current=0; checkGameOver(canvas.height);
        }
      }

      // 무제한 모드: 구슬 다 깨면 새 3줄
      if(isPlaying&&!isGameOverRef.current&&isEndless){
        checkEndlessRefill(canvas.width);
      }

      // ── Shake: 2초 동안 점점 강해지는 진동 ──
      let gsx=0,gsy=0;
      if(shakeTimeRef.current>0){
        const se=now-shakeTimeRef.current;
        const prog=Math.min(se/2000,1.0);
        const freq=40-prog*10;
        const amp=(0.8+prog*4.5)*Math.sin(se/freq);
        gsx=amp*Math.sin(se/13);
        gsy=amp*0.4*Math.abs(Math.sin(se/17));
      }

      // 터치 입력 우선 (모바일) - handPos/pinchDist는 루프 상단에서 이미 선언
      if(touchActiveRef.current){
        latestHandPos.current=touchPosRef.current;
        latestPinchDist.current=0.0;
      }
      const isLocked=isGameOverRef.current||!isPlaying;

      // ── Slingshot input ──
      // 잡기: 핀치(손가락 모음) 상태로 구슬에 닿으면 잡힘
      // 당기기: 핀치 유지하며 이동
      // 발사: 손가락을 확실히 벌렸을 때만 (RELEASE_THRESHOLD)
      // 손이 사라지면: 그냥 리셋 (발사 안 함)
      const RELEASE_THRESHOLD = PINCH_THRESHOLD * 1.02; // 핀치에서 살짝만 벌려도 즉시 발사
      if(!isLocked){
        if(!isFlying.current){
          const isPinched = pinchDist < PINCH_THRESHOLD;
          const isReleased = !isPinched; // 핀치 상태만 아니면 바로 발사

          if(isPinched && handPos){
            // 핀치 상태 + 구슬 근처 → 잡기 시작
            const db=Math.sqrt(Math.pow(handPos.x-ballPos.current.x,2)+Math.pow(handPos.y-ballPos.current.y,2));
            if(!isPinching.current && db < BUBBLE_RADIUS * 5.0){
              isPinching.current=true;
            }
            if(isPinching.current){
              // 당기는 중: 구슬 위치 = 손 위치
              ballPos.current={x:handPos.x,y:handPos.y};
              const ddx=ballPos.current.x-anchorPos.current.x,ddy=ballPos.current.y-anchorPos.current.y;
              const dd=Math.sqrt(ddx*ddx+ddy*ddy);
              if(dd>MAX_DRAG_DIST){
                const ang=Math.atan2(ddy,ddx);
                ballPos.current={x:anchorPos.current.x+Math.cos(ang)*MAX_DRAG_DIST,y:anchorPos.current.y+Math.sin(ang)*MAX_DRAG_DIST};
              }
            }
          } else if(isPinching.current){
            if(!handPos){
              // 손이 사라진 경우 → 발사 안 하고 원위치 복귀
              isPinching.current=false;
              ballPos.current={...anchorPos.current};
            } else if(isReleased){
              // 손가락 확실히 벌린 경우 → 발사
              isPinching.current=false;
              const dx=anchorPos.current.x-ballPos.current.x,dy=anchorPos.current.y-ballPos.current.y;
              const sd=Math.sqrt(dx*dx+dy*dy);
              if(sd>30){
                isFlying.current=true; flightStart.current=now;
                const pr=Math.min(sd/MAX_DRAG_DIST,1.0);
                const vm=MIN_FORCE_MULT+(MAX_FORCE_MULT-MIN_FORCE_MULT)*(pr*pr);
                ballVel.current={x:dx*vm,y:dy*vm};
              } else ballPos.current={...anchorPos.current};
            }
            // 핀치 해제 → 즉시 발사 (isReleased = !isPinched)
          }
        }
        if(!isFlying.current&&!isPinching.current){
          const dx=anchorPos.current.x-ballPos.current.x,dy=anchorPos.current.y-ballPos.current.y;
          ballPos.current.x+=dx*.2; ballPos.current.y+=dy*.2;
        }
      }

      // ── Draw bubbles ──
      const doShake=shakeTimeRef.current>0;
      const activeBubbles=bubbles.current; // active 아닌 건 checkMatches에서 즉시 제거됨

      // ── Physics ──
      if(isFlying.current){
        if(now-flightStart.current>5000){
          isFlying.current=false; ballPos.current={...anchorPos.current}; ballVel.current={x:0,y:0};
        } else {
          const spd=Math.sqrt(ballVel.current.x**2+ballVel.current.y**2);
          const steps=Math.ceil(spd/(BUBBLE_RADIUS*.8)); let hit=false;

          for(let i=0;i<steps;i++){
            ballPos.current.x+=ballVel.current.x/steps;
            ballPos.current.y+=ballVel.current.y/steps;
            if(ballPos.current.x<BUBBLE_RADIUS||ballPos.current.x>canvas.width-BUBBLE_RADIUS){
              ballVel.current.x*=-1;
              ballPos.current.x=Math.max(BUBBLE_RADIUS,Math.min(canvas.width-BUBBLE_RADIUS,ballPos.current.x));
            }
            if(ballPos.current.y<BUBBLE_RADIUS){hit=true;break;}
            const bpx=ballPos.current.x, bpy=ballPos.current.y;
            const collR2=Math.pow(BUBBLE_RADIUS*1.9,2);
            for(const b of activeBubbles){
              if((bpx-b.x)*(bpx-b.x)+(bpy-b.y)*(bpy-b.y)<collR2){hit=true;break;}
            }
            if(hit) break;
          }
          ballVel.current.x*=0.998; ballVel.current.y*=0.998;

          if(hit){
            isFlying.current=false;
            const landedBelow = ballPos.current.y > anchorPos.current.y + 20;
            if(landedBelow&&gameModeRef.current!=='hard'){
              const newCount=downLandCountRef.current+1;
              downLandCountRef.current=newCount; setDownLandCount(newCount);
              if(newCount>=3){
                gameModeRef.current='hard'; setGameMode('hard');
                setShowHardNotif(true); setTimeout(()=>setShowHardNotif(false),3000);
              }
            }

            // 점유된 그리드 칸 Set으로 O(1) 조회
            const occupiedSet=new Set(activeBubbles.map(b=>`${b.row}_${b.col}`));
            let bd=Infinity,br=0,bc=0,bx=0,by=0;
            const MAX_LAND_DIST=BUBBLE_RADIUS*2.4;
            for(let r=0;r<GRID_ROWS+5;r++){
              const cols=r%2!==0?GRID_COLS-1:GRID_COLS;
              for(let c=0;c<cols;c++){
                if(occupiedSet.has(`${r}_${c}`)) continue;
                const p=getBubblePos(r,c,canvas.width);
                const ddx=ballPos.current.x-p.x, ddy=ballPos.current.y-p.y;
                const d=Math.sqrt(ddx*ddx+ddy*ddy);
                if(d<bd&&d<MAX_LAND_DIST){bd=d;br=r;bc=c;bx=p.x;by=p.y;}
              }
            }
            if(bd===Infinity){
              for(let r=0;r<GRID_ROWS+5;r++){
                const cols=r%2!==0?GRID_COLS-1:GRID_COLS;
                for(let c=0;c<cols;c++){
                  if(occupiedSet.has(`${r}_${c}`)) continue;
                  const p=getBubblePos(r,c,canvas.width);
                  const ddx=ballPos.current.x-p.x, ddy=ballPos.current.y-p.y;
                  const d=Math.sqrt(ddx*ddx+ddy*ddy);
                  if(d<bd){bd=d;br=r;bc=c;bx=p.x;by=p.y;}
                }
              }
            }

            const cur=currentBubble();
            const col=(isHard?'purple':cur.color) as BubbleColor;
            const nb:Bubble={id:`shot-${Date.now()}`,row:br,col:bc,x:bx,y:by,
              color:col,answer:cur.answer,expression:cur.expression,active:true};
            bubbles.current.push(nb);
            checkMatches(nb);
            dequeueAndRefill();
            ballPos.current={...anchorPos.current}; ballVel.current={x:0,y:0};
            checkGameOver(canvas.height);
            if(isEndless) checkEndlessRefill(canvas.width);
          }
          if(ballPos.current.y>canvas.height){
            isFlying.current=false; ballPos.current={...anchorPos.current}; ballVel.current={x:0,y:0};
          }
        }
      }

      for(const b of activeBubbles){
        drawMarble(ctx,b.x,b.y,BUBBLE_RADIUS-1,b.color,b.expression,isHard,1.0,doShake?gsx:0,doShake?gsy:0);
      }

      // ── Falling bubbles ──
      for(let i=fallingBubbles.current.length-1;i>=0;i--){
        const fb=fallingBubbles.current[i];
        fb.y+=fb.vy; fb.vy+=FALL_GRAVITY; fb.alpha-=0.022;
        if(fb.alpha<=0||fb.y>canvas.height){fallingBubbles.current.splice(i,1);continue;}
        drawMarble(ctx,fb.x,fb.y,BUBBLE_RADIUS-1,fb.color,fb.expression,isHard,fb.alpha);
      }

      // ── Dust (배치 렌더링: path 한 번에 묶기) ──
      if(frameCountRef.current%2===0 && dustParticles.current.length>0){
        ctx.beginPath();
        for(let i=dustParticles.current.length-1;i>=0;i--){
          const p=dustParticles.current[i]; p.x+=p.vx;p.y+=p.vy;p.life-=.025;
          if(p.life<=0){dustParticles.current.splice(i,1);continue;}
          ctx.moveTo(p.x,p.y); ctx.arc(p.x,p.y,2+p.life*2.5,0,Math.PI*2);
        }
        ctx.globalAlpha=0.5; ctx.fillStyle='hsl(45,50%,65%)'; ctx.fill();
        ctx.globalAlpha=1.0;
      }

      // ── Wavy danger line (무제한 모드는 없음) ──
      if(!isEndless){
        waveOffsetRef.current+=.04;
        const slY=canvas.height-SLINGSHOT_BOTTOM_OFFSET-BUBBLE_RADIUS*2;
        ctx.save();
        ctx.beginPath(); ctx.moveTo(0,slY);
        for(let wx=0;wx<=canvas.width;wx+=12) ctx.lineTo(wx,slY+Math.sin(wx/28+waveOffsetRef.current)*3.5);
        ctx.strokeStyle='rgba(80,160,255,0.55)'; ctx.lineWidth=2;
        ctx.stroke(); ctx.restore();
      }

      // ── Slingshot (개선된 디자인) ──
      drawSlingshot(ctx,anchorPos.current,ballPos.current,canvas.height,isPinching.current,isFlying.current);

      // ── 현재 구슬 (발사할 구슬) ──
      ctx.save();
      if(isLocked&&!isFlying.current) ctx.globalAlpha=0.5;
      const cur=currentBubble();
      const curColor=(isHard?'purple':cur.color) as BubbleColor;
      drawMarble(ctx,ballPos.current.x,ballPos.current.y,BUBBLE_RADIUS,curColor,cur.expression,isHard);
      ctx.restore();

      // ── 조준선: 벽 반사 포함 레이캐스트 (최대 2 세그먼트) ──
      if(isPinching.current&&!isFlying.current){
        const dx=anchorPos.current.x-ballPos.current.x,dy=anchorPos.current.y-ballPos.current.y;
        const len=Math.sqrt(dx*dx+dy*dy);
        if(len>10){
          const collideR2=Math.pow(BUBBLE_RADIUS*1.85,2);
          const raycast=(sx:number,sy:number,vx:number,vy:number,skipFirst=false):{ex:number,ey:number,hit:boolean,wallHit:boolean}=>{
            const stepSize=14; // 6→14: 정밀도 약간 낮추고 속도 대폭 향상
            const maxDist=canvas.height*2;
            const steps=Math.ceil(maxDist/stepSize);
            let ex=sx,ey=sy;
            for(let s=1;s<=steps;s++){
              const rx=sx+vx*stepSize*s, ry=sy+vy*stepSize*s;
              if(ry<BUBBLE_RADIUS) return {ex:rx,ey:ry,hit:true,wallHit:false};
              if(rx<BUBBLE_RADIUS||rx>canvas.width-BUBBLE_RADIUS){
                return {ex:rx,ey:ry,hit:false,wallHit:true};
              }
              if(!skipFirst||s>1){
                for(const b of activeBubbles){ // filter 결과 재사용
                  if((rx-b.x)*(rx-b.x)+(ry-b.y)*(ry-b.y)<collideR2)
                    return {ex:rx,ey:ry,hit:true,wallHit:false};
                }
              }
              ex=rx; ey=ry;
            }
            return {ex,ey,hit:false,wallHit:false};
          };

          const nx=dx/len, ny=dy/len;
          const seg1=raycast(ballPos.current.x,ballPos.current.y,nx,ny);

          ctx.save();
          ctx.setLineDash([8,6]);
          ctx.lineDashOffset=-((now/10)%14);
          ctx.strokeStyle='rgba(255,255,255,0.45)'; ctx.lineWidth=1.5;

          ctx.beginPath();
          ctx.moveTo(ballPos.current.x,ballPos.current.y);
          ctx.lineTo(seg1.ex,seg1.ey);
          ctx.stroke();

          if(seg1.wallHit){
            const seg2=raycast(seg1.ex,seg1.ey,-nx,ny,true);
            ctx.globalAlpha=0.65;
            ctx.beginPath();
            ctx.moveTo(seg1.ex,seg1.ey);
            ctx.lineTo(seg2.ex,seg2.ey);
            ctx.stroke();
            if(seg2.hit||!seg2.wallHit){
              ctx.setLineDash([]);
              ctx.globalAlpha=0.6;
              ctx.beginPath(); ctx.arc(seg2.ex,seg2.ey,5,0,Math.PI*2);
              ctx.fillStyle='rgba(255,200,100,0.7)'; ctx.fill();
            }
            ctx.globalAlpha=1.0;
            ctx.setLineDash([]);
            ctx.beginPath(); ctx.arc(seg1.ex,seg1.ey,4,0,Math.PI*2);
            ctx.fillStyle='rgba(255,255,255,0.4)'; ctx.fill();
          } else if(seg1.hit){
            ctx.setLineDash([]);
            ctx.beginPath(); ctx.arc(seg1.ex,seg1.ey,5,0,Math.PI*2);
            ctx.fillStyle='rgba(255,255,255,0.5)'; ctx.fill();
          }
          ctx.restore();
        }
      }

      // ── Particles (색상별 배치 렌더링) ──
      if(particles.current.length>0){
        // 색상별로 그룹핑
        const colorGroups=new Map<string,{x:number,y:number,r:number,alpha:number}[]>();
        for(let i=particles.current.length-1;i>=0;i--){
          const p=particles.current[i]; p.x+=p.vx;p.y+=p.vy;p.life-=.055;
          if(p.life<=0){particles.current.splice(i,1);continue;}
          if(!colorGroups.has(p.color)) colorGroups.set(p.color,[]);
          colorGroups.get(p.color)!.push({x:p.x,y:p.y,r:4,alpha:p.life});
        }
        for(const [color,pts] of colorGroups){
          // 같은 알파끼리 완전 배치는 불가하지만, beginPath는 한 번만
          ctx.fillStyle=color;
          for(const pt of pts){
            ctx.globalAlpha=pt.alpha;
            ctx.beginPath(); ctx.arc(pt.x,pt.y,pt.r,0,Math.PI*2); ctx.fill();
          }
        }
        ctx.globalAlpha=1.0;
      }

      // ── Opponent ──
      if(oppBubblesRef.current.length>0&&multiStatusRef.current==='playing'){
        drawOpponentBoard(ctx,oppBubblesRef.current,canvas.width-148,8,140,190);
      }

    }; // end gameLoop

    // rAF 시작
    rafRef.current=requestAnimationFrame(gameLoop);

    if(window.Hands){
      hands=new window.Hands({locateFile:(f:string)=>`https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}`});
      hands.setOptions({maxNumHands:1,modelComplexity:0,minDetectionConfidence:.55,minTrackingConfidence:.55});
      hands.onResults(onResults);
      if(window.Camera){
        camera=new window.Camera(video,{
          onFrame:async()=>{ if(videoRef.current&&hands) await hands.send({image:videoRef.current}); },
          width:640,height:480,
        });
        camera.start();
      }
    }
    return()=>{ cancelAnimationFrame(rafRef.current); if(camera) camera.stop(); if(hands) hands.close(); };
  },[initGrid,checkMatches,dropFloatingBubbles,dequeueAndRefill]);

  // ── Touch events ──────────────────────────────────────────────────────────
  useEffect(()=>{
    const canvas=canvasRef.current; if(!canvas) return;
    const getPos=(e:TouchEvent):Point=>{
      const rect=canvas.getBoundingClientRect();
      const sx=canvas.width/rect.width,sy=canvas.height/rect.height;
      const t=e.touches[0];
      return {x:(t.clientX-rect.left)*sx,y:(t.clientY-rect.top)*sy};
    };
    const onStart=(e:TouchEvent)=>{
      e.preventDefault();
      const pos=getPos(e);
      const dx=pos.x-anchorPos.current.x,dy=pos.y-anchorPos.current.y;
      if(Math.sqrt(dx*dx+dy*dy)<160){touchActiveRef.current=true;touchPosRef.current=pos;}
    };
    const onMove=(e:TouchEvent)=>{e.preventDefault();if(touchActiveRef.current)touchPosRef.current=getPos(e);};
    const onEnd=(e:TouchEvent)=>{e.preventDefault();touchActiveRef.current=false;};
    canvas.addEventListener('touchstart',onStart,{passive:false});
    canvas.addEventListener('touchmove',onMove,{passive:false});
    canvas.addEventListener('touchend',onEnd,{passive:false});
    return()=>{
      canvas.removeEventListener('touchstart',onStart);
      canvas.removeEventListener('touchmove',onMove);
      canvas.removeEventListener('touchend',onEnd);
    };
  },[]);

  const isHardMode=gameMode==='hard';

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="w-full h-screen bg-[#121212] overflow-hidden text-[#e3e3e3] relative select-none"
      style={{fontFamily:'system-ui,sans-serif',touchAction:'none'}}>

      <video ref={videoRef} className="absolute hidden" playsInline/>
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full"/>
      <div ref={gameContainerRef} className="absolute inset-0 pointer-events-none"/>

      {/* Loading */}
      {loading&&(
        <div className="absolute inset-0 flex items-center justify-center bg-[#121212] z-50">
          <div className="flex flex-col items-center gap-4">
            <Loader2 className="w-12 h-12 text-[#42a5f5] animate-spin"/>
            <p className="text-lg font-medium">카메라 연결 중...</p>
          </div>
        </div>
      )}

      {/* START */}
      {gamePhase==='start'&&!loading&&(
        <div className="absolute inset-0 z-40 flex items-center justify-center overflow-y-auto py-4"
          style={{background:'radial-gradient(ellipse at center,rgba(30,30,60,0.95) 0%,rgba(10,10,20,0.98) 100%)'}}>
          <div className="flex flex-col items-center gap-4 px-4 w-full max-w-md">
            <div className="text-center">
              <div className="text-5xl mb-2" style={{filter:'drop-shadow(0 0 20px #4fc3f7)'}}>🧮</div>
              <h1 className="text-4xl font-black mb-1" style={{
                background:'linear-gradient(135deg,#4fc3f7,#81c784,#ffb74d)',
                WebkitBackgroundClip:'text',WebkitTextFillColor:'transparent',
              }}>매스 슬링샷</h1>
            </div>

            <div className="w-full space-y-2">
              <div className="bg-white/5 rounded-xl p-3 border border-white/10 text-xs text-[#c4c7c5] space-y-1.5">
                <p className="font-bold text-white text-sm">💥 터지는 조건 (3가지)</p>
                <div className="pl-2 space-y-1">
                  <p>① <span className="text-[#4fc3f7]">같은 정답</span> 구슬 3개 이상 연결 → 팡!</p>
                  <p>② <span className="text-[#81c784]">같은 색</span> 구슬 3개 이상 연결 → 팡!</p>
                  <p>③ <span className="text-[#ffb74d]">같은 색 + 같은 정답</span> 3개 이상 → 주변 1칸까지 폭발! 🌟</p>
                </div>
              </div>
              <div className="bg-white/5 rounded-xl p-3 border border-white/10 text-xs text-[#c4c7c5] space-y-1.5">
                <p className="font-bold text-white text-sm">🎮 조작법</p>
                <div className="pl-2 space-y-1">
                  <p>🖐️ <span className="text-[#4fc3f7]">손가락을 모아 구슬을 당겨</span> 발사</p>
                  <p>📱 모바일: 슬링샷 근처 터치 드래그</p>
                  <p>🪂 천장에서 떨어진 구슬은 자동 낙하!</p>
                </div>
              </div>
              <div className="bg-white/5 rounded-xl p-3 border border-white/10 text-xs text-[#c4c7c5] space-y-1">
                <p className="font-bold text-white text-sm">⚡ 하드 모드</p>
                <p className="pl-2">구슬이 <span className="text-[#ff6b6b]">아래쪽에 3번 착지</span>하면 하드 모드!</p>
                <p className="pl-2">색깔 힌트 없음 + 점수 <span className="text-[#ffb74d]">1.5배</span></p>
              </div>
            </div>

            {/* 모드 선택 버튼 */}
            <div className="w-full grid grid-cols-2 gap-3 mt-1">
              <button onClick={()=>handleStart('normal')}
                className="py-4 rounded-2xl font-black text-lg transition-all active:scale-95"
                style={{background:'linear-gradient(135deg,#4fc3f7,#42a5f5)',color:'#0a0a1a',boxShadow:'0 0 20px rgba(79,195,247,0.4)'}}>
                START!
              </button>
              <button onClick={()=>handleStart('endless')}
                disabled={multiStatus!=='idle'}
                className="py-4 rounded-2xl font-black text-lg transition-all active:scale-95 flex flex-col items-center justify-center gap-0.5 disabled:opacity-40 disabled:cursor-not-allowed"
                style={{background:'linear-gradient(135deg,#ab47bc,#7b1fa2)',color:'white',boxShadow:'0 0 20px rgba(171,71,188,0.4)'}}>
                <span className="flex items-center gap-1"><InfinityIcon className="w-4 h-4"/>무제한</span>
                <span className="text-[10px] font-normal opacity-75">{multiStatus!=='idle'?'매칭 중 비활성':'클리어하면 새 줄 등장'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Countdown */}
      {gamePhase==='countdown'&&(
        <div className="absolute inset-0 z-40 flex items-center justify-center pointer-events-none"
          style={{background:'rgba(10,10,20,0.6)'}}>
          <div key={countdownNum} className="text-[140px] font-black select-none"
            style={{color:'#4fc3f7',textShadow:'0 0 80px #4fc3f7,0 0 30px #fff',animation:'countPop .8s ease-out forwards'}}>
            {countdownNum}
          </div>
        </div>
      )}

      {/* Hard mode notif */}
      {showHardNotif&&(
        <div className="absolute inset-0 flex items-center justify-center z-50 pointer-events-none">
          <div className="bg-gradient-to-br from-[#ab47bc] to-[#ef5350] p-6 rounded-3xl shadow-2xl text-center animate-bounce">
            <Zap className="w-12 h-12 text-white mx-auto mb-2"/>
            <h2 className="text-2xl font-black text-white mb-1">🔥 하드 모드!</h2>
            <p className="text-white/90 font-bold">색깔 힌트 없음 · 점수 1.5배!</p>
          </div>
        </div>
      )}

      {/* Matched */}
      {showMatchedBanner&&(
        <div className="absolute inset-0 flex items-center justify-center z-50 pointer-events-none">
          <div className="text-center px-10 py-6 rounded-3xl"
            style={{background:'linear-gradient(135deg,rgba(30,80,180,0.95),rgba(80,30,160,0.95))',boxShadow:'0 0 60px rgba(100,160,255,0.5)'}}>
            <div className="text-4xl mb-2">🎮</div>
            <h2 className="text-3xl font-black text-white mb-1">Matching!</h2>
            <p className="text-blue-200">상대방을 찾았어요!</p>
          </div>
        </div>
      )}

      {/* Combo 배너 */}
      {showCombo&&(
        <div className="absolute inset-0 flex items-center justify-center z-50 pointer-events-none">
          <div key={comboText} className="px-10 py-5 rounded-3xl text-center"
            style={{
              background:'linear-gradient(135deg,rgba(255,180,0,0.92),rgba(255,100,0,0.92))',
              boxShadow:'0 0 60px rgba(255,160,0,0.7)',
              animation:'comboPop 1.5s ease-out forwards',
            }}>
            <p className="text-4xl font-black text-white" style={{textShadow:'0 0 20px rgba(255,255,255,0.8)'}}>{comboText}</p>
          </div>
        </div>
      )}

      {/* Game Over */}
      {isGameOver&&(
        <div className="absolute inset-0 z-50 flex items-center justify-center"
          style={{background:'rgba(10,10,20,0.88)',backdropFilter:'blur(6px)'}}>
          <div className="flex flex-col items-center gap-5 p-8 rounded-3xl border border-[#ef5350]/40"
            style={{background:'linear-gradient(135deg,#1a0a0a,#2a1010)',boxShadow:'0 0 60px rgba(239,83,80,0.3)'}}>
            <div className="text-6xl" style={{filter:'drop-shadow(0 0 20px #ef5350)'}}>💥</div>
            <h1 className="text-4xl font-black" style={{color:'#ef5350'}}>GAME OVER</h1>
            <div className="text-center">
              <p className="text-[#c4c7c5] text-xs uppercase tracking-widest">최종 점수</p>
              <p className="text-4xl font-black text-white">{finalScore.toLocaleString()}</p>
            </div>
            <button onClick={restartGame}
              className="flex items-center gap-2 px-8 py-3 rounded-2xl font-bold text-lg transition-all active:scale-95"
              style={{background:'linear-gradient(135deg,#ef5350,#ab47bc)',boxShadow:'0 4px 20px rgba(239,83,80,0.4)'}}>
              <RefreshCw className="w-5 h-5"/> 다시 시작
            </button>
          </div>
        </div>
      )}

      {/* HUD - Score + mode */}
      <div className="absolute top-3 left-3 z-40 flex flex-col gap-1.5">
        <div className="bg-[#1e1e1e]/90 px-4 py-2.5 rounded-2xl border border-[#444746] shadow-xl flex items-center gap-2.5 backdrop-blur-sm">
          <Trophy className="w-4 h-4 text-[#42a5f5]"/>
          <div>
            <p className="text-[9px] text-[#c4c7c5] uppercase tracking-wider">
              {gameModeType==='endless'?'무제한 모드':'점수'}
            </p>
            <p className="text-xl font-bold text-white leading-tight">{score.toLocaleString()}</p>
          </div>
        </div>
        <div className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-widest text-center border backdrop-blur-sm ${
          isHardMode?'bg-[#ab47bc]/30 border-[#ab47bc] text-[#ab47bc]':'bg-[#66bb6a]/20 border-[#66bb6a]/50 text-[#66bb6a]'
        }`}>
          {isHardMode?'⚡ 하드 ×1.5':'🎨 쉬운 모드'}
        </div>
        {!isHardMode&&gamePhase==='playing'&&(
          <div className="px-2.5 py-1 rounded-full text-[9px] text-center border border-[#333] backdrop-blur-sm"
            style={{color:'#888',background:'rgba(30,30,30,0.7)'}}>
            아래 착지 {downLandCount}/3 → 하드
          </div>
        )}
      </div>

      {/* HUD - Multi + X */}
      <div className="absolute top-3 right-3 z-40 flex items-center gap-1.5">
        <button onClick={()=>{
            if(multiStatus==='idle'){
              // 무제한 모드면 일반 모드로 전환 후 매칭
              if(gameModeTypeRef.current==='endless'){
                setGameModeType('normal'); gameModeTypeRef.current='normal';
              }
              startMultiplayer();
            } else { leaveMultiplayer(); }
          }}
          className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold transition-all active:scale-95 backdrop-blur-sm"
          style={{
            background:multiStatus==='idle'?'rgba(30,60,120,0.75)':multiStatus==='searching'?'rgba(50,30,100,0.85)':'rgba(20,80,40,0.85)',
            border:`1px solid ${multiStatus==='idle'?'rgba(79,195,247,0.4)':multiStatus==='searching'?'rgba(160,100,255,0.5)':'rgba(100,200,100,0.5)'}`,
            color:'#e3e3e3',
          }}>
          {multiStatus==='searching'
            ?<><Loader2 className="w-3 h-3 animate-spin"/><span>매칭중</span></>
            :multiStatus==='matched'||multiStatus==='playing'
            ?<><div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse"/><span>연결됨</span></>
            :<><Users className="w-3 h-3"/><span>멀티</span></>}
        </button>
        <button onClick={leaveMultiplayer}
          className="w-8 h-8 rounded-xl flex items-center justify-center transition-all active:scale-95 backdrop-blur-sm"
          style={{background:'rgba(60,20,20,0.6)',border:'1px solid rgba(255,100,100,0.3)'}}>
          <X className="w-3.5 h-3.5 text-red-400"/>
        </button>
      </div>

      {/* 다음 구슬 큐 (하단) */}
      {gamePhase==='playing'&&!isGameOver&&(
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-40">
          <div className="bg-[#1e1e1e]/90 px-3 py-2 sm:px-5 sm:py-3 rounded-[24px] border border-[#444746] shadow-2xl flex items-center gap-2 sm:gap-3 backdrop-blur-sm">
            <div className="flex flex-col items-center gap-0.5">
              <p className="text-[9px] text-[#757575] uppercase tracking-wider">다음 구슬</p>
              <p className="text-[8px] text-[#555]">→ → →</p>
            </div>
            {queueDisplay.map((item,i)=>{
              const cfg=COLOR_CONFIG[item.color];
              const isMobileView=window.innerWidth<600;
              const size=isMobileView?(i===0?36:i===1?30:24):(i===0?46:i===1?38:30);
              const opacity=i===0?1.0:i===1?0.75:0.5;
              return (
                <div key={i} className="flex flex-col items-center gap-0.5"
                  style={{opacity,transition:'all 0.3s'}}>
                  <div className="rounded-full flex items-center justify-center font-black relative"
                    style={{
                      width:size,height:size,
                      background:isHardMode?'radial-gradient(circle at 35% 35%,#777799,#333355)'
                        :`radial-gradient(circle at 35% 35%,${cfg.hex},${cfg.dark})`,
                      boxShadow:`0 2px 8px ${cfg.hex}55,inset 0 -2px 3px rgba(0,0,0,0.3)`,
                      fontSize:item.expression.length<=2?size*.36:size*.28,
                      color:'white',
                    }}>
                    {isHardMode?'?':item.expression}
                    {/* 하이라이트 */}
                    <div style={{
                      position:'absolute',top:'15%',left:'20%',
                      width:'35%',height:'25%',
                      background:'rgba(255,255,255,0.4)',
                      borderRadius:'50%',
                      transform:'rotate(-30deg)',
                      filter:'blur(2px)',
                    }}/>
                  </div>
                  {i===0&&<p className="text-[8px] text-[#888]">다음</p>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <style>{`
        @keyframes countPop {
          0%{transform:scale(1.8);opacity:0;}
          30%{transform:scale(1.0);opacity:1;}
          80%{transform:scale(1.0);opacity:1;}
          100%{transform:scale(0.6);opacity:0;}
        }
        @keyframes comboPop {
          0%  {transform:scale(0.5) translateY(20px);opacity:0;}
          20% {transform:scale(1.2) translateY(0);opacity:1;}
          50% {transform:scale(1.0);opacity:1;}
          80% {transform:scale(1.0);opacity:1;}
          100%{transform:scale(0.8) translateY(-30px);opacity:0;}
        }
      `}</style>
    </div>
  );
};

export default MathSlingshot;
