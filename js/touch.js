// Mobile/touch helpers (implemented from scratch)
// Touch controls:
// - Tap: rotate
// - Swipe left/right: move (continuous)
// - Swipe down: soft drop (continuous)
// - Strong swipe down: hard drop

const COLS = 10;
const ROWS = 20;

function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

/**
 * 캔버스 크기 자동 맞춤
 * - 세로(모바일) 기준: 내 보드는 좌측에 딱 붙이고
 * - 우측 남는 공간: 위=NEXT, 아래=상대 보드(10x20)만
 */
export function fitCanvases(cvMe, cvOpp, cvNext){
  if(!cvMe || !cvOpp || !cvNext) return;

  const dpr = Math.min(2, window.devicePixelRatio || 1);

  // 실제 레이아웃 폭/높이를 DOM에서 측정
  const playShell = document.getElementById('playShell');
  const boardCol = document.getElementById('boardCol');
  const sideCol = document.getElementById('sideCol');
  const nextCard = document.getElementById('nextCard');
  const oppCard = document.getElementById('oppCard');

  const shellW = playShell?.clientWidth || (window.visualViewport?.width || window.innerWidth || 360);
  const shellH = playShell?.clientHeight || (window.visualViewport?.height || window.innerHeight || 640);

  const sideW = sideCol?.clientWidth || clamp(Math.floor(shellW * 0.28), 112, 170);
  const boardW = boardCol?.clientWidth || Math.max(200, shellW - sideW - 10);

  // 보드가 세로로 꽉 차도록 (HUD는 이미 playShell 밖)
  const maxH = Math.max(240, shellH);
  let cell = Math.floor(Math.min(boardW / COLS, maxH / ROWS));
  cell = clamp(cell, 14, 48);

  const meW = cell * COLS;
  const meH = cell * ROWS;
  cvMe.width = Math.floor(meW * dpr);
  cvMe.height = Math.floor(meH * dpr);
  cvMe.style.width = meW + 'px';
  cvMe.style.height = meH + 'px';

  // NEXT: 4x4, 우측 상단 카드 폭에 맞춤
  const nextInnerW = (nextCard?.clientWidth || sideW) - 16;
  let nextCell = Math.floor(nextInnerW / 4);
  nextCell = clamp(nextCell, 10, 18);
  const nextW = nextCell * 4;
  const nextH = nextCell * 4;
  cvNext.width = Math.floor(nextW * dpr);
  cvNext.height = Math.floor(nextH * dpr);
  cvNext.style.width = '100%';
  cvNext.style.height = 'auto';

  // 상대 보드: 남은 높이/폭에 맞춰 10x20
  const oppInnerW = (oppCard?.clientWidth || sideW) - 16;
  const usedH = (nextCard?.offsetHeight || 0) + 10; // gap
  const oppMaxH = Math.max(180, shellH - usedH);

  let oppCell = Math.floor(Math.min(oppInnerW / COLS, oppMaxH / ROWS));
  oppCell = clamp(oppCell, 6, 20);
  const oppW = oppCell * COLS;
  const oppH = oppCell * ROWS;
  cvOpp.width = Math.floor(oppW * dpr);
  cvOpp.height = Math.floor(oppH * dpr);
  cvOpp.style.width = '100%';
  cvOpp.style.height = 'auto';
}

export function initTouchControls(canvas, onAction){
  if(!canvas || !onAction) return;

  try { canvas.style.touchAction = "none"; } catch {}

  let touchStartX = 0;
  let touchStartY = 0;
  let originX = 0;
  let originY = 0;
  let hardDropTriggered = false;

  const moveThreshold = 28;      // px per 1-cell move
  const softThreshold = 44;      // px per 1 soft drop
  const hardDropThreshold = 150; // px downward total for hard drop

  const getTouch = (e)=>{
    if(e.changedTouches && e.changedTouches[0]) return e.changedTouches[0];
    if(e.touches && e.touches[0]) return e.touches[0];
    return null;
  };

  const onStart = (e)=>{
    e.preventDefault();
    const t = getTouch(e);
    if(!t) return;
    originX = t.pageX;
    originY = t.pageY;
    touchStartX = originX;
    touchStartY = originY;
    hardDropTriggered = false;
  };

  const onMove = (e)=>{
    e.preventDefault();
    const t = getTouch(e);
    if(!t) return;

    let dx = t.pageX - touchStartX;
    while(Math.abs(dx) >= moveThreshold){
      if(dx > 0){
        onAction("right");
        touchStartX += moveThreshold;
      }else{
        onAction("left");
        touchStartX -= moveThreshold;
      }
      dx = t.pageX - touchStartX;
    }

    let dy = t.pageY - touchStartY;
    while(!hardDropTriggered && dy >= softThreshold){
      onAction("down");
      touchStartY += softThreshold;
      dy = t.pageY - touchStartY;
    }

    const totalDy = t.pageY - originY;
    if(totalDy > hardDropThreshold && !hardDropTriggered){
      onAction("drop");
      hardDropTriggered = true;
    }
  };

  const onEnd = (e)=>{
    e.preventDefault();
    const t = getTouch(e);
    if(!t) return;

    const totalDx = t.pageX - originX;
    const totalDy = t.pageY - originY;

    if(Math.abs(totalDx) < moveThreshold && Math.abs(totalDy) < moveThreshold && !hardDropTriggered){
      onAction("rotate");
    }
  };

  canvas.addEventListener("touchstart", onStart, { passive:false });
  canvas.addEventListener("touchmove", onMove, { passive:false });
  canvas.addEventListener("touchend", onEnd, { passive:false });
  canvas.addEventListener("touchcancel", onEnd, { passive:false });
  canvas.addEventListener("contextmenu", (e)=>e.preventDefault());
}
