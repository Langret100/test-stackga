import { COLS, mulberry32 } from "./game.js";

// 아주 단순한 CPU: 새 블록마다 목표 x/회전을 정하고, 그쪽으로 이동/회전 후 빠르게 내려놓습니다.
// (정교한 최적화/탐색은 하지 않음)

export class CpuController {
  constructor(game, seed){
    this.game = game;
    this.rnd = mulberry32((seed>>>0) || 1);
    this.lastPiece = null;
    this.targetX = 3;
    this.targetRot = 0;
    this.actionAcc = 0;
    this.actionMs = 70;
    this.dropBias = 0.55; // 높을수록 하드드롭 비율 증가
  }

  _plan(){
    // 0~9에서 골라 이동 시도(충돌이면 game.move가 막아줌)
    this.targetX = Math.floor(this.rnd() * COLS);
    this.targetRot = Math.floor(this.rnd() * 4);
  }

  update(dt){
    const g = this.game;
    if(!g || g.dead || g.paused) return;

    if(this.lastPiece !== g.current){
      this.lastPiece = g.current;
      this._plan();
      // 난이도: 레벨이 오르면 조금 더 자주 액션
      this.actionMs = Math.max(35, 80 - (g.level-1)*6);
    }

    this.actionAcc += dt;
    while(this.actionAcc >= this.actionMs){
      this.actionAcc -= this.actionMs;

      // 회전 맞추기
      if(g.current && g.current.rot !== this.targetRot){
        g.rotate(1);
        continue;
      }

      // x 맞추기
      if(g.current && g.current.x < this.targetX){
        g.move(1);
        continue;
      }
      if(g.current && g.current.x > this.targetX){
        g.move(-1);
        continue;
      }

      // 내려놓기
      if(this.rnd() < this.dropBias){
        g.hardDrop();
      }else{
        // 살짝씩 내려서 자연스럽게 보이게
        g.softDrop();
        g.softDrop();
      }
    }
  }
}
