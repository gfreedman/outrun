import { Game } from './game';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const game = new Game(canvas);

// Use CSS-pixel dimensions only — no DPR transform.
// The browser upscales on retina (nearest-neighbour with image-rendering:pixelated),
// which looks fine for a retro game and eliminates DPR-transform flicker.
function resize(): void {
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
  game.w = window.innerWidth;
  game.h = window.innerHeight;
}

resize();
window.addEventListener('resize', resize);
game.start();
