import { COLS, ROWS, SHAPES, mulberry32 } from "./game.js";

// CPU 난이도 상향: 가능한 배치(회전/위치)를 탐색해 휴리스틱 점수로 최선 수를 선택합니다.
function cloneBoard(b){
  return b.map(row => row.slice());
}

function collide(board, type, rot, px, py){
  const shape = SHAPES[type][rot];
  for(let y=0;y<4;y++){
    for(let x=0;x<4;x++){
      if(!shape[y][x]) continue;
      const bx = px + x;
      const by = py + y;
      if(bx < 0 || bx >= COLS || by >= ROWS) return true;
      if(by >= 0 && board[by][bx]) return true;
    }
  }
  return false;
}

function merge(board, type, rot, px, py, id){
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
  for(let y=ROWS-1; y>=0; y--){
    if(board[y].every(v=>v)){
      board.splice(y,1);
      board.unshift(new Array(COLS).fill(0));
      cleared++;
      y++;
    }
  }
  return cleared;
}

function evalBoard(board, cleared){
  // column heights
  const heights = new Array(COLS).fill(0);
  for(let x=0;x<COLS;x++){
    let h = 0;
    for(let y=0;y<ROWS;y++){
      if(board[y][x]){
        h = ROWS - y;
        break;
      }
    }
    heights[x] = h;
  }
  const aggHeight = heights.reduce((a,b)=>a+b,0);
  const maxHeight = Math.max(...heights);
  let bump = 0;
  for(let x=0;x<COLS-1;x++) bump += Math.abs(heights[x]-heights[x+1]);

  // holes
  let holes = 0;
  for(let x=0;x<COLS;x++){
    let seenBlock = false;
    for(let y=0;y<ROWS;y++){
      if(board[y][x]) seenBlock = true;
      else if(seenBlock) holes++;
    }
  }

  // Heuristic weights (tuned to be stronger but still human-like)
  let score = 0;
  score += cleared * 1200;          // clear lines
  score -= holes * 160;             // avoid holes strongly
  score -= aggHeight * 6;           // keep low
  score -= bump * 10;               // smoother
  score -= maxHeight * 12;          // avoid topping out
  return score;
}

export class CpuController {
  constructor(game, seed){
    this.game = game;
    this.rnd = mulberry32((seed>>>0) || 1);
    this.lastPieceKey = "";
    this.targetX = 3;
    this.targetRot = 0;
    this.actionAcc = 0;
    this.actionMs = 38; // faster decisions
  }

  _plan(){
    const g = this.game;
    if(!g || g.dead || g.paused || !g.current) return;

    const type = g.current.type;
    const id = g.current.id || 7;
    const key = `${type}:${g.current.id}:${g.next?.type||""}`;
    if(this.lastPieceKey === key) return;
    this.lastPieceKey = key;

    const base = cloneBoard(g.board);
    let best = { score: -1e18, x: g.current.x, rot: g.current.rot };

    for(let rot=0; rot<4; rot++){
      // x range broad enough for 4x4 matrices
      for(let x=-2; x<COLS; x++){
        let y = -3;
        // if collides at spawn area, skip
        if(collide(base, type, rot, x, y)) continue;
        while(!collide(base, type, rot, x, y+1)) y++;
        const b2 = cloneBoard(base);
        merge(b2, type, rot, x, y, id);
        const cleared = clearLines(b2);
        const sc = evalBoard(b2, cleared);

        // small randomness to avoid identical play
        const jitter = (this.rnd()-0.5) * 3;
        const sc2 = sc + jitter;

        if(sc2 > best.score){
          best = { score: sc2, x, rot };
        }
      }
    }

    this.targetX = best.x;
    this.targetRot = best.rot;
  }

  update(dt){
    const g = this.game;
    if(!g || g.dead || g.paused) return;

    this._plan();

    this.actionAcc += dt;
    while(this.actionAcc >= this.actionMs){
      this.actionAcc -= this.actionMs;

      // rotate toward target
      if(g.current && g.current.rot !== this.targetRot){
        g.rotate(1);
        continue;
      }
      // move toward target x
      if(g.current && g.current.x < this.targetX){
        g.move(1);
        continue;
      }
      if(g.current && g.current.x > this.targetX){
        g.move(-1);
        continue;
      }

      // once aligned, hard drop quickly
      g.hardDrop();
    }
  }
}
