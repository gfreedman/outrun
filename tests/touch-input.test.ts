/**
 * touch-input.test.ts
 *
 * Tests for TouchInput: zone assignment, snapshot, tap synthesis,
 * reset, and destroy (listener cleanup).
 *
 * Uses a minimal canvas stub — no browser / jsdom required.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TouchInput } from '../src/touch-input';
import { TOUCH_DEADZONE } from '../src/constants';

// ── Canvas stub ──────────────────────────────────────────────────────────────

interface Listener { type: string; handler: EventListener; }

function makeCanvas(width = 400, height = 300): HTMLCanvasElement & { _listeners: Listener[] }
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
      return { left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}) };
    },
  } as unknown as HTMLCanvasElement & { _listeners: Listener[] };
}

// ── Touch event helpers ───────────────────────────────────────────────────────

function makeTouch(id: number, clientX: number, clientY: number): Touch
{
  return { identifier: id, clientX, clientY } as Touch;
}

function dispatch(
  canvas: HTMLCanvasElement,
  type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel',
  touches: Touch[],
): void
{
  const event = { type, changedTouches: touches, preventDefault: () => {} } as unknown as TouchEvent;
  // Fire all matching listeners
  (canvas as ReturnType<typeof makeCanvas>)._listeners
    .filter(l => l.type === type)
    .forEach(l => l.handler(event as unknown as Event));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TouchInput', () =>
{
  let canvas: ReturnType<typeof makeCanvas>;
  let ti: TouchInput;

  beforeEach(() =>
  {
    canvas = makeCanvas(400, 300);
    ti     = new TouchInput(canvas as unknown as HTMLCanvasElement);
  });

  // ── Constructor registers 4 listeners ──────────────────────────────────────

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
  });

  it('assigns right zone for touch starting right of midpoint', () =>
  {
    dispatch(canvas, 'touchstart', [makeTouch(2, 350, 150)]);  // x=350, midX=200
    dispatch(canvas, 'touchmove',  [makeTouch(2, 350, 150 - TOUCH_DEADZONE - 1)]);
    const s = ti.toInputSnapshot();
    expect(s.throttle).toBe(true);
    expect(s.brake).toBe(false);
  });

  it('steerRight when left finger slides right past deadzone', () =>
  {
    dispatch(canvas, 'touchstart', [makeTouch(1, 100, 150)]);
    dispatch(canvas, 'touchmove',  [makeTouch(1, 100 + TOUCH_DEADZONE + 1, 150)]);
    const s = ti.toInputSnapshot();
    expect(s.steerRight).toBe(true);
    expect(s.steerLeft).toBe(false);
  });

  it('brake when right finger slides down past deadzone', () =>
  {
    dispatch(canvas, 'touchstart', [makeTouch(2, 300, 100)]);
    dispatch(canvas, 'touchmove',  [makeTouch(2, 300, 100 + TOUCH_DEADZONE + 1)]);
    const s = ti.toInputSnapshot();
    expect(s.brake).toBe(true);
    expect(s.throttle).toBe(false);
  });

  it('no action when drag is within deadzone', () =>
  {
    dispatch(canvas, 'touchstart', [makeTouch(1, 100, 150)]);
    dispatch(canvas, 'touchmove',  [makeTouch(1, 100 + TOUCH_DEADZONE - 1, 150)]);
    const s = ti.toInputSnapshot();
    expect(s.steerLeft).toBe(false);
    expect(s.steerRight).toBe(false);
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

  it('synthesises a tap for a minimal-movement touchend', () =>
  {
    dispatch(canvas, 'touchstart', [makeTouch(1, 100, 150)]);
    dispatch(canvas, 'touchend',   [makeTouch(1, 102, 151)]);  // < 15 px drift
    const tap = ti.consumeTap();
    expect(tap).not.toBeNull();
    expect(tap!.x).toBeCloseTo(102, 0);
    expect(tap!.y).toBeCloseTo(151, 0);
  });

  it('does not synthesise a tap when drag exceeds threshold', () =>
  {
    // Tap threshold checks slot.currentX (last touchmove), not the touchend position.
    // Must fire a touchmove to register the drift before the touchend.
    dispatch(canvas, 'touchstart', [makeTouch(1, 100, 150)]);
    dispatch(canvas, 'touchmove',  [makeTouch(1, 120, 150)]);  // 20 px drift recorded
    dispatch(canvas, 'touchend',   [makeTouch(1, 120, 150)]);
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

  // ── reset() ───────────────────────────────────────────────────────────────

  it('reset clears active zones and pending tap', () =>
  {
    dispatch(canvas, 'touchstart', [makeTouch(1, 50, 150)]);
    dispatch(canvas, 'touchstart', [makeTouch(1, 100, 148)]);  // register tap-start
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
