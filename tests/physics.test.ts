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
  PhysicsState,
  PhysicsConfig,
  InputSnapshot,
  StaticHitDescriptor,
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
} from '../src/constants';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeState(overrides: Partial<PhysicsState> = {}): PhysicsState
{
  return {
    speed: 0, playerX: 0, playerZ: 0, steerAngle: 0, brakeHeld: 0,
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
    const st = makeState({ speed: 5000 });
    const cfg = makeCfg({ segmentCurve: 0 });
    const { state } = advancePhysics(st, NO_INPUT, DT, cfg);
    // playerX should only change from coasting, not centrifugal
    // With zero curve, centrifugal contribution is 0
    expect(state.playerX).toBe(0);
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

// ── advancePhysics — grind decel ────────────────────────────────────────────

describe('advancePhysics — grind decel', () =>
{
  it('grindTimer > 0: speed decreases by HIT_CRUNCH_GRIND_DECEL * dt each tick', () =>
  {
    const st = makeState({ speed: 5000, grindTimer: 1.0 });
    const { state } = advancePhysics(st, NO_INPUT, DT, makeCfg());
    // Speed should decrease due to both coast AND grind decel
    // The grind decel alone is HIT_CRUNCH_GRIND_DECEL * DT
    // Speed decreases more than just coast
    const stNoGrind = makeState({ speed: 5000, grindTimer: 0 });
    const { state: noGrind } = advancePhysics(stNoGrind, NO_INPUT, DT, makeCfg());
    expect(state.speed).toBeLessThan(noGrind.speed);
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
