/**
 * main.ts
 *
 * Entry point — wires the canvas to the Game class and starts the loop.
 *
 * Canvas sizing strategy:
 *   We use CSS-pixel dimensions only — no device-pixel-ratio (DPR) transform.
 *   On a retina screen the browser upscales via image-rendering: pixelated,
 *   which gives a clean nearest-neighbour look that suits the retro aesthetic.
 *   Avoiding DPR transform also eliminates sub-pixel flicker on canvas resize.
 */

import { Game } from './game';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const game   = new Game(canvas);

/**
 * Maximum pixel-buffer dimensions (L7).
 *
 * At 4K (2560×1440) a full-res canvas 2D fill covers 3.7M pixels per frame —
 * canvas 2D fill cost scales linearly with area.  Capping the pixel buffer at
 * 1280×720 and stretching via CSS keeps the retro upscale intent while
 * limiting fill area to ~0.9M pixels regardless of display resolution.
 */
const MAX_CANVAS_W = 1280;
const MAX_CANVAS_H = 720;

/**
 * Resizes the canvas buffer (capped at 1280×720) and stretches it
 * via CSS to fill the browser window.
 */
function resize(): void
{
  const w = Math.min(window.innerWidth,  MAX_CANVAS_W);
  const h = Math.min(window.innerHeight, MAX_CANVAS_H);
  canvas.width        = w;
  canvas.height       = h;
  canvas.style.width  = '100vw';
  canvas.style.height = '100vh';
  game.resize(w, h);
}

resize();
window.addEventListener('resize', resize);
game.start();
