/**
 * 매스 슬링샷 — 구구단/나눗셈 학습용 버블 슈터
 * ✦ 웹캠 손 추적 (데스크탑 + 모바일 공통)
 * ✦ 터치 드래그 보조 지원 (모바일)
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Point, Bubble, Particle, BubbleColor, GameMode } from '../types';
import { Loader2, Trophy, Zap, RefreshCw, X, Users } from 'lucide-react';
import {
  initFirebase, joinLobby, watchRoom, setRoomState,
  publishMyState, subscribeOppState, removePlayer,
  sweepLobbySlots, stableLobbyId, JoinResult, FirebaseServices
} from '../services/firebaseService';

// ─── Constants ────────────────────────────────────────────────────────────────
const PINCH_THRESHOLD         = 0.05;
const BUBBLE_RADIUS           = 26;
const ROW_HEIGHT              = BUBBLE_RADIUS * Math.sqrt(3);
const GRID_COLS               = 11;
const MAX_BUBBLES_PER_ROW     = 6;
const INIT_ROWS               = 2;
const GRID_ROWS               = 8;
const SLINGSHOT_BOTTOM_OFFSET = 220;
const MAX_DRAG_DIST           = 180;
const MIN_FORCE_MULT          = 0.15;
const MAX_FORCE_MULT          = 0.45;
const MAX_PARTICLES           = 150;
const FALL_GRAVITY            = 0.45; // 낙하 구슬 중력
// 손이 이 y 비율 이하(화면 하단 영역)에 있으면 정답 선택 모드
const SELECT_ZONE_RATIO       = 0.82;

const getDropInterval = (elapsedMs: number): number => {
  const periods = Math.floor(elapsedMs / 20000);
  return Math.max(7000, 12000 - periods * 1000);
};

// ─── Math data ────────────────────────────────────────────────────────────────
const ANSWER_COLOR_MAP: Record<number, BubbleColor> = {
  6:'red',  8:'blue',   9:'green',  12:'yellow',
  15:'purple', 16:'orange', 18:'red', 24:'blue', 27:'green', 36:'yellow',
};
const EXPRESSION_POOL: Record<number, string[]> = {
  6:  ['2×3','3×2','6÷1','1×6','6'],
  8:  ['2×4','4×2','8÷2','1×8','8'],
  9:  ['3×3','9÷1','1×9','9'],
  12: ['3×4','4×3','2×6','6×2','12'],
  15: ['3×5','5×3','15÷3','1×15','15'],
  16: ['4×4','2×8','8×2','16÷1','16'],
  18: ['3×6','6×3','2×9','9×2','18'],
  24: ['4×6','6×4','3×8','8×3','24'],
  27: ['3×9','9×3','27÷3','27'],
  36: ['4×9','9×4','6×6','36÷1','36'],
};
const ANSWER_POOL = [6,8,9,12,15,16,18,24,27,36];
const COLOR_CONFIG: Record<BubbleColor, { hex:string; dark:string; points:number; label:string }> = {
  red:    { hex:'#ff6b6b', dark:'#c0392b', points:100, label:'빨강' },
  blue:   { hex:'#4fc3f7', dark:'#0277bd', points:150, label:'파랑' },
  green:  { hex:'#81c784', dark:'#2e7d32', points:200, label:'초록' },
  yellow: { hex:'#fff176', dark:'#f57f17', points:250, label:'노랑' },
  purple: { hex:'#ce93d8', dark:'#6a1b9a', points:300, label:'보라' },
  orange: { hex:'#ffb74d', dark:'#e65100', points:350, label:'주황' },
};
const COLOR_KEYS: BubbleColor[] = ['red','blue','green','yellow','purple','orange'];

// ─── Falling bubble (낙하 애니메이션용) ──────────────────────────────────────
interface FallingBubble {
  x: number; y: number; vy: number;
  color: BubbleColor; expression: string; alpha: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const adj = (color: string, amt: number) => {
  const hex = color.replace('#','');
  const c=(o:number)=>Math.max(0,Math.min(255,parseInt(hex.slice(o,o+2),16)+amt));
  return '#'+[c(0),c(2),c(4)].map(v=>v.toString(16).padStart(2,'0')).join('');
};
const rndExpr = (a: number) => {
  const p = EXPRESSION_POOL[a]||[String(a)];
  return p[Math.floor(Math.random()*p.length)];
};

// ─── Marble drawing ───────────────────────────────────────────────────────────
const drawMarble = (
  ctx: CanvasRenderingContext2D,
  x:number, y:number, r:number,
  color:BubbleColor, expression:string,
  isHard:boolean, alpha=1.0, sx=0, sy=0
) => {
  ctx.save();
  if (alpha<1) ctx.globalAlpha=alpha;
  const cx=x+sx, cy=y+sy;
  const cfg=COLOR_CONFIG[color];
  const base=isHard?'#5c5c7a':cfg.hex;
  const dark=isHard?'#2a2a44':cfg.dark;
  ctx.shadowColor=`${dark}99`; ctx.shadowBlur=6; ctx.shadowOffsetX=2; ctx.shadowOffsetY=3;
  const g=ctx.createRadialGradient(cx-r*.3,cy-r*.3,r*.05,cx,cy,r);
  g.addColorStop(0,'#ffffff'); g.addColorStop(0.2,adj(base,50));
  g.addColorStop(0.7,base); g.addColorStop(1,dark);
  ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.fillStyle=g; ctx.fill();
  ctx.shadowColor='transparent'; ctx.shadowBlur=0; ctx.shadowOffsetX=0; ctx.shadowOffsetY=0;
  ctx.strokeStyle=dark+'88'; ctx.lineWidth=1; ctx.stroke();
  const hg=ctx.createRadialGradient(cx-r*.32,cy-r*.38,0,cx-r*.2,cy-r*.2,r*.5);
  hg.addColorStop(0,'rgba(255,255,255,0.65)'); hg.addColorStop(1,'rgba(255,255,255,0)');
  ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.fillStyle=hg; ctx.fill();
  const len=expression.length;
  const fs=len<=2?r*.78:len<=4?r*.60:len<=6?r*.50:r*.42;
  ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.font=`900 ${fs}px 'Arial Black',sans-serif`;
  ctx.shadowColor='rgba(0,0,0,0.5)'; ctx.shadowBlur=2; ctx.shadowOffsetX=1; ctx.shadowOffsetY=1;
  ctx.strokeStyle=`${dark}66`; ctx.lineWidth=fs*.18; ctx.lineJoin='round';
  ctx.strokeText(expression,cx,cy+fs*.04);
  ctx.fillStyle=isHard?'rgba(210,210,255,0.95)':'rgba(255,255,255,0.95)';
  ctx.fillText(expression,cx,cy+fs*.04);
  ctx.shadowColor='transparent'; ctx.shadowBlur=0; ctx.shadowOffsetX=0; ctx.shadowOffsetY=0;
  ctx.restore();
};

const drawOpponentBoard = (
  ctx: CanvasRenderingContext2D,
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
  for (const b of opp) {
    const bx=x+4+b.x*scale, by=y+20+b.y*scale, br=Math.max(4,BUBBLE_RADIUS*scale*1.2);
    if (bx<x||bx>x+w||by<y+20||by>y+h) continue;
    drawMarble(ctx,bx,by,br,b.color,b.expression,false,0.9);
  }
  ctx.restore();
};

type MultiStatus = 'idle'|'searching'|'matched'|'playing';
type GamePhase   = 'start'|'countdown'|'playing'|'over';

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

  const selectedAnswerRef = useRef<number>(12);
  const gameModeRef       = useRef<GameMode>('easy');
  // 하드모드: 실제 아래로 착지한 발사 횟수
  const downLandCountRef  = useRef(0);
  const gameStartTimeRef  = useRef(0);
  const lastDropTimeRef   = useRef(0);
  const isGameOverRef     = useRef(false);
  const dustParticles     = useRef<Particle[]>([]);
  const shakeTimeRef      = useRef(0);
  const gamePhaseRef      = useRef<GamePhase>('start');
  const waveOffsetRef     = useRef(0);
  const frameCountRef     = useRef(0);

  // 터치 (모바일 보조)
  const touchActiveRef = useRef(false);
  const touchPosRef    = useRef<Point>({x:0,y:0});

  // 선택 모드: 손이 하단 영역에 있을 때
  const selectModeRef    = useRef(false);
  const selectModeState  = useRef(false); // 손이 select zone 진입 당시 pinching 여부

  // Multiplayer
  const fbRef           = useRef<FirebaseServices|null>(null);
  const joinResultRef   = useRef<JoinResult|null>(null);
  const multiStatusRef  = useRef<MultiStatus>('idle');
  const oppBubblesRef   = useRef<{x:number;y:number;color:BubbleColor;expression:string}[]>([]);
  const roomUnsubRef    = useRef<(()=>void)|null>(null);
  const oppUnsubRef     = useRef<(()=>void)|null>(null);
  const publishTimerRef = useRef<ReturnType<typeof setInterval>|null>(null);
  const rafRef          = useRef<number>(0);

  const [loading,           setLoading]          = useState(true);
  const [score,             setScore]            = useState(0);
  const [selectedAnswer,    setSelectedAnswer]   = useState<number>(12);
  const [availableAnswers,  setAvailableAnswers] = useState<number[]>([]);
  const [gameMode,          setGameMode]         = useState<GameMode>('easy');
  const [showHardNotif,     setShowHardNotif]    = useState(false);
  const [isGameOver,        setIsGameOver]       = useState(false);
  const [finalScore,        setFinalScore]       = useState(0);
  const [gamePhase,         setGamePhase]        = useState<GamePhase>('start');
  const [countdownNum,      setCountdownNum]     = useState(3);
  const [multiStatus,       setMultiStatus]      = useState<MultiStatus>('idle');
  const [showMatchedBanner, setShowMatchedBanner]= useState(false);
  // 선택 모드 UI 표시용
  const [inSelectMode,      setInSelectMode]     = useState(false);

  useEffect(()=>{ selectedAnswerRef.current=selectedAnswer; },[selectedAnswer]);
  useEffect(()=>{ gameModeRef.current=gameMode; },[gameMode]);
  useEffect(()=>{ gamePhaseRef.current=gamePhase; },[gamePhase]);
  useEffect(()=>{ multiStatusRef.current=multiStatus; },[multiStatus]);

  // ── Grid ──────────────────────────────────────────────────────────────────
  const getBubblePos = (row:number, col:number, width:number) => {
    const xOffset=(width-GRID_COLS*BUBBLE_RADIUS*2)/2+BUBBLE_RADIUS;
    return {
      x: xOffset+col*(BUBBLE_RADIUS*2)+(row%2!==0?BUBBLE_RADIUS:0),
      y: BUBBLE_RADIUS+row*ROW_HEIGHT,
    };
  };

  const updateAvailableAnswers = useCallback(()=>{
    const active=new Set<number>();
    bubbles.current.forEach(b=>{ if(b.active) active.add(b.answer); });
    const arr=Array.from(active).sort((a,b)=>a-b);
    setAvailableAnswers(arr);
    if (!active.has(selectedAnswerRef.current)&&arr.length>0) setSelectedAnswer(arr[0]);
  },[]);

  // 연결된 구슬 배치 보장: 각 구슬이 최소 1개 이웃과 연결되도록
  const makeRow = (row:number, width:number, existingBubbles:Bubble[]): Bubble[] => {
    const maxCols=row%2!==0?GRID_COLS-1:GRID_COLS;
    const all=Array.from({length:maxCols},(_,i)=>i);
    for (let i=all.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[all[i],all[j]]=[all[j],all[i]];}

    // 연속된 컬럼 선택 (중앙 근처에서 MAX_BUBBLES_PER_ROW개 연속 배치 → 떨어지지 않도록)
    const start=Math.floor(Math.random()*(maxCols-MAX_BUBBLES_PER_ROW+1));
    const chosen=Array.from({length:MAX_BUBBLES_PER_ROW},(_,i)=>start+i);

    return chosen.map(c=>{
      const {x,y}=getBubblePos(row,c,width);
      const ans=ANSWER_POOL[Math.floor(Math.random()*ANSWER_POOL.length)];
      return {id:`${row}-${c}-${Date.now()}-${c}`,row,col:c,x,y,
        color:ANSWER_COLOR_MAP[ans]||'red',answer:ans,expression:rndExpr(ans),active:true};
    });
  };

  const initGrid = useCallback((width:number)=>{
    const nb:Bubble[]=[];
    for (let r=0;r<INIT_ROWS;r++) nb.push(...makeRow(r,width,[]));
    bubbles.current=[...nb]; particles.current=[]; dustParticles.current=[]; fallingBubbles.current=[];
    isGameOverRef.current=false; scoreRef.current=0;
    gameStartTimeRef.current=performance.now(); lastDropTimeRef.current=performance.now();
    shakeTimeRef.current=0; downLandCountRef.current=0;
    updateAvailableAnswers();
  },[updateAvailableAnswers]);

  // ── Floating check: 천장(row=0)에 연결 안 된 구슬 낙하 ──────────────────
  const dropFloatingBubbles = useCallback(()=>{
    const active=bubbles.current.filter(b=>b.active);
    // BFS: row=0에 닿아있는 구슬 찾기
    const connected=new Set<string>();
    const queue=active.filter(b=>b.row===0);
    queue.forEach(b=>connected.add(b.id));
    let qi=0;
    while (qi<queue.length){
      const cur=queue[qi++];
      active.filter(b=>!connected.has(b.id)&&isNeighbor(cur,b)).forEach(b=>{
        connected.add(b.id); queue.push(b);
      });
    }
    // 연결 안 된 구슬 → 낙하
    const toFall=active.filter(b=>!connected.has(b.id));
    toFall.forEach(b=>{
      b.active=false;
      fallingBubbles.current.push({x:b.x,y:b.y,vy:1+Math.random()*2,color:b.color,expression:b.expression,alpha:1.0});
    });
    if (toFall.length>0) bubbles.current=bubbles.current.filter(b=>b.active);
  },[]);

  // ── isNeighbor ────────────────────────────────────────────────────────────
  const isNeighbor=(a:Bubble,b:Bubble)=>{
    const dr=b.row-a.row,dc=b.col-a.col;
    if (Math.abs(dr)>1) return false;
    if (dr===0) return Math.abs(dc)===1;
    return a.row%2!==0?(dc===0||dc===1):(dc===-1||dc===0);
  };

  // ── Effects ───────────────────────────────────────────────────────────────
  const createDust=(cw:number)=>{
    if (dustParticles.current.length>60) return;
    for (let i=0;i<20;i++) dustParticles.current.push({
      x:Math.random()*cw,y:BUBBLE_RADIUS*2+Math.random()*8,
      vx:(Math.random()-.5)*2.5,vy:Math.random()*1.2+0.2,
      life:.6+Math.random()*.4,color:`hsl(${40+Math.random()*20},50%,65%)`,
    });
  };

  const createExplosion=(x:number,y:number,color:string,big=false)=>{
    if (particles.current.length>MAX_PARTICLES) return;
    const n=big?20:12, sp=big?18:14;
    for (let i=0;i<n;i++) particles.current.push({x,y,vx:(Math.random()-.5)*sp,vy:(Math.random()-.5)*sp,life:1.0,color});
    for (let i=0;i<6;i++) particles.current.push({x,y,vx:(Math.random()-.5)*8,vy:-Math.random()*12-3,life:1.3,color:'#fff'});
  };

  // ── Match logic ───────────────────────────────────────────────────────────
  // 규칙1: 같은 정답 3개 이상
  // 규칙2: 같은 색 3개 이상
  // 규칙3: 같은 색+정답 → 주변 1칸 범위 폭발 (콤보)
  const checkMatches = useCallback((start:Bubble)=>{
    let exploded=false;
    const mult=gameModeRef.current==='hard'?1.5:1.0;

    // 규칙3: 같은 색+같은 정답 클러스터
    const sameColorAnswer=new Set<string>([start.id]);
    const q3=[start];
    let qi=0;
    while(qi<q3.length){
      const cur=q3[qi++];
      bubbles.current.filter(b=>b.active&&!sameColorAnswer.has(b.id)&&isNeighbor(cur,b)
        &&b.color===start.color&&b.answer===start.answer).forEach(b=>{sameColorAnswer.add(b.id);q3.push(b);});
    }
    if (sameColorAnswer.size>=3){
      // 주변 1칸 범위까지 모두 폭발
      const toExplode=new Set<string>(sameColorAnswer);
      sameColorAnswer.forEach(id=>{
        const b=bubbles.current.find(x=>x.id===id); if(!b) return;
        bubbles.current.filter(nb=>nb.active&&!toExplode.has(nb.id)&&isNeighbor(b,nb))
          .forEach(nb=>toExplode.add(nb.id));
      });
      let pts=0;
      toExplode.forEach(id=>{
        const b=bubbles.current.find(x=>x.id===id); if(!b||!b.active) return;
        b.active=false; createExplosion(b.x,b.y,COLOR_CONFIG[b.color].hex,true);
        pts+=COLOR_CONFIG[b.color].points*2; // 콤보 보너스 2배
      });
      bubbles.current=bubbles.current.filter(b=>b.active);
      scoreRef.current+=Math.floor(pts*mult); setScore(scoreRef.current);
      dropFloatingBubbles(); return;
    }

    // 규칙1: 같은 정답 3개 이상
    const sameAns=new Set<string>([start.id]);
    const q1=[start]; qi=0;
    while(qi<q1.length){
      const cur=q1[qi++];
      bubbles.current.filter(b=>b.active&&!sameAns.has(b.id)&&isNeighbor(cur,b)&&b.answer===start.answer)
        .forEach(b=>{sameAns.add(b.id);q1.push(b);});
    }
    if (sameAns.size>=3){
      let pts=0;
      sameAns.forEach(id=>{
        const b=bubbles.current.find(x=>x.id===id); if(!b||!b.active) return;
        b.active=false; createExplosion(b.x,b.y,COLOR_CONFIG[b.color].hex);
        pts+=COLOR_CONFIG[b.color].points*(sameAns.size>3?1.5:1.0);
      });
      bubbles.current=bubbles.current.filter(b=>b.active);
      scoreRef.current+=Math.floor(pts*mult); setScore(scoreRef.current);
      exploded=true; dropFloatingBubbles(); return;
    }

    // 규칙2: 같은 색 3개 이상
    const sameCol=new Set<string>([start.id]);
    const q2=[start]; qi=0;
    while(qi<q2.length){
      const cur=q2[qi++];
      bubbles.current.filter(b=>b.active&&!sameCol.has(b.id)&&isNeighbor(cur,b)&&b.color===start.color)
        .forEach(b=>{sameCol.add(b.id);q2.push(b);});
    }
    if (sameCol.size>=3){
      let pts=0;
      sameCol.forEach(id=>{
        const b=bubbles.current.find(x=>x.id===id); if(!b||!b.active) return;
        b.active=false; createExplosion(b.x,b.y,COLOR_CONFIG[b.color].hex);
        pts+=COLOR_CONFIG[b.color].points;
      });
      bubbles.current=bubbles.current.filter(b=>b.active);
      scoreRef.current+=Math.floor(pts*mult); setScore(scoreRef.current);
      dropFloatingBubbles(); return;
    }

    void exploded;
  },[dropFloatingBubbles]);

  // ── New row ───────────────────────────────────────────────────────────────
  const addNewRow=(cw:number)=>{
    bubbles.current=bubbles.current.filter(b=>b.active);
    bubbles.current.forEach(b=>{ b.row++; b.y+=ROW_HEIGHT; });
    bubbles.current.push(...makeRow(0,cw,bubbles.current));
    // 새 줄 추가 후 천장 연결 체크
    dropFloatingBubbles();
    updateAvailableAnswers(); createDust(cw);
  };

  const checkGameOver=(ch:number)=>{
    const slY=ch-SLINGSHOT_BOTTOM_OFFSET-BUBBLE_RADIUS*3;
    if (bubbles.current.some(b=>b.active&&b.y+BUBBLE_RADIUS>=slY)){
      isGameOverRef.current=true; setFinalScore(scoreRef.current);
      setIsGameOver(true); setGamePhase('over'); gamePhaseRef.current='over';
    }
  };

  // ── Launch ────────────────────────────────────────────────────────────────
  const tryLaunch=(now:number, isHard:boolean, landedBelow:boolean)=>{
    const dx=anchorPos.current.x-ballPos.current.x, dy=anchorPos.current.y-ballPos.current.y;
    const sd=Math.sqrt(dx*dx+dy*dy);
    if (sd>30){
      isFlying.current=true; flightStart.current=now;
      const pr=Math.min(sd/MAX_DRAG_DIST,1.0);
      const vm=MIN_FORCE_MULT+(MAX_FORCE_MULT-MIN_FORCE_MULT)*(pr*pr);
      ballVel.current={x:dx*vm,y:dy*vm};
    } else { ballPos.current={...anchorPos.current}; }
    void landedBelow; void isHard;
  };

  const applyDrag=(pos:Point)=>{
    ballPos.current={x:pos.x,y:pos.y};
    const ddx=ballPos.current.x-anchorPos.current.x, ddy=ballPos.current.y-anchorPos.current.y;
    const dd=Math.sqrt(ddx*ddx+ddy*ddy);
    if (dd>MAX_DRAG_DIST){
      const ang=Math.atan2(ddy,ddx);
      ballPos.current={x:anchorPos.current.x+Math.cos(ang)*MAX_DRAG_DIST,y:anchorPos.current.y+Math.sin(ang)*MAX_DRAG_DIST};
    }
  };

  // ── Multiplayer ───────────────────────────────────────────────────────────
  const startCountdown=(onDone:()=>void)=>{
    setGamePhase('countdown'); gamePhaseRef.current='countdown'; setCountdownNum(3);
    let c=3;
    const iv=setInterval(()=>{ c--;setCountdownNum(c); if(c<=0){clearInterval(iv);onDone();} },1000);
  };

  const startMultiplayer=useCallback(async()=>{
    if (multiStatusRef.current==='searching'||multiStatusRef.current==='matched') return;
    setMultiStatus('searching'); multiStatusRef.current='searching';
    try {
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
        if(!res?.state?.bubbles) return;
        oppBubblesRef.current=res.state.bubbles;
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
    downLandCountRef.current=0; isGameOverRef.current=false;
    particles.current=[]; dustParticles.current=[]; fallingBubbles.current=[];
    initGrid(canvasRef.current?.width||800);
    setGamePhase('start'); gamePhaseRef.current='start';
  },[initGrid]);

  const handleStart=()=>{
    startCountdown(()=>{setGamePhase('playing');gamePhaseRef.current='playing';});
  };

  useEffect(()=>()=>{leaveMultiplayer();},[leaveMultiplayer]);

  // ─────────────────────────────────────────────────────────────────────────
  // MAIN GAME LOOP (MediaPipe — 모바일 + 데스크탑 공통)
  // ─────────────────────────────────────────────────────────────────────────
  useEffect(()=>{
    if(!videoRef.current||!canvasRef.current||!gameContainerRef.current) return;
    const video=videoRef.current, canvas=canvasRef.current, container=gameContainerRef.current;
    const ctx=canvas.getContext('2d',{willReadFrequently:false}); if(!ctx) return;

    canvas.width=container.clientWidth; canvas.height=container.clientHeight;
    anchorPos.current={x:canvas.width/2,y:canvas.height-SLINGSHOT_BOTTOM_OFFSET};
    ballPos.current={...anchorPos.current};
    initGrid(canvas.width);

    let camera:any=null, hands:any=null;

    const onResults=(results:any)=>{
      setLoading(false);
      frameCountRef.current++;

      if(canvas.width!==container.clientWidth||canvas.height!==container.clientHeight){
        canvas.width=container.clientWidth; canvas.height=container.clientHeight;
        anchorPos.current={x:canvas.width/2,y:canvas.height-SLINGSHOT_BOTTOM_OFFSET};
        if(!isFlying.current&&!isPinching.current) ballPos.current={...anchorPos.current};
      }

      ctx.save();
      ctx.clearRect(0,0,canvas.width,canvas.height);
      if(results.image){
        ctx.drawImage(results.image,0,0,canvas.width,canvas.height);
        ctx.fillStyle='rgba(18,18,18,0.85)';
      } else { ctx.fillStyle='#121212'; }
      ctx.fillRect(0,0,canvas.width,canvas.height);

      const now=performance.now();
      const isPlaying=gamePhaseRef.current==='playing';
      const isHard=gameModeRef.current==='hard';

      // ── Row drop ──
      if(isPlaying&&!isGameOverRef.current){
        const elapsed=now-gameStartTimeRef.current, interval=getDropInterval(elapsed);
        const sinceLast=now-lastDropTimeRef.current;
        if(sinceLast>=interval-2000&&shakeTimeRef.current===0)
          shakeTimeRef.current=now-(sinceLast-(interval-2000));
        if(sinceLast<interval-2000) shakeTimeRef.current=0;
        if(sinceLast>=interval){
          lastDropTimeRef.current=now; addNewRow(canvas.width);
          shakeTimeRef.current=0; checkGameOver(canvas.height);
        }
      }

      // ── Shake (구슬 있는 행만) ──
      let gsx=0, gsy=0;
      if(shakeTimeRef.current>0){
        const se=now-shakeTimeRef.current, sp=Math.min(se/2000,1.0);
        const amp=(1.5+sp*4)*Math.sin(se/35);
        gsx=amp*(Math.random()-.5)*1.5; gsy=amp*Math.abs(Math.sin(se/55))*.4;
      }

      // ── Hand tracking ──
      let handPos:Point|null=null, pinchDist=1.0;

      // 터치 입력 (모바일 보조)
      if(touchActiveRef.current){
        handPos=touchPosRef.current; pinchDist=0.0;
      }

      if(results.multiHandLandmarks?.length>0){
        const lm=results.multiHandLandmarks[0], idx=lm[8], thumb=lm[4];
        handPos={x:(idx.x+thumb.x)*canvas.width/2,y:(idx.y+thumb.y)*canvas.height/2};
        const dx=idx.x-thumb.x,dy=idx.y-thumb.y; pinchDist=Math.sqrt(dx*dx+dy*dy);
        if(frameCountRef.current%2===0&&window.drawConnectors&&window.drawLandmarks){
          window.drawConnectors(ctx,lm,window.HAND_CONNECTIONS,{color:'#669df6',lineWidth:1});
          window.drawLandmarks(ctx,lm,{color:'#aecbfa',lineWidth:1,radius:2});
        }
        ctx.beginPath(); ctx.arc(handPos.x,handPos.y,18,0,Math.PI*2);
        ctx.strokeStyle=pinchDist<PINCH_THRESHOLD?'#66bb6a':'#ffffff';
        ctx.lineWidth=2; ctx.stroke();
      }

      const isLocked=isGameOverRef.current||!isPlaying;
      const selectZoneY=canvas.height*SELECT_ZONE_RATIO;

      // ── 정답 선택 모드 (손이 하단 영역) ──
      const handInSelectZone=handPos&&handPos.y>selectZoneY&&!isFlying.current;
      if(handInSelectZone&&!isPinching.current){
        selectModeRef.current=true;
        setInSelectMode(true);
        // 손 x 위치로 정답 선택
        if(handPos&&availableAnswers.length>0){
          const margin=60;
          const segW=(canvas.width-margin*2)/Math.max(availableAnswers.length-1,1);
          const idx=Math.round((handPos.x-margin)/segW);
          const clamped=Math.max(0,Math.min(availableAnswers.length-1,idx));
          const picked=availableAnswers[clamped];
          if(picked!==selectedAnswerRef.current) setSelectedAnswer(picked);
        }
      } else if(!handInSelectZone){
        if(selectModeRef.current){ selectModeRef.current=false; setInSelectMode(false); }
      }

      // ── Slingshot input (선택모드 아닐 때) ──
      if(!isLocked&&!selectModeRef.current){
        if(handPos&&pinchDist<PINCH_THRESHOLD&&!isFlying.current){
          const db=Math.sqrt(Math.pow(handPos.x-ballPos.current.x,2)+Math.pow(handPos.y-ballPos.current.y,2));
          if(!isPinching.current&&db<120) isPinching.current=true;
          if(isPinching.current) applyDrag(handPos);
        } else if(isPinching.current&&(!handPos||pinchDist>=PINCH_THRESHOLD||isLocked)){
          isPinching.current=false;
          if(isLocked) ballPos.current={...anchorPos.current};
          else tryLaunch(now,isHard,false);
        } else if(!isFlying.current&&!isPinching.current){
          const dx=anchorPos.current.x-ballPos.current.x,dy=anchorPos.current.y-ballPos.current.y;
          ballPos.current.x+=dx*.15; ballPos.current.y+=dy*.15;
        }
      }

      // ── Physics ──
      if(isFlying.current){
        if(now-flightStart.current>5000){
          isFlying.current=false; ballPos.current={...anchorPos.current}; ballVel.current={x:0,y:0};
        } else {
          const spd=Math.sqrt(ballVel.current.x**2+ballVel.current.y**2);
          const steps=Math.ceil(spd/(BUBBLE_RADIUS*.8)); let hit=false;
          let hitBelow=false; // 아래로 착지했는지

          for(let i=0;i<steps;i++){
            ballPos.current.x+=ballVel.current.x/steps;
            ballPos.current.y+=ballVel.current.y/steps;
            if(ballPos.current.x<BUBBLE_RADIUS||ballPos.current.x>canvas.width-BUBBLE_RADIUS){
              ballVel.current.x*=-1;
              ballPos.current.x=Math.max(BUBBLE_RADIUS,Math.min(canvas.width-BUBBLE_RADIUS,ballPos.current.x));
            }
            if(ballPos.current.y<BUBBLE_RADIUS){hit=true;break;}
            for(const b of bubbles.current){
              if(!b.active) continue;
              if(Math.pow(ballPos.current.x-b.x,2)+Math.pow(ballPos.current.y-b.y,2)<Math.pow(BUBBLE_RADIUS*1.8,2)){
                hit=true;
                // 구슬보다 아래에서 충돌 = 아래방향 발사
                if(ballPos.current.y>b.y) hitBelow=true;
                break;
              }
            }
            if(hit) break;
          }
          ballVel.current.x*=0.998; ballVel.current.y*=0.998;

          if(hit){
            isFlying.current=false;
            // 하드모드 카운트: 구슬보다 아래에 착지한 경우
            if(hitBelow&&!isHard){
              downLandCountRef.current++;
              if(downLandCountRef.current>=3){
                gameModeRef.current='hard'; setGameMode('hard');
                setShowHardNotif(true); setTimeout(()=>setShowHardNotif(false),3000);
              }
            }
            let bd=Infinity,br=0,bc=0,bx=0,by=0;
            for(let r=0;r<GRID_ROWS+5;r++){
              const cols=r%2!==0?GRID_COLS-1:GRID_COLS;
              for(let c=0;c<cols;c++){
                const p=getBubblePos(r,c,canvas.width);
                if(bubbles.current.some(b=>b.active&&b.row===r&&b.col===c)) continue;
                const d=Math.sqrt(Math.pow(ballPos.current.x-p.x,2)+Math.pow(ballPos.current.y-p.y,2));
                if(d<bd){bd=d;br=r;bc=c;bx=p.x;by=p.y;}
              }
            }
            const ans=selectedAnswerRef.current;
            const col=(isHard?'purple':ANSWER_COLOR_MAP[ans]||'red') as BubbleColor;
            const nb:Bubble={id:`shot-${Date.now()}`,row:br,col:bc,x:bx,y:by,color:col,answer:ans,expression:rndExpr(ans),active:true};
            bubbles.current.push(nb);
            checkMatches(nb);
            updateAvailableAnswers();
            ballPos.current={...anchorPos.current}; ballVel.current={x:0,y:0};
            checkGameOver(canvas.height);
          }
          if(ballPos.current.y>canvas.height){
            isFlying.current=false; ballPos.current={...anchorPos.current}; ballVel.current={x:0,y:0};
          }
        }
      }

      // ── Draw bubbles (구슬 있는 행만 흔들림) ──
      const doShake=shakeTimeRef.current>0;
      // 구슬이 존재하는 최상단/최하단 row 계산
      const activeRows=new Set(bubbles.current.filter(b=>b.active).map(b=>b.row));
      for(const b of bubbles.current){
        if(!b.active) continue;
        const shake=doShake&&activeRows.has(b.row);
        drawMarble(ctx,b.x,b.y,BUBBLE_RADIUS-1,b.color,b.expression,isHard,1.0,shake?gsx:0,shake?gsy:0);
      }

      // ── Falling bubbles ──
      for(let i=fallingBubbles.current.length-1;i>=0;i--){
        const fb=fallingBubbles.current[i];
        fb.y+=fb.vy; fb.vy+=FALL_GRAVITY; fb.alpha-=0.022;
        if(fb.alpha<=0||fb.y>canvas.height){fallingBubbles.current.splice(i,1);continue;}
        drawMarble(ctx,fb.x,fb.y,BUBBLE_RADIUS-1,fb.color,fb.expression,isHard,fb.alpha);
        // 착지 파티클
        if(fb.y>canvas.height-50) createExplosion(fb.x,fb.y,COLOR_CONFIG[fb.color].hex);
      }

      // ── Dust ──
      if(frameCountRef.current%2===0){
        for(let i=dustParticles.current.length-1;i>=0;i--){
          const p=dustParticles.current[i]; p.x+=p.vx;p.y+=p.vy;p.life-=.025;
          if(p.life<=0){dustParticles.current.splice(i,1);continue;}
          ctx.globalAlpha=p.life*.6;
          ctx.beginPath();ctx.arc(p.x,p.y,2+p.life*2.5,0,Math.PI*2);ctx.fillStyle=p.color;ctx.fill();
        }
        ctx.globalAlpha=1.0;
      }

      // ── Wavy danger line ──
      waveOffsetRef.current+=.04;
      const slY=canvas.height-SLINGSHOT_BOTTOM_OFFSET-BUBBLE_RADIUS*3;
      ctx.save();
      ctx.beginPath(); ctx.moveTo(0,slY);
      for(let wx=0;wx<=canvas.width;wx+=6) ctx.lineTo(wx,slY+Math.sin(wx/28+waveOffsetRef.current)*3.5);
      const lg=ctx.createLinearGradient(0,0,canvas.width,0);
      lg.addColorStop(0,'rgba(60,140,255,0)'); lg.addColorStop(0.2,'rgba(80,160,255,0.5)');
      lg.addColorStop(0.5,'rgba(100,180,255,0.65)'); lg.addColorStop(0.8,'rgba(80,160,255,0.5)');
      lg.addColorStop(1,'rgba(60,140,255,0)');
      ctx.strokeStyle=lg; ctx.lineWidth=2; ctx.shadowBlur=6; ctx.shadowColor='rgba(80,160,255,0.5)';
      ctx.stroke(); ctx.shadowBlur=0; ctx.restore();

      // ── 정답 선택 모드 UI (캔버스) ──
      if(selectModeRef.current&&availableAnswers.length>0&&handPos){
        const margin=60;
        const segW=(canvas.width-margin*2)/Math.max(availableAnswers.length-1,1);
        ctx.save();
        ctx.fillStyle='rgba(0,0,0,0.4)';
        ctx.fillRect(0,selectZoneY,canvas.width,canvas.height-selectZoneY);
        ctx.fillStyle='rgba(255,255,255,0.12)';
        ctx.fillRect(0,selectZoneY,canvas.width,2);
        ctx.font='bold 12px sans-serif'; ctx.textAlign='center';
        availableAnswers.forEach((ans,i)=>{
          const ax=margin+i*segW;
          const col=ANSWER_COLOR_MAP[ans]||'red', cfg=COLOR_CONFIG[col];
          const isSel=ans===selectedAnswerRef.current;
          const r=isSel?30:22;
          drawMarble(ctx,ax,selectZoneY+50,r,col,String(ans),isHard,isSel?1.0:0.7);
          if(isSel){
            ctx.beginPath(); ctx.arc(ax,selectZoneY+50,r+5,0,Math.PI*2);
            ctx.strokeStyle=cfg.hex+'99'; ctx.lineWidth=3; ctx.stroke();
            // 손 위치 포인터
            ctx.beginPath(); ctx.moveTo(handPos!.x,selectZoneY-10); ctx.lineTo(ax,selectZoneY+20);
            ctx.strokeStyle='rgba(255,255,255,0.4)'; ctx.lineWidth=1; ctx.setLineDash([4,4]); ctx.stroke();
            ctx.setLineDash([]);
          }
        });
        ctx.restore();
      }

      // ── Slingshot ──
      const band=isPinching.current?'#fdd835':'rgba(255,255,255,0.4)';
      if(!isFlying.current){
        ctx.beginPath();ctx.moveTo(anchorPos.current.x-35,anchorPos.current.y-10);ctx.lineTo(ballPos.current.x,ballPos.current.y);
        ctx.lineWidth=5;ctx.strokeStyle=band;ctx.lineCap='round';ctx.stroke();
      }
      ctx.save();
      if(isLocked&&!isFlying.current) ctx.globalAlpha=0.5;
      const sc=(isHard?'purple':ANSWER_COLOR_MAP[selectedAnswerRef.current]||'red') as BubbleColor;
      drawMarble(ctx,ballPos.current.x,ballPos.current.y,BUBBLE_RADIUS,sc,String(selectedAnswerRef.current),isHard);
      ctx.restore();
      if(!isFlying.current){
        ctx.beginPath();ctx.moveTo(ballPos.current.x,ballPos.current.y);ctx.lineTo(anchorPos.current.x+35,anchorPos.current.y-10);
        ctx.lineWidth=5;ctx.strokeStyle=band;ctx.lineCap='round';ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(anchorPos.current.x,canvas.height);
      ctx.lineTo(anchorPos.current.x,anchorPos.current.y+40);
      ctx.lineTo(anchorPos.current.x-40,anchorPos.current.y);
      ctx.moveTo(anchorPos.current.x,anchorPos.current.y+40);
      ctx.lineTo(anchorPos.current.x+40,anchorPos.current.y);
      ctx.lineWidth=10;ctx.lineCap='round';ctx.strokeStyle='#616161';ctx.stroke();

      // ── 조준선 (당기는 중) ──
      if(isPinching.current&&!isFlying.current){
        const dx=anchorPos.current.x-ballPos.current.x, dy=anchorPos.current.y-ballPos.current.y;
        const len=Math.sqrt(dx*dx+dy*dy);
        if(len>10){
          ctx.save(); ctx.setLineDash([12,10]);
          ctx.lineDashOffset=-((now/12)%22);
          ctx.strokeStyle='rgba(255,255,255,0.4)'; ctx.lineWidth=2;
          ctx.beginPath();
          ctx.moveTo(ballPos.current.x,ballPos.current.y);
          ctx.lineTo(ballPos.current.x+dx/len*180,ballPos.current.y+dy/len*180);
          ctx.stroke(); ctx.restore();
        }
      }

      // ── Particles ──
      for(let i=particles.current.length-1;i>=0;i--){
        const p=particles.current[i]; p.x+=p.vx;p.y+=p.vy;p.life-=.055;
        if(p.life<=0){particles.current.splice(i,1);continue;}
        ctx.globalAlpha=p.life;ctx.beginPath();ctx.arc(p.x,p.y,4,0,Math.PI*2);ctx.fillStyle=p.color;ctx.fill();
      }
      ctx.globalAlpha=1.0;

      // ── Opponent ──
      if(oppBubblesRef.current.length>0&&multiStatusRef.current==='playing'){
        const ow=140,oh=190;
        drawOpponentBoard(ctx,oppBubblesRef.current,canvas.width-ow-8,8,ow,oh);
      }

      ctx.restore();
    };

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
  },[initGrid,checkMatches,updateAvailableAnswers,dropFloatingBubbles,availableAnswers]);

  // ── 터치 이벤트 ──────────────────────────────────────────────────────────
  useEffect(()=>{
    const canvas=canvasRef.current; if(!canvas) return;
    const getPos=(e:TouchEvent):Point=>{
      const rect=canvas.getBoundingClientRect();
      const sx=canvas.width/rect.width, sy=canvas.height/rect.height;
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
          <div className="flex flex-col items-center gap-5 px-4 w-full max-w-md">
            <div className="text-center">
              <div className="text-5xl mb-2" style={{filter:'drop-shadow(0 0 20px #4fc3f7)'}}>🧮</div>
              <h1 className="text-4xl font-black mb-1" style={{
                background:'linear-gradient(135deg,#4fc3f7,#81c784,#ffb74d)',
                WebkitBackgroundClip:'text',WebkitTextFillColor:'transparent',
              }}>매스 슬링샷</h1>
            </div>

            {/* 규칙 카드 */}
            <div className="w-full space-y-2">
              <p className="text-[#c4c7c5] text-xs uppercase tracking-widest text-center font-bold mb-1">게임 규칙</p>

              <div className="bg-white/5 rounded-xl p-3 border border-white/10 text-xs text-[#c4c7c5] space-y-1.5">
                <p className="font-bold text-white text-sm">💥 터지는 조건 (3가지)</p>
                <div className="pl-2 space-y-1">
                  <p>① <span className="text-[#4fc3f7]">같은 정답</span> 3개 이상 연결 → 팡!</p>
                  <p>② <span className="text-[#81c784]">같은 색</span> 3개 이상 연결 → 팡!</p>
                  <p>③ <span className="text-[#ffb74d]">같은 색 + 같은 정답</span> 3개 이상 → 주변 1칸까지 폭발! 🌟</p>
                </div>
              </div>

              <div className="bg-white/5 rounded-xl p-3 border border-white/10 text-xs text-[#c4c7c5] space-y-1.5">
                <p className="font-bold text-white text-sm">🎮 조작법</p>
                <div className="pl-2 space-y-1">
                  <p>🖐️ <span className="text-[#4fc3f7]">손가락을 모아 구슬을 당겨</span> 발사</p>
                  <p>⬇️ 손을 <span className="text-[#ce93d8]">화면 아래쪽</span>으로 내리면 정답 선택</p>
                  <p>📱 터치: 슬링샷 근처 터치 드래그로 발사</p>
                </div>
              </div>

              <div className="bg-white/5 rounded-xl p-3 border border-white/10 text-xs text-[#c4c7c5] space-y-1.5">
                <p className="font-bold text-white text-sm">⚡ 하드 모드</p>
                <div className="pl-2 space-y-1">
                  <p>구슬이 <span className="text-[#ff6b6b]">아래 방향</span>으로 착지 3회 → 하드 모드!</p>
                  <p>색깔 힌트 없음 + 점수 <span className="text-[#ffb74d]">1.5배</span></p>
                </div>
              </div>

              <div className="bg-white/5 rounded-xl p-3 border border-white/10 text-xs text-[#c4c7c5] space-y-1">
                <p>⏱️ 12초마다 새 줄이 내려옵니다 (최대 7초)</p>
                <p>💥 구슬이 발사대에 닿으면 Game Over</p>
                <p>🪂 천장과 연결 안 된 구슬은 자동 낙하!</p>
              </div>
            </div>

            <button onClick={handleStart}
              className="w-full py-4 rounded-2xl font-black text-2xl transition-all duration-200 active:scale-95"
              style={{
                background:'linear-gradient(135deg,#4fc3f7,#42a5f5)',
                boxShadow:'0 0 30px rgba(79,195,247,0.5)',
                color:'#0a0a1a',letterSpacing:'0.08em',
              }}>
              START!
            </button>
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

      {/* HUD - Score */}
      <div className="absolute top-3 left-3 z-40 flex flex-col gap-1.5">
        <div className="bg-[#1e1e1e]/90 px-4 py-2.5 rounded-2xl border border-[#444746] shadow-xl flex items-center gap-2.5 backdrop-blur-sm">
          <Trophy className="w-4 h-4 text-[#42a5f5]"/>
          <div>
            <p className="text-[9px] text-[#c4c7c5] uppercase tracking-wider">점수</p>
            <p className="text-xl font-bold text-white leading-tight">{score.toLocaleString()}</p>
          </div>
        </div>
        <div className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-widest text-center border backdrop-blur-sm ${
          isHardMode?'bg-[#ab47bc]/30 border-[#ab47bc] text-[#ab47bc]':'bg-[#66bb6a]/20 border-[#66bb6a]/50 text-[#66bb6a]'
        }`}>
          {isHardMode?'⚡ 하드 ×1.5':'🎨 쉬운 모드'}
        </div>
        {!isHardMode&&(
          <div className="px-2.5 py-1 rounded-full text-[9px] text-center text-[#757575] border border-[#333]">
            아래 착지 {downLandCountRef.current}/3 → 하드
          </div>
        )}
      </div>

      {/* HUD - Multi + X */}
      <div className="absolute top-3 right-3 z-40 flex items-center gap-1.5">
        <button onClick={multiStatus==='idle'?startMultiplayer:leaveMultiplayer}
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

      {/* 정답 선택 모드 힌트 (게임 중, 선택모드 아닐 때) */}
      {gamePhase==='playing'&&!isGameOver&&!inSelectMode&&(
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-30 pointer-events-none">
          <div className="flex items-center gap-2 bg-[#1e1e1e]/80 px-3 py-1.5 rounded-full border border-[#444746]/50 backdrop-blur-sm">
            <span className="text-xs text-[#c4c7c5]">⬇️ 손을 아래로 내리면 정답 선택</span>
          </div>
        </div>
      )}

      {/* 정답 선택 모드 진행중 표시 */}
      {inSelectMode&&(
        <div className="absolute bottom-24 left-1/2 -translate-x-1/2 z-30 pointer-events-none">
          <div className="flex items-center gap-2 bg-[#4fc3f7]/20 px-4 py-2 rounded-full border border-[#4fc3f7]/50 backdrop-blur-sm animate-pulse">
            <span className="text-xs text-[#4fc3f7] font-bold">정답 선택 중 — 손을 좌우로 움직여 고르세요</span>
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
      `}</style>
    </div>
  );
};

export default MathSlingshot;
