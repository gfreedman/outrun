/**
 * touch-input.test.ts
 *
 * Unit tests for the TouchInput class (src/touch-input.ts).
 *
 * ## What is being tested
 *
 * TouchInput implements a two-zone touch controller for mobile play:
 *
 *   Left zone  (clientX < canvas midpoint): horizontal drag → steer left/right
 *   Right zone (clientX ≥ canvas midpoint): vertical drag   → throttle/brake
 *
 * Key design invariants verified here:
 *   1. Zone assignment is determined once at touchstart and never re-evaluated,
 *      even if the finger crosses the midline during a drag.
 *   2. Each zone is identified by touch identifier, so spurious or unrelated
 *      touch events cannot corrupt the active zone's state.
 *   3. A touchend with ≤14 px total displacement synthesises a "tap" at the
 *      lift position — enabling menu interaction while in-game.
 *   4. Tap detection uses the touchend client position (not the last touchmove),
 *      so fast coalesced drags without touchmove events are correctly rejected.
 *   5. steerMagnitude() returns a [0..1] scalar from the left-zone drag
 *      distance, linearly scaled from TOUCH_DEADZONE to TOUCH_STEER_RANGE.
 *
 * ## Testing approach
 *
 * No browser / jsdom is required.  A lightweight canvas stub models only the
 * three HTMLCanvasElement APIs TouchInput actually calls:
 *   - addEventListener / removeEventListener  (listener tracking)
 *   - getBoundingClientRect                   (coordinate transform)
 *
 * Touch events are constructed as plain objects and dispatched synchronously
 * through the stub's listener list, which lets tests stay fast and deterministic.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TouchInput } from '../src/touch-input';
import { TOUCH_DEADZONE, TOUCH_STEER_RANGE } from '../src/constants';

// ── Canvas stub ───────────────────────────────────────────────────────────────
//
// Models only the subset of HTMLCanvasElement that TouchInput needs.
// Separating logicalWidth/Height (canvas.width/height) from cssWidth/Height
// (getBoundingClientRect().width/height) lets tests exercise the DPR-scaling
// path inside touchToCanvas() without a real browser.

interface Listener { type: string; handler: EventListener; }

interface CanvasStub extends Partial<HTMLCanvasElement>
{
  width:      number;
  height:     number;
  _listeners: Listener[];
}

/**
 * Creates a minimal canvas stub.
 *
 * @param width/height   - Logical canvas dimensions (canvas.width / .height).
 * @param rectLeft/Top   - Viewport offset of the canvas element (default 0,0).
 * @param rectWidth/Height - CSS display size; defaults to logical size (1:1 DPR).
 *                          Pass smaller than width/height to simulate retina scaling.
 */
function makeCanvas(
  width      = 400,
  height     = 300,
  rectLeft   = 0,
  rectTop    = 0,
  rectWidth  = width,
  rectHeight = height,
): CanvasStub
{
  const listeners: Listener[] = [];
  return {
    width,
    height,
    _listeners: listeners,
    addEventListener(type: string, handler: EventListener)
    {
      listeners.push({ type, handler });
    },
    removeEventListener(type: string, handler: EventListener)
    {
      const idx = listeners.findIndex(l => l.type === type && l.handler === handler);
      if (idx !== -1) listeners.splice(idx, 1);
    },
    getBoundingClientRect()
    {
      return {
        left:   rectLeft,
        top:    rectTop,
        width:  rectWidth,
        height: rectHeight,
        right:  rectLeft + rectWidth,
        bottom: rectTop  + rectHeight,
        x: rectLeft,
        y: rectTop,
        toJSON: () => ({}),
      } as DOMRect;
    },
  };
}

// ── Touch event helpers ───────────────────────────────────────────────────────

/** Creates a minimal Touch object with the fields TouchInput reads. */
function makeTouch(id: number, clientX: number, clientY: number): Touch
{
  return { identifier: id, clientX, clientY } as Touch;
}

/**
 * Synchronously dispatches a touch event through the stub's listener list.
 * Mirrors what the browser does: every registered listener for `type` is called.
 */
function dispatch(
  canvas:  CanvasStub,
  type:    'touchstart' | 'touchmove' | 'touchend' | 'touchcancel',
  touches: Touch[],
): void
{
  const event = { type, changedTouches: touches, preventDefault: () => {} } as unknown as TouchEvent;
  canvas._listeners
    .filter(l => l.type === type)
    .forEach(l => l.handler(event as unknown as Event));
}

/**
 * Convenience factory: returns a paired (canvas stub, TouchInput) ready for use.
 * Parameters mirror makeCanvas — see that function's JSDoc for details.
 */
function makeTI(
  width = 400, height = 300,
  rectLeft = 0, rectTop = 0,
  rectWidth = width, rectHeight = height,
)
{
  const canvas = makeCanvas(width, height, rectLeft, rectTop, rectWidth, rectHeight);
  const ti     = new TouchInput(canvas as unknown as HTMLCanvasElement);
  return { canvas, ti };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TouchInput', () =>
{
  // Shared instances re-created fresh before each test to prevent state leakage.
  let canvas: CanvasStub;
  let ti:     TouchInput;

  beforeEach(() => { ({ canvas, ti } = makeTI()); });

  // ── Construction ───────────────────────────────────────────────────────────
  // TouchInput must register all four touch event types so no event type is
  // silently missed (e.g. touchcancel is easy to forget but needed to clear
  // stale zones on system interrupts like incoming calls).

  it('registers exactly 4 touch listeners (start, move, end, cancel)', () =>
  {
    expect(canvas._listeners).toHaveLength(4);
    const types = canvas._listeners.map(l => l.type).sort();
    expect(types).toEqual(['touchcancel', 'touchend', 'touchmove', 'touchstart']);
  });

  // ── Default / idle snapshot ────────────────────────────────────────────────
  // With no touches active, all four InputSnapshot fields must be false so the
  // game loop reads no phantom input between sessions.

  it('returns all-false snapshot when no touches are active', () =>
  {
    expect(ti.toInputSnapshot()).toEqual(
      { throttle: false, brake: false, steerLeft: false, steerRight: false },
    );
  });

  // ── Zone assignment ────────────────────────────────────────────────────────
  // Zone (left vs right) is decided by comparing touchstart clientX to the
  // canvas midpoint.  The condition is strict less-than, so midX itself belongs
  // to the right zone (tested separately below).
  //
  // Cross-checks on all four snapshot fields catch mis-assignments where a
  // left-zone touch erroneously activates throttle/brake (or vice-versa).

  it('assigns left zone for touch starting left of midpoint', () =>
  {
    dispatch(canvas, 'touchstart', [makeTouch(1, 50, 150)]);   // x=50 < midX=200
    dispatch(canvas, 'touchmove',  [makeTouch(1, 50 - TOUCH_DEADZONE - 1, 150)]);
    const s = ti.toInputSnapshot();
    expect(s.steerLeft).toBe(true);
    expect(s.steerRight).toBe(false);
    expect(s.throttle).toBe(false);   // left-zone touch must not bleed into right-zone output
    expect(s.brake).toBe(false);
  });

  it('assigns right zone for touch starting right of midpoint', () =>
  {
    dispatch(canvas, 'touchstart', [makeTouch(2, 350, 150)]);   // x=350 > midX=200
    dispatch(canvas, 'touchmove',  [makeTouch(2, 350, 150 - TOUCH_DEADZONE - 1)]);
    const s = ti.toInputSnapshot();
    expect(s.throttle).toBe(true);
    expect(s.brake).toBe(false);
    expect(s.steerLeft).toBe(false);   // right-zone touch must not bleed into left-zone output
    expect(s.steerRight).toBe(false);
  });

  it('touch at exactly midX is assigned to right zone (strict < boundary)', () =>
  {
    // Zone condition: clientX < midX.  At exactly midX=200 the condition is
    // false, so the touch belongs to the right zone.  Verifies the boundary
    // is correctly one-sided.
    dispatch(canvas, 'touchstart', [makeTouch(1, 200, 150)]);   // exactly midX
    dispatch(canvas, 'touchmove',  [makeTouch(1, 200, 150 - TOUCH_DEADZONE - 1)]);  // slide up
    const s = ti.toInputSnapshot();
    expect(s.throttle).toBe(true);    // right zone: upward slide → throttle
    expect(s.steerLeft).toBe(false);
    expect(s.steerRight).toBe(false);
  });

  it('steerRight activates when left-zone finger slides right past deadzone', () =>
  {
    dispatch(canvas, 'touchstart', [makeTouch(1, 100, 150)]);
    dispatch(canvas, 'touchmove',  [makeTouch(1, 100 + TOUCH_DEADZONE + 1, 150)]);
    const s = ti.toInputSnapshot();
    expect(s.steerRight).toBe(true);
    expect(s.steerLeft).toBe(false);
    expect(s.throttle).toBe(false);
    expect(s.brake).toBe(false);
  });

  it('brake activates when right-zone finger slides down past deadzone', () =>
  {
    dispatch(canvas, 'touchstart', [makeTouch(2, 300, 100)]);
    dispatch(canvas, 'touchmove',  [makeTouch(2, 300, 100 + TOUCH_DEADZONE + 1)]);
    const s = ti.toInputSnapshot();
    expect(s.brake).toBe(true);
    expect(s.throttle).toBe(false);
    expect(s.steerLeft).toBe(false);
    expect(s.steerRight).toBe(false);
  });

  // ── Deadzone ───────────────────────────────────────────────────────────────
  // Small finger movements within TOUCH_DEADZONE px must produce no output —
  // this prevents jitter from a resting finger triggering unintended input.
  // The condition is strict (> TOUCH_DEADZONE), so exactly at the threshold
  // must also be inactive.

  it('produces no output when drag is within deadzone', () =>
  {
    dispatch(canvas, 'touchstart', [makeTouch(1, 100, 150)]);
    dispatch(canvas, 'touchmove',  [makeTouch(1, 100 + TOUCH_DEADZONE - 1, 150)]);
    expect(ti.toInputSnapshot()).toEqual(
      { throttle: false, brake: false, steerLeft: false, steerRight: false },
    );
  });

  it('produces no output when drag is exactly at deadzone boundary (strict >)', () =>
  {
    // Condition is leftDx > TOUCH_DEADZONE — exactly equal must remain inactive.
    dispatch(canvas, 'touchstart', [makeTouch(1, 100, 150)]);
    dispatch(canvas, 'touchmove',  [makeTouch(1, 100 + TOUCH_DEADZONE, 150)]);
    const s = ti.toInputSnapshot();
    expect(s.steerRight).toBe(false);
    expect(s.steerLeft).toBe(false);
  });

  // ── Zone lock integrity ────────────────────────────────────────────────────
  // Zone is locked at touchstart and must never change, even if the finger
  // physically crosses the screen midline.  This prevents control mode from
  // switching mid-gesture, which would be confusing and unsafe.

  it('zone stays locked to left even when finger crosses midpoint', () =>
  {
    // Touch starts at x=50 (left zone).  Finger moves to x=250 — past midX=200.
    // The zone must remain "left": the large positive dx produces steerRight,
    // NOT throttle (which would indicate a mis-assignment to the right zone).
    dispatch(canvas, 'touchstart', [makeTouch(1, 50, 150)]);
    dispatch(canvas, 'touchmove',  [makeTouch(1, 250, 150)]);   // dx=+200, past midX
    const s = ti.toInputSnapshot();
    expect(s.steerRight).toBe(true);   // left zone + positive dx → steerRight
    expect(s.throttle).toBe(false);    // must NOT have been re-assigned to right zone
    expect(s.brake).toBe(false);
  });

  // ── Multi-touch ────────────────────────────────────────────────────────────
  // Both zones can be active simultaneously (one finger steers, the other
  // controls throttle/brake).  Each zone's state is independent.

  it('both zones active simultaneously produce independent outputs', () =>
  {
    dispatch(canvas, 'touchstart', [makeTouch(1, 50,  150)]);   // left zone
    dispatch(canvas, 'touchstart', [makeTouch(2, 350, 150)]);   // right zone
    dispatch(canvas, 'touchmove',  [makeTouch(1, 50  - TOUCH_DEADZONE - 1, 150)]);
    dispatch(canvas, 'touchmove',  [makeTouch(2, 350, 150 - TOUCH_DEADZONE - 1)]);
    const s = ti.toInputSnapshot();
    expect(s.steerLeft).toBe(true);
    expect(s.throttle).toBe(true);
    expect(s.steerRight).toBe(false);
    expect(s.brake).toBe(false);
  });

  it('releasing one zone does not affect the other', () =>
  {
    dispatch(canvas, 'touchstart', [makeTouch(1, 50,  150)]);
    dispatch(canvas, 'touchstart', [makeTouch(2, 350, 150)]);
    dispatch(canvas, 'touchmove',  [makeTouch(1, 50  - TOUCH_DEADZONE - 5, 150)]);
    dispatch(canvas, 'touchmove',  [makeTouch(2, 350, 150 - TOUCH_DEADZONE - 5)]);

    dispatch(canvas, 'touchend', [makeTouch(1, 50 - TOUCH_DEADZONE - 5, 150)]);

    const s = ti.toInputSnapshot();
    expect(s.steerLeft).toBe(false);   // left zone released
    expect(s.throttle).toBe(true);     // right zone still active
  });

  it('third touchstart is ignored when both zones are already occupied', () =>
  {
    // The implementation skips touchstart for an occupied zone (`if active continue`).
    // A third finger must not overwrite or corrupt either active zone.
    dispatch(canvas, 'touchstart', [makeTouch(1, 50,  150)]);   // occupies left
    dispatch(canvas, 'touchstart', [makeTouch(2, 350, 150)]);   // occupies right
    dispatch(canvas, 'touchmove',  [makeTouch(1, 50  - TOUCH_DEADZONE - 5, 150)]);
    dispatch(canvas, 'touchmove',  [makeTouch(2, 350, 150 - TOUCH_DEADZONE - 5)]);

    dispatch(canvas, 'touchstart', [makeTouch(3, 80, 150)]);    // third finger — must be ignored
    const s = ti.toInputSnapshot();
    expect(s.steerLeft).toBe(true);   // original left touch unchanged
    expect(s.throttle).toBe(true);    // original right touch unchanged
  });

  // ── Touch ID matching ──────────────────────────────────────────────────────
  // touchmove events are matched by touch identifier, not by position.
  // A spurious event with an unknown ID must be silently dropped so that
  // system-generated or multi-finger events cannot corrupt active zone state.

  it('ignores touchmove with a mismatched touch ID', () =>
  {
    dispatch(canvas, 'touchstart', [makeTouch(1, 100, 150)]);
    dispatch(canvas, 'touchmove',  [makeTouch(99, 100 - TOUCH_DEADZONE - 10, 150)]);  // wrong ID
    const s = ti.toInputSnapshot();
    expect(s.steerLeft).toBe(false);   // ID 99 silently ignored; zone state unchanged
  });

  // ── Zone release ───────────────────────────────────────────────────────────

  it('clears zone on touchend', () =>
  {
    dispatch(canvas, 'touchstart', [makeTouch(1, 50, 150)]);
    dispatch(canvas, 'touchmove',  [makeTouch(1, 50 - TOUCH_DEADZONE - 5, 150)]);
    expect(ti.toInputSnapshot().steerLeft).toBe(true);

    dispatch(canvas, 'touchend', [makeTouch(1, 50 - TOUCH_DEADZONE - 5, 150)]);
    expect(ti.toInputSnapshot().steerLeft).toBe(false);
  });

  it('clears zone on touchcancel', () =>
  {
    // touchcancel fires on system interrupts (incoming call, notification, etc.).
    // The zone must be cleared so input doesn't get stuck in an active state.
    dispatch(canvas, 'touchstart', [makeTouch(2, 300, 100)]);
    dispatch(canvas, 'touchmove',  [makeTouch(2, 300, 100 - TOUCH_DEADZONE - 5)]);
    expect(ti.toInputSnapshot().throttle).toBe(true);

    dispatch(canvas, 'touchcancel', [makeTouch(2, 300, 100)]);
    expect(ti.toInputSnapshot().throttle).toBe(false);
  });

  // ── Tap synthesis ─────────────────────────────────────────────────────────
  // A short tap (lift within 14 px of touchstart) synthesises a mouse-click
  // equivalent so menu buttons respond to touch without extra tap-handling code.
  //
  // Threshold is 14 px (< 15) — wider than TOUCH_DEADZONE to forgive the
  // natural drift that occurs as a finger lifts off the screen.
  //
  // IMPORTANT: displacement is measured from touchstart to touchend client
  // position directly — NOT from the last touchmove.  This correctly rejects
  // fast coalesced drags where no touchmove events fired.

  it('synthesises a tap for a minimal-movement touchend (left zone)', () =>
  {
    dispatch(canvas, 'touchstart', [makeTouch(1, 100, 150)]);
    dispatch(canvas, 'touchend',   [makeTouch(1, 102, 151)]);   // 2 px drift — well within threshold
    const tap = ti.consumeTap();
    expect(tap).not.toBeNull();
    expect(tap!.x).toBeCloseTo(102, 0);
    expect(tap!.y).toBeCloseTo(151, 0);
  });

  it('synthesises a tap for a minimal-movement touchend (right zone)', () =>
  {
    // Tap synthesis applies to both zones; verify right zone is not excluded.
    dispatch(canvas, 'touchstart', [makeTouch(2, 300, 150)]);
    dispatch(canvas, 'touchend',   [makeTouch(2, 302, 151)]);
    const tap = ti.consumeTap();
    expect(tap).not.toBeNull();
    expect(tap!.x).toBeCloseTo(302, 0);
    expect(tap!.y).toBeCloseTo(151, 0);
  });

  it('does not synthesise a tap when drag exceeds 14 px (no touchmove required)', () =>
  {
    // Coalesced fast drag: no touchmove fires, finger lifts 20 px from start.
    // Must be rejected even though slot.currentX was never updated.
    dispatch(canvas, 'touchstart', [makeTouch(1, 100, 150)]);
    dispatch(canvas, 'touchend',   [makeTouch(1, 120, 150)]);   // 20 px — exceeds threshold
    expect(ti.consumeTap()).toBeNull();
  });

  it('consumeTap clears the pending tap so it is returned only once', () =>
  {
    dispatch(canvas, 'touchstart', [makeTouch(1, 100, 150)]);
    dispatch(canvas, 'touchend',   [makeTouch(1, 101, 150)]);
    expect(ti.consumeTap()).not.toBeNull();
    expect(ti.consumeTap()).toBeNull();   // already consumed
  });

  it('touchcancel does not synthesise a tap', () =>
  {
    // A cancelled touch (system interrupt) must never be treated as a tap —
    // the user did not intentionally lift their finger.
    dispatch(canvas, 'touchstart',  [makeTouch(1, 100, 150)]);
    dispatch(canvas, 'touchcancel', [makeTouch(1, 101, 150)]);
    expect(ti.consumeTap()).toBeNull();
  });

  // ── Tap coordinate transform ───────────────────────────────────────────────
  // touchToCanvas() converts browser client coordinates to canvas logical pixels
  // by subtracting the canvas rect offset and applying DPR scaling.
  // Tests use a non-zero rect offset and a 2× DPR stub to exercise both paths.

  it('tap coords subtract the canvas rect offset (canvas not at viewport origin)', () =>
  {
    // Canvas rect: left=100, top=50.  Touch at (150, 80).
    // Expected canvas coords: x = (150-100)*1 = 50, y = (80-50)*1 = 30.
    const { canvas: c2, ti: ti2 } = makeTI(400, 300, 100, 50);
    dispatch(c2, 'touchstart', [makeTouch(1, 150, 80)]);
    dispatch(c2, 'touchend',   [makeTouch(1, 151, 80)]);   // 1 px drift — tap
    const tap = ti2.consumeTap();
    expect(tap).not.toBeNull();
    expect(tap!.x).toBeCloseTo(51, 0);
    expect(tap!.y).toBeCloseTo(30, 0);
  });

  it('tap coords are scaled by the DPR ratio (canvas.width > rect.width)', () =>
  {
    // Logical canvas 800×600 displayed in 400×300 CSS pixels → scaleX=scaleY=2.
    // Touch at clientX=101 → canvas x = (101-0) * (800/400) = 202.
    const { canvas: c2, ti: ti2 } = makeTI(800, 600, 0, 0, 400, 300);
    dispatch(c2, 'touchstart', [makeTouch(1, 100, 100)]);
    dispatch(c2, 'touchend',   [makeTouch(1, 101, 100)]);   // 1 px drift — tap
    const tap = ti2.consumeTap();
    expect(tap).not.toBeNull();
    expect(tap!.x).toBeCloseTo(202, 0);   // (101-0) * 2
    expect(tap!.y).toBeCloseTo(200, 0);   // (100-0) * (600/300)
  });

  // ── steerMagnitude() ──────────────────────────────────────────────────────
  // Returns a [0..1] scalar for the left-zone drag so the renderer can scale
  // the steer arrow highlight.  Formula:
  //   clamp((|dx| - TOUCH_DEADZONE) / TOUCH_STEER_RANGE, 0, 1)
  //
  // This is separate from the boolean snapshot fields: the snapshot activates
  // at TOUCH_DEADZONE+1, while the magnitude scales continuously from 0 at
  // TOUCH_DEADZONE up to 1 at TOUCH_DEADZONE + TOUCH_STEER_RANGE.

  it('steerMagnitude returns 0 when left zone is inactive', () =>
  {
    expect(ti.steerMagnitude()).toBe(0);
  });

  it('steerMagnitude returns 0 when drag is within deadzone', () =>
  {
    dispatch(canvas, 'touchstart', [makeTouch(1, 100, 150)]);
    dispatch(canvas, 'touchmove',  [makeTouch(1, 100 + TOUCH_DEADZONE - 1, 150)]);
    expect(ti.steerMagnitude()).toBe(0);
  });

  it('steerMagnitude returns 0 at exactly TOUCH_DEADZONE', () =>
  {
    // (|dx| - TOUCH_DEADZONE) / TOUCH_STEER_RANGE = (10-10)/60 = 0.
    dispatch(canvas, 'touchstart', [makeTouch(1, 100, 150)]);
    dispatch(canvas, 'touchmove',  [makeTouch(1, 100 + TOUCH_DEADZONE, 150)]);
    expect(ti.steerMagnitude()).toBe(0);
  });

  it('steerMagnitude scales linearly to 0.5 at mid-range', () =>
  {
    dispatch(canvas, 'touchstart', [makeTouch(1, 100, 150)]);
    dispatch(canvas, 'touchmove',  [makeTouch(1, 100 + TOUCH_DEADZONE + TOUCH_STEER_RANGE / 2, 150)]);
    expect(ti.steerMagnitude()).toBeCloseTo(0.5, 5);
  });

  it('steerMagnitude returns exactly 1.0 at TOUCH_STEER_RANGE', () =>
  {
    dispatch(canvas, 'touchstart', [makeTouch(1, 100, 150)]);
    dispatch(canvas, 'touchmove',  [makeTouch(1, 100 + TOUCH_DEADZONE + TOUCH_STEER_RANGE, 150)]);
    expect(ti.steerMagnitude()).toBe(1);
  });

  it('steerMagnitude is clamped to 1.0 when drag exceeds TOUCH_STEER_RANGE', () =>
  {
    dispatch(canvas, 'touchstart', [makeTouch(1, 100, 150)]);
    dispatch(canvas, 'touchmove',  [makeTouch(1, 100 + TOUCH_DEADZONE + TOUCH_STEER_RANGE + 50, 150)]);
    expect(ti.steerMagnitude()).toBe(1);
  });

  it('steerMagnitude is symmetric for leftward drag', () =>
  {
    // |dx| is used, so left and right drags of equal distance produce equal magnitude.
    dispatch(canvas, 'touchstart', [makeTouch(1, 100, 150)]);
    dispatch(canvas, 'touchmove',  [makeTouch(1, 100 - TOUCH_DEADZONE - TOUCH_STEER_RANGE / 2, 150)]);
    expect(ti.steerMagnitude()).toBeCloseTo(0.5, 5);
  });

  // ── reset() ───────────────────────────────────────────────────────────────
  // Called on orientationchange and resize to discard any stale zone anchors.
  // After reset the controller must behave as if freshly constructed.

  it('reset clears active zones and any pending tap', () =>
  {
    dispatch(canvas, 'touchstart', [makeTouch(1, 50, 150)]);
    dispatch(canvas, 'touchmove',  [makeTouch(1, 50 - TOUCH_DEADZONE - 5, 150)]);
    expect(ti.toInputSnapshot().steerLeft).toBe(true);   // confirm zone was live before reset

    ti.reset();

    expect(ti.toInputSnapshot()).toEqual(
      { throttle: false, brake: false, steerLeft: false, steerRight: false },
    );
    expect(ti.consumeTap()).toBeNull();
  });

  // ── destroy() ─────────────────────────────────────────────────────────────
  // destroy() must remove all four listeners using the exact same handler
  // reference that was registered at construction — otherwise the browser's
  // removeEventListener call is a no-op and the listeners leak.

  it('destroy removes all 4 touch listeners', () =>
  {
    expect(canvas._listeners).toHaveLength(4);
    ti.destroy();
    expect(canvas._listeners).toHaveLength(0);
  });

  it('no touch events are processed after destroy', () =>
  {
    // After destroy the handler reference is unregistered.  Dispatching events
    // through the stub must not update any state (handler is not in the list).
    ti.destroy();
    dispatch(canvas, 'touchstart', [makeTouch(1, 50, 150)]);
    dispatch(canvas, 'touchmove',  [makeTouch(1, 50 - TOUCH_DEADZONE - 5, 150)]);
    expect(ti.toInputSnapshot().steerLeft).toBe(false);
  });
});
