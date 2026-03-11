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
 * Resizes the canvas to fill the entire browser window.
 * Called on page load and again whenever the user resizes the window.
 */
function resize(): void
{
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
  game.w = window.innerWidth;
  game.h = window.innerHeight;
}

resize();
window.addEventListener('resize', resize);
game.start();
