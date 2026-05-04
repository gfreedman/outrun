/**
 * main.ts
 *
 * Entry point — restores persisted settings, wires the canvas to Game,
 * and starts the animation loop.
 */

import { Game }          from './game';
import { loadSettings }  from './intro-controller';

/** The single <canvas> element where the entire game is rendered. */
const canvas = document.getElementById('game') as HTMLCanvasElement;

// ── Mobile detection ──────────────────────────────────────────────────────────

/**
 * True when running on a touch-primary device (phone / tablet).
 * Three-condition check: UA string, ontouchstart presence, maxTouchPoints.
 * Computed once at startup; never changes.
 */
const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
  || ('ontouchstart' in window)
  || (navigator.maxTouchPoints > 1);

/**
 * True when running on iOS Safari specifically.
 * Used to skip screen.orientation.lock() (silently ignored on iOS).
 */
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// ── Safe-area insets ──────────────────────────────────────────────────────────

/**
 * Reads env(safe-area-inset-*) from the #safe-probe zero-div.
 * Called once at startup and again on every orientationchange.
 * Results are passed to game.setSafeInsets() so the pill renderer can
 * keep affordances clear of the notch and home-bar swipe zone.
 *
 * CSS `env(safe-area-inset-*)` values cannot be read directly from
 * JavaScript — there is no JS API that exposes them.  Instead, the
 * #safe-probe element in index.html has its padding set to those env()
 * values in CSS (`padding: env(safe-area-inset-top) env(safe-area-inset-right)
 * env(safe-area-inset-bottom) env(safe-area-inset-left)`).  Reading the
 * element's computed padding via getComputedStyle() is therefore the
 * standard workaround for extracting env() values into JS.
 */
function readSafeInsets(): void
{
  const probe = document.getElementById('safe-probe');
  if (!probe) return;
  const cs = getComputedStyle(probe);
  game.setSafeInsets(
    parseFloat(cs.paddingLeft)   || 0,
    parseFloat(cs.paddingRight)  || 0,
    parseFloat(cs.paddingBottom) || 0,
  );
}

const game = new Game(canvas, loadSettings(), isMobile);

/** Maximum windowed canvas width in CSS pixels (matches 720p). */
const MAX_CANVAS_W = 1280;
/** Maximum windowed canvas height in CSS pixels (matches 720p). */
const MAX_CANVAS_H = 720;
/** Target aspect ratio (16:9) used for letter/pillar-boxing. */
const ASPECT       = MAX_CANVAS_W / MAX_CANVAS_H;   // 16 / 9

/**
 * Resizes the canvas to fill the window while preserving a 16:9 aspect ratio.
 *
 * Mobile: fills the viewport completely (no 1280×720 cap, no fullscreen check).
 * Desktop fullscreen: expands to the raw display size.
 * Desktop windowed: capped at 1280×720 with letter/pillar-boxing via CSS margin.
 *
 * The canvas logical size (canvas.width / height) equals the CSS pixel size —
 * no DPR scaling is applied.
 */
function resize(): void
{
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let maxW: number, maxH: number;
  if (isMobile)
  {
    // Mobile: always fill the full viewport — no windowed cap.
    maxW = vw;
    maxH = vh;
  }
  else
  {
    // Desktop: cap at 1280×720 windowed; expand to viewport in fullscreen.
    maxW = document.fullscreenElement ? vw : MAX_CANVAS_W;
    maxH = document.fullscreenElement ? vh : MAX_CANVAS_H;
  }

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

if (isMobile)
{
  // ── visualViewport listener ──────────────────────────────────────────────
  // iOS Safari fires visualViewport resize when the address bar animates but
  // not reliably on window.resize.  The equality guard prevents 60 Hz calls
  // during scroll-momentum animation when the address bar is animating.
  if (window.visualViewport)
  {
    // Coalesce to one rAF tick: iOS fires visualViewport resize at 60 Hz while
    // the address bar animates, and the equality guard was unreliable post-
    // letterboxing.  cancelAnimationFrame + rAF collapses every burst to one call.
    let vpRaf = 0;
    window.visualViewport.addEventListener('resize', () =>
    {
      cancelAnimationFrame(vpRaf);
      vpRaf = requestAnimationFrame(resize);
    });
  }

  // ── Orientation change ───────────────────────────────────────────────────
  // The 300 ms delay is an empirical settle window: after the device rotates,
  // the browser needs time to complete its reflow before window.innerWidth /
  // innerHeight reflect the new orientation.  Calling resize() synchronously
  // inside orientationchange returns stale dimensions on some iOS versions
  // (particularly Safari on iPhone < iOS 16), where values below ~200 ms
  // still report the pre-rotation size.  300 ms is the widely accepted safe
  // floor; the subsequent visualViewport 'resize' event fires as a correction
  // if the first call still landed early.
  window.addEventListener('orientationchange', () =>
  {
    setTimeout(resize, 300);
    readSafeInsets();   // notch insets swap left↔right on rotate
    // TouchInput.reset() is called inside game.resize() via pauseOnResize()
  });

  // ── Portrait pause wiring ─────────────────────────────────────────────────
  // Suspends race timer and physics while the rotate overlay is showing.
  const portraitMql = window.matchMedia('(orientation: portrait)');
  portraitMql.addEventListener('change', () => game.setPortraitPaused(portraitMql.matches));

  // ── Android orientation lock ──────────────────────────────────────────────
  // screen.orientation.lock is silently ignored on iOS; only attempt on Android.
  if (!isIOS && (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> })?.lock)
  {
    (screen.orientation as ScreenOrientation & { lock: (o: string) => Promise<void> })
      .lock('landscape').catch(() => {});
  }
}
else
{
  // Desktop only: fullscreenchange listener.
  // On mobile fullscreen is not used; calling requestFullscreen on iOS logs a
  // rejected-promise error in DevTools on every race start.
  document.addEventListener('fullscreenchange', () =>
  {
    resize();
    requestAnimationFrame(resize);
  });
}

// Read safe-area insets once DOM is ready (also re-read on orientationchange above).
document.addEventListener('DOMContentLoaded', readSafeInsets);

// pagehide fires reliably on mobile tab-close/navigate; beforeunload doesn't.
// Tearing down the AudioContext releases the Web Audio quota (Chrome caps ~6/tab).
window.addEventListener('pagehide', () => game.destroy());

game.start();
