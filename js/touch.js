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

  // DOM measurements (HUD is outside playShell)
  const playShell = document.getElementById('playShell');
  const boardCol = document.getElementById('boardCol');
  const sideCol  = document.getElementById('sideCol');
  const nextCard = document.getElementById('nextCard');
  const oppCard  = document.getElementById('oppCard');
  const comboCard = document.getElementById('comboCard');

  const shellW = playShell?.clientWidth  || (window.visualViewport?.width  || window.innerWidth  || 360);
  const shellH = playShell?.clientHeight || (window.visualViewport?.height || window.innerHeight || 640);

  const sideW  = sideCol?.clientWidth || clamp(Math.floor(shellW * 0.28), 112, 170);
  const gapW = 10;
  const boardPad = 20; // boardCard padding approx (10*2)
  const boardW = Math.max(180, shellW - sideW - gapW - boardPad);

  // ---- Main board (10x20)
  const maxH = Math.max(240, shellH);
  let cell = Math.floor(Math.min(boardW / COLS, maxH / ROWS));
  cell = clamp(cell, 14, 52);

  const meW = cell * COLS;
  const meH = cell * ROWS;
  cvMe.width  = Math.floor(meW * dpr);
  cvMe.height = Math.floor(meH * dpr);
  cvMe.style.width  = meW + 'px';
  cvMe.style.height = meH + 'px';

  // ---- Side column: force Next + Opp + Combo to fit in the visible height (no clipping)
  const sideH = sideCol?.clientHeight || shellH;
  const gap = 10;
  const pad = 16; // card padding (8*2)

  // Combo takes a small fixed chunk at the bottom.
  let comboH = clamp(Math.floor(sideH * 0.14), 48, 72);

  // Allocate a reasonable Next box height, but never steal too much from Opp.
  const minOppH = 140;
  let nextInner = Math.min((sideW - pad), Math.floor(sideH * 0.22));
  nextInner = clamp(nextInner, 56, 120);

  // Ensure we always have room for Opp + Combo.
  const minTotal = (minOppH + pad) + comboH + gap*2 + (nextInner + pad);
  if(minTotal > sideH){
    // shrink Next first, then combo if needed
    const over = minTotal - sideH;
    nextInner = Math.max(56, nextInner - over);
    if((minOppH + pad) + comboH + gap*2 + (nextInner + pad) > sideH){
      comboH = Math.max(44, comboH - (over*0.6));
    }
  }

  const nextH = Math.max(56 + pad, nextInner + pad);
  const oppH  = Math.max(minOppH + pad, sideH - nextH - comboH - gap*2);

  if(nextCard) nextCard.style.height = nextH + 'px';
  if(oppCard)  oppCard.style.height  = oppH + 'px';
  if(comboCard) comboCard.style.height = comboH + 'px';


  // NEXT: 4x4, fit to Next box inner size (square)
  const nextCell = clamp(Math.floor(Math.min(nextInner, nextInner) / 4), 8, 20);
  const nextW = nextCell * 4;
  const nextHpx = nextCell * 4;
  cvNext.width  = Math.floor(nextW * dpr);
  cvNext.height = Math.floor(nextHpx * dpr);
  cvNext.style.width  = '100%';
  cvNext.style.height = '100%';

  // Opp: 10x20, fit to remaining box
  const oppInnerW = Math.max(64, (sideW - pad));
  const oppInnerH = Math.max(minOppH, (oppH - pad));
  let oppCell = Math.floor(Math.min(oppInnerW / COLS, oppInnerH / ROWS));
  oppCell = clamp(oppCell, 6, 24);
  const oppW = oppCell * COLS;
  const oppHpx = oppCell * ROWS;

  cvOpp.width  = Math.floor(oppW * dpr);
  cvOpp.height = Math.floor(oppHpx * dpr);
  cvOpp.style.width  = '100%';
  cvOpp.style.height = '100%';
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
