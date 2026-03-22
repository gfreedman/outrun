/**
 * main.ts
 *
 * Entry point — restores persisted settings, wires the canvas to Game,
 * and starts the animation loop.
 */

import { Game }                     from './game';
import { GameMode, GameSettings }   from './types';

const canvas = document.getElementById('game') as HTMLCanvasElement;

function loadPersistedSettings(): GameSettings | undefined
{
  try
  {
    const raw = localStorage.getItem('outrun_settings');
    if (raw)
    {
      const s = JSON.parse(raw) as Partial<GameSettings>;
      const mode = Object.values(GameMode).includes(s.mode as GameMode)
        ? s.mode as GameMode
        : GameMode.MEDIUM;
      return { mode, soundEnabled: s.soundEnabled !== false };
    }
  }
  catch { /* ignore quota / private-mode errors */ }
  return undefined;
}

const game = new Game(canvas, loadPersistedSettings());

const MAX_CANVAS_W = 1280;
const MAX_CANVAS_H = 720;
const ASPECT       = MAX_CANVAS_W / MAX_CANVAS_H;   // 16 / 9

function resize(): void
{
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // In fullscreen: fill the entire screen (no 1280×720 cap).
  // Windowed: cap at 1280×720 and letter/pillar-box.
  const maxW = document.fullscreenElement ? vw : MAX_CANVAS_W;
  const maxH = document.fullscreenElement ? vh : MAX_CANVAS_H;

  let w: number, h: number;
  if (vw / vh >= ASPECT)
  {
    h = Math.min(vh, maxH);
    w = Math.round(h * ASPECT);
  }
  else
  {
    w = Math.min(vw, maxW);
    h = Math.round(w / ASPECT);
  }

  // Logical resolution = CSS pixel size — no canvas scaling, coordinates always match.
  canvas.width        = w;
  canvas.height       = h;
  canvas.style.width  = `${w}px`;
  canvas.style.height = `${h}px`;
  game.resize(w, h);
}

resize();
window.addEventListener('resize', resize);
// fullscreenchange fires when entering/exiting fullscreen.
// Some browsers update window.innerWidth/Height asynchronously after the event,
// so we resize immediately AND one frame later to catch the settled dimensions.
document.addEventListener('fullscreenchange', () =>
{
  resize();
  requestAnimationFrame(resize);
});
game.start();
