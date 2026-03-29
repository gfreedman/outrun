/**
 * touch-input.test.ts
 *
 * Tests for TouchInput: zone assignment, snapshot, tap synthesis,
 * reset, destroy (listener cleanup), steerMagnitude, and multi-touch.
 *
 * Uses a minimal canvas stub — no browser / jsdom required.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TouchInput } from '../src/touch-input';
import { TOUCH_DEADZONE, TOUCH_STEER_RANGE } from '../src/constants';

// ── Canvas stub ──────────────────────────────────────────────────────────────

interface Listener { type: string; handler: EventListener; }

interface CanvasStub extends Partial<HTMLCanvasElement>
{
  width:  number;
  height: number;
  _listeners: Listener[];
  _rectLeft:  number;
  _rectTop:   number;
}

function makeCanvas(
  width     = 400,
  height    = 300,
  rectLeft  = 0,
  rectTop   = 0,
  // CSS display size — defaults to logical size (1:1 DPR).
  // Set smaller than width/height to simulate retina / DPR scaling.
  rectWidth  = width,
  rectHeight = height,
): CanvasStub
{
  const listeners: Listener[] = [];
  return {
    width,
    height,
    _listeners:  listeners,
    _rectLeft:   rectLeft,
    _rectTop:    rectTop,
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

function makeTouch(id: number, clientX: number, clientY: number): Touch
{
  return { identifier: id, clientX, clientY } as Touch;
}

function dispatch(
  canvas: CanvasStub,
  type:   'touchstart' | 'touchmove' | 'touchend' | 'touchcancel',
  touches: Touch[],
): void
{
  const event = { type, changedTouches: touches, preventDefault: () => {} } as unknown as TouchEvent;
  canvas._listeners
    .filter(l => l.type === type)
    .forEach(l => l.handler(event as unknown as Event));
}

// Helper: create a TouchInput wired to a stub canvas
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
  let canvas: CanvasStub;
  let ti: TouchInput;

  beforeEach(() =>
  {
    ({ canvas, ti } = makeTI());
  });

  // ── Constructor ────────────────────────────────────────────────────────────

  it('registers 4 touch listeners on construction', () =>
  {
    expect(canvas._listeners).toHaveLength(4);
    const types = canvas._listeners.map(l => l.type).sort();
    expect(types).toEqual(['touchcancel', 'touchend', 'touchmove', 'touchstart']);
  });

  // ── Default snapshot ───────────────────────────────────────────────────────

  it('returns all-false snapshot when no touches are active', () =>
  {
    const s = ti.toInputSnapshot();
    expect(s).toEqual({ throttle: false, brake: false, steerLeft: false, steerRight: false });
  });

  // ── Zone assignment ────────────────────────────────────────────────────────

  it('assigns left zone for touch starting left of midpoint', () =>
  {
    dispatch(canvas, 'touchstart', [makeTouch(1, 50, 150)]);  // x=50, midX=200
    dispatch(canvas, 'touchmove',  [makeTouch(1, 50 - TOUCH_DEADZONE - 1, 150)]);
    const s = ti.toInputSnapshot();
    expect(s.steerLeft).toBe(true);
    expect(s.steerRight).toBe(false);
    // Cross-check: left-zone touch must not activate right-zone actions
    expect(s.throttle).toBe(false);
    expect(s.brake).toBe(false);
  });

  it('assigns right zone for touch starting right of midpoint', () =>
  {
    dispatch(canvas, 'touchstart', [makeTouch(2, 350, 150)]);  // x=350, midX=200
    dispatch(canvas, 'touchmove',  [makeTouch(2, 350, 150 - TOUCH_DEADZONE - 1)]);
    const s = ti.toInputSnapshot();
    expect(s.throttle).toBe(true);
    expect(s.brake).toBe(false);
    // Cross-check: right-zone touch must not activate left-zone actions
    expect(s.steerLeft).toBe(false);
    expect(s.steerRight).toBe(false);
  });

  it('steerRight when left finger slides right past deadzone', () =>
  {
    dispatch(canvas, 'touchstart', [makeTouch(1, 100, 150)]);
    dispatch(canvas, 'touchmove',  [makeTouch(1, 100 + TOUCH_DEADZONE + 1, 150)]);
    const s = ti.toInputSnapshot();
    expect(s.steerRight).toBe(true);
    expect(s.steerLeft).toBe(false);
    expect(s.throttle).toBe(false);
    expect(s.brake).toBe(false);
  });

  it('brake when right finger slides down past deadzone', () =>
  {
    dispatch(canvas, 'touchstart', [makeTouch(2, 300, 100)]);
    dispatch(canvas, 'touchmove',  [makeTouch(2, 300, 100 + TOUCH_DEADZONE + 1)]);
    const s = ti.toInputSnapshot();
    expect(s.brake).toBe(true);
    expect(s.throttle).toBe(false);
    expect(s.steerLeft).toBe(false);
    expect(s.steerRight).toBe(false);
  });

  it('no action when drag is within deadzone', () =>
  {
    dispatch(canvas, 'touchstart', [makeTouch(1, 100, 150)]);
    dispatch(canvas, 'touchmove',  [makeTouch(1, 100 + TOUCH_DEADZONE - 1, 150)]);
    const s = ti.toInputSnapshot();
    expect(s.steerLeft).toBe(false);
    expect(s.steerRight).toBe(false);
    expect(s.throttle).toBe(false);
    expect(s.brake).toBe(false);
  });

  it('no action when drag is exactly at deadzone boundary (strict inequality)', () =>
  {
    // Condition is leftDx > TOUCH_DEADZONE (strict), so exactly TOUCH_DEADZONE must be inactive.
    dispatch(canvas, 'touchstart', [makeTouch(1, 100, 150)]);
    dispatch(canvas, 'touchmove',  [makeTouch(1, 100 + TOUCH_DEADZONE, 150)]);
    const s = ti.toInputSnapshot();
    expect(s.steerRight).toBe(false);
    expect(s.steerLeft).toBe(false);
  });

  // ── Zone lock integrity ────────────────────────────────────────────────────

  it('zone stays locked to left even when finger crosses midpoint', () =>
  {
    // Touch starts left of midX=200; moves far past midpoint to x=250.
    // Must remain in left zone — producing steerRight (large positive dx), not throttle.
    dispatch(canvas, 'touchstart', [makeTouch(1, 50, 150)]);
    dispatch(canvas, 'touchmove',  [makeTouch(1, 250, 150)]);   // dx=+200, past midX
    const s = ti.toInputSnapshot();
    expect(s.steerRight).toBe(true);   // left zone, positive dx → steerRight
    expect(s.throttle).toBe(false);    // must NOT have been re-assigned to right zone
    expect(s.brake).toBe(false);
  });

  // ── Multi-touch ────────────────────────────────────────────────────────────

  it('both zones active simultaneously produce independent outputs', () =>
  {
    // Left touch steers left; right touch throttles — both at once.
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

    // Release left zone only
    dispatch(canvas, 'touchend', [makeTouch(1, 50 - TOUCH_DEADZONE - 5, 150)]);
    const s = ti.toInputSnapshot();
    expect(s.steerLeft).toBe(false);
    expect(s.throttle).toBe(true);   // right zone still active
  });

  it('ignores a third touchstart when both zones are already occupied', () =>
  {
    dispatch(canvas, 'touchstart', [makeTouch(1, 50,  150)]);   // takes left zone
    dispatch(canvas, 'touchstart', [makeTouch(2, 350, 150)]);   // takes right zone
    dispatch(canvas, 'touchmove',  [makeTouch(1, 50  - TOUCH_DEADZONE - 5, 150)]);
    dispatch(canvas, 'touchmove',  [makeTouch(2, 350, 150 - TOUCH_DEADZONE - 5)]);

    // Third touch on left side — zone is occupied, must be ignored
    dispatch(canvas, 'touchstart', [makeTouch(3, 80, 150)]);
    const s = ti.toInputSnapshot();
    expect(s.steerLeft).toBe(true);   // original touch still controls steering
    expect(s.throttle).toBe(true);    // right zone unchanged
  });

  // ── Touch ID matching ──────────────────────────────────────────────────────

  it('ignores touchmove with a mismatched touch ID', () =>
  {
    dispatch(canvas, 'touchstart', [makeTouch(1, 100, 150)]);
    // Spurious move event with wrong ID — state must not change
    dispatch(canvas, 'touchmove',  [makeTouch(99, 100 - TOUCH_DEADZONE - 10, 150)]);
    const s = ti.toInputSnapshot();
    expect(s.steerLeft).toBe(false);   // ID 99 should be silently ignored
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
    dispatch(canvas, 'touchstart', [makeTouch(2, 300, 100)]);
    dispatch(canvas, 'touchmove',  [makeTouch(2, 300, 100 - TOUCH_DEADZONE - 5)]);
    expect(ti.toInputSnapshot().throttle).toBe(true);
    dispatch(canvas, 'touchcancel', [makeTouch(2, 300, 100)]);
    expect(ti.toInputSnapshot().throttle).toBe(false);
  });

  // ── Tap synthesis ─────────────────────────────────────────────────────────

  it('synthesises a tap for a minimal-movement touchend (left zone)', () =>
  {
    dispatch(canvas, 'touchstart', [makeTouch(1, 100, 150)]);
    dispatch(canvas, 'touchend',   [makeTouch(1, 102, 151)]);  // < 15 px drift
    const tap = ti.consumeTap();
    expect(tap).not.toBeNull();
    expect(tap!.x).toBeCloseTo(102, 0);
    expect(tap!.y).toBeCloseTo(151, 0);
  });

  it('synthesises a tap for a minimal-movement touchend (right zone)', () =>
  {
    dispatch(canvas, 'touchstart', [makeTouch(2, 300, 150)]);
    dispatch(canvas, 'touchend',   [makeTouch(2, 302, 151)]);  // < 15 px drift
    const tap = ti.consumeTap();
    expect(tap).not.toBeNull();
    expect(tap!.x).toBeCloseTo(302, 0);
    expect(tap!.y).toBeCloseTo(151, 0);
  });

  it('does not synthesise a tap when drag exceeds threshold (no touchmove required)', () =>
  {
    // Tap check uses the touchend client position directly, so coalesced fast
    // drags (no touchmove fired) are correctly rejected.
    dispatch(canvas, 'touchstart', [makeTouch(1, 100, 150)]);
    dispatch(canvas, 'touchend',   [makeTouch(1, 120, 150)]);  // 20 px — no prior touchmove
    expect(ti.consumeTap()).toBeNull();
  });

  it('consumeTap clears the pending tap', () =>
  {
    dispatch(canvas, 'touchstart', [makeTouch(1, 100, 150)]);
    dispatch(canvas, 'touchend',   [makeTouch(1, 101, 150)]);
    expect(ti.consumeTap()).not.toBeNull();
    expect(ti.consumeTap()).toBeNull();  // consumed — should be gone
  });

  it('touchcancel does not synthesise a tap', () =>
  {
    dispatch(canvas, 'touchstart',  [makeTouch(1, 100, 150)]);
    dispatch(canvas, 'touchcancel', [makeTouch(1, 101, 150)]);
    expect(ti.consumeTap()).toBeNull();
  });

  // ── Tap coordinate transform ───────────────────────────────────────────────

  it('tap coords are transformed correctly when canvas has non-zero rect offset', () =>
  {
    // Canvas visually positioned at (100, 50) in the viewport.
    // touch at clientX=150 → canvas x = (150 - 100) * (400/400) = 50
    // touch at clientY=80  → canvas y = (80  -  50) * (300/300) = 30
    const { canvas: c2, ti: ti2 } = makeTI(400, 300, 100, 50);
    dispatch(c2, 'touchstart', [makeTouch(1, 150, 80)]);
    dispatch(c2, 'touchend',   [makeTouch(1, 151, 80)]);  // minimal drift — tap
    const tap = ti2.consumeTap();
    expect(tap).not.toBeNull();
    expect(tap!.x).toBeCloseTo(51, 0);   // (151 - 100) * 1
    expect(tap!.y).toBeCloseTo(30, 0);   // (80  -  50) * 1
  });

  it('tap coords are scaled correctly with DPR (canvas.width > rect.width)', () =>
  {
    // Retina-style: logical canvas 800×600 displayed in 400×300 CSS pixels → scaleX=2.
    // makeTI(logicalW, logicalH, rectLeft, rectTop, cssW, cssH)
    const { canvas: c2, ti: ti2 } = makeTI(800, 600, 0, 0, 400, 300);
    dispatch(c2, 'touchstart', [makeTouch(1, 100, 100)]);
    dispatch(c2, 'touchend',   [makeTouch(1, 101, 100)]);
    const tap = ti2.consumeTap();
    expect(tap).not.toBeNull();
    // scaleX = 800/400 = 2; tap x = (101 - 0) * 2 = 202
    expect(tap!.x).toBeCloseTo(202, 0);
    expect(tap!.y).toBeCloseTo(200, 0);  // (100 - 0) * (600/300) = 200
  });

  // ── steerMagnitude() ──────────────────────────────────────────────────────

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

  it('steerMagnitude returns 0 at exactly TOUCH_DEADZONE (clamped floor)', () =>
  {
    dispatch(canvas, 'touchstart', [makeTouch(1, 100, 150)]);
    dispatch(canvas, 'touchmove',  [makeTouch(1, 100 + TOUCH_DEADZONE, 150)]);
    // (TOUCH_DEADZONE - TOUCH_DEADZONE) / TOUCH_STEER_RANGE = 0
    expect(ti.steerMagnitude()).toBe(0);
  });

  it('steerMagnitude scales linearly between deadzone and full range', () =>
  {
    dispatch(canvas, 'touchstart', [makeTouch(1, 100, 150)]);
    // drag = TOUCH_DEADZONE + TOUCH_STEER_RANGE/2 → magnitude = 0.5
    dispatch(canvas, 'touchmove',  [makeTouch(1, 100 + TOUCH_DEADZONE + TOUCH_STEER_RANGE / 2, 150)]);
    expect(ti.steerMagnitude()).toBeCloseTo(0.5, 5);
  });

  it('steerMagnitude returns 1.0 at full TOUCH_STEER_RANGE', () =>
  {
    dispatch(canvas, 'touchstart', [makeTouch(1, 100, 150)]);
    dispatch(canvas, 'touchmove',  [makeTouch(1, 100 + TOUCH_DEADZONE + TOUCH_STEER_RANGE, 150)]);
    expect(ti.steerMagnitude()).toBe(1);
  });

  it('steerMagnitude is clamped to 1.0 beyond full range', () =>
  {
    dispatch(canvas, 'touchstart', [makeTouch(1, 100, 150)]);
    dispatch(canvas, 'touchmove',  [makeTouch(1, 100 + TOUCH_DEADZONE + TOUCH_STEER_RANGE + 50, 150)]);
    expect(ti.steerMagnitude()).toBe(1);
  });

  it('steerMagnitude is symmetric for leftward drag', () =>
  {
    dispatch(canvas, 'touchstart', [makeTouch(1, 100, 150)]);
    dispatch(canvas, 'touchmove',  [makeTouch(1, 100 - TOUCH_DEADZONE - TOUCH_STEER_RANGE / 2, 150)]);
    expect(ti.steerMagnitude()).toBeCloseTo(0.5, 5);
  });

  // ── reset() ───────────────────────────────────────────────────────────────

  it('reset clears active zones and pending tap', () =>
  {
    dispatch(canvas, 'touchstart', [makeTouch(1, 50, 150)]);
    ti.reset();
    expect(ti.toInputSnapshot()).toEqual({ throttle: false, brake: false, steerLeft: false, steerRight: false });
    expect(ti.consumeTap()).toBeNull();
  });

  // ── destroy() ─────────────────────────────────────────────────────────────

  it('destroy removes all 4 touch listeners', () =>
  {
    expect(canvas._listeners).toHaveLength(4);
    ti.destroy();
    expect(canvas._listeners).toHaveLength(0);
  });

  it('destroy uses the same handler reference registered at construction', () =>
  {
    ti.destroy();
    // After destroy, dispatching a touch event should not update state
    dispatch(canvas, 'touchstart', [makeTouch(1, 50, 150)]);
    dispatch(canvas, 'touchmove',  [makeTouch(1, 50 - TOUCH_DEADZONE - 5, 150)]);
    expect(ti.toInputSnapshot().steerLeft).toBe(false);
  });
});
