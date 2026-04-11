/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * 수학 슬링샷 게임 — 구구단/나눗셈 학습용 버블 슈터
 * ✦ 같은 정답 구슬 3개 이상 연결 → 팡!
 * ✦ 10초마다 새 줄이 위에서 내려옴 (시간 지날수록 간격 단축, 최소 6초)
 * ✦ 내려오기 2초 전 지진 흔들림 + 먼지 이펙트
 * ✦ Firebase 실시간 2인 매칭 지원
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { getStrategicHint, TargetCandidate } from '../services/geminiService';
import { Point, Bubble, Particle, BubbleColor, DebugInfo, GameMode } from '../types';
import {
  Loader2, Trophy, BrainCircuit, Play, MousePointerClick,
  Eye, Terminal, AlertTriangle, Lightbulb, Monitor, Zap,
  RefreshCw, X, Users
} from 'lucide-react';
import {
  initFirebase, joinLobby, watchRoom, setRoomState,
  publishMyState, subscribeOppState, removePlayer,
  sweepLobbySlots, stableLobbyId, JoinResult, FirebaseServices
} from '../services/firebaseService';

// ─── Constants ────────────────────────────────────────────────────────────────
const PINCH_THRESHOLD  = 0.05;
const GRAVITY          = 0.0;
const FRICTION         = 0.998;
const BUBBLE_RADIUS    = 26;
const ROW_HEIGHT       = BUBBLE_RADIUS * Math.sqrt(3);
const GRID_COLS        = 11;
const GRID_ROWS        = 8;
const SLINGSHOT_BOTTOM_OFFSET = 220;
const MAX_DRAG_DIST    = 180;
const MIN_FORCE_MULT   = 0.15;
const MAX_FORCE_MULT   = 0.45;

// ─── Row-drop timing ──────────────────────────────────────────────────────────
const getDropInterval = (elapsedMs: number): number => {
  if (elapsedMs < 20000) return 10000;
  const periods = Math.floor((elapsedMs - 20000) / 20000);
  return Math.max(6000, 10000 - periods * 1000);
};

// ─── Math data ────────────────────────────────────────────────────────────────
const ANSWER_COLOR_MAP: Record<number, BubbleColor> = {
  6:'red', 8:'blue', 9:'green', 12:'yellow',
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

const COLOR_CONFIG: Record<BubbleColor, {hex:string; dark:string; points:number; label:string}> = {
  red:    { hex:'#ff6b6b', dark:'#c0392b', points:100, label:'빨강' },
  blue:   { hex:'#4fc3f7', dark:'#0277bd', points:150, label:'파랑' },
  green:  { hex:'#81c784', dark:'#2e7d32', points:200, label:'초록' },
  yellow: { hex:'#fff176', dark:'#f57f17', points:250, label:'노랑' },
  purple: { hex:'#ce93d8', dark:'#6a1b9a', points:300, label:'보라' },
  orange: { hex:'#ffb74d', dark:'#e65100', points:350, label:'주황' },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
const adj = (color: string, amt: number) => {
  const hex = color.replace('#','');
  const clamp = (v:number) => Math.max(0,Math.min(255,v));
  const r=clamp(parseInt(hex.slice(0,2),16)+amt);
  const g=clamp(parseInt(hex.slice(2,4),16)+amt);
  const b=clamp(parseInt(hex.slice(4,6),16)+amt);
  return '#'+[r,g,b].map(v=>v.toString(16).padStart(2,'0')).join('');
};

const rndExpr = (answer: number): string => {
  const pool = EXPRESSION_POOL[answer] || [String(answer)];
  return pool[Math.floor(Math.random()*pool.length)];
};

// ─── Marble drawing ───────────────────────────────────────────────────────────
const drawMarble = (
  ctx: CanvasRenderingContext2D,
  x: number, y: number, r: number,
  color: BubbleColor, expression: string,
  isHard: boolean, alpha = 1.0,
  shakeX = 0, shakeY = 0   // 진동 오프셋
) => {
  ctx.save();
  ctx.globalAlpha = alpha;
  const cx = x + shakeX, cy = y + shakeY;
  const cfg = COLOR_CONFIG[color];
  const base = isHard ? '#5c5c7a' : cfg.hex;
  const dark = isHard ? '#2a2a44' : cfg.dark;

  // Shadow
  ctx.shadowColor = isHard ? 'rgba(0,0,0,0.8)' : `${dark}cc`;
  ctx.shadowBlur=10; ctx.shadowOffsetX=3; ctx.shadowOffsetY=4;

  // Sphere gradient
  const g = ctx.createRadialGradient(cx-r*.35,cy-r*.35,r*.05, cx+r*.1,cy+r*.1,r);
  g.addColorStop(0,'#ffffff');
  g.addColorStop(0.15, adj(base,60));
  g.addColorStop(0.5, base);
  g.addColorStop(0.85, adj(base,-40));
  g.addColorStop(1, dark);
  ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2);
  ctx.fillStyle=g; ctx.fill();
  ctx.shadowColor='transparent'; ctx.shadowBlur=0; ctx.shadowOffsetX=0; ctx.shadowOffsetY=0;

  // Outline
  ctx.strokeStyle=dark+'aa'; ctx.lineWidth=1.2; ctx.stroke();

  // Inner depth ring
  const ig=ctx.createRadialGradient(cx,cy,r*.5,cx,cy,r*.95);
  ig.addColorStop(0,'transparent'); ig.addColorStop(1,'rgba(0,0,0,0.12)');
  ctx.beginPath(); ctx.arc(cx,cy,r*.95,0,Math.PI*2); ctx.fillStyle=ig; ctx.fill();

  // Main highlight
  const hg=ctx.createRadialGradient(cx-r*.38,cy-r*.42,0,cx-r*.25,cy-r*.25,r*.55);
  hg.addColorStop(0,'rgba(255,255,255,0.75)');
  hg.addColorStop(0.5,'rgba(255,255,255,0.15)');
  hg.addColorStop(1,'rgba(255,255,255,0)');
  ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.fillStyle=hg; ctx.fill();

  // Specular dot
  ctx.beginPath();
  ctx.ellipse(cx-r*.32,cy-r*.38,r*.18,r*.10,-Math.PI/5,0,Math.PI*2);
  ctx.fillStyle='rgba(255,255,255,0.55)'; ctx.fill();

  // Bottom env light
  const bg=ctx.createRadialGradient(cx,cy+r*.7,0,cx,cy+r*.5,r*.5);
  bg.addColorStop(0,isHard?'rgba(120,120,180,0.2)':`${cfg.hex}44`);
  bg.addColorStop(1,'rgba(0,0,0,0)');
  ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.fillStyle=bg; ctx.fill();

  // Text
  const len=expression.length;
  const fs = len<=2?r*.80:len<=4?r*.62:len<=6?r*.52:r*.44;
  ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.shadowColor=isHard?'rgba(255,255,255,0.3)':'rgba(0,0,0,0.6)';
  ctx.shadowBlur=3; ctx.shadowOffsetX=1; ctx.shadowOffsetY=1;
  ctx.font=`900 ${fs}px 'Arial Black','Arial Bold',sans-serif`;
  ctx.strokeStyle=isHard?'rgba(255,255,255,0.15)':`${dark}88`;
  ctx.lineWidth=fs*.22; ctx.lineJoin='round';
  ctx.strokeText(expression, cx, cy+fs*.04);
  ctx.fillStyle=isHard?'rgba(220,220,255,0.92)':'rgba(255,255,255,0.95)';
  ctx.fillText(expression, cx, cy+fs*.04);
  ctx.fillStyle=isHard?'rgba(255,255,255,0.25)':'rgba(255,255,255,0.35)';
  ctx.fillText(expression, cx, cy-fs*.06);
  ctx.shadowColor='transparent'; ctx.shadowBlur=0; ctx.shadowOffsetX=0; ctx.shadowOffsetY=0;
  ctx.restore();
};

// ─── Opponent mini-board drawing ──────────────────────────────────────────────
const drawOpponentBoard = (
  ctx: CanvasRenderingContext2D,
  oppBubbles: {x:number;y:number;color:BubbleColor;expression:string}[],
  x: number, y: number, w: number, h: number
) => {
  ctx.save();
  // Background
  ctx.fillStyle='rgba(10,10,30,0.85)';
  ctx.strokeStyle='rgba(100,150,255,0.4)';
  ctx.lineWidth=1.5;
  const r=10;
  ctx.beginPath();
  ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.quadraticCurveTo(x+w,y,x+w,y+r);
  ctx.lineTo(x+w,y+h-r); ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
  ctx.lineTo(x+r,y+h); ctx.quadraticCurveTo(x,y+h,x,y+h-r);
  ctx.lineTo(x,y+r); ctx.quadraticCurveTo(x,y,x+r,y);
  ctx.closePath();
  ctx.fill(); ctx.stroke();

  // Label
  ctx.fillStyle='rgba(100,180,255,0.7)';
  ctx.font='bold 11px sans-serif';
  ctx.textAlign='center';
  ctx.fillText('상대방', x+w/2, y+16);

  // Clip to board area
  ctx.beginPath();
  ctx.rect(x+2, y+22, w-4, h-26);
  ctx.clip();

  // Draw opponent bubbles (scaled down)
  const scale = (w-8) / 500; // approximate scale
  for (const b of oppBubbles) {
    const bx = x + 4 + b.x * scale;
    const by = y + 22 + b.y * scale;
    const br = Math.max(5, BUBBLE_RADIUS * scale * 1.2);
    if (bx < x || bx > x+w || by < y+22 || by > y+h) continue;
    drawMarble(ctx, bx, by, br, b.color, b.expression, false, 0.9);
  }
  ctx.restore();
};

// ─── MultiplayState type ──────────────────────────────────────────────────────
type MultiStatus = 'idle' | 'searching' | 'matched' | 'playing';

// ─── Component ────────────────────────────────────────────────────────────────
const GeminiSlingshot: React.FC = () => {
  const videoRef         = useRef<HTMLVideoElement>(null);
  const canvasRef        = useRef<HTMLCanvasElement>(null);
  const gameContainerRef = useRef<HTMLDivElement>(null);

  // Physics
  const ballPos     = useRef<Point>({ x:0,y:0 });
  const ballVel     = useRef<Point>({ x:0,y:0 });
  const anchorPos   = useRef<Point>({ x:0,y:0 });
  const isPinching  = useRef(false);
  const isFlying    = useRef(false);
  const flightStart = useRef(0);
  const bubbles     = useRef<Bubble[]>([]);
  const particles   = useRef<Particle[]>([]);
  const scoreRef    = useRef(0);

  // AI
  const aimTargetRef    = useRef<Point|null>(null);
  const isAiThinkingRef = useRef(false);
  const captureReqRef   = useRef(false);

  // Game
  const selectedAnswerRef = useRef<number>(12);
  const gameModeRef       = useRef<GameMode>('easy');
  const downShotCount     = useRef(0);
  const gameStartTimeRef  = useRef(0);
  const lastDropTimeRef   = useRef(0);
  const isGameOverRef     = useRef(false);
  const dustParticles     = useRef<Particle[]>([]);
  const shakeTimeRef      = useRef(0); // 흔들림 시작 시간 (0=없음)

  // Game phase: 'start' | 'playing' | 'over'
  const gamePhaseRef = useRef<'start'|'countdown'|'playing'|'over'>('start');

  // Multiplayer
  const fbRef          = useRef<FirebaseServices|null>(null);
  const joinResultRef  = useRef<JoinResult|null>(null);
  const multiStatusRef = useRef<MultiStatus>('idle');
  const oppBubblesRef  = useRef<{x:number;y:number;color:BubbleColor;expression:string}[]>([]);
  const roomUnsubRef   = useRef<(()=>void)|null>(null);
  const oppUnsubRef    = useRef<(()=>void)|null>(null);
  const publishTimerRef= useRef<ReturnType<typeof setInterval>|null>(null);

  // React state
  const [loading,           setLoading]          = useState(true);
  const [aiHint,            setAiHint]            = useState<string|null>('전략 엔진 초기화 중...');
  const [aiRationale,       setAiRationale]       = useState<string|null>(null);
  const [aimTarget,         setAimTarget]         = useState<Point|null>(null);
  const [score,             setScore]             = useState(0);
  const [isAiThinking,      setIsAiThinking]      = useState(false);
  const [selectedAnswer,    setSelectedAnswer]    = useState<number>(12);
  const [availableAnswers,  setAvailableAnswers]  = useState<number[]>([]);
  const [aiRecommendedColor,setAiRecommendedColor]= useState<BubbleColor|null>(null);
  const [debugInfo,         setDebugInfo]         = useState<DebugInfo|null>(null);
  const [gameMode,          setGameMode]          = useState<GameMode>('easy');
  const [showHardNotif,     setShowHardNotif]     = useState(false);
  const [isGameOver,        setIsGameOver]        = useState(false);
  const [finalScore,        setFinalScore]        = useState(0);
  const [gamePhase,         setGamePhase]         = useState<'start'|'countdown'|'playing'|'over'>('start');
  const [countdownNum,      setCountdownNum]      = useState(3);
  const [multiStatus,       setMultiStatus]       = useState<MultiStatus>('idle');
  const [showMatchedBanner, setShowMatchedBanner] = useState(false);
  const [oppBubbles,        setOppBubbles]        = useState<{x:number;y:number;color:BubbleColor;expression:string}[]>([]);

  useEffect(()=>{ selectedAnswerRef.current=selectedAnswer; },[selectedAnswer]);
  useEffect(()=>{ aimTargetRef.current=aimTarget; },[aimTarget]);
  useEffect(()=>{ isAiThinkingRef.current=isAiThinking; },[isAiThinking]);
  useEffect(()=>{ gameModeRef.current=gameMode; },[gameMode]);
  useEffect(()=>{ gamePhaseRef.current=gamePhase; },[gamePhase]);
  useEffect(()=>{ multiStatusRef.current=multiStatus; },[multiStatus]);

  // ── Grid helpers ──────────────────────────────────────────────────────────
  const getBubblePos = (row: number, col: number, width: number) => {
    const xOffset=(width-GRID_COLS*BUBBLE_RADIUS*2)/2+BUBBLE_RADIUS;
    const isOdd=row%2!==0;
    return {
      x: xOffset+col*(BUBBLE_RADIUS*2)+(isOdd?BUBBLE_RADIUS:0),
      y: BUBBLE_RADIUS+row*ROW_HEIGHT
    };
  };

  const updateAvailableAnswers = () => {
    const active=new Set<number>();
    bubbles.current.forEach(b=>{ if(b.active) active.add(b.answer); });
    const arr=Array.from(active).sort((a,b)=>a-b);
    setAvailableAnswers(arr);
    if (!active.has(selectedAnswerRef.current)&&arr.length>0) setSelectedAnswer(arr[0]);
  };

  const initGrid = useCallback((width: number) => {
    const nb: Bubble[]=[];
    for (let r=0;r<5;r++) {
      const cols=r%2!==0?GRID_COLS-1:GRID_COLS;
      for (let c=0;c<cols;c++) {
        if (Math.random()>0.12) {
          const {x,y}=getBubblePos(r,c,width);
          const ans=ANSWER_POOL[Math.floor(Math.random()*ANSWER_POOL.length)];
          nb.push({ id:`${r}-${c}`, row:r,col:c,x,y,
            color:ANSWER_COLOR_MAP[ans]||'red', answer:ans, expression:rndExpr(ans), active:true });
        }
      }
    }
    bubbles.current=nb;
    particles.current=[]; dustParticles.current=[];
    isGameOverRef.current=false; scoreRef.current=0;
    gameStartTimeRef.current=performance.now();
    lastDropTimeRef.current=performance.now();
    shakeTimeRef.current=0;
    updateAvailableAnswers();
    setTimeout(()=>{ captureReqRef.current=true; }, 2000);
  }, []);

  // ── Dust particles ────────────────────────────────────────────────────────
  const createDust = (canvasWidth: number) => {
    // 위쪽 가장자리에서 먼지 생성
    for (let i=0;i<40;i++) {
      dustParticles.current.push({
        x: Math.random()*canvasWidth,
        y: BUBBLE_RADIUS*2 + Math.random()*10,
        vx: (Math.random()-0.5)*3,
        vy: Math.random()*1.5+0.3,
        life: 0.7+Math.random()*0.5,
        color: `hsl(${40+Math.random()*20},${50+Math.random()*30}%,${60+Math.random()*20}%)`
      });
    }
  };

  // ── Explosion ─────────────────────────────────────────────────────────────
  const createExplosion = (x:number,y:number,color:string) => {
    for (let i=0;i<20;i++)
      particles.current.push({x,y,vx:(Math.random()-.5)*16,vy:(Math.random()-.5)*16,life:1.0,color});
    for (let i=0;i<8;i++)
      particles.current.push({x,y,vx:(Math.random()-.5)*9,vy:-Math.random()*12-3,life:1.3,color:'#ffffff'});
  };

  // ── Neighbor/Path ──────────────────────────────────────────────────────────
  const isNeighbor=(a:Bubble,b:Bubble)=>{
    const dr=b.row-a.row,dc=b.col-a.col;
    if (Math.abs(dr)>1) return false;
    if (dr===0) return Math.abs(dc)===1;
    return a.row%2!==0?(dc===0||dc===1):(dc===-1||dc===0);
  };

  const isPathClear=(target:Bubble)=>{
    const {x:sx,y:sy}=anchorPos.current;
    const dx=target.x-sx,dy=target.y-sy;
    const dist=Math.sqrt(dx*dx+dy*dy);
    const steps=Math.ceil(dist/(BUBBLE_RADIUS/2));
    for (let i=1;i<steps-2;i++) {
      const t=i/steps,cx=sx+dx*t,cy=sy+dy*t;
      for (const b of bubbles.current) {
        if (!b.active||b.id===target.id) continue;
        if (Math.pow(cx-b.x,2)+Math.pow(cy-b.y,2)<Math.pow(BUBBLE_RADIUS*1.8,2)) return false;
      }
    }
    return true;
  };

  const getAllClusters=():TargetCandidate[]=>{
    const actives=bubbles.current.filter(b=>b.active);
    const answers:number[]=Array.from(new Set(actives.map(b=>b.answer)));
    const out:TargetCandidate[]=[];
    for (const ans of answers) {
      const visited=new Set<string>();
      for (const b of actives) {
        if (b.answer!==ans||visited.has(b.id)) continue;
        const members:Bubble[]=[]; const queue=[b]; visited.add(b.id);
        while (queue.length>0) {
          const cur=queue.shift()!; members.push(cur);
          actives.filter(n=>!visited.has(n.id)&&n.answer===ans&&isNeighbor(cur,n))
            .forEach(n=>{ visited.add(n.id); queue.push(n); });
        }
        members.sort((a,b)=>b.y-a.y);
        const hit=members.find(m=>isPathClear(m));
        if (hit) {
          const xPct=hit.x/(gameContainerRef.current?.clientWidth||window.innerWidth);
          const dir=xPct<.33?'왼쪽':xPct>.66?'오른쪽':'가운데';
          out.push({ id:hit.id, color:ANSWER_COLOR_MAP[ans]||'red', size:members.length,
            row:hit.row, col:hit.col, pointsPerBubble:100, description:`${dir}(정답=${ans})` });
        }
      }
    }
    return out;
  };

  const checkMatches=(start:Bubble)=>{
    const stack=[start],visited=new Set<string>(),matches:Bubble[]=[];
    const target=start.answer;
    while (stack.length>0) {
      const cur=stack.pop()!;
      if (visited.has(cur.id)) continue;
      visited.add(cur.id);
      if (cur.answer===target) {
        matches.push(cur);
        bubbles.current.filter(b=>b.active&&!visited.has(b.id)&&isNeighbor(cur,b)).forEach(b=>stack.push(b));
      }
    }
    if (matches.length>=3) {
      const col=ANSWER_COLOR_MAP[target]||'red';
      const pts=COLOR_CONFIG[col].points;
      const mult=gameModeRef.current==='hard'?1.5:(matches.length>3?1.5:1.0);
      let total=0;
      matches.forEach(b=>{ b.active=false; createExplosion(b.x,b.y,COLOR_CONFIG[b.color].hex); total+=pts; });
      scoreRef.current+=Math.floor(total*mult);
      setScore(scoreRef.current);
      return true;
    }
    return false;
  };

  // ── Add new row from top ──────────────────────────────────────────────────
  const addNewRow = (cw: number) => {
    bubbles.current.forEach(b=>{ if(!b.active) return; b.row+=1; b.y+=ROW_HEIGHT; });
    for (let c=0;c<GRID_COLS;c++) {
      if (Math.random()>0.1) {
        const {x,y}=getBubblePos(0,c,cw);
        const ans=ANSWER_POOL[Math.floor(Math.random()*ANSWER_POOL.length)];
        bubbles.current.push({ id:`new-${Date.now()}-${c}`, row:0,col:c,x,y,
          color:ANSWER_COLOR_MAP[ans]||'red', answer:ans, expression:rndExpr(ans), active:true });
      }
    }
    updateAvailableAnswers();
    createDust(cw);
  };

  const checkGameOver=(ch:number)=>{
    const slY=ch-SLINGSHOT_BOTTOM_OFFSET-BUBBLE_RADIUS*3;
    if (bubbles.current.some(b=>b.active&&b.y+BUBBLE_RADIUS>=slY)) {
      isGameOverRef.current=true;
      setFinalScore(scoreRef.current);
      setIsGameOver(true);
      setGamePhase('over');
      gamePhaseRef.current='over';
    }
  };

  // ── AI ────────────────────────────────────────────────────────────────────
  const performAiAnalysis=async(screenshot:string)=>{
    isAiThinkingRef.current=true; setIsAiThinking(true);
    setAiHint('전략 분석 중...'); setAiRationale(null); setAiRecommendedColor(null); setAimTarget(null);
    const clusters=getAllClusters();
    const maxRow=bubbles.current.reduce((mx,b)=>b.active?Math.max(mx,b.row):mx,0);
    const cw=canvasRef.current?.width||1000;
    getStrategicHint(screenshot,clusters,maxRow).then(res=>{
      const {hint,debug}=res; setDebugInfo(debug); setAiHint(hint.message); setAiRationale(hint.rationale||null);
      if (typeof hint.targetRow==='number'&&typeof hint.targetCol==='number') {
        if (hint.recommendedColor) setAiRecommendedColor(hint.recommendedColor);
        setAimTarget(getBubblePos(hint.targetRow,hint.targetCol,cw));
      }
      isAiThinkingRef.current=false; setIsAiThinking(false);
    });
  };

  // ── Multiplayer ───────────────────────────────────────────────────────────
  const startMultiplayer = useCallback(async () => {
    if (multiStatusRef.current==='searching'||multiStatusRef.current==='matched') return;
    setMultiStatus('searching'); multiStatusRef.current='searching';

    try {
      const fb = await initFirebase();
      if (!fb) { setMultiStatus('idle'); return; }
      fbRef.current=fb;
      const lobbyId=stableLobbyId();
      try { await sweepLobbySlots({...fb,lobbyId,maxTeams:10}); } catch {}
      const joined=await joinLobby({...fb,lobbyId,name:'Player',maxTeams:10});
      joinResultRef.current=joined;

      // Watch room
      roomUnsubRef.current?.();
      roomUnsubRef.current = watchRoom({
        ...fb, roomId:joined.roomId,
        onRoom:(room)=>{
          if (!room||!room.meta) return;
          const meta=room.meta;
          const ids=Object.keys(room.players||{});
          if (ids.length===2&&meta.state==='open') {
            setRoomState({...fb,roomId:joined.roomId},'playing').catch(()=>{});
          }
          if (ids.length===2&&(meta.state==='open'||meta.state==='playing')
              &&multiStatusRef.current==='searching') {
            // Matched!
            setMultiStatus('matched'); multiStatusRef.current='matched';
            setShowMatchedBanner(true);
            setTimeout(()=>{ setShowMatchedBanner(false); setMultiStatus('playing'); multiStatusRef.current='playing'; },2000);
            // Reset game
            const cw=canvasRef.current?.width||800;
            initGrid(cw);
            setScore(0); setIsGameOver(false); setGamePhase('countdown'); gamePhaseRef.current='countdown';
            setCountdownNum(3);
            let c=3;
            const iv=setInterval(()=>{
              c--;
              if (c<=0) { clearInterval(iv); setGamePhase('playing'); gamePhaseRef.current='playing'; }
              else setCountdownNum(c);
            },1000);
          }
        }
      });

      // Subscribe opponent state
      oppUnsubRef.current?.();
      oppUnsubRef.current = subscribeOppState({
        ...fb, roomId:joined.roomId, pid:joined.pid,
        onOpp:(res)=>{
          if (!res?.state?.bubbles) return;
          const bs=res.state.bubbles as {x:number;y:number;color:BubbleColor;expression:string}[];
          oppBubblesRef.current=bs;
          setOppBubbles(bs);
        }
      });

      // Publish my state every 500ms
      if (publishTimerRef.current) clearInterval(publishTimerRef.current);
      publishTimerRef.current=setInterval(()=>{
        if (!fb||!joinResultRef.current) return;
        const activeBubbles=bubbles.current
          .filter(b=>b.active)
          .map(b=>({x:b.x,y:b.y,color:b.color,expression:b.expression}));
        publishMyState({
          ...fb, roomId:joined.roomId, pid:joined.pid,
          state:{ bubbles:activeBubbles, score:scoreRef.current, dead:isGameOverRef.current }
        }).catch(()=>{});
      },500);

    } catch(e) {
      console.error('Multiplayer error:',e);
      setMultiStatus('idle');
    }
  },[initGrid]);

  const leaveMultiplayer = useCallback(()=>{
    roomUnsubRef.current?.(); roomUnsubRef.current=null;
    oppUnsubRef.current?.(); oppUnsubRef.current=null;
    if (publishTimerRef.current) { clearInterval(publishTimerRef.current); publishTimerRef.current=null; }
    const fb=fbRef.current; const jr=joinResultRef.current;
    if (fb&&jr) removePlayer({...fb,roomId:jr.roomId,pid:jr.pid}).catch(()=>{});
    if (jr?.hbTimer) clearInterval(jr.hbTimer);
    joinResultRef.current=null; fbRef.current=null;
    setMultiStatus('idle'); multiStatusRef.current='idle';
    oppBubblesRef.current=[]; setOppBubbles([]);
  },[]);

  // ── Restart ───────────────────────────────────────────────────────────────
  const restartGame=useCallback(()=>{
    setIsGameOver(false); setScore(0);
    setGameMode('easy'); gameModeRef.current='easy';
    downShotCount.current=0; isGameOverRef.current=false;
    particles.current=[]; dustParticles.current=[];
    const cw=canvasRef.current?.width||800;
    initGrid(cw);
    setGamePhase('start'); gamePhaseRef.current='start';
  },[initGrid]);

  // START button → countdown → playing
  const handleStart=()=>{
    setGamePhase('countdown'); gamePhaseRef.current='countdown';
    setCountdownNum(3);
    let c=3;
    const iv=setInterval(()=>{
      c--; setCountdownNum(c);
      if (c<=0) { clearInterval(iv); setGamePhase('playing'); gamePhaseRef.current='playing'; }
    },1000);
  };

  // ── Cleanup on unmount ────────────────────────────────────────────────────
  useEffect(()=>()=>{ leaveMultiplayer(); },[leaveMultiplayer]);

  // ─────────────────────────────────────────────────────────────────────────
  // MAIN GAME LOOP
  // ─────────────────────────────────────────────────────────────────────────
  useEffect(()=>{
    if (!videoRef.current||!canvasRef.current||!gameContainerRef.current) return;
    const video=videoRef.current, canvas=canvasRef.current, container=gameContainerRef.current;
    const ctx=canvas.getContext('2d',{willReadFrequently:true});
    if (!ctx) return;

    canvas.width=container.clientWidth; canvas.height=container.clientHeight;
    anchorPos.current={x:canvas.width/2,y:canvas.height-SLINGSHOT_BOTTOM_OFFSET};
    ballPos.current={...anchorPos.current};
    initGrid(canvas.width);

    let camera:any=null, hands:any=null;

    const onResults=(results:any)=>{
      setLoading(false);
      if (canvas.width!==container.clientWidth||canvas.height!==container.clientHeight) {
        canvas.width=container.clientWidth; canvas.height=container.clientHeight;
        anchorPos.current={x:canvas.width/2,y:canvas.height-SLINGSHOT_BOTTOM_OFFSET};
        if (!isFlying.current&&!isPinching.current) ballPos.current={...anchorPos.current};
      }

      ctx.save();
      ctx.clearRect(0,0,canvas.width,canvas.height);
      ctx.drawImage(results.image,0,0,canvas.width,canvas.height);
      ctx.fillStyle='rgba(18,18,18,0.85)';
      ctx.fillRect(0,0,canvas.width,canvas.height);

      const phase=gamePhaseRef.current;
      const isPlaying=phase==='playing';
      const isHard=gameModeRef.current==='hard';
      const now=performance.now();

      // ── Row drop logic (only when playing) ──
      if (isPlaying&&!isGameOverRef.current) {
        const elapsed=now-gameStartTimeRef.current;
        const interval=getDropInterval(elapsed);
        const sinceLast=now-lastDropTimeRef.current;
        const remaining=interval-sinceLast;

        // Shake warning: 2초 전
        if (remaining<=2000&&remaining>0&&shakeTimeRef.current===0) {
          shakeTimeRef.current=now;
        }
        if (remaining>2000) shakeTimeRef.current=0;

        if (sinceLast>=interval) {
          lastDropTimeRef.current=now;
          addNewRow(canvas.width);
          shakeTimeRef.current=0;
          checkGameOver(canvas.height);
        }
      }

      // ── Shake amplitude ──
      let globalShakeX=0,globalShakeY=0;
      if (shakeTimeRef.current>0) {
        const shakeElapsed=now-shakeTimeRef.current;
        const shakeProg=Math.min(shakeElapsed/2000,1.0);
        const amp=(2+shakeProg*6)*Math.sin(shakeElapsed/40);
        globalShakeX=amp*(Math.random()-.5)*2;
        globalShakeY=amp*Math.abs(Math.sin(shakeElapsed/60))*0.5;
      }

      // ── Hand tracking ──
      let handPos:Point|null=null, pinchDist=1.0;
      if (results.multiHandLandmarks?.length>0) {
        const lm=results.multiHandLandmarks[0];
        const idx=lm[8],thumb=lm[4];
        handPos={x:(idx.x+thumb.x)*canvas.width/2,y:(idx.y+thumb.y)*canvas.height/2};
        const dx=idx.x-thumb.x,dy=idx.y-thumb.y;
        pinchDist=Math.sqrt(dx*dx+dy*dy);
        if (window.drawConnectors&&window.drawLandmarks) {
          window.drawConnectors(ctx,lm,window.HAND_CONNECTIONS,{color:'#669df6',lineWidth:1});
          window.drawLandmarks(ctx,lm,{color:'#aecbfa',lineWidth:1,radius:2});
        }
        ctx.beginPath(); ctx.arc(handPos.x,handPos.y,20,0,Math.PI*2);
        ctx.strokeStyle=pinchDist<PINCH_THRESHOLD?'#66bb6a':'#ffffff';
        ctx.lineWidth=2; ctx.stroke();
      }

      const isLocked=isAiThinkingRef.current||isGameOverRef.current||!isPlaying;

      // ── Slingshot input ──
      if (!isLocked&&handPos&&pinchDist<PINCH_THRESHOLD&&!isFlying.current) {
        const db=Math.sqrt(Math.pow(handPos.x-ballPos.current.x,2)+Math.pow(handPos.y-ballPos.current.y,2));
        if (!isPinching.current&&db<100) isPinching.current=true;
        if (isPinching.current) {
          ballPos.current={x:handPos.x,y:handPos.y};
          const ddx=ballPos.current.x-anchorPos.current.x,ddy=ballPos.current.y-anchorPos.current.y;
          const dd=Math.sqrt(ddx*ddx+ddy*ddy);
          if (dd>MAX_DRAG_DIST) {
            const ang=Math.atan2(ddy,ddx);
            ballPos.current={x:anchorPos.current.x+Math.cos(ang)*MAX_DRAG_DIST,y:anchorPos.current.y+Math.sin(ang)*MAX_DRAG_DIST};
          }
        }
      } else if (isPinching.current&&(!handPos||pinchDist>=PINCH_THRESHOLD||isLocked)) {
        isPinching.current=false;
        if (isLocked) { ballPos.current={...anchorPos.current}; }
        else {
          const dx=anchorPos.current.x-ballPos.current.x,dy=anchorPos.current.y-ballPos.current.y;
          const sd=Math.sqrt(dx*dx+dy*dy);
          if (sd>30) {
            isFlying.current=true; flightStart.current=now;
            const pr=Math.min(sd/MAX_DRAG_DIST,1.0);
            const vm=MIN_FORCE_MULT+(MAX_FORCE_MULT-MIN_FORCE_MULT)*(pr*pr);
            ballVel.current={x:dx*vm,y:dy*vm};
            if (ballPos.current.y>anchorPos.current.y&&!isHard) {
              downShotCount.current++;
              if (downShotCount.current>=3) {
                gameModeRef.current='hard'; setGameMode('hard');
                setShowHardNotif(true); setTimeout(()=>setShowHardNotif(false),3000);
              }
            }
          } else { ballPos.current={...anchorPos.current}; }
        }
      } else if (!isFlying.current&&!isPinching.current) {
        const dx=anchorPos.current.x-ballPos.current.x,dy=anchorPos.current.y-ballPos.current.y;
        ballPos.current.x+=dx*.15; ballPos.current.y+=dy*.15;
      }

      // ── Physics ──
      if (isFlying.current) {
        if (now-flightStart.current>5000) {
          isFlying.current=false; ballPos.current={...anchorPos.current}; ballVel.current={x:0,y:0};
        } else {
          const spd=Math.sqrt(ballVel.current.x**2+ballVel.current.y**2);
          const steps=Math.ceil(spd/(BUBBLE_RADIUS*.8)); let hit=false;
          for (let i=0;i<steps;i++) {
            ballPos.current.x+=ballVel.current.x/steps;
            ballPos.current.y+=ballVel.current.y/steps;
            if (ballPos.current.x<BUBBLE_RADIUS||ballPos.current.x>canvas.width-BUBBLE_RADIUS) {
              ballVel.current.x*=-1;
              ballPos.current.x=Math.max(BUBBLE_RADIUS,Math.min(canvas.width-BUBBLE_RADIUS,ballPos.current.x));
            }
            if (ballPos.current.y<BUBBLE_RADIUS) { hit=true; break; }
            for (const b of bubbles.current) {
              if (!b.active) continue;
              if (Math.pow(ballPos.current.x-b.x,2)+Math.pow(ballPos.current.y-b.y,2)<Math.pow(BUBBLE_RADIUS*1.8,2)) { hit=true; break; }
            }
            if (hit) break;
          }
          ballVel.current.y+=GRAVITY; ballVel.current.x*=FRICTION; ballVel.current.y*=FRICTION;
          if (hit) {
            isFlying.current=false;
            let bd=Infinity,br=0,bc=0,bx=0,by=0;
            for (let r=0;r<GRID_ROWS+5;r++) {
              const cols=r%2!==0?GRID_COLS-1:GRID_COLS;
              for (let c=0;c<cols;c++) {
                const p=getBubblePos(r,c,canvas.width);
                if (bubbles.current.some(b=>b.active&&b.row===r&&b.col===c)) continue;
                const d=Math.sqrt(Math.pow(ballPos.current.x-p.x,2)+Math.pow(ballPos.current.y-p.y,2));
                if (d<bd) { bd=d; br=r; bc=c; bx=p.x; by=p.y; }
              }
            }
            const ans=selectedAnswerRef.current;
            const col=(isHard?'purple':ANSWER_COLOR_MAP[ans]||'red') as BubbleColor;
            const nb:Bubble={id:`shot-${Date.now()}`,row:br,col:bc,x:bx,y:by,
              color:col,answer:ans,expression:rndExpr(ans),active:true};
            bubbles.current.push(nb);
            checkMatches(nb); updateAvailableAnswers();
            ballPos.current={...anchorPos.current}; ballVel.current={x:0,y:0};
            captureReqRef.current=true;
            checkGameOver(canvas.height);
          }
          if (ballPos.current.y>canvas.height) {
            isFlying.current=false; ballPos.current={...anchorPos.current}; ballVel.current={x:0,y:0};
          }
        }
      }

      // ── Draw bubbles (with shake) ──
      bubbles.current.forEach(b=>{
        if (!b.active) return;
        drawMarble(ctx,b.x,b.y,BUBBLE_RADIUS-1,b.color,b.expression,isHard,1.0,
          shakeTimeRef.current>0?globalShakeX:0,
          shakeTimeRef.current>0?globalShakeY:0);
      });

      // ── Dust particles ──
      for (let i=dustParticles.current.length-1;i>=0;i--) {
        const p=dustParticles.current[i];
        p.x+=p.vx; p.y+=p.vy; p.life-=0.018;
        if (p.life<=0) { dustParticles.current.splice(i,1); continue; }
        ctx.globalAlpha=p.life*.7;
        ctx.beginPath(); ctx.arc(p.x,p.y,3+p.life*3,0,Math.PI*2);
        ctx.fillStyle=p.color; ctx.fill();
        ctx.globalAlpha=1.0;
      }

      // ── Wavy danger line ──
      const slY=canvas.height-SLINGSHOT_BOTTOM_OFFSET-BUBBLE_RADIUS*3;
      ctx.save();
      const t2=now/600;
      ctx.beginPath();
      ctx.moveTo(0,slY);
      for (let wx=0;wx<=canvas.width;wx+=4) {
        ctx.lineTo(wx, slY+Math.sin(wx/30+t2)*4);
      }
      const lineGrad=ctx.createLinearGradient(0,0,canvas.width,0);
      lineGrad.addColorStop(0,'rgba(60,140,255,0)');
      lineGrad.addColorStop(0.2,'rgba(80,160,255,0.55)');
      lineGrad.addColorStop(0.5,'rgba(100,180,255,0.7)');
      lineGrad.addColorStop(0.8,'rgba(80,160,255,0.55)');
      lineGrad.addColorStop(1,'rgba(60,140,255,0)');
      ctx.strokeStyle=lineGrad;
      ctx.lineWidth=2.5; ctx.setLineDash([]);
      ctx.shadowBlur=8; ctx.shadowColor='rgba(80,160,255,0.6)';
      ctx.stroke();
      ctx.shadowBlur=0;
      ctx.restore();

      // ── Laser sight ──
      const curTarget=aimTargetRef.current,thinking=isAiThinkingRef.current;
      const curColor=ANSWER_COLOR_MAP[selectedAnswerRef.current]||'red';
      if ((curTarget||thinking)&&isPlaying) {
        ctx.save();
        const hl=thinking?'#a8c7fa':COLOR_CONFIG[curColor].hex;
        ctx.shadowBlur=15; ctx.shadowColor=hl;
        ctx.beginPath(); ctx.moveTo(anchorPos.current.x,anchorPos.current.y);
        if (curTarget) ctx.lineTo(curTarget.x,curTarget.y);
        else ctx.lineTo(anchorPos.current.x,anchorPos.current.y-200);
        ctx.setLineDash([20,15]); ctx.lineDashOffset=-((now/15)%30);
        ctx.strokeStyle=thinking?'rgba(168,199,250,0.5)':hl;
        ctx.lineWidth=4; ctx.stroke();
        if (curTarget&&!thinking) {
          ctx.beginPath(); ctx.arc(curTarget.x,curTarget.y,BUBBLE_RADIUS,0,Math.PI*2);
          ctx.setLineDash([5,5]); ctx.strokeStyle=hl;
          ctx.fillStyle='rgba(255,255,255,0.08)'; ctx.fill(); ctx.stroke();
        }
        ctx.restore();
      }

      // ── Slingshot ──
      const band=isPinching.current?'#fdd835':'rgba(255,255,255,0.4)';
      if (!isFlying.current) {
        ctx.beginPath(); ctx.moveTo(anchorPos.current.x-35,anchorPos.current.y-10); ctx.lineTo(ballPos.current.x,ballPos.current.y);
        ctx.lineWidth=5; ctx.strokeStyle=band; ctx.lineCap='round'; ctx.stroke();
      }
      ctx.save();
      if ((isLocked)&&!isFlying.current) ctx.globalAlpha=0.5;
      const shootColor=(isHard?'purple':ANSWER_COLOR_MAP[selectedAnswerRef.current]||'red') as BubbleColor;
      drawMarble(ctx,ballPos.current.x,ballPos.current.y,BUBBLE_RADIUS,shootColor,String(selectedAnswerRef.current),isHard);
      ctx.restore();
      if (!isFlying.current) {
        ctx.beginPath(); ctx.moveTo(ballPos.current.x,ballPos.current.y); ctx.lineTo(anchorPos.current.x+35,anchorPos.current.y-10);
        ctx.lineWidth=5; ctx.strokeStyle=band; ctx.lineCap='round'; ctx.stroke();
      }
      // Handle
      ctx.beginPath();
      ctx.moveTo(anchorPos.current.x,canvas.height);
      ctx.lineTo(anchorPos.current.x,anchorPos.current.y+40);
      ctx.lineTo(anchorPos.current.x-40,anchorPos.current.y);
      ctx.moveTo(anchorPos.current.x,anchorPos.current.y+40);
      ctx.lineTo(anchorPos.current.x+40,anchorPos.current.y);
      ctx.lineWidth=10; ctx.lineCap='round'; ctx.strokeStyle='#616161'; ctx.stroke();

      // ── Particles ──
      for (let i=particles.current.length-1;i>=0;i--) {
        const p=particles.current[i];
        p.x+=p.vx; p.y+=p.vy; p.life-=.05;
        if (p.life<=0) { particles.current.splice(i,1); continue; }
        ctx.globalAlpha=p.life;
        ctx.beginPath(); ctx.arc(p.x,p.y,5,0,Math.PI*2);
        ctx.fillStyle=p.color; ctx.fill(); ctx.globalAlpha=1.0;
      }

      // ── Opponent mini board ──
      const opp=oppBubblesRef.current;
      if (opp.length>0&&multiStatusRef.current==='playing') {
        const ow=160,oh=220;
        const ox=canvas.width-ow-12, oy=12;
        drawOpponentBoard(ctx,opp,ox,oy,ow,oh);
      }

      ctx.restore();

      // ── Screenshot for AI ──
      if (captureReqRef.current&&isPlaying&&!isGameOverRef.current) {
        captureReqRef.current=false;
        const off=document.createElement('canvas');
        const scale=Math.min(1,480/canvas.width);
        off.width=canvas.width*scale; off.height=canvas.height*scale;
        const oc=off.getContext('2d');
        if (oc) {
          oc.drawImage(canvas,0,0,off.width,off.height);
          setTimeout(()=>performAiAnalysis(off.toDataURL("image/jpeg",.6)),0);
        }
      }
    };

    if (window.Hands) {
      hands=new window.Hands({locateFile:(f:string)=>`https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}`});
      hands.setOptions({maxNumHands:1,modelComplexity:1,minDetectionConfidence:.5,minTrackingConfidence:.5});
      hands.onResults(onResults);
      if (window.Camera) {
        camera=new window.Camera(video,{
          onFrame:async()=>{ if(videoRef.current&&hands) await hands.send({image:videoRef.current}); },
          width:1280,height:720,
        });
        camera.start();
      }
    }

    return ()=>{ if(camera) camera.stop(); if(hands) hands.close(); };
  },[initGrid]);

  const recColor=aiRecommendedColor?COLOR_CONFIG[aiRecommendedColor]:null;
  const borderColor=recColor?recColor.hex:'#444746';
  const isHardMode=gameMode==='hard';

  return (
    <div className="flex w-full h-screen bg-[#121212] overflow-hidden text-[#e3e3e3]" style={{fontFamily:'system-ui,sans-serif'}}>

      {/* Mobile blocker */}
      <div className="fixed inset-0 z-[100] bg-[#121212] flex flex-col items-center justify-center p-8 text-center md:hidden">
        <Monitor className="w-16 h-16 text-[#ef5350] mb-6 animate-pulse"/>
        <h2 className="text-2xl font-bold mb-4">데스크탑에서 이용해주세요</h2>
        <p className="text-[#c4c7c5] max-w-md text-lg">웹캠 손 추적을 위해 더 큰 화면이 필요합니다.</p>
      </div>

      {/* ── GAME AREA ── */}
      <div ref={gameContainerRef} className="flex-1 relative h-full overflow-hidden">
        <video ref={videoRef} className="absolute hidden" playsInline/>
        <canvas ref={canvasRef} className="absolute inset-0"/>

        {/* Loading */}
        {loading&&(
          <div className="absolute inset-0 flex items-center justify-center bg-[#121212] z-50">
            <div className="flex flex-col items-center gap-4">
              <Loader2 className="w-12 h-12 text-[#42a5f5] animate-spin"/>
              <p className="text-lg font-medium">게임 엔진 시작 중...</p>
            </div>
          </div>
        )}

        {/* ── START SCREEN ── */}
        {gamePhase==='start'&&!loading&&(
          <div className="absolute inset-0 z-40 flex items-center justify-center"
            style={{background:'radial-gradient(ellipse at center, rgba(30,30,60,0.92) 0%, rgba(10,10,20,0.97) 100%)'}}>
            <div className="flex flex-col items-center gap-8">
              {/* Title */}
              <div className="text-center">
                <div className="text-6xl mb-3 select-none" style={{filter:'drop-shadow(0 0 20px #4fc3f7)'}}>🧮</div>
                <h1 className="text-5xl font-black mb-2" style={{
                  background:'linear-gradient(135deg,#4fc3f7,#81c784,#ffb74d)',
                  WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent'
                }}>수학 슬링샷</h1>
                <p className="text-[#c4c7c5] text-lg">같은 정답의 구슬을 3개 이상 연결하세요!</p>
              </div>
              {/* Rules */}
              <div className="bg-white/5 rounded-2xl p-5 border border-white/10 text-sm text-[#c4c7c5] max-w-xs space-y-2">
                <p>🎯 같은 정답 구슬 3개 이상 → 팡!</p>
                <p>📉 아래로 3번 쏘면 하드모드 (1.5배)</p>
                <p>⏱️ 10초마다 새 줄이 내려옵니다</p>
                <p>💥 구슬이 발사대에 닿으면 Game Over</p>
              </div>
              {/* START button */}
              <button onClick={handleStart}
                className="px-16 py-5 rounded-2xl font-black text-3xl transition-all duration-200 hover:scale-105 active:scale-95 select-none"
                style={{
                  background:'linear-gradient(135deg,#4fc3f7,#42a5f5)',
                  boxShadow:'0 0 40px rgba(79,195,247,0.5), 0 8px 32px rgba(0,0,0,0.4)',
                  color:'#0a0a1a', letterSpacing:'0.08em'
                }}>
                START!
              </button>
            </div>
          </div>
        )}

        {/* ── COUNTDOWN ── */}
        {gamePhase==='countdown'&&(
          <div className="absolute inset-0 z-40 flex items-center justify-center pointer-events-none"
            style={{background:'rgba(10,10,20,0.6)'}}>
            <div key={countdownNum} className="text-[160px] font-black select-none"
              style={{
                color:'#4fc3f7',
                textShadow:'0 0 80px #4fc3f7, 0 0 30px #fff',
                animation:'countPop 0.8s ease-out forwards'
              }}>
              {countdownNum}
            </div>
          </div>
        )}

        {/* AI Thinking */}
        {isAiThinking&&gamePhase==='playing'&&(
          <div className="absolute left-1/2 z-50 flex flex-col items-center pointer-events-none"
            style={{bottom:'220px',transform:'translate(-50%,50%)'}}>
            <div className="w-[72px] h-[72px] rounded-full border-4 border-t-[#a8c7fa] border-r-[#a8c7fa] border-b-transparent border-l-transparent animate-spin"/>
            <p className="mt-4 text-[#a8c7fa] font-bold text-xs tracking-widest animate-pulse">분석 중...</p>
          </div>
        )}

        {/* Hard mode notif */}
        {showHardNotif&&(
          <div className="absolute inset-0 flex items-center justify-center z-50 pointer-events-none">
            <div className="bg-gradient-to-br from-[#ab47bc] to-[#ef5350] p-8 rounded-3xl shadow-2xl text-center animate-bounce">
              <Zap className="w-16 h-16 text-white mx-auto mb-3"/>
              <h2 className="text-3xl font-black text-white mb-2">🔥 하드 모드!</h2>
              <p className="text-white/90 text-lg font-bold">점수 1.5배!</p>
            </div>
          </div>
        )}

        {/* ── Matched! banner ── */}
        {showMatchedBanner&&(
          <div className="absolute inset-0 flex items-center justify-center z-50 pointer-events-none">
            <div className="text-center" style={{
              background:'linear-gradient(135deg,rgba(30,80,180,0.95),rgba(80,30,160,0.95))',
              borderRadius:24, padding:'32px 60px',
              boxShadow:'0 0 80px rgba(100,160,255,0.5)'
            }}>
              <div className="text-5xl mb-3">🎮</div>
              <h2 className="text-4xl font-black text-white mb-1">Matching!</h2>
              <p className="text-blue-200 text-lg">상대방을 찾았어요!</p>
            </div>
          </div>
        )}

        {/* ── GAME OVER ── */}
        {isGameOver&&(
          <div className="absolute inset-0 z-50 flex items-center justify-center"
            style={{background:'rgba(10,10,20,0.88)',backdropFilter:'blur(6px)'}}>
            <div className="flex flex-col items-center gap-6 p-10 rounded-3xl border border-[#ef5350]/40"
              style={{background:'linear-gradient(135deg,#1a0a0a,#2a1010)',boxShadow:'0 0 80px rgba(239,83,80,0.3)'}}>
              <div className="text-7xl select-none" style={{filter:'drop-shadow(0 0 20px #ef5350)'}}>💥</div>
              <h1 className="text-5xl font-black" style={{color:'#ef5350',textShadow:'0 0 30px #ef535080'}}>GAME OVER</h1>
              <div className="text-center">
                <p className="text-[#c4c7c5] text-sm uppercase tracking-widest">최종 점수</p>
                <p className="text-5xl font-black text-white">{finalScore.toLocaleString()}</p>
              </div>
              <button onClick={restartGame}
                className="flex items-center gap-3 px-8 py-4 rounded-2xl font-bold text-lg transition-all hover:scale-105 active:scale-95"
                style={{background:'linear-gradient(135deg,#ef5350,#ab47bc)',boxShadow:'0 4px 30px rgba(239,83,80,0.4)'}}>
                <RefreshCw className="w-5 h-5"/> 다시 시작
              </button>
            </div>
          </div>
        )}

        {/* ── TOP-RIGHT: Multi + X buttons ── */}
        <div className="absolute top-4 right-4 z-40 flex items-center gap-2">
          {/* Multi button */}
          <button onClick={multiStatus==='idle'?startMultiplayer:leaveMultiplayer}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all hover:scale-105 active:scale-95"
            style={{
              background: multiStatus==='idle'
                ? 'rgba(30,60,120,0.75)'
                : multiStatus==='searching'
                ? 'rgba(50,30,100,0.85)'
                : multiStatus==='matched'||multiStatus==='playing'
                ? 'rgba(20,80,40,0.85)'
                : 'rgba(30,60,120,0.75)',
              border: `1px solid ${
                multiStatus==='idle'?'rgba(79,195,247,0.4)'
                :multiStatus==='searching'?'rgba(160,100,255,0.5)'
                :'rgba(100,200,100,0.5)'}`,
              backdropFilter:'blur(8px)',
              color:'#e3e3e3'
            }}>
            {multiStatus==='searching'
              ? <><Loader2 className="w-3.5 h-3.5 animate-spin"/><span>매칭중...</span></>
              : multiStatus==='matched'||multiStatus==='playing'
              ? <><div className="w-2 h-2 rounded-full bg-green-400 animate-pulse"/><span>연결됨</span></>
              : <><Users className="w-3.5 h-3.5"/><span>멀티</span></>}
          </button>
          {/* X button */}
          <button onClick={()=>{ leaveMultiplayer(); }}
            className="w-9 h-9 rounded-xl flex items-center justify-center transition-all hover:scale-105 active:scale-95"
            style={{background:'rgba(60,20,20,0.6)',border:'1px solid rgba(255,100,100,0.3)',backdropFilter:'blur(8px)'}}>
            <X className="w-4 h-4 text-red-400"/>
          </button>
        </div>

        {/* HUD: Score + mode */}
        <div className="absolute top-4 left-4 z-40 flex flex-col gap-2">
          <div className="bg-[#1e1e1e] p-4 rounded-[22px] border border-[#444746] shadow-xl flex items-center gap-3 min-w-[170px]">
            <div className="bg-[#42a5f5]/20 p-2.5 rounded-full">
              <Trophy className="w-5 h-5 text-[#42a5f5]"/>
            </div>
            <div>
              <p className="text-[10px] text-[#c4c7c5] uppercase tracking-wider font-medium">점수</p>
              <p className="text-2xl font-bold text-white">{score.toLocaleString()}</p>
            </div>
          </div>
          <div className={`px-3 py-1 rounded-full text-[11px] font-bold uppercase tracking-widest text-center border ${
            isHardMode?'bg-[#ab47bc]/30 border-[#ab47bc] text-[#ab47bc]':'bg-[#66bb6a]/20 border-[#66bb6a]/50 text-[#66bb6a]'
          }`}>
            {isHardMode?'⚡ 하드 ×1.5':'🎨 쉬운 모드'}
          </div>
        </div>

        {/* Answer selector */}
        {gamePhase==='playing'&&(
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-40">
            <div className="bg-[#1e1e1e] px-5 py-3.5 rounded-[28px] border border-[#444746] shadow-2xl flex items-center gap-2.5">
              <p className="text-[10px] text-[#c4c7c5] uppercase font-bold tracking-wider mr-1 hidden md:block whitespace-nowrap">발사할 정답</p>
              {availableAnswers.length===0
                ? <p className="text-sm text-gray-500">구슬 없음</p>
                : availableAnswers.map(ans=>{
                  const isSel=selectedAnswer===ans;
                  const col=ANSWER_COLOR_MAP[ans]||'red';
                  const cfg=COLOR_CONFIG[col];
                  return (
                    <button key={ans} onClick={()=>setSelectedAnswer(ans)}
                      className={`relative w-13 h-13 rounded-full transition-all duration-150 transform flex flex-col items-center justify-center
                        ${isSel?'scale-110 ring-4 ring-white/50 z-10':'opacity-70 hover:opacity-100 hover:scale-105'}`}
                      style={{
                        width:52,height:52,
                        background:isHardMode?'radial-gradient(circle at 35% 35%,#777799,#333355)':
                          `radial-gradient(circle at 35% 35%,${cfg.hex},${cfg.dark})`,
                        boxShadow:isSel
                          ?`0 0 20px ${isHardMode?'#ab47bc':cfg.hex},inset 0 -3px 3px rgba(0,0,0,0.3)`
                          :'0 3px 6px rgba(0,0,0,0.4),inset 0 -3px 3px rgba(0,0,0,0.3)'
                      }}>
                      <span className="text-sm font-black text-white drop-shadow">{ans}</span>
                      {isSel&&<MousePointerClick className="w-3 h-3 text-white/80"/>}
                    </button>
                  );
                })}
            </div>
          </div>
        )}

        {/* Tip */}
        {!isPinching.current&&!isFlying.current&&!isAiThinking&&gamePhase==='playing'&&!isGameOver&&(
          <div className="absolute bottom-28 left-1/2 -translate-x-1/2 z-30 pointer-events-none opacity-35">
            <div className="flex items-center gap-2 bg-[#1e1e1e]/90 px-4 py-2 rounded-full border border-[#444746]">
              <Play className="w-3 h-3 text-[#42a5f5] fill-current"/>
              <p className="text-xs font-medium">손가락을 집어서 당기면 발사!</p>
            </div>
          </div>
        )}
      </div>

      {/* ── RIGHT PANEL ── */}
      <div className="w-[340px] bg-[#1e1e1e] border-l border-[#444746] flex flex-col h-full overflow-hidden shadow-2xl">

        {/* Strategy */}
        <div className="p-4 border-b-4 transition-colors duration-500 flex flex-col gap-2"
          style={{backgroundColor:'#252525',borderColor}}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <BrainCircuit className="w-4 h-4" style={{color:borderColor}}/>
              <h2 className="font-bold text-xs tracking-widest uppercase" style={{color:borderColor}}>AI 수학 전략</h2>
            </div>
            {isAiThinking&&<Loader2 className="w-4 h-4 animate-spin text-white/50"/>}
          </div>
          <p className="text-[#e3e3e3] text-sm leading-relaxed font-bold">{aiHint}</p>
          {aiRationale&&(
            <div className="flex gap-2 mt-1">
              <Lightbulb className="w-3.5 h-3.5 text-[#a8c7fa] shrink-0 mt-0.5"/>
              <p className="text-[#a8c7fa] text-[11px] italic leading-tight">{aiRationale}</p>
            </div>
          )}
          <div className="mt-1 p-2.5 bg-black/20 rounded-lg border border-[#444746]">
            <p className="text-[9px] text-[#757575] uppercase tracking-wider mb-1.5 font-bold">정답 색깔 힌트</p>
            <div className="grid grid-cols-5 gap-1">
              {ANSWER_POOL.map(ans=>{
                const c=ANSWER_COLOR_MAP[ans]||'red',cfg=COLOR_CONFIG[c];
                return (
                  <div key={ans} className="flex flex-col items-center gap-0.5">
                    <div className="w-3 h-3 rounded-full" style={{background:isHardMode?'#555':cfg.hex}}/>
                    <span className="text-[9px] text-[#c4c7c5] font-bold">{ans}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Debugger */}
        <div className="p-2.5 border-b border-[#444746] flex items-center gap-2 text-[#757575]">
          <Terminal className="w-3.5 h-3.5"/>
          <span className="text-[10px] font-bold uppercase tracking-wider">Debugger</span>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-4">
          <div>
            <div className={`p-2.5 rounded-lg border ${isAiThinking?'bg-[#a8c7fa]/10 border-[#a8c7fa]/30 text-[#a8c7fa]':'bg-[#444746]/20 border-[#444746]/50 text-[#c4c7c5]'}`}>
              <div className="flex items-center gap-2">
                <div className={`w-1.5 h-1.5 rounded-full ${isAiThinking?'bg-[#a8c7fa] animate-pulse':'bg-[#66bb6a]'}`}/>
                <span className="text-xs font-mono">{isAiThinking?'분석 중...':'입력 대기'}</span>
              </div>
            </div>
          </div>

          {debugInfo?.screenshotBase64&&(
            <div>
              <p className="text-[9px] text-[#757575] font-bold uppercase tracking-wider mb-1 flex items-center gap-1"><Eye className="w-3 h-3"/>비전</p>
              <div className="rounded-lg overflow-hidden border border-[#444746] relative group">
                <img src={debugInfo.screenshotBase64} alt="AI" className="w-full h-auto opacity-80 group-hover:opacity-100 transition-opacity"/>
                <div className="absolute bottom-0 left-0 right-0 bg-black/70 p-0.5 text-[9px] text-center text-gray-400 font-mono">gemini-flash</div>
              </div>
            </div>
          )}

          {debugInfo&&(
            <div>
              <div className="grid grid-cols-2 gap-2 mb-2">
                <div className="bg-[#2a2a2a] p-2 rounded border border-[#444746]">
                  <p className="text-[9px] text-gray-500 mb-0.5">지연</p>
                  <p className="text-[#a8c7fa] font-mono font-bold text-xs">{debugInfo.latency}ms</p>
                </div>
                <div className="bg-[#2a2a2a] p-2 rounded border border-[#444746]">
                  <p className="text-[9px] text-gray-500 mb-0.5">추천색</p>
                  <p className="text-[#e3e3e3] font-mono font-bold text-xs capitalize">{debugInfo.parsedResponse?.recommendedColor||'--'}</p>
                </div>
              </div>
              {debugInfo.error&&(
                <div className="bg-[#ef5350]/10 border border-[#ef5350]/30 p-2 rounded mb-2">
                  <div className="flex gap-1 text-[#ef5350] items-start">
                    <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0"/>
                    <p className="text-[9px] font-mono break-all">{debugInfo.error}</p>
                  </div>
                </div>
              )}
              <p className="text-[9px] text-gray-500 mb-0.5">원본 응답</p>
              <div className="bg-[#121212] p-2 rounded border border-[#444746] font-mono text-[10px] text-[#66bb6a] max-h-28 overflow-y-auto whitespace-pre-wrap mb-2 border-l-2 border-l-[#66bb6a]">
                {debugInfo.rawResponse}
              </div>
              <p className="text-[9px] text-gray-500 mb-0.5">JSON</p>
              <div className="bg-[#121212] p-2 rounded border border-[#444746] font-mono text-[9px] text-[#a8c7fa] overflow-x-auto">
                <pre>{JSON.stringify(debugInfo.parsedResponse||{error:'파싱 실패'},null,2)}</pre>
              </div>
            </div>
          )}
        </div>

        <div className="p-2.5 bg-[#252525] border-t border-[#444746] text-center">
          <p className="text-[9px] text-gray-500">Powered by Google Gemini Flash</p>
        </div>
      </div>

      {/* Countdown CSS */}
      <style>{`
        @keyframes countPop {
          0%   { transform:scale(1.8);opacity:0; }
          30%  { transform:scale(1.0);opacity:1; }
          80%  { transform:scale(1.0);opacity:1; }
          100% { transform:scale(0.6);opacity:0; }
        }
      `}</style>
    </div>
  );
};

export default GeminiSlingshot;
