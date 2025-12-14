
export const COLS = 10;
// 요청: 기존 20행 기준에서 +3행 고정
export const ROWS = 23;

export const SHAPES = {
  I: [
    [[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]],
    [[0,0,1,0],[0,0,1,0],[0,0,1,0],[0,0,1,0]],
    [[0,0,0,0],[0,0,0,0],[1,1,1,1],[0,0,0,0]],
    [[0,1,0,0],[0,1,0,0],[0,1,0,0],[0,1,0,0]],
  ],
  O: [
    [[0,1,1,0],[0,1,1,0],[0,0,0,0],[0,0,0,0]],
    [[0,1,1,0],[0,1,1,0],[0,0,0,0],[0,0,0,0]],
    [[0,1,1,0],[0,1,1,0],[0,0,0,0],[0,0,0,0]],
    [[0,1,1,0],[0,1,1,0],[0,0,0,0],[0,0,0,0]],
  ],
  T: [
    [[0,1,0,0],[1,1,1,0],[0,0,0,0],[0,0,0,0]],
    [[0,1,0,0],[0,1,1,0],[0,1,0,0],[0,0,0,0]],
    [[0,0,0,0],[1,1,1,0],[0,1,0,0],[0,0,0,0]],
    [[0,1,0,0],[1,1,0,0],[0,1,0,0],[0,0,0,0]],
  ],
  S: [
    [[0,1,1,0],[1,1,0,0],[0,0,0,0],[0,0,0,0]],
    [[0,1,0,0],[0,1,1,0],[0,0,1,0],[0,0,0,0]],
    [[0,0,0,0],[0,1,1,0],[1,1,0,0],[0,0,0,0]],
    [[1,0,0,0],[1,1,0,0],[0,1,0,0],[0,0,0,0]],
  ],
  Z: [
    [[1,1,0,0],[0,1,1,0],[0,0,0,0],[0,0,0,0]],
    [[0,0,1,0],[0,1,1,0],[0,1,0,0],[0,0,0,0]],
    [[0,0,0,0],[1,1,0,0],[0,1,1,0],[0,0,0,0]],
    [[0,1,0,0],[1,1,0,0],[1,0,0,0],[0,0,0,0]],
  ],
  J: [
    [[1,0,0,0],[1,1,1,0],[0,0,0,0],[0,0,0,0]],
    [[0,1,1,0],[0,1,0,0],[0,1,0,0],[0,0,0,0]],
    [[0,0,0,0],[1,1,1,0],[0,0,1,0],[0,0,0,0]],
    [[0,1,0,0],[0,1,0,0],[1,1,0,0],[0,0,0,0]],
  ],
  L: [
    [[0,0,1,0],[1,1,1,0],[0,0,0,0],[0,0,0,0]],
    [[0,1,0,0],[0,1,0,0],[0,1,1,0],[0,0,0,0]],
    [[0,0,0,0],[1,1,1,0],[1,0,0,0],[0,0,0,0]],
    [[1,1,0,0],[0,1,0,0],[0,1,0,0],[0,0,0,0]],
  ],
};

const TYPES = ["I","O","T","S","Z","J","L"];

export function mulberry32(seed){
  let a = seed >>> 0;
  return function(){
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeBagRng(seed){
  const rnd = mulberry32(seed);
  let bag = [];
  function refill(){
    bag = TYPES.slice();
    for(let i=bag.length-1;i>0;i--){
      const j = Math.floor(rnd()*(i+1));
      [bag[i],bag[j]] = [bag[j],bag[i]];
    }
  }
  refill();
  return () => {
    if(bag.length===0) refill();
    return bag.pop();
  };
}

export function newBoard(){
  return Array.from({length:ROWS},()=>Array.from({length:COLS},()=>0));
}

export function cloneBoard(b){
  return b.map(r=>r.slice());
}

function collide(board, piece, px, py, rot){
  const shape = SHAPES[piece.type][rot];
  for(let y=0;y<4;y++){
    for(let x=0;x<4;x++){
      if(!shape[y][x]) continue;
      const bx = px + x;
      const by = py + y;
      if(bx<0 || bx>=COLS || by>=ROWS) return true;
      if(by>=0 && board[by][bx]) return true;
    }
  }
  return false;
}

function merge(board, piece){
  const {x:px, y:py, rot, type, id} = piece;
  const shape = SHAPES[type][rot];
  for(let y=0;y<4;y++){
    for(let x=0;x<4;x++){
      if(!shape[y][x]) continue;
      const bx = px + x;
      const by = py + y;
      if(by>=0 && by<ROWS && bx>=0 && bx<COLS) board[by][bx] = id;
    }
  }
}

function clearLines(board){
  let cleared = 0;
  for(let y=ROWS-1;y>=0;y--){
    if(board[y].every(v=>v!==0)){
      board.splice(y,1);
      board.unshift(Array.from({length:COLS},()=>0));
      cleared++;
      y++; // recheck same row index after shift
    }
  }
  return cleared;
}

export class StackGame {
  constructor(seed){
    this.seed = seed>>>0;
    this.getNextType = makeBagRng(this.seed);
    this.board = newBoard();
    this.score = 0;
    this.level = 1;
    this.lines = 0;
    this.dropMs = 900;
    this.gravityAcc = 0;
    this.paused = false;

    this.effects = {
      invertUntil: 0,
      shrinkUntil: 0,
      bigNextUntil: 0
    };

    // RNG for garbage-hole positions
    this._garbageRnd = mulberry32(((this.seed ^ 0xA5A5A5A5)>>>0) || 1);

    this.current = null;
    this.next = this._makePiece();
    this.dead = false;
    this.lastCleared = 0;
    this.spawn();
  }

  _makePiece(){
    const type = this.getNextType();
    const idMap = {I:1,O:2,T:3,S:4,Z:5,J:6,L:7};
    return { type, id: idMap[type], x:3, y:-1, rot:0 };
  }

  spawn(){
    this.current = this.next;
    this.current.x = 3; this.current.y = -1; this.current.rot = 0;
    this.next = this._makePiece();
    if(this._isBigNextActive()){
      // No physics change, only render enlargement handled in renderer.
    }
    if(collide(this.board,this.current,this.current.x,this.current.y,this.current.rot)){
      this.dead = true;
    }
  }

  _isInvertActive(now=Date.now()){ return now < this.effects.invertUntil; }
  _isShrinkActive(now=Date.now()){ return now < this.effects.shrinkUntil; }
  _isBigNextActive(now=Date.now()){ return now < this.effects.bigNextUntil; }

  applyEffect(kind, ms){
    const now = Date.now();
    if(kind==="invert") this.effects.invertUntil = Math.max(this.effects.invertUntil, now+ms);
    if(kind==="shrink") this.effects.shrinkUntil = Math.max(this.effects.shrinkUntil, now+ms);
    if(kind==="bignext") this.effects.bigNextUntil = Math.max(this.effects.bigNextUntil, now+ms);
  }
  addGarbage(lines){
    if(this.dead || this.paused) return;
    const n = Math.max(0, lines|0);
    for(let i=0;i<n;i++){
      // If blocks are already in the top row, rising garbage causes top-out.
      if(this.board[0].some(v=>v)){
        this.dead = true;
        return;
      }
      const hole = Math.floor(this._garbageRnd()*COLS);
      const row = new Array(COLS).fill(8);
      row[hole] = 0;

      // Rising garbage: shift everything up, insert garbage at bottom
      this.board.shift();
      this.board.push(row);

      // If the active piece now overlaps, try pushing it up a bit; otherwise top-out.
      if(this.current && collide(this.board, this.current, this.current.x, this.current.y, this.current.rot)){
        let ok = false;
        for(let k=0;k<4;k++){
          this.current.y -= 1;
          if(!collide(this.board, this.current, this.current.x, this.current.y, this.current.rot)){
            ok = true;
            break;
          }
        }
        if(!ok){
          this.dead = true;
          return;
        }
      }
    }
  }


  tick(dt){
    if(this.dead || this.paused) return;
    this.gravityAcc += dt;
    const ms = this._computeDropMs();
    while(this.gravityAcc >= ms){
      this.gravityAcc -= ms;
      this.softDrop();
      if(this.dead) break;
    }
  }

  _computeDropMs(){
    // faster by level
    return Math.max(120, this.dropMs - (this.level-1)*70);
  }

  move(dx){
    if(this.dead || this.paused) return false;
    const nx = this.current.x + dx;
    if(!collide(this.board,this.current,nx,this.current.y,this.current.rot)){
      this.current.x = nx;
      return true;
    }
    return false;
  }

  rotate(dir){
    if(this.dead || this.paused) return false;
    const nr = (this.current.rot + (dir>0?1:3)) % 4;
    // simple wall kicks
    const kicks = [0,-1,1,-2,2];
    for(const k of kicks){
      const nx = this.current.x + k;
      if(!collide(this.board,this.current,nx,this.current.y,nr)){
        this.current.rot = nr;
        this.current.x = nx;
        return true;
      }
    }
    return false;
  }

  hardDrop(){
    if(this.dead || this.paused) return;
    while(!collide(this.board,this.current,this.current.x,this.current.y+1,this.current.rot)){
      this.current.y += 1;
    }
    this._lock();
  }

  softDrop(){
    if(this.dead || this.paused) return;
    if(!collide(this.board,this.current,this.current.x,this.current.y+1,this.current.rot)){
      this.current.y += 1;
    } else {
      this._lock();
    }
  }

  _lock(){
    merge(this.board,this.current);
    const cleared = clearLines(this.board);
    this.lastCleared = cleared;
    if(cleared>0){
      const pts = [0,100,250,450,700][cleared] || (cleared*250);
      this.score += pts * this.level;
      this.lines += cleared;
      this.level = 1 + Math.floor(this.lines / 10);
    }
    this.spawn();
    if(this.dead){
      // keep board as-is
    }
  }

  snapshot(){
    // board with current piece overlaid
    const b = cloneBoard(this.board);
    if(!this.dead && this.current){
      const shape = SHAPES[this.current.type][this.current.rot];
      for(let y=0;y<4;y++){
        for(let x=0;x<4;x++){
          if(!shape[y][x]) continue;
          const bx = this.current.x + x;
          const by = this.current.y + y;
          if(by>=0 && by<ROWS && bx>=0 && bx<COLS) b[by][bx] = this.current.id;
        }
      }
    }
    return b;
  }
}

export function drawBoard(ctx, board, cell, opts={}){
  const { ghost=false } = opts;
  ctx.clearRect(0,0,ctx.canvas.width,ctx.canvas.height);
  // background grid
  ctx.globalAlpha = 1;
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.fillRect(0,0,ctx.canvas.width,ctx.canvas.height);

  for(let y=0;y<ROWS;y++){
    for(let x=0;x<COLS;x++){
      const v = board[y][x];
      if(v){
        ctx.fillStyle = colorOf(v, ghost);
        ctx.fillRect(x*cell, y*cell, cell-1, cell-1);
      } else {
        // faint grid
        ctx.fillStyle = "rgba(15,23,42,0.06)";
        ctx.fillRect(x*cell, y*cell, cell-1, cell-1);
      }
    }
  }
}

// Draw next-piece preview in a 4x4 grid (no labels)
export function drawNext(ctx, piece, cell){
  ctx.clearRect(0,0,ctx.canvas.width,ctx.canvas.height);
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.fillRect(0,0,ctx.canvas.width,ctx.canvas.height);
  if(!piece) return;
  const shape = SHAPES[piece.type][0];
  // Center within the 4x4 preview
  for(let y=0;y<4;y++){
    for(let x=0;x<4;x++){
      if(!shape[y][x]){
        ctx.fillStyle = "rgba(15,23,42,0.06)";
        ctx.fillRect(x*cell, y*cell, cell-1, cell-1);
        continue;
      }
      ctx.fillStyle = colorOf(piece.id, false);
      ctx.fillRect(x*cell, y*cell, cell-1, cell-1);
    }
  }
}

function colorOf(v, ghost){
  const base = [
    "#000000",
    "rgba(110,231,255,0.95)",
    "rgba(124,255,178,0.95)",
    "rgba(255,215,110,0.95)",
    "rgba(179,142,255,0.95)",
    "rgba(255,110,170,0.95)",
    "rgba(255,140,110,0.95)",
    "rgba(180,255,110,0.95)",
    "rgba(148,163,184,0.92)"
  ][v] || "rgba(255,255,255,0.9)";
  if(!ghost) return base;
  return base.replace("0.95","0.55");
}
