/**
 * physics.test.ts
 *
 * Tests for the pure physics functions extracted from game.ts.
 *
 * Two contracts:
 *
 *   1. advancePhysics — pure tick update: throttle, brake, coast, steering,
 *      centrifugal, off-road, Barney boost, playerZ advance, grind decel.
 *
 *   2. applyCollisionResponse — pure collision response per CollisionClass:
 *      Ghost, Glance, Smack, Crunch, plus cross-cutting invariants
 *      (playerX clamp, speed floor).
 */

import { describe, it, expect } from 'vitest';
import {
  advancePhysics,
  applyCollisionResponse,
  applyTrafficHitResponse,
  PhysicsState,
  PhysicsConfig,
  InputSnapshot,
  StaticHitDescriptor,
  TrafficHitDescriptor,
} from '../src/physics';
import { CollisionClass } from '../src/types';
import {
  PLAYER_MAX_SPEED,
  SEGMENT_LENGTH,
  PLAYER_STEERING,
  BARNEY_BOOST_MULTIPLIER,
  HIT_CRUNCH_GRIND_DECEL,
  HIT_GLANCE_COOLDOWN,
  HIT_SMACK_SPEED_CAP,
  HIT_SMACK_RECOVERY_TIME,
  HIT_SMACK_RECOVERY_BOOST,
  HIT_CRUNCH_SPEED_CAP,
  HIT_CRUNCH_GRIND_TIME,
  HIT_CRUNCH_COOLDOWN,
  HIT_SPEED_FLOOR,
  SHAKE_GLANCE_DURATION,
  SHAKE_GLANCE_INTENSITY,
  SHAKE_SMACK_DURATION,
  SHAKE_SMACK_INTENSITY,
  SHAKE_CRUNCH_DURATION,
  SHAKE_CRUNCH_INTENSITY,
  HIT_CRUNCH_RECOVERY_TIME,
  HIT_CRUNCH_RECOVERY_BOOST,
  TRAFFIC_HIT_COOLDOWN,
  TRAFFIC_HIT_COOLDOWN_BOOSTING,
} from '../src/constants';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeState(overrides: Partial<PhysicsState> = {}): PhysicsState
{
  return {
    speed: 0, playerX: 0, playerZ: 0, steerAngle: 0, steerVelocity: 0, brakeHeld: 0,
    offRoad: false, offRoadRecovery: 1, slideVelocity: 0, jitterY: 0,
    hitCooldown: 0, grindTimer: 0, hitRecoveryTimer: 0, hitRecoveryBoost: 1,
    shakeTimer: 0, shakeIntensity: 0, barneyBoostTimer: 0, distanceTravelled: 0,
    ...overrides,
  };
}

function makeCfg(overrides: Partial<PhysicsConfig> = {}): PhysicsConfig
{
  return {
    maxSpeed: PLAYER_MAX_SPEED, accelMultiplier: 1,
    trackLength: 500 * SEGMENT_LENGTH, segmentCurve: 0,
    ...overrides,
  };
}

const NO_INPUT: InputSnapshot = { throttle: false, brake: false, steerLeft: false, steerRight: false };
const THROTTLE: InputSnapshot = { ...NO_INPUT, throttle: true };
const BRAKE:    InputSnapshot = { ...NO_INPUT, brake: true };

const DT = 1 / 60;   // one 60 fps frame

// ── advancePhysics — throttle ───────────────────────────────────────────────

describe('advancePhysics — throttle', () =>
{
  it('throttle from rest: speed increases after one tick', () =>
  {
    const { state } = advancePhysics(makeState(), THROTTLE, DT, makeCfg());
    expect(state.speed).toBeGreaterThan(0);
  });

  it('throttle from near-max (speedRatio=0.95): accel is less than at speedRatio=0.5', () =>
  {
    const stateHigh = makeState({ speed: PLAYER_MAX_SPEED * 0.95 });
    const stateMid  = makeState({ speed: PLAYER_MAX_SPEED * 0.5 });
    const { state: outHigh } = advancePhysics(stateHigh, THROTTLE, DT, makeCfg());
    const { state: outMid }  = advancePhysics(stateMid, THROTTLE, DT, makeCfg());
    const accelHigh = outHigh.speed - stateHigh.speed;
    const accelMid  = outMid.speed  - stateMid.speed;
    expect(accelHigh).toBeLessThan(accelMid);
  });

  it('throttle at exact maxSpeed: speed does not exceed maxSpeed', () =>
  {
    const st = makeState({ speed: PLAYER_MAX_SPEED });
    const { state } = advancePhysics(st, THROTTLE, DT, makeCfg());
    expect(state.speed).toBeLessThanOrEqual(PLAYER_MAX_SPEED);
  });

  it('no throttle, speed=0: speed stays 0', () =>
  {
    const { state } = advancePhysics(makeState(), NO_INPUT, DT, makeCfg());
    expect(state.speed).toBe(0);
  });
});

// ── advancePhysics — braking ────────────────────────────────────────────────

describe('advancePhysics — braking', () =>
{
  it('brake from speed=5000: speed decreases after one tick', () =>
  {
    const st = makeState({ speed: 5000 });
    const { state } = advancePhysics(st, BRAKE, DT, makeCfg());
    expect(state.speed).toBeLessThan(5000);
  });

  it('speed never goes negative under braking', () =>
  {
    const st = makeState({ speed: 10 });
    const { state } = advancePhysics(st, BRAKE, DT, makeCfg());
    expect(state.speed).toBeGreaterThanOrEqual(0);
  });

  it('brakeHeld increases each tick while braking', () =>
  {
    const st = makeState({ speed: 5000, brakeHeld: 0 });
    const { state } = advancePhysics(st, BRAKE, DT, makeCfg());
    expect(state.brakeHeld).toBeGreaterThan(0);
  });

  it('brakeHeld decays when not braking', () =>
  {
    const st = makeState({ speed: 5000, brakeHeld: 0.05 });
    const { state } = advancePhysics(st, NO_INPUT, DT, makeCfg());
    expect(state.brakeHeld).toBeLessThan(0.05);
  });
});

// ── advancePhysics — coasting ───────────────────────────────────────────────

describe('advancePhysics — coasting', () =>
{
  it('no input, speed=5000: speed decreases (coast friction)', () =>
  {
    const st = makeState({ speed: 5000 });
    const { state } = advancePhysics(st, NO_INPUT, DT, makeCfg());
    expect(state.speed).toBeLessThan(5000);
  });

  it('no input, speed=0: speed stays 0', () =>
  {
    const { state } = advancePhysics(makeState(), NO_INPUT, DT, makeCfg());
    expect(state.speed).toBe(0);
  });
});

// ── advancePhysics — steering ───────────────────────────────────────────────

describe('advancePhysics — steering', () =>
{
  it('steerLeft at speed=0: playerX unchanged (no movement when stopped)', () =>
  {
    const steerLeft: InputSnapshot = { ...NO_INPUT, steerLeft: true };
    const { state } = advancePhysics(makeState(), steerLeft, DT, makeCfg());
    expect(state.playerX).toBe(0);
  });

  it('steerLeft at speed=5000: playerX moves left', () =>
  {
    const steerLeft: InputSnapshot = { ...NO_INPUT, steerLeft: true };
    const st = makeState({ speed: 5000 });
    const { state } = advancePhysics(st, steerLeft, DT, makeCfg());
    expect(state.playerX).toBeLessThan(0);
  });

  it('steerRight at speed=5000: playerX moves right', () =>
  {
    const steerRight: InputSnapshot = { ...NO_INPUT, steerRight: true };
    const st = makeState({ speed: 5000 });
    const { state } = advancePhysics(st, steerRight, DT, makeCfg());
    expect(state.playerX).toBeGreaterThan(0);
  });

  it('playerX is clamped to [-2, +2]', () =>
  {
    const steerRight: InputSnapshot = { ...NO_INPUT, steerRight: true };
    const st = makeState({ speed: 5000, playerX: 1.99 });
    // Run many ticks to push past boundary
    let current = st;
    for (let i = 0; i < 100; i++)
    {
      const { state } = advancePhysics(current, steerRight, DT, makeCfg());
      current = state;
    }
    expect(current.playerX).toBeLessThanOrEqual(2);

    const steerLeft: InputSnapshot = { ...NO_INPUT, steerLeft: true };
    let currentL = makeState({ speed: 5000, playerX: -1.99 });
    for (let i = 0; i < 100; i++)
    {
      const { state } = advancePhysics(currentL, steerLeft, DT, makeCfg());
      currentL = state;
    }
    expect(currentL.playerX).toBeGreaterThanOrEqual(-2);
  });

  it('high speed = less lateral movement per tick than low speed (grip reduction)', () =>
  {
    const steerLeft: InputSnapshot = { ...NO_INPUT, steerLeft: true };
    const stLow  = makeState({ speed: PLAYER_MAX_SPEED * 0.2 });
    const stHigh = makeState({ speed: PLAYER_MAX_SPEED * 0.95 });
    const { state: outLow }  = advancePhysics(stLow, steerLeft, DT, makeCfg());
    const { state: outHigh } = advancePhysics(stHigh, steerLeft, DT, makeCfg());
    const moveLow  = Math.abs(outLow.playerX - stLow.playerX);
    const moveHigh = Math.abs(outHigh.playerX - stHigh.playerX);
    expect(moveHigh).toBeLessThan(moveLow);
  });
});

// ── advancePhysics — centrifugal ────────────────────────────────────────────

describe('advancePhysics — centrifugal', () =>
{
  it('positive segmentCurve at speed>0: playerX decreases (pushed outward on left curve)', () =>
  {
    const st = makeState({ speed: 5000 });
    const cfg = makeCfg({ segmentCurve: 4 });
    const { state } = advancePhysics(st, NO_INPUT, DT, cfg);
    // Centrifugal pushes playerX in negative direction for positive curve
    expect(state.playerX).toBeLessThan(0);
  });

  it('zero segmentCurve: no centrifugal effect', () =>
  {
    // Start at a non-zero position so any spurious centrifugal force would be detectable.
    // (Starting at 0 would be vacuous: curve*0 = 0 regardless of the formula.)
    const st = makeState({ speed: 5000, playerX: 0.4 });
    const cfg = makeCfg({ segmentCurve: 0 });
    const { state } = advancePhysics(st, NO_INPUT, DT, cfg);
    // No steering, no slide, no centrifugal — playerX must stay exactly where it started.
    expect(state.playerX).toBe(0.4);
  });
});

// ── advancePhysics — off-road ───────────────────────────────────────────────

describe('advancePhysics — off-road', () =>
{
  it('|playerX| > 1 -> offRoad becomes true', () =>
  {
    const st = makeState({ speed: 5000, playerX: 1.5 });
    const { state } = advancePhysics(st, NO_INPUT, DT, makeCfg());
    expect(state.offRoad).toBe(true);
  });

  it('|playerX| <= 1 -> offRoad becomes false', () =>
  {
    const st = makeState({ speed: 5000, playerX: 0.5, offRoad: true });
    const { state } = advancePhysics(st, NO_INPUT, DT, makeCfg());
    expect(state.offRoad).toBe(false);
  });

  it('off-road + throttle: speed capped at off-road limit', () =>
  {
    const st = makeState({ speed: PLAYER_MAX_SPEED * 0.8, playerX: 1.5 });
    // Run several ticks to let off-road decel take effect
    let current = st;
    for (let i = 0; i < 60; i++)
    {
      const { state } = advancePhysics(current, THROTTLE, DT, makeCfg());
      current = state;
    }
    // Speed should be significantly reduced from initial
    expect(current.speed).toBeLessThan(PLAYER_MAX_SPEED * 0.8);
  });

  it('on-road: no speed cap from off-road', () =>
  {
    const st = makeState({ speed: PLAYER_MAX_SPEED * 0.8, playerX: 0 });
    const { state } = advancePhysics(st, THROTTLE, DT, makeCfg());
    // Should be able to accelerate freely
    expect(state.speed).toBeGreaterThan(PLAYER_MAX_SPEED * 0.8);
  });
});

// ── advancePhysics — Barney boost ───────────────────────────────────────────

describe('advancePhysics — Barney boost', () =>
{
  it('barneyBoostTimer > 0: speed can exceed maxSpeed (up to maxSpeed * BARNEY_BOOST_MULTIPLIER)', () =>
  {
    const st = makeState({ speed: PLAYER_MAX_SPEED * 1.1, barneyBoostTimer: 2.0 });
    const { state } = advancePhysics(st, THROTTLE, DT, makeCfg());
    // Speed should be allowed above maxSpeed
    expect(state.speed).toBeGreaterThan(PLAYER_MAX_SPEED);
    expect(state.speed).toBeLessThanOrEqual(PLAYER_MAX_SPEED * BARNEY_BOOST_MULTIPLIER);
  });

  it('barneyBoostTimer <= 0: speed hard-capped at maxSpeed', () =>
  {
    // Start above maxSpeed with no boost — should be capped
    const st = makeState({ speed: PLAYER_MAX_SPEED * 1.1, barneyBoostTimer: 0 });
    const { state } = advancePhysics(st, THROTTLE, DT, makeCfg());
    expect(state.speed).toBeLessThanOrEqual(PLAYER_MAX_SPEED);
  });
});

// ── advancePhysics — playerZ advance ────────────────────────────────────────

describe('advancePhysics — playerZ advance', () =>
{
  const trackLength = 500 * SEGMENT_LENGTH;

  it('with speed > 0: playerZ increases by speed * dt', () =>
  {
    const st = makeState({ speed: 5000 });
    const { state } = advancePhysics(st, NO_INPUT, DT, makeCfg());
    // playerZ should increase (approximately speed * dt, but speed also changes from coasting)
    expect(state.playerZ).toBeGreaterThan(0);
  });

  it('playerZ wraps modulo trackLength', () =>
  {
    const st = makeState({ speed: 5000, playerZ: trackLength - 10 });
    const { state } = advancePhysics(st, NO_INPUT, DT, makeCfg());
    // Should have wrapped
    expect(state.playerZ).toBeLessThan(trackLength);
    expect(state.playerZ).toBeGreaterThanOrEqual(0);
  });

  it('distanceTravelled always increases (never wraps)', () =>
  {
    const st = makeState({ speed: 5000, playerZ: trackLength - 10, distanceTravelled: 100000 });
    const { state } = advancePhysics(st, NO_INPUT, DT, makeCfg());
    expect(state.distanceTravelled).toBeGreaterThan(100000);
  });
});

// ── advancePhysics — timer countdowns ────────────────────────────────────────
//
// advancePhysics is the single owner of all player timer decrements.
// Every timer must tick by dt each frame and floor at 0 — never go negative.

describe('advancePhysics — timer countdowns', () =>
{
  it('barneyBoostTimer decrements by dt', () =>
  {
    const st = makeState({ barneyBoostTimer: 0.5 });
    const { state } = advancePhysics(st, NO_INPUT, DT, makeCfg());
    expect(state.barneyBoostTimer).toBeCloseTo(0.5 - DT, 5);
  });

  it('barneyBoostTimer floors at 0 (never negative)', () =>
  {
    const st = makeState({ barneyBoostTimer: DT * 0.1 });
    const { state } = advancePhysics(st, NO_INPUT, DT, makeCfg());
    expect(state.barneyBoostTimer).toBe(0);
  });

  it('hitCooldown decrements by dt', () =>
  {
    const st = makeState({ hitCooldown: 1.0 });
    const { state } = advancePhysics(st, NO_INPUT, DT, makeCfg());
    expect(state.hitCooldown).toBeCloseTo(1.0 - DT, 5);
  });

  it('hitCooldown floors at 0', () =>
  {
    const st = makeState({ hitCooldown: DT * 0.1 });
    const { state } = advancePhysics(st, NO_INPUT, DT, makeCfg());
    expect(state.hitCooldown).toBe(0);
  });

  it('grindTimer decrements by dt', () =>
  {
    const st = makeState({ grindTimer: 1.0 });
    const { state } = advancePhysics(st, NO_INPUT, DT, makeCfg());
    expect(state.grindTimer).toBeCloseTo(1.0 - DT, 5);
  });

  it('grindTimer floors at 0', () =>
  {
    const st = makeState({ grindTimer: DT * 0.1 });
    const { state } = advancePhysics(st, NO_INPUT, DT, makeCfg());
    expect(state.grindTimer).toBe(0);
  });

  it('hitRecoveryTimer decrements by dt', () =>
  {
    const st = makeState({ hitRecoveryTimer: 1.0 });
    const { state } = advancePhysics(st, NO_INPUT, DT, makeCfg());
    expect(state.hitRecoveryTimer).toBeCloseTo(1.0 - DT, 5);
  });

  it('shakeTimer decrements by dt', () =>
  {
    const st = makeState({ shakeTimer: 1.0 });
    const { state } = advancePhysics(st, NO_INPUT, DT, makeCfg());
    expect(state.shakeTimer).toBeCloseTo(1.0 - DT, 5);
  });

  it('all 5 timers reach exactly 0 within their natural duration (62-tick simulation)', () =>
  {
    // Start all at 1.0 s; 62 ticks at 60 fps = ~1.033 s — well past expiry.
    let st = makeState({
      barneyBoostTimer: 1.0, hitCooldown: 1.0, grindTimer: 1.0,
      hitRecoveryTimer: 1.0, shakeTimer: 1.0,
    });
    for (let i = 0; i < 62; i++)
    {
      const { state } = advancePhysics(st, NO_INPUT, DT, makeCfg());
      st = state;
    }
    expect(st.barneyBoostTimer).toBe(0);
    expect(st.hitCooldown).toBe(0);
    expect(st.grindTimer).toBe(0);
    expect(st.hitRecoveryTimer).toBe(0);
    expect(st.shakeTimer).toBe(0);
  });
});

// ── advancePhysics — grind decel ─────────────────────────────────────────────
//
// When grindTimer > dt (still active after this tick's decrement), the car
// decelerates by HIT_CRUNCH_GRIND_DECEL per second on top of normal coasting.
// When the timer expires this tick (grindTimer <= dt → floors to 0), decel
// is NOT applied because the guard fires on the post-decrement value.

describe('advancePhysics — grind decel', () =>
{
  it('grindTimer >> dt: speed decreases more than coasting alone', () =>
  {
    const stGrind   = makeState({ speed: 5000, grindTimer: 1.0 });
    const stNoGrind = makeState({ speed: 5000, grindTimer: 0   });
    const { state: withGrind }    = advancePhysics(stGrind,   NO_INPUT, DT, makeCfg());
    const { state: withoutGrind } = advancePhysics(stNoGrind, NO_INPUT, DT, makeCfg());
    expect(withGrind.speed).toBeLessThan(withoutGrind.speed);
  });

  it('grindTimer = 0: no extra decel beyond coasting', () =>
  {
    const st    = makeState({ speed: 5000, grindTimer: 0 });
    const stRef = makeState({ speed: 5000 });
    const { state: out }    = advancePhysics(st,    NO_INPUT, DT, makeCfg());
    const { state: outRef } = advancePhysics(stRef, NO_INPUT, DT, makeCfg());
    expect(out.speed).toBeCloseTo(outRef.speed, 1);
  });

  it('grindTimer expires exactly this tick (grindTimer < dt): decel NOT applied', () =>
  {
    // Timer tiny enough to floor to 0 — the `if (grindTimer > 0)` guard is false.
    const stExpiring = makeState({ speed: 5000, grindTimer: DT * 0.5 });
    const stZero     = makeState({ speed: 5000, grindTimer: 0         });
    const { state: outExpiring } = advancePhysics(stExpiring, NO_INPUT, DT, makeCfg());
    const { state: outZero }     = advancePhysics(stZero,     NO_INPUT, DT, makeCfg());
    expect(outExpiring.speed).toBeCloseTo(outZero.speed, 1);
  });
});

// ── advancePhysics — hitRecoveryBoost reset ──────────────────────────────────

describe('advancePhysics — hitRecoveryBoost reset', () =>
{
  it('hitRecoveryTimer > dt: hitRecoveryBoost preserved', () =>
  {
    const boost = 1.5;
    const st = makeState({ hitRecoveryTimer: 1.0, hitRecoveryBoost: boost });
    const { state } = advancePhysics(st, NO_INPUT, DT, makeCfg());
    expect(state.hitRecoveryBoost).toBe(boost);
  });

  it('hitRecoveryTimer expires this tick: hitRecoveryBoost resets to 1.0', () =>
  {
    const st = makeState({ hitRecoveryTimer: DT * 0.1, hitRecoveryBoost: 1.5 });
    const { state } = advancePhysics(st, NO_INPUT, DT, makeCfg());
    expect(state.hitRecoveryTimer).toBe(0);
    expect(state.hitRecoveryBoost).toBe(1.0);
  });

  it('hitRecoveryTimer already 0: hitRecoveryBoost stays 1.0 (idempotent)', () =>
  {
    const st = makeState({ hitRecoveryTimer: 0, hitRecoveryBoost: 1.0 });
    const { state } = advancePhysics(st, NO_INPUT, DT, makeCfg());
    expect(state.hitRecoveryBoost).toBe(1.0);
  });
});

// ── advancePhysics — shake jitter ────────────────────────────────────────────

describe('advancePhysics — shake jitter', () =>
{
  it('shakeTimer > dt and nonzero intensity: |jitterY| > 0 in at least one of 20 trials', () =>
  {
    // Probabilistic: Math.random() could theoretically produce exactly 0.5,
    // but P(all 20 trials zero) is effectively 0 for any nonzero intensity.
    const st = makeState({ shakeTimer: 1.0, shakeIntensity: 10 });
    let nonZeroSeen = false;
    for (let i = 0; i < 20; i++)
    {
      const { state } = advancePhysics(st, NO_INPUT, DT, makeCfg());
      if (Math.abs(state.jitterY) > 0) { nonZeroSeen = true; break; }
    }
    expect(nonZeroSeen).toBe(true);
  });

  it('shakeTimer = 0: jitterY decays toward 0 (not overwritten by shake noise)', () =>
  {
    // On-road, shakeTimer off — jitterY should decay exponentially, not stay large.
    const st = makeState({ shakeTimer: 0, shakeIntensity: 10, jitterY: 5, playerX: 0 });
    const { state } = advancePhysics(st, NO_INPUT, DT, makeCfg());
    expect(Math.abs(state.jitterY)).toBeLessThan(5);
  });

  it('shakeTimer expires this tick: jitterY NOT set to shake noise (guard false)', () =>
  {
    // shakeTimer tiny → floors to 0 → guard false → off-road decay path runs instead.
    // Jitter should decay, not spike to intensity range.
    const st = makeState({ shakeTimer: DT * 0.1, shakeIntensity: 100, jitterY: 1, playerX: 0 });
    const { state } = advancePhysics(st, NO_INPUT, DT, makeCfg());
    // If shake had fired, jitterY would be up to ±100.  Decay gives ≈ 0.98.
    expect(Math.abs(state.jitterY)).toBeLessThan(10);
  });
});

// ── advancePhysics — offRoadRecovery ─────────────────────────────────────────

describe('advancePhysics — offRoadRecovery', () =>
{
  it('on-road: offRoadRecovery increases toward 1', () =>
  {
    const st = makeState({ speed: 5000, playerX: 0, offRoadRecovery: 0.3 });
    const { state } = advancePhysics(st, NO_INPUT, DT, makeCfg());
    expect(state.offRoadRecovery).toBeGreaterThan(0.3);
    expect(state.offRoadRecovery).toBeLessThanOrEqual(1);
  });

  it('off-road: offRoadRecovery resets to 0', () =>
  {
    const st = makeState({ speed: 5000, playerX: 1.5, offRoadRecovery: 0.8 });
    const { state } = advancePhysics(st, NO_INPUT, DT, makeCfg());
    expect(state.offRoadRecovery).toBe(0);
  });

  it('offRoadRecovery does not exceed 1', () =>
  {
    const st = makeState({ speed: 5000, playerX: 0, offRoadRecovery: 1.0 });
    const { state } = advancePhysics(st, NO_INPUT, DT, makeCfg());
    expect(state.offRoadRecovery).toBeLessThanOrEqual(1.0);
  });
});

// ── advancePhysics — screechRatio ────────────────────────────────────────────

describe('advancePhysics — screechRatio', () =>
{
  it('fast curve (HARD, speedRatio=0.8): screechRatio > 0', () =>
  {
    const st  = makeState({ speed: PLAYER_MAX_SPEED * 0.8 });
    const cfg = makeCfg({ segmentCurve: 6 });   // ROAD_CURVE.HARD
    const { screechRatio } = advancePhysics(st, NO_INPUT, DT, cfg);
    expect(screechRatio).toBeGreaterThan(0);
  });

  it('straight road (segmentCurve = 0): screechRatio = 0', () =>
  {
    const st  = makeState({ speed: PLAYER_MAX_SPEED * 0.8 });
    const cfg = makeCfg({ segmentCurve: 0 });
    const { screechRatio } = advancePhysics(st, NO_INPUT, DT, cfg);
    expect(screechRatio).toBe(0);
  });

  it('low speed (speedRatio <= 0.4) on hard curve: screechRatio = 0', () =>
  {
    const st  = makeState({ speed: PLAYER_MAX_SPEED * 0.3 });
    const cfg = makeCfg({ segmentCurve: 6 });
    const { screechRatio } = advancePhysics(st, NO_INPUT, DT, cfg);
    expect(screechRatio).toBe(0);
  });
});

// ── advancePhysics — steerAngle (visual) ─────────────────────────────────────

describe('advancePhysics — steerAngle', () =>
{
  it('steerLeft: steerAngle moves negative', () =>
  {
    const steerLeft: InputSnapshot = { ...NO_INPUT, steerLeft: true };
    const st = makeState({ speed: 5000, steerAngle: 0 });
    const { state } = advancePhysics(st, steerLeft, DT, makeCfg());
    expect(state.steerAngle).toBeLessThan(0);
  });

  it('steerRight: steerAngle moves positive', () =>
  {
    const steerRight: InputSnapshot = { ...NO_INPUT, steerRight: true };
    const st = makeState({ speed: 5000, steerAngle: 0 });
    const { state } = advancePhysics(st, steerRight, DT, makeCfg());
    expect(state.steerAngle).toBeGreaterThan(0);
  });

  it('no steer input: steerAngle decays toward 0', () =>
  {
    const st = makeState({ speed: 5000, steerAngle: 0.5 });
    const { state } = advancePhysics(st, NO_INPUT, DT, makeCfg());
    expect(Math.abs(state.steerAngle)).toBeLessThan(0.5);
  });

  it('steerAngle is clamped to [-1, +1]', () =>
  {
    const steerLeft: InputSnapshot = { ...NO_INPUT, steerLeft: true };
    let current = makeState({ speed: 5000, steerAngle: -0.99 });
    for (let i = 0; i < 20; i++)
    {
      const { state } = advancePhysics(current, steerLeft, DT, makeCfg());
      current = state;
    }
    expect(current.steerAngle).toBeGreaterThanOrEqual(-1);
  });
});

// ── applyCollisionResponse — bumpDir → slideVelocity direction ───────────────

describe('applyCollisionResponse — bumpDir → slideVelocity direction', () =>
{
  /**
   * bumpDir = +1 means the obstacle is to the RIGHT of the player, so the car
   * bounces LEFT.  bumpSign = -bumpDir = -1, so slideVelocity < 0 (leftward).
   */
  it('Smack bumpDir=+1: slideVelocity < 0 (pushed left)', () =>
  {
    const st  = makeState({ speed: 5000, playerX: 0.8, steerAngle: 0 });
    const hit: StaticHitDescriptor = { cls: CollisionClass.Smack, bumpDir: +1 };
    const result = applyCollisionResponse(st, hit, PLAYER_MAX_SPEED);
    expect(result.slideVelocity).toBeLessThan(0);
  });

  it('Smack bumpDir=-1: slideVelocity > 0 (pushed right)', () =>
  {
    const st  = makeState({ speed: 5000, playerX: -0.8, steerAngle: 0 });
    const hit: StaticHitDescriptor = { cls: CollisionClass.Smack, bumpDir: -1 };
    const result = applyCollisionResponse(st, hit, PLAYER_MAX_SPEED);
    expect(result.slideVelocity).toBeGreaterThan(0);
  });

  it('Crunch bumpDir=+1: slideVelocity < 0 (pushed left)', () =>
  {
    const st  = makeState({ speed: 5000, playerX: 0.8, steerAngle: 0 });
    const hit: StaticHitDescriptor = { cls: CollisionClass.Crunch, bumpDir: +1 };
    const result = applyCollisionResponse(st, hit, PLAYER_MAX_SPEED);
    expect(result.slideVelocity).toBeLessThan(0);
  });

  it('Crunch bumpDir=-1: slideVelocity > 0 (pushed right)', () =>
  {
    const st  = makeState({ speed: 5000, playerX: -0.8, steerAngle: 0 });
    const hit: StaticHitDescriptor = { cls: CollisionClass.Crunch, bumpDir: -1 };
    const result = applyCollisionResponse(st, hit, PLAYER_MAX_SPEED);
    expect(result.slideVelocity).toBeGreaterThan(0);
  });
});

// ── applyCollisionResponse — immutability ────────────────────────────────────

describe('applyCollisionResponse — immutability', () =>
{
  it('does not mutate the input state object', () =>
  {
    const st = makeState({ speed: 5000, playerX: 0.8 });
    const frozen = { ...st };
    const hit: StaticHitDescriptor = { cls: CollisionClass.Crunch, bumpDir: +1 };
    applyCollisionResponse(st, hit, PLAYER_MAX_SPEED);
    expect(st).toEqual(frozen);
  });
});

// ── advancePhysics — integration (multi-tick simulation) ─────────────────────

describe('advancePhysics — integration (60-tick simulation)', () =>
{
  it('speed stays in [0, maxSpeed] over 60 full-throttle ticks', () =>
  {
    let st = makeState({ speed: 0 });
    for (let i = 0; i < 60; i++)
    {
      const { state } = advancePhysics(st, THROTTLE, DT, makeCfg());
      st = state;
      expect(st.speed).toBeGreaterThanOrEqual(0);
      expect(st.speed).toBeLessThanOrEqual(PLAYER_MAX_SPEED);
    }
  });

  it('playerZ advances and stays in [0, trackLength) over 60 ticks', () =>
  {
    const trackLength = 500 * SEGMENT_LENGTH;
    let st = makeState({ speed: PLAYER_MAX_SPEED * 0.8 });
    for (let i = 0; i < 60; i++)
    {
      const { state } = advancePhysics(st, NO_INPUT, DT, makeCfg());
      st = state;
      expect(st.playerZ).toBeGreaterThanOrEqual(0);
      expect(st.playerZ).toBeLessThan(trackLength);
    }
  });

  it('playerX stays in [-2, +2] with hard steerRight over 60 ticks', () =>
  {
    const steerRight: InputSnapshot = { ...NO_INPUT, steerRight: true };
    let st = makeState({ speed: PLAYER_MAX_SPEED * 0.8, playerX: 0 });
    for (let i = 0; i < 60; i++)
    {
      const { state } = advancePhysics(st, steerRight, DT, makeCfg());
      st = state;
      expect(st.playerX).toBeLessThanOrEqual(2);
      expect(st.playerX).toBeGreaterThanOrEqual(-2);
    }
  });

  it('distanceTravelled strictly increases (never wraps with playerZ)', () =>
  {
    const trackLength = 500 * SEGMENT_LENGTH;
    // Start near end of track so playerZ wraps
    let st = makeState({ speed: PLAYER_MAX_SPEED * 0.8, playerZ: trackLength - 10, distanceTravelled: 1e6 });
    for (let i = 0; i < 10; i++)
    {
      const prev = st.distanceTravelled;
      const { state } = advancePhysics(st, THROTTLE, DT, makeCfg());
      st = state;
      expect(st.distanceTravelled).toBeGreaterThan(prev);
    }
  });
});

// ── applyCollisionResponse — per class ──────────────────────────────────────

describe('applyCollisionResponse — Ghost', () =>
{
  it('state is completely unchanged', () =>
  {
    const st = makeState({ speed: 5000, playerX: 0.5 });
    const hit: StaticHitDescriptor = { cls: CollisionClass.Ghost, bumpDir: +1 };
    const result = applyCollisionResponse(st, hit, PLAYER_MAX_SPEED);
    // Ghost applies speed floor if speed > 0, and playerX clamp — but values stay the same
    // since speed is already > HIT_SPEED_FLOOR * maxSpeed and playerX is in range
    expect(result.speed).toBe(st.speed);
    expect(result.playerX).toBe(st.playerX);
    expect(result.hitCooldown).toBe(st.hitCooldown);
    expect(result.grindTimer).toBe(st.grindTimer);
    expect(result.shakeTimer).toBe(st.shakeTimer);
    expect(result.shakeIntensity).toBe(st.shakeIntensity);
    expect(result.slideVelocity).toBe(st.slideVelocity);
  });
});

describe('applyCollisionResponse — Glance', () =>
{
  it('hitCooldown = HIT_GLANCE_COOLDOWN, speed reduced, playerX bumped in bumpSign direction', () =>
  {
    const st = makeState({ speed: 5000, playerX: 1.2 });
    const hit: StaticHitDescriptor = { cls: CollisionClass.Glance, bumpDir: +1 };
    const result = applyCollisionResponse(st, hit, PLAYER_MAX_SPEED);
    expect(result.hitCooldown).toBe(HIT_GLANCE_COOLDOWN);
    expect(result.speed).toBeLessThan(5000);
    // bumpSign = -hit.bumpDir = -1, so playerX decreases
    expect(result.playerX).toBeLessThan(1.2);
    expect(result.shakeTimer).toBe(SHAKE_GLANCE_DURATION);
    expect(result.shakeIntensity).toBe(SHAKE_GLANCE_INTENSITY);
  });
});

describe('applyCollisionResponse — Smack', () =>
{
  it('speed capped at HIT_SMACK_SPEED_CAP * maxSpeed, hitRecoveryTimer set, hitRecoveryBoost set', () =>
  {
    const st = makeState({ speed: PLAYER_MAX_SPEED * 0.9, playerX: 1.2 });
    const hit: StaticHitDescriptor = { cls: CollisionClass.Smack, bumpDir: +1 };
    const result = applyCollisionResponse(st, hit, PLAYER_MAX_SPEED);
    expect(result.speed).toBeLessThanOrEqual(PLAYER_MAX_SPEED * HIT_SMACK_SPEED_CAP);
    expect(result.hitRecoveryTimer).toBe(HIT_SMACK_RECOVERY_TIME);
    expect(result.hitRecoveryBoost).toBe(HIT_SMACK_RECOVERY_BOOST);
    expect(result.shakeTimer).toBe(SHAKE_SMACK_DURATION);
    expect(result.shakeIntensity).toBe(SHAKE_SMACK_INTENSITY);
  });
});

describe('applyCollisionResponse — Crunch', () =>
{
  it('speed capped at HIT_CRUNCH_SPEED_CAP * maxSpeed, grindTimer = HIT_CRUNCH_GRIND_TIME, hitCooldown = HIT_CRUNCH_COOLDOWN, shakeTimer set', () =>
  {
    const st = makeState({ speed: PLAYER_MAX_SPEED * 0.9, playerX: 1.2 });
    const hit: StaticHitDescriptor = { cls: CollisionClass.Crunch, bumpDir: +1 };
    const result = applyCollisionResponse(st, hit, PLAYER_MAX_SPEED);
    // Crunch caps at HIT_CRUNCH_SPEED_CAP * maxSpeed, but speed floor may apply
    expect(result.speed).toBeLessThanOrEqual(
      Math.max(PLAYER_MAX_SPEED * HIT_CRUNCH_SPEED_CAP, PLAYER_MAX_SPEED * HIT_SPEED_FLOOR));
    expect(result.grindTimer).toBe(HIT_CRUNCH_GRIND_TIME);
    expect(result.hitCooldown).toBe(HIT_CRUNCH_COOLDOWN);
    expect(result.shakeTimer).toBe(SHAKE_CRUNCH_DURATION);
    expect(result.shakeIntensity).toBe(SHAKE_CRUNCH_INTENSITY);
    expect(result.hitRecoveryTimer).toBe(HIT_CRUNCH_RECOVERY_TIME);
    expect(result.hitRecoveryBoost).toBe(HIT_CRUNCH_RECOVERY_BOOST);
  });
});

describe('applyCollisionResponse — cross-cutting', () =>
{
  it('after any non-Ghost hit: playerX stays within [-2, +2]', () =>
  {
    // Push playerX far out via glance bump
    const st = makeState({ speed: 5000, playerX: 1.98 });
    const hit: StaticHitDescriptor = { cls: CollisionClass.Glance, bumpDir: -1 };
    // bumpSign = +1, so playerX += HIT_GLANCE_BUMP which could push past 2
    const result = applyCollisionResponse(st, hit, PLAYER_MAX_SPEED);
    expect(result.playerX).toBeLessThanOrEqual(2);
    expect(result.playerX).toBeGreaterThanOrEqual(-2);
  });

  it('speed floor: if speed > 0 before hit, speed >= maxSpeed * HIT_SPEED_FLOOR after hit', () =>
  {
    // Smack with high speed to ensure speed > 0 after
    const st = makeState({ speed: PLAYER_MAX_SPEED * 0.5, playerX: 1.2 });
    const hit: StaticHitDescriptor = { cls: CollisionClass.Smack, bumpDir: +1 };
    const result = applyCollisionResponse(st, hit, PLAYER_MAX_SPEED);
    expect(result.speed).toBeGreaterThanOrEqual(PLAYER_MAX_SPEED * HIT_SPEED_FLOOR);
  });

  it('speed floor applies to crunch as well', () =>
  {
    const st = makeState({ speed: PLAYER_MAX_SPEED * 0.5, playerX: 1.2 });
    const hit: StaticHitDescriptor = { cls: CollisionClass.Crunch, bumpDir: +1 };
    const result = applyCollisionResponse(st, hit, PLAYER_MAX_SPEED);
    expect(result.speed).toBeGreaterThanOrEqual(PLAYER_MAX_SPEED * HIT_SPEED_FLOOR);
  });
});

// ── advancePhysics does not mutate input ────────────────────────────────────

describe('advancePhysics — immutability', () =>
{
  it('does not mutate the input state object', () =>
  {
    const st = makeState({ speed: 5000, playerX: 0.5 });
    const frozen = { ...st };
    advancePhysics(st, THROTTLE, DT, makeCfg());
    expect(st).toEqual(frozen);
  });
});

// ── advancePhysics — steering attenuation ────────────────────────────────────
//
// At full speed the car requires wider, earlier inputs — steerVelocity
// saturates at a lower cap than at low speed (STEER_AUTHORITY_MIN guards
// against going to zero).

describe('advancePhysics — steering attenuation at high speed', () =>
{
  it('saturated steerVelocity is lower at full speed than at low speed', () =>
  {
    const steerRight: InputSnapshot = { ...NO_INPUT, steerRight: true };

    // Pre-set steerVelocity far above any authority level so one frame clamps to
    // the authority ceiling, letting us read the authority directly from the output.
    const lowState  = makeState({ speed: PLAYER_MAX_SPEED * 0.05, steerVelocity: 100 });
    const highState = makeState({ speed: PLAYER_MAX_SPEED,        steerVelocity: 100 });

    const { state: lowResult  } = advancePhysics(lowState,  steerRight, DT, makeCfg());
    const { state: highResult } = advancePhysics(highState, steerRight, DT, makeCfg());

    expect(Math.abs(highResult.steerVelocity)).toBeLessThan(Math.abs(lowResult.steerVelocity));
  });

  it('steerVelocity at full speed remains >= PLAYER_STEERING * STEER_AUTHORITY_MIN (never zeroed)', () =>
  {
    // STEER_AUTHORITY_MIN = 0.70, so capped steerVelocity ≥ PLAYER_STEERING * 0.70
    const steerRight: InputSnapshot = { ...NO_INPUT, steerRight: true };
    const st = makeState({ speed: PLAYER_MAX_SPEED, steerVelocity: 100 });
    const { state: result } = advancePhysics(st, steerRight, DT, makeCfg());

    // 0.70 × PLAYER_STEERING is the floor; we expect the saturated value to be at least this.
    expect(Math.abs(result.steerVelocity)).toBeGreaterThanOrEqual(PLAYER_STEERING * 0.70 - 0.01);
  });
});

// ── applyTrafficHitResponse ───────────────────────────────────────────────────

describe('applyTrafficHitResponse — speed-as-armour', () =>
{
  const normalHit: TrafficHitDescriptor = { bumpDir: +1, isBoosting: false, carMassMult: 1.0 };

  it('higher player speed retains more speed after hit (OutRun: speed is armour)', () =>
  {
    const stLow  = makeState({ speed: PLAYER_MAX_SPEED * 0.20 });
    const stHigh = makeState({ speed: PLAYER_MAX_SPEED * 0.90 });

    const { state: lowResult  } = applyTrafficHitResponse(stLow,  normalHit, PLAYER_MAX_SPEED);
    const { state: highResult } = applyTrafficHitResponse(stHigh, normalHit, PLAYER_MAX_SPEED);

    // Express retained speed as fraction of pre-hit speed for a fair comparison
    const lowRetained  = lowResult.speed  / stLow.speed;
    const highRetained = highResult.speed / stHigh.speed;
    expect(highRetained).toBeGreaterThan(lowRetained);
  });

  it('heavy car (massMult=2.0) causes worse deceleration than light car (massMult=0.7)', () =>
  {
    const st       = makeState({ speed: PLAYER_MAX_SPEED * 0.5 });
    const heavyHit: TrafficHitDescriptor = { bumpDir: +1, isBoosting: false, carMassMult: 2.0 };
    const lightHit: TrafficHitDescriptor = { bumpDir: +1, isBoosting: false, carMassMult: 0.7 };

    const { state: heavyResult } = applyTrafficHitResponse(st, heavyHit, PLAYER_MAX_SPEED);
    const { state: lightResult } = applyTrafficHitResponse(st, lightHit, PLAYER_MAX_SPEED);

    expect(heavyResult.speed).toBeLessThan(lightResult.speed);
  });

  it('lateral flick is smaller at high speed than at low speed', () =>
  {
    const stLow  = makeState({ speed: PLAYER_MAX_SPEED * 0.10 });
    const stHigh = makeState({ speed: PLAYER_MAX_SPEED * 0.90 });

    const { state: lowResult  } = applyTrafficHitResponse(stLow,  normalHit, PLAYER_MAX_SPEED);
    const { state: highResult } = applyTrafficHitResponse(stHigh, normalHit, PLAYER_MAX_SPEED);

    expect(Math.abs(highResult.slideVelocity)).toBeLessThan(Math.abs(lowResult.slideVelocity));
  });

  it('bumpDir +1: slideVelocity < 0 (pushed left)', () =>
  {
    const st = makeState({ speed: PLAYER_MAX_SPEED * 0.5 });
    const { state: result } = applyTrafficHitResponse(st, normalHit, PLAYER_MAX_SPEED);
    expect(result.slideVelocity).toBeLessThan(0);
  });

  it('bumpDir -1: slideVelocity > 0 (pushed right)', () =>
  {
    const st  = makeState({ speed: PLAYER_MAX_SPEED * 0.5 });
    const hit: TrafficHitDescriptor = { bumpDir: -1, isBoosting: false, carMassMult: 1.0 };
    const { state: result } = applyTrafficHitResponse(st, hit, PLAYER_MAX_SPEED);
    expect(result.slideVelocity).toBeGreaterThan(0);
  });
});

describe('applyTrafficHitResponse — car mass effects', () =>
{
  it('lighter car flies further on impact (carThrowVelocity inversely proportional to mass)', () =>
  {
    const st       = makeState({ speed: PLAYER_MAX_SPEED * 0.5 });
    const heavyHit: TrafficHitDescriptor = { bumpDir: +1, isBoosting: false, carMassMult: 2.0 };
    const lightHit: TrafficHitDescriptor = { bumpDir: +1, isBoosting: false, carMassMult: 0.7 };

    const { carThrowVelocity: heavyThrow } = applyTrafficHitResponse(st, heavyHit, PLAYER_MAX_SPEED);
    const { carThrowVelocity: lightThrow } = applyTrafficHitResponse(st, lightHit, PLAYER_MAX_SPEED);

    expect(Math.abs(lightThrow)).toBeGreaterThan(Math.abs(heavyThrow));
  });

  it('recovery boost is higher after a light hit than a heavy hit', () =>
  {
    const st       = makeState({ speed: PLAYER_MAX_SPEED * 0.5 });
    const heavyHit: TrafficHitDescriptor = { bumpDir: +1, isBoosting: false, carMassMult: 2.0 };
    const lightHit: TrafficHitDescriptor = { bumpDir: +1, isBoosting: false, carMassMult: 0.7 };

    const { state: heavyResult } = applyTrafficHitResponse(st, heavyHit, PLAYER_MAX_SPEED);
    const { state: lightResult } = applyTrafficHitResponse(st, lightHit, PLAYER_MAX_SPEED);

    expect(lightResult.hitRecoveryBoost).toBeGreaterThan(heavyResult.hitRecoveryBoost);
  });
});

describe('applyTrafficHitResponse — boosting branch', () =>
{
  it('no speed penalty and no lateral kick when boosting', () =>
  {
    const st  = makeState({ speed: PLAYER_MAX_SPEED, barneyBoostTimer: 2.0, slideVelocity: 0.4 });
    const hit: TrafficHitDescriptor = { bumpDir: +1, isBoosting: true, carMassMult: 1.0 };
    const { state: result } = applyTrafficHitResponse(st, hit, PLAYER_MAX_SPEED);
    expect(result.speed).toBe(PLAYER_MAX_SPEED);
    expect(result.slideVelocity).toBe(0);   // pre-existing drift must not carry through
  });

  it('boosting cooldown is shorter than normal hit cooldown', () =>
  {
    const st      = makeState({ speed: PLAYER_MAX_SPEED, barneyBoostTimer: 2.0 });
    const stNorm  = makeState({ speed: PLAYER_MAX_SPEED * 0.5 });
    const boostHit: TrafficHitDescriptor  = { bumpDir: +1, isBoosting: true,  carMassMult: 1.0 };
    const normalHit: TrafficHitDescriptor = { bumpDir: +1, isBoosting: false, carMassMult: 1.0 };

    const { state: boostResult  } = applyTrafficHitResponse(st,     boostHit,  PLAYER_MAX_SPEED);
    const { state: normalResult } = applyTrafficHitResponse(stNorm, normalHit, PLAYER_MAX_SPEED);

    expect(boostResult.hitCooldown).toBeLessThan(normalResult.hitCooldown);
    expect(boostResult.hitCooldown).toBe(TRAFFIC_HIT_COOLDOWN_BOOSTING);
  });

  it('boosting: struck car throw is twice the normal base', () =>
  {
    const st      = makeState({ speed: PLAYER_MAX_SPEED, barneyBoostTimer: 2.0 });
    const stNorm  = makeState({ speed: PLAYER_MAX_SPEED * 0.5 });
    const boostHit:  TrafficHitDescriptor = { bumpDir: +1, isBoosting: true,  carMassMult: 1.0 };
    const normalHit: TrafficHitDescriptor = { bumpDir: +1, isBoosting: false, carMassMult: 1.0 };

    const { carThrowVelocity: boostThrow  } = applyTrafficHitResponse(st,     boostHit,  PLAYER_MAX_SPEED);
    const { carThrowVelocity: normalThrow } = applyTrafficHitResponse(stNorm, normalHit, PLAYER_MAX_SPEED);

    expect(Math.abs(boostThrow)).toBeGreaterThan(Math.abs(normalThrow));
  });
});

describe('applyTrafficHitResponse — immutability', () =>
{
  it('does not mutate the input state', () =>
  {
    const st     = makeState({ speed: PLAYER_MAX_SPEED * 0.5, playerX: 0.3 });
    const frozen = { ...st };
    const hit: TrafficHitDescriptor = { bumpDir: +1, isBoosting: false, carMassMult: 1.0 };
    applyTrafficHitResponse(st, hit, PLAYER_MAX_SPEED);
    expect(st).toEqual(frozen);
  });
});
