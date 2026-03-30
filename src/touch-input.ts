/**
 * touch-input.ts
 *
 * Two-zone touch controller for mobile play.
 *
 * Zone assignment is determined at touchstart and locked for the lifetime of
 * that touch identifier — even if the finger drifts across the midline.
 *
 * Left zone  (x < midX): slide ←→ to steer.
 * Right zone (x ≥ midX): slide ↑ = gas, slide ↓ = brake.
 *
 * Only instantiated when isMobile === true (see game.ts).  Desktop path is
 * completely unaffected — InputManager is never touched.
 */

import { TOUCH_DEADZONE, TOUCH_STEER_RANGE } from './constants';
import { InputSnapshot }                      from './physics';

// ── Per-zone touch record ─────────────────────────────────────────────────────

interface ZoneState
{
  id:        number;
  startX:    number;
  startY:    number;
  currentX:  number;
  currentY:  number;
  active:    boolean;
  cancelled: boolean;
}

function emptyZone(): ZoneState
{
  return { id: -1, startX: 0, startY: 0, currentX: 0, currentY: 0, active: false, cancelled: false };
}

// ── TouchInput ────────────────────────────────────────────────────────────────

/**
 * Two-zone touch controller that translates finger gestures into an
 * {@link InputSnapshot} compatible with the keyboard input path.
 *
 * **Zone layout** (determined at touchstart, locked for that touch's lifetime):
 * ```
 * ┌─────────────────────┬─────────────────────┐
 * │   LEFT ZONE         │   RIGHT ZONE        │
 * │   slide ←  steer L  │   slide ↑  throttle │
 * │   slide →  steer R  │   slide ↓  brake    │
 * └─────────────────────┴─────────────────────┘
 *          clientX < midX     clientX ≥ midX
 * ```
 *
 * **Tap synthesis** — a touchend with total displacement < 15 px produces a
 * pending tap (canvas-pixel coords) that game.ts injects as a mouseClick so
 * all {@link Button} hit-areas work without special touch handling.
 *
 * Instantiated only when `isMobile === true`; the desktop input path
 * ({@link InputManager}) is completely unaffected.
 */
export class TouchInput
{
  private left:       ZoneState = emptyZone();
  private right:      ZoneState = emptyZone();
  private pendingTap: { x: number; y: number } | null = null;

  private readonly handler: EventListener;

  constructor(private readonly canvas: HTMLCanvasElement)
  {
    this.handler = ((e: TouchEvent): void =>
    {
      e.preventDefault();
      this.handleEvent(e);
    }) as EventListener;
    (['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const).forEach(type =>
      canvas.addEventListener(type, this.handler, { passive: false }),
    );
  }

  /** Removes all touch event listeners. Call when the game is torn down. */
  destroy(): void
  {
    (['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const).forEach(type =>
      this.canvas.removeEventListener(type, this.handler),
    );
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Clears all active zone state and any pending tap. Called on rotate / resize. */
  reset(): void
  {
    this.left       = emptyZone();
    this.right      = emptyZone();
    this.pendingTap = null;
  }

  /** Returns the current input as boolean fields, compatible with InputSnapshot. */
  toInputSnapshot(): InputSnapshot
  {
    const leftDx  = this.left.active  ? this.left.currentX  - this.left.startX  : 0;
    const rightDy = this.right.active ? this.right.currentY - this.right.startY : 0;
    return {
      steerLeft:  this.left.active  && leftDx  < -TOUCH_DEADZONE,
      steerRight: this.left.active  && leftDx  >  TOUCH_DEADZONE,
      throttle:   this.right.active && rightDy < -TOUCH_DEADZONE,
      brake:      this.right.active && rightDy >  TOUCH_DEADZONE,
    };
  }

  /**
   * Consumes and returns one pending tap (canvas pixels), or null.
   * A tap is registered when touchend has |deltaX| < 15 && |deltaY| < 15 CSS px.
   * The 15 px threshold is wider than TOUCH_DEADZONE (10 px) to account for
   * the natural ~12 px finger lift drift during a quick tap.
   */
  consumeTap(): { x: number; y: number } | null
  {
    const tap       = this.pendingTap;
    this.pendingTap = null;
    return tap;
  }

  /**
   * Steer magnitude [0..1] for the left-zone pill highlight.
   * Returns 0 when the left zone is inactive or within deadzone.
   */
  steerMagnitude(): number
  {
    if (!this.left.active) return 0;
    const dx = this.left.currentX - this.left.startX;
    return Math.min(1, Math.max(0, (Math.abs(dx) - TOUCH_DEADZONE) / TOUCH_STEER_RANGE));
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /**
   * Converts a CSS-viewport touch position to canvas logical pixels.
   * On mobile the canvas CSS size === canvas logical size (1:1), but the
   * getBoundingClientRect path keeps this correct through any resize.
   */
  private touchToCanvas(clientX: number, clientY: number): { x: number; y: number }
  {
    const r      = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width  / r.width;
    const scaleY = this.canvas.height / r.height;
    return {
      x: (clientX - r.left) * scaleX,
      y: (clientY - r.top)  * scaleY,
    };
  }

  private handleEvent(e: TouchEvent): void
  {
    const type = e.type;
    const rect = this.canvas.getBoundingClientRect();
    const midX = rect.left + rect.width / 2;

    for (let i = 0; i < e.changedTouches.length; i++)
    {
      const t = e.changedTouches[i];

      if (type === 'touchstart')
      {
        // Assign this new touch to whichever half of the screen it landed on and
        // record its start position.  The assignment is permanent for this touch id —
        // crossing the midline during a drag never reassigns the zone.
        const zoneKey: 'left' | 'right' = t.clientX < midX ? 'left' : 'right';
        // Prevent a second simultaneous touch on the same side from hijacking the
        // already-active zone — the first finger's drag vector must not be reset.
        if (this[zoneKey].active) continue;   // zone occupied — ignore extra touches
        this[zoneKey] = {
          id:        t.identifier,
          startX:    t.clientX,
          startY:    t.clientY,
          currentX:  t.clientX,
          currentY:  t.clientY,
          active:    true,
          cancelled: false,
        };
      }
      else if (type === 'touchmove')
      {
        // Update the running position for whichever zone owns this touch id so
        // that toInputSnapshot() always reflects the latest finger position.
        if (this.left.active  && this.left.id  === t.identifier)
        {
          this.left.currentX  = t.clientX;
          this.left.currentY  = t.clientY;
        }
        if (this.right.active && this.right.id === t.identifier)
        {
          this.right.currentX = t.clientX;
          this.right.currentY = t.clientY;
        }
      }
      else if (type === 'touchend')
      {
        for (const zoneKey of ['left', 'right'] as const)
        {
          const slot = this[zoneKey];
          if (!slot.active || slot.id !== t.identifier) continue;

          if (!slot.cancelled)
          {
            // Use touchend position as the final position — coalesced fast drags
            // may fire no touchmove events, so slot.currentX could still equal
            // startX even if the finger travelled far.
            const dx = t.clientX - slot.startX;
            const dy = t.clientY - slot.startY;
            // Tap: minimal movement — synthesise a click at the lift position.
            // 15 px is wider than TOUCH_DEADZONE to forgive natural lift drift.
            // We use t.clientX/Y (the touchend coordinates) rather than the
            // cached slot.currentX/Y because the touch may have drifted slightly
            // between the last touchmove and lift; the final finger position is
            // the authoritative location for tap-target hit testing.
            if (Math.abs(dx) < 15 && Math.abs(dy) < 15)
              this.pendingTap = this.touchToCanvas(t.clientX, t.clientY);
          }
          this[zoneKey] = emptyZone();
        }
      }
      else if (type === 'touchcancel')
      {
        // System interrupt (incoming call, notification overlay, etc.) — release
        // the zone so the next touchstart can reclaim it.  A cancelled touch
        // never becomes a tap because the intent was interrupted mid-gesture.
        for (const zoneKey of ['left', 'right'] as const)
        {
          if (this[zoneKey].active && this[zoneKey].id === t.identifier)
            this[zoneKey] = emptyZone();
        }
      }
    }
  }
}
