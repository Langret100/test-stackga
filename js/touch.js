// Mobile/touch helpers (implemented from scratch)
// Touch controls:
// - Tap: rotate
// - Swipe left/right: move (continuous)
// - Swipe down: soft drop (continuous)
// - Strong swipe down: hard drop

const COLS = 10;
// 요청: 기존 20행에서 +3행 고정
const ROWS = 23;

function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

/**
 * 캔버스 크기 자동 맞춤
 * - 세로(모바일) 기준: 내 보드는 좌측에 딱 붙이고
 * - 우측 남는 공간: 위=NEXT, 아래=상대 보드(10x20)만
 */
export function fitCanvases(cvMe, cvOpp, cvNext, rows=0){
  if(!cvMe || !cvOpp || !cvNext) return { rows: ROWS, cell: 24 };

  const dpr = Math.min(2, window.devicePixelRatio || 1);

  // DOM measurements (HUD is outside playShell)
  const playShell = document.getElementById('playShell');
  const sideCol  = document.getElementById('sideCol');
  const nextCard = document.getElementById('nextCard');
  const oppCard  = document.getElementById('oppCard');
  const comboArea = document.getElementById('comboArea');

  const shellW = playShell?.clientWidth  || (window.visualViewport?.width  || window.innerWidth  || 360);
  const shellH = playShell?.clientHeight || (window.visualViewport?.height || window.innerHeight || 640);

  // Use actual board card inner size so we can maximize board height (avoid big blank under the board)
  const boardCard = document.getElementById('boardCol');
  const boardInnerW = Math.max(180, (boardCard?.clientWidth || (shellW*0.74)) - 20);
  const boardInnerH = Math.max(260, (boardCard?.clientHeight || shellH) - 20);

  // Determine rows (fixed)
  const rowsVal = (rows|0) > 0 ? (rows|0) : ROWS;

  // Choose a cell so rowsVal fits.
  let cell = Math.floor(Math.min(boardInnerW / COLS, boardInnerH / rowsVal));
  cell = clamp(cell, 12, 56);

  // Recompute cell conservatively.
  cell = Math.floor(Math.min(boardInnerW / COLS, boardInnerH / rowsVal));
  cell = clamp(cell, 10, 56);

  // ---- Main board (10 x rowsVal)
  const meW = cell * COLS;
  const meH = cell * rowsVal;
  cvMe.width  = Math.floor(meW * dpr);
  cvMe.height = Math.floor(meH * dpr);
  cvMe.style.width  = meW + 'px';
  cvMe.style.height = meH + 'px';

  // ---- Side column: Next + Opp(10 x rowsVal, no stretch) + Combo text
  const sideW  = sideCol?.clientWidth || clamp(Math.floor(shellW * 0.26), 104, 180);
  const sideH = sideCol?.clientHeight || shellH;
  const gap = 10;
  const pad = 16; // card padding (8*2)

  const comboMinH = 64;

  // Next preview (square)
  let nextInner = clamp(Math.min((sideW - pad), Math.floor(sideH * 0.20)), 52, 118);
  const nextCardH = nextInner + pad;

  // Remaining height after Next (reserve space for combo text)
  const remain = Math.max(160, sideH - nextCardH - gap);
  const oppInnerW = Math.max(64, (sideW - pad));
  const oppInnerMaxH = Math.max(120, remain - comboMinH - gap);

  let oppCell = Math.floor(Math.min(oppInnerW / COLS, oppInnerMaxH / rowsVal));
  oppCell = clamp(oppCell, 5, 24);
  const oppW = oppCell * COLS;
  const oppHpx = oppCell * rowsVal;

  const oppCardH = oppHpx + pad;
  const comboH = Math.max(comboMinH, remain - oppCardH - gap);

  if(nextCard) nextCard.style.height = nextCardH + 'px';
  if(oppCard)  oppCard.style.height  = oppCardH + 'px';
  if(comboArea) comboArea.style.height = comboH + 'px';

  // Next canvas (fill card)
  const nextW = nextInner;
  const nextHpx = nextInner;
  cvNext.width  = Math.floor(nextW * dpr);
  cvNext.height = Math.floor(nextHpx * dpr);
  cvNext.style.width  = '100%';
  cvNext.style.height = '100%';

  // Opp canvas: explicit px height so it never stretches vertically
  cvOpp.width  = Math.floor(oppW * dpr);
  cvOpp.height = Math.floor(oppHpx * dpr);
  cvOpp.style.width  = '100%';
  cvOpp.style.height = '100%';

  return { rows: rowsVal, cell };
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
