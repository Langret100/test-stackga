export interface Point { x: number; y: number; }

export type BubbleColor = 'red' | 'blue' | 'green' | 'yellow' | 'purple' | 'orange';

export interface Bubble {
  id: string;
  row: number;
  col: number;
  x: number;
  y: number;
  color: BubbleColor;
  answer: number;
  expression: string;
  active: boolean;
}

export interface Particle {
  x: number; y: number;
  vx: number; vy: number;
  life: number;
  color: string;
}

export type GameMode = 'easy' | 'hard';

declare global {
  interface Window {
    Hands: any; Camera: any;
    drawConnectors: any; drawLandmarks: any; HAND_CONNECTIONS: any;
  }
}
