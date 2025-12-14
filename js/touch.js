// Mobile/touch helpers (implemented from scratch for this project)
// Touch controls (portrait-first):
// - Tap: rotate
// - Swipe left/right: move (continuous)
// - Swipe down: soft drop (continuous)
// - Strong swipe down: hard drop

const COLS = 10;
const ROWS = 20;

function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

export function fitCanvases(cvMe, cvOpp, cvNext){
  if(!cvMe || !cvOpp) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);

  // visualViewport is more stable on mobile (address bar / keyboard)
  const vvp = window.visualViewport;
  const vw = Math.max(320, (vvp?.width ?? window.innerWidth ?? 0));
  const vh = Math.max(520, (vvp?.height ?? window.innerHeight ?? 0));
  const portrait = vh >= vw;

  // Reserve space for header/hud and safe areas (measure actual DOM when possible).
  const topbarH = document.querySelector('.topbar')?.offsetHeight || 0;
  const hudH = document.querySelector('.hud')?.offsetHeight || 0;
  const extra = portrait ? 28 : 18; // paddings/margins buffer
  const reservedH = clamp(topbarH + hudH + extra, portrait ? 72 : 60, portrait ? 160 : 130);

  const maxH = Math.max(360, vh - reservedH);
  const maxW = Math.min(portrait ? (vw - 16) : (vw - 240), 760);

  let cell = clamp(Math.floor(Math.min(maxW / COLS, maxH / ROWS)), 16, 46);
  // Slightly reduce the main board on portrait so the PIP doesn't feel cramped.
  if(portrait) cell = Math.max(14, Math.floor(cell * 0.92));
  const logicalW = cell * COLS;
  const logicalH = cell * ROWS;

  cvMe.width = Math.floor(logicalW * dpr);
  cvMe.height = Math.floor(logicalH * dpr);
  cvMe.style.width = logicalW + "px";
  cvMe.style.height = logicalH + "px";

  // Opponent PIP overlay box (kept visible on mobile)
  // - We size the overlay by main-cell units (stable in portrait)
  // - Game logic uses the same blocked zone (top-right) so blocks never go behind it.
  const pipCols = 3; // blocked columns on the right
  const pipRows = 6; // blocked rows on the top
  const pipW = pipCols * cell;
  const pipH = pipRows * cell; // keep 1:2 ratio

  cvOpp.width = Math.floor(pipW * dpr);
  cvOpp.height = Math.floor(pipH * dpr);
  cvOpp.style.width = pipW + "px";
  cvOpp.style.height = pipH + "px";

  // Next piece preview (4x4) - half size and overlaid on the main board
  if(cvNext){
    const nextCell = clamp(Math.floor(cell * 0.38), 8, 16);
    const nextW = nextCell * 4;
    const nextH = nextCell * 4;
    cvNext.width = Math.floor(nextW * dpr);
    cvNext.height = Math.floor(nextH * dpr);
    cvNext.style.width = nextW + 'px';
    cvNext.style.height = nextH + 'px';
  }
}

export function initTouchControls(canvas, onAction){
  if(!canvas || !onAction) return;

  // Disable browser gestures/scroll on the canvas.
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

    // continuous horizontal moves
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

    // continuous soft drops
    let dy = t.pageY - touchStartY;
    while(!hardDropTriggered && dy >= softThreshold){
      onAction("down");
      touchStartY += softThreshold;
      dy = t.pageY - touchStartY;
    }

    // one-shot hard drop on strong downward swipe
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

    // tap => rotate
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
