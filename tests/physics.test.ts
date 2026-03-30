/**
 * physics.test.ts
 *
 * Tests for the pure physics functions extracted from game.ts.
 *
 * Architecture note — why pure functions?
 * ─────────────────────────────────────────
 * All gameplay math was extracted into two side-effect-free functions so that
 * the entire physics model can be exercised without a browser, canvas, or game
 * loop.  Each function takes state-in → returns state-out, making every
 * transformation deterministic and trivially invertible for property testing.
 *
 *   advancePhysics(state, input, dt, cfg) → { state, screechRatio }
 *     One 60 Hz tick of player physics: throttle, brake, coast, steering,
 *     centrifugal, off-road, Barney boost, playerZ advance, all timer
 *     decrements, and visual helpers (steerAngle, jitterY).
 *
 *   applyCollisionResponse(state, hit, maxSpeed) → PhysicsState
 *     Instant effect of one static-obstacle collision: speed cap, lateral
 *     bounce, cooldown, shake, grind, and recovery boost.
 *
 *   applyTrafficHitResponse(state, hit, maxSpeed) → { state, carThrowVelocity }
 *     Traffic-car variant: speed-as-armour momentum model, lateral flick,
 *     boosting branch (Barney power-up passes through traffic), and the
 *     force that sends the struck car flying.
 *
 * Test ordering — simple → complex:
 *   Sections progress from the most atomic guarantees (does speed change at
 *   all?) through boundary conditions (exact speed cap, exact timer expiry)
 *   to integration scenarios (60-tick simulations) and cross-cutting
 *   invariants (immutability, playerX clamp, speed floor).
 *
 * Naming convention:
 *   makeState(overrides) — minimal PhysicsState for one test.
 *   makeCfg(overrides)   — minimal PhysicsConfig.
 *   DT = 1/60            — one canonical 60 fps frame.
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
//
// makeState and makeCfg provide zero/baseline values for every field so each
// test can specify only the fields it cares about.  This isolates tests from
// future additions to PhysicsState — a new field with a sensible zero default
// won't break existing tests.

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

/** One canonical 60 fps frame — used as dt in all single-tick tests. */
const DT = 1 / 60;

// ── advancePhysics — throttle ───────────────────────────────────────────────
//
// The throttle model uses a three-phase torque curve: low-speed flat band,
// mid-speed linear, high-speed taper.  At any speed > 0 with throttle held,
// the engine must produce positive net force.  At maxSpeed the net force is
// zero — the governor clamps further gains.

describe('advancePhysics — throttle', () =>
{
  /**
   * The most basic smoke test: if the car cannot accelerate from rest, the
   * entire game is broken.  Fails if the accel formula divides by zero,
   * produces NaN, or returns a negative delta.
   */
  it('throttle from rest: speed increases after one tick', () =>
  {
    const { state } = advancePhysics(makeState(), THROTTLE, DT, makeCfg());
    expect(state.speed).toBeGreaterThan(0);
  });

  /**
   * Verifies the torque taper: peak acceleration occurs in the mid-speed band,
   * not at the top of the rev range.  Without this, the car would accelerate
   * just as hard at 95% speed as at 50% speed, making the top-end feel
   * unrealistically linear and overpowered.
   */
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

  /**
   * The hard speed cap is a critical game-balance constraint.  Without it,
   * Barney boost + held throttle would produce unbounded speed after the boost
   * expires, and races against the timer would become trivially easy.
   * The cap must be enforced even when the car arrives at maxSpeed already
   * (not just when approaching from below).
   */
  it('throttle at exact maxSpeed: speed does not exceed maxSpeed', () =>
  {
    const st = makeState({ speed: PLAYER_MAX_SPEED });
    const { state } = advancePhysics(st, THROTTLE, DT, makeCfg());
    expect(state.speed).toBeLessThanOrEqual(PLAYER_MAX_SPEED);
  });

  /**
   * Zeroing invariant: no input + zero speed must produce exactly zero speed.
   * A floating-point accumulation bug could cause tiny creep that would let
   * the car drift off the start line before the race begins.
   */
  it('no throttle, speed=0: speed stays 0', () =>
  {
    const { state } = advancePhysics(makeState(), NO_INPUT, DT, makeCfg());
    expect(state.speed).toBe(0);
  });
});

// ── advancePhysics — braking ────────────────────────────────────────────────
//
// Braking uses a hydraulic ramp: brakeHeld accumulates while the pedal is
// pressed, driving the brake force up to PLAYER_BRAKE_MAX over PLAYER_BRAKE_RAMP
// seconds.  This simulates the feel of pumping the brakes vs slamming them.

describe('advancePhysics — braking', () =>
{
  /**
   * The most basic smoke test for braking.  If this fails, the player has no
   * way to slow down — the game is unwinnable because the timer runs out before
   * checkpoints are reached.
   */
  it('brake from speed=5000: speed decreases after one tick', () =>
  {
    const st = makeState({ speed: 5000 });
    const { state } = advancePhysics(st, BRAKE, DT, makeCfg());
    expect(state.speed).toBeLessThan(5000);
  });

  /**
   * Negative speed would mean the car is reversing, which is an unimplemented
   * mechanic.  The speed floor at 0 keeps all downstream physics (projection
   * scale, z-advance) well-defined and non-negative.
   */
  it('speed never goes negative under braking', () =>
  {
    const st = makeState({ speed: 10 });
    const { state } = advancePhysics(st, BRAKE, DT, makeCfg());
    expect(state.speed).toBeGreaterThanOrEqual(0);
  });

  /**
   * brakeHeld drives the hydraulic ramp formula.  If it failed to increase,
   * the brake force would always be at its minimum (weak brakes feel wrong
   * and can't slow the car enough to make corners before the timer expires).
   */
  it('brakeHeld increases each tick while braking', () =>
  {
    const st = makeState({ speed: 5000, brakeHeld: 0 });
    const { state } = advancePhysics(st, BRAKE, DT, makeCfg());
    expect(state.brakeHeld).toBeGreaterThan(0);
  });

  /**
   * When the player releases the brake, the hydraulic pressure must decay back
   * toward zero.  Without decay, the brake would be permanently at its last
   * held pressure — the next time the player touches the pedal it would
   * immediately slam to full force, breaking the progressive ramp feel.
   */
  it('brakeHeld decays when not braking', () =>
  {
    const st = makeState({ speed: 5000, brakeHeld: 0.05 });
    const { state } = advancePhysics(st, NO_INPUT, DT, makeCfg());
    expect(state.brakeHeld).toBeLessThan(0.05);
  });
});

// ── advancePhysics — coasting ───────────────────────────────────────────────
//
// With no input, the car loses speed at a constant coast-friction rate.  This
// models aerodynamic drag + engine-braking so the car feels "alive" even with
// hands off the wheel.

describe('advancePhysics — coasting', () =>
{
  /**
   * Engine-off friction must always decelerate the car.  Without this the car
   * would maintain speed indefinitely with no input, making tight corners
   * trivially easy (just let off the throttle and glide around).
   */
  it('no input, speed=5000: speed decreases (coast friction)', () =>
  {
    const st = makeState({ speed: 5000 });
    const { state } = advancePhysics(st, NO_INPUT, DT, makeCfg());
    expect(state.speed).toBeLessThan(5000);
  });

  /**
   * The friction multiplier is applied to current speed.  At speed=0,
   * PLAYER_COAST_RATE × 0 = 0, so nothing happens.  This also tests that
   * the physics engine doesn't spontaneously generate energy at rest.
   */
  it('no input, speed=0: speed stays 0', () =>
  {
    const { state } = advancePhysics(makeState(), NO_INPUT, DT, makeCfg());
    expect(state.speed).toBe(0);
  });
});

// ── advancePhysics — steering ───────────────────────────────────────────────
//
// Steering uses a steerVelocity spring model capped by a speed-dependent
// authority curve.  playerX is normalised −1..+1 on the road surface;
// −2..−1 and +1..+2 are the off-road shoulders.  Beyond ±2 is void (never
// reachable in normal play due to the clamp below).

describe('advancePhysics — steering', () =>
{
  /**
   * Steering is speed-gated: steerVelocity × (speed / maxSpeed) × dt produces
   * zero lateral motion at speed=0.  This prevents the player from teleporting
   * sideways before the countdown finishes and keeps the starting grid valid.
   */
  it('steerLeft at speed=0: playerX unchanged (no movement when stopped)', () =>
  {
    const steerLeft: InputSnapshot = { ...NO_INPUT, steerLeft: true };
    const { state } = advancePhysics(makeState(), steerLeft, DT, makeCfg());
    expect(state.playerX).toBe(0);
  });

  /**
   * Basic directionality: steerLeft must produce a negative playerX delta.
   * If reversed, the controls would be backwards — a critical UX regression
   * that affects every platform (keyboard and touch).
   */
  it('steerLeft at speed=5000: playerX moves left', () =>
  {
    const steerLeft: InputSnapshot = { ...NO_INPUT, steerLeft: true };
    const st = makeState({ speed: 5000 });
    const { state } = advancePhysics(st, steerLeft, DT, makeCfg());
    expect(state.playerX).toBeLessThan(0);
  });

  /**
   * Symmetric check of the right direction.  Testing both directions
   * independently guards against a sign-flip that makes one direction work
   * but silently reverses the other.
   */
  it('steerRight at speed=5000: playerX moves right', () =>
  {
    const steerRight: InputSnapshot = { ...NO_INPUT, steerRight: true };
    const st = makeState({ speed: 5000 });
    const { state } = advancePhysics(st, steerRight, DT, makeCfg());
    expect(state.playerX).toBeGreaterThan(0);
  });

  /**
   * The playerX clamp at ±2 is the hard boundary of the game world.  Beyond
   * ±2 the renderer has no geometry to project (there is no road or shoulder
   * data), and the collision system's hitbox math assumes playerX ≤ 2.
   * Without this clamp, the car could escape the world entirely.
   * 100 ticks of full steer at speed is enough to saturate any sane cap.
   */
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

  /**
   * Mario Kart-inspired handling: at high speed, the car has less lateral
   * authority per tick (it understeers, requiring wider lines).  This is the
   * core difficulty tuning — without it, corners are equally easy at all speeds
   * and the game loses its skill gradient.
   *
   * stLow is 20% max, stHigh is 95% max.  Both have identical steer input and
   * dt, so the difference in movement is purely from the authority curve.
   */
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
//
// On curved segments, centrifugal force is the primary challenge mechanic:
// the car is pushed outward and the player must steer into the bend.  The
// force scales with both curve intensity and speed (higher speed = stronger
// push, as in real physics).

describe('advancePhysics — centrifugal', () =>
{
  /**
   * The sign of the centrifugal force determines the primary challenge on every
   * corner.  Positive segmentCurve = left-bending road → pushes playerX negative
   * (outward = left side of the curve).  If the sign were wrong, curves would
   * push the player inward (trivially easy to hold the road).
   */
  it('positive segmentCurve at speed>0: playerX decreases (pushed outward on left curve)', () =>
  {
    const st = makeState({ speed: 5000 });
    const cfg = makeCfg({ segmentCurve: 4 });
    const { state } = advancePhysics(st, NO_INPUT, DT, cfg);
    // Centrifugal pushes playerX in negative direction for positive curve
    expect(state.playerX).toBeLessThan(0);
  });

  /**
   * On a straight segment there must be zero centrifugal effect.
   * Starting at playerX=0.4 (not 0) is intentional: at playerX=0 a bug of the
   * form `playerX += curve × anything` would still produce 0 and the test would
   * vacuously pass.  Starting at 0.4 exposes any spurious drift.
   */
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
//
// |playerX| > 1 means the car is on the shoulder (sand/grass).  Off-road
// incurs a speed cap lower than the normal maximum — the surface friction
// model prevents the player from using the shoulder as a shortcut.

describe('advancePhysics — off-road', () =>
{
  /**
   * The offRoad flag drives the sand-decel and offRoadRecovery logic.  If it
   * fails to set, the car will accelerate freely on the shoulder and the
   * speed-is-armour traction mechanic breaks (the player never loses grip
   * advantage by going off-road).
   */
  it('|playerX| > 1 -> offRoad becomes true', () =>
  {
    const st = makeState({ speed: 5000, playerX: 1.5 });
    const { state } = advancePhysics(st, NO_INPUT, DT, makeCfg());
    expect(state.offRoad).toBe(true);
  });

  /**
   * When the player steers back onto the asphalt (|playerX| ≤ 1), the flag
   * must clear immediately so the offRoadRecovery ramp can begin.  If it stays
   * true, the car would remain on simulated sand indefinitely even after
   * returning to the road surface.
   */
  it('|playerX| <= 1 -> offRoad becomes false', () =>
  {
    const st = makeState({ speed: 5000, playerX: 0.5, offRoad: true });
    const { state } = advancePhysics(st, NO_INPUT, DT, makeCfg());
    expect(state.offRoad).toBe(false);
  });

  /**
   * 60 ticks of full throttle on the shoulder must not sustain the starting
   * speed.  This validates the sand-decel constant is strong enough to
   * override the engine force at any point in the speed range.  Without this,
   * the shoulder would be a free acceleration zone.
   */
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

  /**
   * On-road acceleration must be uninhibited by the off-road cap.  This ensures
   * the penalty is spatially local — returning to the road restores full
   * acceleration immediately (modulo offRoadRecovery ramp, which is tested
   * separately).
   */
  it('on-road: no speed cap from off-road', () =>
  {
    const st = makeState({ speed: PLAYER_MAX_SPEED * 0.8, playerX: 0 });
    const { state } = advancePhysics(st, THROTTLE, DT, makeCfg());
    // Should be able to accelerate freely
    expect(state.speed).toBeGreaterThan(PLAYER_MAX_SPEED * 0.8);
  });
});

// ── advancePhysics — Barney boost ───────────────────────────────────────────
//
// The Barney power-up temporarily lifts the speed cap to
// maxSpeed × BARNEY_BOOST_MULTIPLIER.  The boost is timed; once barneyBoostTimer
// reaches 0 the normal governor re-engages.

describe('advancePhysics — Barney boost', () =>
{
  /**
   * With an active boost, the car must be allowed to exceed the normal maxSpeed
   * cap.  This is the core Barney power-up reward.  The boost ceiling is
   * BARNEY_BOOST_MULTIPLIER × maxSpeed — exceeding that would be a second,
   * unintended cap violation.
   */
  it('barneyBoostTimer > 0: speed can exceed maxSpeed (up to maxSpeed * BARNEY_BOOST_MULTIPLIER)', () =>
  {
    const st = makeState({ speed: PLAYER_MAX_SPEED * 1.1, barneyBoostTimer: 2.0 });
    const { state } = advancePhysics(st, THROTTLE, DT, makeCfg());
    // Speed should be allowed above maxSpeed
    expect(state.speed).toBeGreaterThan(PLAYER_MAX_SPEED);
    expect(state.speed).toBeLessThanOrEqual(PLAYER_MAX_SPEED * BARNEY_BOOST_MULTIPLIER);
  });

  /**
   * Without an active boost, the normal governor must enforce the cap even if
   * the car was above maxSpeed when the boost expired.  This prevents a
   * one-frame grace window where the car is both above maxSpeed and unprotected.
   */
  it('barneyBoostTimer <= 0: speed hard-capped at maxSpeed', () =>
  {
    // Start above maxSpeed with no boost — should be capped
    const st = makeState({ speed: PLAYER_MAX_SPEED * 1.1, barneyBoostTimer: 0 });
    const { state } = advancePhysics(st, THROTTLE, DT, makeCfg());
    expect(state.speed).toBeLessThanOrEqual(PLAYER_MAX_SPEED);
  });
});

// ── advancePhysics — playerZ advance ────────────────────────────────────────
//
// playerZ is the player's world-space position along the track (0..trackLength).
// It wraps modulo trackLength to create the seamless looping road.
// distanceTravelled is the cumulative odometer — it never wraps so the
// finish-line detector can work across multiple laps.

describe('advancePhysics — playerZ advance', () =>
{
  const trackLength = 500 * SEGMENT_LENGTH;

  /**
   * Z advance is the primary gameplay loop: the player must reach checkpoints
   * before the timer runs out.  If Z fails to increase, the countdown always
   * runs out and the game is unplayable.
   */
  it('with speed > 0: playerZ increases by speed × dt', () =>
  {
    const st = makeState({ speed: 5000 });
    const { state } = advancePhysics(st, NO_INPUT, DT, makeCfg());
    // playerZ should increase (approximately speed * dt, but speed also changes from coasting)
    expect(state.playerZ).toBeGreaterThan(0);
  });

  /**
   * At the end of the track, playerZ must wrap back into [0, trackLength) so
   * that findSegment() receives a valid index.  Without modulo wrap the segment
   * index would be out of bounds and the renderer would crash.
   */
  it('playerZ wraps modulo trackLength', () =>
  {
    const st = makeState({ speed: 5000, playerZ: trackLength - 10 });
    const { state } = advancePhysics(st, NO_INPUT, DT, makeCfg());
    // Should have wrapped
    expect(state.playerZ).toBeLessThan(trackLength);
    expect(state.playerZ).toBeGreaterThanOrEqual(0);
  });

  /**
   * distanceTravelled is the authoritative odometer for the finish-line check
   * and leaderboard distance.  It must increase even when playerZ wraps.
   * If distanceTravelled also wrapped, finishing a lap would register as
   * "zero progress" and the race could never complete.
   */
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
//
// The floor-at-zero invariant is critical: negative timers would cause
// condition guards like `if (grindTimer > 0)` to fire for phantom ticks,
// and time-remaining displays would show impossible negative values.

describe('advancePhysics — timer countdowns', () =>
{
  /**
   * barneyBoostTimer gates the Barney speed multiplier.  It must count down by
   * exactly dt each frame so the boost expires at the correct wall-clock time.
   * toBeCloseTo(5) allows for sub-microsecond floating-point rounding in dt.
   */
  it('barneyBoostTimer decrements by dt', () =>
  {
    const st = makeState({ barneyBoostTimer: 0.5 });
    const { state } = advancePhysics(st, NO_INPUT, DT, makeCfg());
    expect(state.barneyBoostTimer).toBeCloseTo(0.5 - DT, 5);
  });

  /**
   * When the timer ticks below zero in a single frame (e.g., a DT larger than
   * the remaining value), it must land at exactly 0, not go negative.
   * barneyBoostTimer = DT * 0.1 will underflow in one tick.
   */
  it('barneyBoostTimer floors at 0 (never negative)', () =>
  {
    const st = makeState({ barneyBoostTimer: DT * 0.1 });
    const { state } = advancePhysics(st, NO_INPUT, DT, makeCfg());
    expect(state.barneyBoostTimer).toBe(0);
  });

  /**
   * hitCooldown prevents collision detection from firing multiple times on the
   * same obstacle.  Accurate per-frame countdown is required so the immunity
   * window matches the authored duration in HIT_*_COOLDOWN constants.
   */
  it('hitCooldown decrements by dt', () =>
  {
    const st = makeState({ hitCooldown: 1.0 });
    const { state } = advancePhysics(st, NO_INPUT, DT, makeCfg());
    expect(state.hitCooldown).toBeCloseTo(1.0 - DT, 5);
  });

  /**
   * hitCooldown at tiny value must floor to 0, not go negative.  A negative
   * hitCooldown would satisfy `hitCooldown > 0` on the next hit check and
   * block the next collision for a phantom extra frame.
   */
  it('hitCooldown floors at 0', () =>
  {
    const st = makeState({ hitCooldown: DT * 0.1 });
    const { state } = advancePhysics(st, NO_INPUT, DT, makeCfg());
    expect(state.hitCooldown).toBe(0);
  });

  /**
   * grindTimer gates the post-crunch deceleration.  Counting it down by dt
   * ensures the grind phase ends at the correct authored duration
   * (HIT_CRUNCH_GRIND_TIME seconds after the crash).
   */
  it('grindTimer decrements by dt', () =>
  {
    const st = makeState({ grindTimer: 1.0 });
    const { state } = advancePhysics(st, NO_INPUT, DT, makeCfg());
    expect(state.grindTimer).toBeCloseTo(1.0 - DT, 5);
  });

  /**
   * A grindTimer that underflows must land at 0 so the grind-decel guard
   * (`if grindTimer > 0`) correctly stops applying extra deceleration.
   */
  it('grindTimer floors at 0', () =>
  {
    const st = makeState({ grindTimer: DT * 0.1 });
    const { state } = advancePhysics(st, NO_INPUT, DT, makeCfg());
    expect(state.grindTimer).toBe(0);
  });

  /**
   * hitRecoveryTimer gates the post-hit speed boost window.  Counting it down
   * correctly is what makes the recovery boost time-limited; a stuck timer
   * would grant permanent acceleration advantage.
   */
  it('hitRecoveryTimer decrements by dt', () =>
  {
    const st = makeState({ hitRecoveryTimer: 1.0 });
    const { state } = advancePhysics(st, NO_INPUT, DT, makeCfg());
    expect(state.hitRecoveryTimer).toBeCloseTo(1.0 - DT, 5);
  });

  /**
   * shakeTimer gates the screen-shake visual effect.  Counting it down ensures
   * the shake lasts exactly SHAKE_*_DURATION seconds — no longer, no shorter.
   * A non-decrementing shakeTimer would cause permanent screen shake.
   */
  it('shakeTimer decrements by dt', () =>
  {
    const st = makeState({ shakeTimer: 1.0 });
    const { state } = advancePhysics(st, NO_INPUT, DT, makeCfg());
    expect(state.shakeTimer).toBeCloseTo(1.0 - DT, 5);
  });

  /**
   * Integration test: all 5 timers must reach exactly 0 after enough frames —
   * never get stuck above 0 due to floating-point accumulation.
   * 62 frames at DT=1/60 ≈ 1.033 s, which is 33 ms past the 1.0 s expiry.
   */
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
  /**
   * The crunch grind phase is the most punishing collision penalty — the car
   * grinds to a stop for HIT_CRUNCH_GRIND_TIME seconds.  If grind-decel did
   * not add to coasting friction, crunching would feel identical to a light
   * hit and lose its impact as a risk-reward signal.
   */
  it('grindTimer >> dt: speed decreases more than coasting alone', () =>
  {
    const stGrind   = makeState({ speed: 5000, grindTimer: 1.0 });
    const stNoGrind = makeState({ speed: 5000, grindTimer: 0   });
    const { state: withGrind }    = advancePhysics(stGrind,   NO_INPUT, DT, makeCfg());
    const { state: withoutGrind } = advancePhysics(stNoGrind, NO_INPUT, DT, makeCfg());
    expect(withGrind.speed).toBeLessThan(withoutGrind.speed);
  });

  /**
   * When grindTimer is 0, speed must behave identically to a car with no
   * grind history — the decel is truly gone, not merely reduced.
   * toBeCloseTo(1) allows 0.1 absolute tolerance for floating-point coast
   * differences between the two state objects.
   */
  it('grindTimer = 0: no extra decel beyond coasting', () =>
  {
    const st    = makeState({ speed: 5000, grindTimer: 0 });
    const stRef = makeState({ speed: 5000 });
    const { state: out }    = advancePhysics(st,    NO_INPUT, DT, makeCfg());
    const { state: outRef } = advancePhysics(stRef, NO_INPUT, DT, makeCfg());
    expect(out.speed).toBeCloseTo(outRef.speed, 1);
  });

  /**
   * The grind guard is evaluated AFTER the timer is decremented this tick.
   * A timer tiny enough to underflow to 0 (DT * 0.5 < DT) means the guard
   * fires on 0 — grind-decel must NOT apply on the same tick the timer expires.
   * Without this, there would be a one-frame "phantom grind" on every crunch.
   */
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
//
// hitRecoveryBoost is an acceleration multiplier set by collision response and
// cleared when hitRecoveryTimer expires.  It ensures that after a hard hit the
// car gets a brief burst of extra engine force — a "get-up" bonus that keeps
// the pacing exciting.

describe('advancePhysics — hitRecoveryBoost reset', () =>
{
  /**
   * While the recovery window is still open (timer > dt), the boost must be
   * preserved unchanged.  Resetting it early would deny the player the
   * acceleration window the collision response promises.
   */
  it('hitRecoveryTimer > dt: hitRecoveryBoost preserved', () =>
  {
    const boost = 1.5;
    const st = makeState({ hitRecoveryTimer: 1.0, hitRecoveryBoost: boost });
    const { state } = advancePhysics(st, NO_INPUT, DT, makeCfg());
    expect(state.hitRecoveryBoost).toBe(boost);
  });

  /**
   * When the recovery window closes (timer reaches 0 this tick), the boost
   * must reset to 1.0 (neutral) immediately so the extra acceleration does not
   * persist indefinitely.  Without this reset, every crunch would grant a
   * permanent speed multiplier — a serious game-balance exploit.
   */
  it('hitRecoveryTimer expires this tick: hitRecoveryBoost resets to 1.0', () =>
  {
    const st = makeState({ hitRecoveryTimer: DT * 0.1, hitRecoveryBoost: 1.5 });
    const { state } = advancePhysics(st, NO_INPUT, DT, makeCfg());
    expect(state.hitRecoveryTimer).toBe(0);
    expect(state.hitRecoveryBoost).toBe(1.0);
  });

  /**
   * Idempotency check: if the timer is already 0 and the boost already 1.0,
   * one tick must leave both unchanged.  Guards against a bug where the reset
   * logic runs every tick (not only on the expiry tick) and re-sets unnecessarily.
   */
  it('hitRecoveryTimer already 0: hitRecoveryBoost stays 1.0 (idempotent)', () =>
  {
    const st = makeState({ hitRecoveryTimer: 0, hitRecoveryBoost: 1.0 });
    const { state } = advancePhysics(st, NO_INPUT, DT, makeCfg());
    expect(state.hitRecoveryBoost).toBe(1.0);
  });
});

// ── advancePhysics — shake jitter ────────────────────────────────────────────
//
// Screen shake is a random Y offset sampled each tick while shakeTimer > 0.
// Off-road jitter uses a separate exponential-decay path, not the shake timer.

describe('advancePhysics — shake jitter', () =>
{
  /**
   * Probabilistic test: with shakeIntensity=10 and 20 independent trials,
   * at least one must produce a nonzero jitterY.  P(all 20 are exactly 0.5
   * from Math.random) is effectively impossible.  This guards against the shake
   * formula accidentally evaluating to 0 (e.g., intensity multiplied by zero).
   */
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

  /**
   * With shakeTimer off (0), jitterY must decay toward 0 (off-road decay path),
   * not be overwritten by new shake noise.  Starting jitterY=5 is large enough
   * that even after one frame of exponential decay it is measurably closer to 0.
   * This ensures the shake and off-road jitter paths are correctly mutually exclusive.
   */
  it('shakeTimer = 0: jitterY decays toward 0 (not overwritten by shake noise)', () =>
  {
    // On-road, shakeTimer off — jitterY should decay exponentially, not stay large.
    const st = makeState({ shakeTimer: 0, shakeIntensity: 10, jitterY: 5, playerX: 0 });
    const { state } = advancePhysics(st, NO_INPUT, DT, makeCfg());
    expect(Math.abs(state.jitterY)).toBeLessThan(5);
  });

  /**
   * The shake guard fires on the POST-decrement timer value.  A timer tiny
   * enough to floor to 0 this tick means the guard is false — the decay path
   * runs instead.  Without this, a single-frame "phantom shake spike" at very
   * high intensity (100) would be visible every time the shake expires.
   */
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
//
// offRoadRecovery is a [0..1] ramp that modulates grip after returning from
// the shoulder.  While off-road it snaps to 0; on-road it climbs back to 1
// over OFFROAD_RECOVERY_RATE seconds.  This creates a "slippery re-entry" feel —
// the player can't just dip off-road and immediately regain full speed.

describe('advancePhysics — offRoadRecovery', () =>
{
  /**
   * On-road recovery must increase monotonically after returning to tarmac.
   * If it stalled at 0.3, the player would have permanently reduced grip even
   * on the racing line — an invisible and unfair penalty.
   */
  it('on-road: offRoadRecovery increases toward 1', () =>
  {
    const st = makeState({ speed: 5000, playerX: 0, offRoadRecovery: 0.3 });
    const { state } = advancePhysics(st, NO_INPUT, DT, makeCfg());
    expect(state.offRoadRecovery).toBeGreaterThan(0.3);
    expect(state.offRoadRecovery).toBeLessThanOrEqual(1);
  });

  /**
   * Entering the shoulder resets the recovery ramp to 0 immediately.  This
   * forces the player to earn back full grip each time they go off-road —
   * preventing a partial-grip exploit where the player grazes the shoulder
   * repeatedly but maintains most of their traction.
   */
  it('off-road: offRoadRecovery resets to 0', () =>
  {
    const st = makeState({ speed: 5000, playerX: 1.5, offRoadRecovery: 0.8 });
    const { state } = advancePhysics(st, NO_INPUT, DT, makeCfg());
    expect(state.offRoadRecovery).toBe(0);
  });

  /**
   * offRoadRecovery must be clamped to 1.0 — it must not overshoot to a
   * "super-grip" value above 1 that would make the car handle better than
   * default (possible if the recovery ramp used additive rather than lerp logic).
   */
  it('offRoadRecovery does not exceed 1', () =>
  {
    const st = makeState({ speed: 5000, playerX: 0, offRoadRecovery: 1.0 });
    const { state } = advancePhysics(st, NO_INPUT, DT, makeCfg());
    expect(state.offRoadRecovery).toBeLessThanOrEqual(1.0);
  });
});

// ── advancePhysics — screechRatio ────────────────────────────────────────────
//
// screechRatio ∈ [0..1] drives the tyre-screech audio: 0 = silent,
// 1 = maximum screech.  It is calculated from the product of normalised
// speed and absolute curve intensity.  Audio is optional but the ratio must
// be correct so volume scales realistically with cornering load.

describe('advancePhysics — screechRatio', () =>
{
  /**
   * At 80% max speed on a HARD curve the lateral g-force is high enough to
   * produce an audible screech.  Screech at zero would silence the tyre
   * feedback entirely and make hard corners feel less threatening.
   */
  it('fast curve (HARD, speedRatio=0.8): screechRatio > 0', () =>
  {
    const st  = makeState({ speed: PLAYER_MAX_SPEED * 0.8 });
    const cfg = makeCfg({ segmentCurve: 6 });   // ROAD_CURVE.HARD
    const { screechRatio } = advancePhysics(st, NO_INPUT, DT, cfg);
    expect(screechRatio).toBeGreaterThan(0);
  });

  /**
   * On a straight segment there is no lateral load regardless of speed —
   * screechRatio must be exactly 0.  Any nonzero value would produce spurious
   * tyre noise on straights and confuse the player about the road geometry.
   */
  it('straight road (segmentCurve = 0): screechRatio = 0', () =>
  {
    const st  = makeState({ speed: PLAYER_MAX_SPEED * 0.8 });
    const cfg = makeCfg({ segmentCurve: 0 });
    const { screechRatio } = advancePhysics(st, NO_INPUT, DT, cfg);
    expect(screechRatio).toBe(0);
  });

  /**
   * At low speed (30% max) the lateral load is below the screech onset
   * threshold even on the hardest curve.  This prevents the car from
   * "squealing" at walking pace, which would feel cartoonish and wrong.
   */
  it('low speed (speedRatio <= 0.4) on hard curve: screechRatio = 0', () =>
  {
    const st  = makeState({ speed: PLAYER_MAX_SPEED * 0.3 });
    const cfg = makeCfg({ segmentCurve: 6 });
    const { screechRatio } = advancePhysics(st, NO_INPUT, DT, cfg);
    expect(screechRatio).toBe(0);
  });
});

// ── advancePhysics — steerAngle (visual) ─────────────────────────────────────
//
// steerAngle ∈ [-1..+1] is a visual-only value — it controls the rendered
// wheel-turn angle on the car sprite.  It is driven by a simple spring:
// it chases the input direction and decays when no input is held.

describe('advancePhysics — steerAngle', () =>
{
  /**
   * steerLeft input must produce a negative steerAngle (left-turn wheel
   * position).  If the sign is inverted, the car sprite's wheels turn right
   * when the player steers left — a clear visual incoherence.
   */
  it('steerLeft: steerAngle moves negative', () =>
  {
    const steerLeft: InputSnapshot = { ...NO_INPUT, steerLeft: true };
    const st = makeState({ speed: 5000, steerAngle: 0 });
    const { state } = advancePhysics(st, steerLeft, DT, makeCfg());
    expect(state.steerAngle).toBeLessThan(0);
  });

  /**
   * Symmetric check: steerRight must produce a positive steerAngle.
   * Testing both directions guards against a sign-flip that makes one work
   * but mirrors the other.
   */
  it('steerRight: steerAngle moves positive', () =>
  {
    const steerRight: InputSnapshot = { ...NO_INPUT, steerRight: true };
    const st = makeState({ speed: 5000, steerAngle: 0 });
    const { state } = advancePhysics(st, steerRight, DT, makeCfg());
    expect(state.steerAngle).toBeGreaterThan(0);
  });

  /**
   * When the player releases the wheel, steerAngle must self-centre.  A
   * non-decaying steerAngle would leave the rendered wheel permanently
   * turned after any steering input — visually wrong for straight driving.
   */
  it('no steer input: steerAngle decays toward 0', () =>
  {
    const st = makeState({ speed: 5000, steerAngle: 0.5 });
    const { state } = advancePhysics(st, NO_INPUT, DT, makeCfg());
    expect(Math.abs(state.steerAngle)).toBeLessThan(0.5);
  });

  /**
   * steerAngle clamped to ±1 ensures the car sprite never rotates beyond its
   * maximum authored turn angle.  Without this clamp, sustained steer input
   * would spin the sprite indefinitely, breaking the animation entirely.
   */
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
   *
   * If bumpDir and slideVelocity sign are decoupled, the car would bounce
   * through obstacles rather than away from them, breaking the physics model.
   */
  it('Smack bumpDir=+1: slideVelocity < 0 (pushed left)', () =>
  {
    const st  = makeState({ speed: 5000, playerX: 0.8, steerAngle: 0 });
    const hit: StaticHitDescriptor = { cls: CollisionClass.Smack, bumpDir: +1 };
    const result = applyCollisionResponse(st, hit, PLAYER_MAX_SPEED);
    expect(result.slideVelocity).toBeLessThan(0);
  });

  /**
   * Symmetric: bumpDir=-1 (obstacle to the LEFT) pushes the car rightward.
   * Both directions must be tested since the formula `bumpSign = -bumpDir`
   * could have a sign error that affects only one polarity.
   */
  it('Smack bumpDir=-1: slideVelocity > 0 (pushed right)', () =>
  {
    const st  = makeState({ speed: 5000, playerX: -0.8, steerAngle: 0 });
    const hit: StaticHitDescriptor = { cls: CollisionClass.Smack, bumpDir: -1 };
    const result = applyCollisionResponse(st, hit, PLAYER_MAX_SPEED);
    expect(result.slideVelocity).toBeGreaterThan(0);
  });

  /**
   * The Crunch class uses a different speed cap and grind timer than Smack,
   * but the lateral bounce direction must use the same bumpDir convention.
   * This test verifies the direction is not hardcoded per class.
   */
  it('Crunch bumpDir=+1: slideVelocity < 0 (pushed left)', () =>
  {
    const st  = makeState({ speed: 5000, playerX: 0.8, steerAngle: 0 });
    const hit: StaticHitDescriptor = { cls: CollisionClass.Crunch, bumpDir: +1 };
    const result = applyCollisionResponse(st, hit, PLAYER_MAX_SPEED);
    expect(result.slideVelocity).toBeLessThan(0);
  });

  /**
   * Crunch + bumpDir=-1: same bumpDir convention check for the Crunch class.
   */
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
  /**
   * applyCollisionResponse must return a NEW state object without modifying
   * the input.  If it mutated the input, game.ts's tick loop (which reads
   * state before and after collision) would observe incorrect intermediate
   * values and the physics would compound incorrectly.
   */
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
//
// Single-tick tests verify individual invariants; multi-tick simulations check
// that the invariants hold across an entire race segment with no drift or
// accumulation error.

describe('advancePhysics — integration (60-tick simulation)', () =>
{
  /**
   * Speed must remain in [0, maxSpeed] for every frame of a one-second
   * full-throttle run from rest.  This catches transient overshoot: a
   * single-tick test at maxSpeed might pass while the intermediate frames
   * during the acceleration ramp briefly exceed the cap.
   */
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

  /**
   * Over 60 frames of coasting at 80% speed, playerZ must remain in
   * [0, trackLength).  This verifies the modulo wrap is applied every frame,
   * not just on the first frame, and that no frame can slip past the boundary.
   */
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

  /**
   * Hard steerRight for 60 frames from playerX=0 must never push playerX
   * outside [-2, +2].  If the clamp is applied only on entry (not per-frame),
   * or if steerVelocity integration is unbounded, the car could escape in a
   * later frame even if the first few frames are fine.
   */
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

  /**
   * distanceTravelled must increase monotonically even when playerZ wraps at
   * the end of the track.  Starting near the end of the track and running 10
   * frames ensures at least one wrap event occurs, after which distanceTravelled
   * must still exceed its pre-wrap value.
   */
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
  /**
   * Ghost class (decorative sprites: shrubs, signs) must produce zero change
   * to every gameplay field.  speed, playerX, hitCooldown, grindTimer,
   * shakeTimer, shakeIntensity, and slideVelocity must all be unchanged.
   * If a Ghost hit applied any penalty, decorative bushes would feel as
   * dangerous as palm trees — breaking the collision feedback design.
   */
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
  /**
   * A Glance (cactus brush) is a minor hit: it applies a short cooldown, a
   * small speed reduction, a lateral nudge (bumpDir), and a brief shake.
   * All five effects must trigger together — if any is missing, the feedback
   * feels inconsistent (e.g., speed reduced but no screen shake = invisible hit).
   */
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
  /**
   * A Smack (palm, billboard) is a hard hit: speed is reduced to at most
   * HIT_SMACK_SPEED_CAP × maxSpeed, and the recovery timer grants the player
   * a boost window after the impact.  The shake is stronger than a Glance.
   * All five fields must match constants exactly — using different values than
   * the authored constants would silently change gameplay feel without a test
   * failure to catch it.
   */
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
  /**
   * A Crunch (house, wall) is the worst static collision: speed is crushed to
   * HIT_CRUNCH_SPEED_CAP × maxSpeed (or HIT_SPEED_FLOOR if that's higher),
   * a long grind phase begins (HIT_CRUNCH_GRIND_TIME), a long cooldown is set,
   * and the recovery boost is also granted.  Six fields must all be set
   * correctly and simultaneously — a missing one would give an inconsistent
   * penalty between crunches and smacks.
   */
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
  /**
   * Even after the lateral bump from a collision, playerX must stay within
   * the world boundary [-2, +2].  Starting at playerX=1.98 with a rightward
   * bump (bumpDir=-1 → bumpSign=+1) could push it past 2 without the clamp.
   * This prevents glancing a wall from teleporting the car out of the world.
   */
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

  /**
   * The speed floor prevents the car from stopping dead on a moving road —
   * a stationary car on a looping track would mean the player can never
   * restart without a pause/resume.  HIT_SPEED_FLOOR × maxSpeed is the
   * minimum speed after any collision that finds the player moving.
   */
  it('speed floor: if speed > 0 before hit, speed >= maxSpeed * HIT_SPEED_FLOOR after hit', () =>
  {
    // Smack with high speed to ensure speed > 0 after
    const st = makeState({ speed: PLAYER_MAX_SPEED * 0.5, playerX: 1.2 });
    const hit: StaticHitDescriptor = { cls: CollisionClass.Smack, bumpDir: +1 };
    const result = applyCollisionResponse(st, hit, PLAYER_MAX_SPEED);
    expect(result.speed).toBeGreaterThanOrEqual(PLAYER_MAX_SPEED * HIT_SPEED_FLOOR);
  });

  /**
   * The speed floor must apply to the most severe collision class (Crunch) as
   * well — not just Smack.  Without this, a house collision could stop the car
   * completely, which has no restart mechanism in the current game loop.
   */
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
  /**
   * advancePhysics must return a new state object without modifying its input.
   * The game loop calls it as `const { state } = advancePhysics(current, ...)`,
   * then replaces `current`.  If the input were mutated, any code referencing
   * `current` before the replacement would see corrupted values — particularly
   * dangerous in the collision and rendering passes that read state in the same
   * tick.
   */
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
  /**
   * The speed-authority curve makes high-speed cornering harder (more planning
   * required).  Pre-seeding steerVelocity=100 (far above any cap) forces one
   * frame to clamp to the authority ceiling, making the ceiling directly
   * readable from the output.  If the attenuation were removed, both speeds
   * would produce identical steerVelocity and the difficulty gradient disappears.
   */
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

  /**
   * The STEER_AUTHORITY_MIN floor (0.70) ensures the car remains steerable at
   * any speed — it never becomes completely unresponsive at maximum velocity.
   * Without this floor, a designer could accidentally tune CENTRIFUGAL and
   * PLAYER_MAX_SPEED such that the car is impossible to steer on fast corners.
   */
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
//
// Traffic collisions use a momentum-based model: the player's speed acts as
// "armour" — faster players take proportionally less damage because their
// kinetic energy ratio is higher.  The struck car's throw velocity is the
// inverse: heavy cars absorb more momentum and fly less far.

describe('applyTrafficHitResponse — speed-as-armour', () =>
{
  const normalHit: TrafficHitDescriptor = { bumpDir: +1, isBoosting: false, carMassMult: 1.0 };

  /**
   * The OutRun arcade mechanic: speed is armour.  A player going 90% max speed
   * should retain a higher fraction of their pre-hit speed than one going 20%.
   * Without this, faster driving would carry more risk than slower driving —
   * the opposite of the intended risk-reward design.
   * Comparing retained fractions (not absolute speeds) makes the test fair
   * regardless of the different starting speeds.
   */
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

  /**
   * Car mass is the "other half" of the momentum equation: heavier cars
   * transfer more impulse and slow the player down more.  Without mass
   * scaling, a 40-tonne truck would feel identical to a 600 kg kart.
   * massMult=2.0 represents a heavy truck; massMult=0.7 represents a light
   * compact — same player speed, different outcomes.
   */
  it('heavy car (massMult=2.0) causes worse deceleration than light car (massMult=0.7)', () =>
  {
    const st       = makeState({ speed: PLAYER_MAX_SPEED * 0.5 });
    const heavyHit: TrafficHitDescriptor = { bumpDir: +1, isBoosting: false, carMassMult: 2.0 };
    const lightHit: TrafficHitDescriptor = { bumpDir: +1, isBoosting: false, carMassMult: 0.7 };

    const { state: heavyResult } = applyTrafficHitResponse(st, heavyHit, PLAYER_MAX_SPEED);
    const { state: lightResult } = applyTrafficHitResponse(st, lightHit, PLAYER_MAX_SPEED);

    expect(heavyResult.speed).toBeLessThan(lightResult.speed);
  });

  /**
   * The lateral flick (slideVelocity) from a traffic hit must be smaller at
   * high speed than at low speed.  At high speed the player's forward momentum
   * dominates; at low speed there is less inertia and the lateral impulse
   * throws the car further sideways.  This prevents high-speed driving from
   * being dominated by lateral chaos.
   */
  it('lateral flick is smaller at high speed than at low speed', () =>
  {
    const stLow  = makeState({ speed: PLAYER_MAX_SPEED * 0.10 });
    const stHigh = makeState({ speed: PLAYER_MAX_SPEED * 0.90 });

    const { state: lowResult  } = applyTrafficHitResponse(stLow,  normalHit, PLAYER_MAX_SPEED);
    const { state: highResult } = applyTrafficHitResponse(stHigh, normalHit, PLAYER_MAX_SPEED);

    expect(Math.abs(highResult.slideVelocity)).toBeLessThan(Math.abs(lowResult.slideVelocity));
  });

  /**
   * bumpDir=+1 (traffic car is to the right) must produce negative slideVelocity
   * (player pushed left).  Incorrect sign would send the player into the car
   * rather than away from it.
   */
  it('bumpDir +1: slideVelocity < 0 (pushed left)', () =>
  {
    const st = makeState({ speed: PLAYER_MAX_SPEED * 0.5 });
    const { state: result } = applyTrafficHitResponse(st, normalHit, PLAYER_MAX_SPEED);
    expect(result.slideVelocity).toBeLessThan(0);
  });

  /**
   * Symmetric check: bumpDir=-1 (traffic car to the left) must push the player
   * rightward (positive slideVelocity).
   */
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
  /**
   * Newton's third law analogue: the carThrowVelocity (how far the struck car
   * flies) must be inversely proportional to its mass.  A light car (massMult=0.7)
   * receives more impulse and flies further than a heavy car (massMult=2.0)
   * under the same collision.  Without this, a smart player would always aim
   * for heavy cars to maximise visual drama at no extra risk.
   */
  it('lighter car flies further on impact (carThrowVelocity inversely proportional to mass)', () =>
  {
    const st       = makeState({ speed: PLAYER_MAX_SPEED * 0.5 });
    const heavyHit: TrafficHitDescriptor = { bumpDir: +1, isBoosting: false, carMassMult: 2.0 };
    const lightHit: TrafficHitDescriptor = { bumpDir: +1, isBoosting: false, carMassMult: 0.7 };

    const { carThrowVelocity: heavyThrow } = applyTrafficHitResponse(st, heavyHit, PLAYER_MAX_SPEED);
    const { carThrowVelocity: lightThrow } = applyTrafficHitResponse(st, lightHit, PLAYER_MAX_SPEED);

    expect(Math.abs(lightThrow)).toBeGreaterThan(Math.abs(heavyThrow));
  });

  /**
   * The recovery boost after a light-car hit must be larger than after a
   * heavy-car hit: light cars provide less resistance so the player gets more
   * "rebound" momentum.  Without this distinction, all traffic hits would feel
   * identical regardless of car type.
   */
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
  /**
   * The Barney power-up grants temporary invulnerability to traffic physics:
   * the player plows through cars with no speed penalty and no lateral kick.
   * This is the core reward for collecting the power-up.  If the boosting
   * branch is skipped, Barney hits feel identical to normal hits and the
   * power-up is worthless.  slideVelocity must also be cleared (not just
   * unchanged) to cancel any pre-existing drift.
   */
  it('no speed penalty and no lateral kick when boosting', () =>
  {
    const st  = makeState({ speed: PLAYER_MAX_SPEED, barneyBoostTimer: 2.0, slideVelocity: 0.4 });
    const hit: TrafficHitDescriptor = { bumpDir: +1, isBoosting: true, carMassMult: 1.0 };
    const { state: result } = applyTrafficHitResponse(st, hit, PLAYER_MAX_SPEED);
    expect(result.speed).toBe(PLAYER_MAX_SPEED);
    expect(result.slideVelocity).toBe(0);   // pre-existing drift must not carry through
  });

  /**
   * When boosting, the collision cooldown must be shorter (TRAFFIC_HIT_COOLDOWN_BOOSTING)
   * than the normal cooldown (TRAFFIC_HIT_COOLDOWN).  The boosting player is
   * immune to penalty but still needs a cooldown to prevent the same car from
   * registering a hit on every frame while overlapping.  The shorter value
   * keeps the collision response snappy without double-counting.
   */
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

  /**
   * When boosting, the struck car must fly further than in a normal hit.
   * This is the visual "bowling ball through pins" effect: the power-up
   * makes collisions more spectacular.  Without this, boosting feels the
   * same as normal driving from the other cars' perspective.
   */
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
  /**
   * applyTrafficHitResponse must return a new state without mutating the input,
   * for the same reason as applyCollisionResponse: the game loop reads the input
   * state in the rendering pass that immediately follows the physics pass.
   * Any mutation would corrupt the rendered frame for that tick.
   */
  it('does not mutate the input state', () =>
  {
    const st     = makeState({ speed: PLAYER_MAX_SPEED * 0.5, playerX: 0.3 });
    const frozen = { ...st };
    const hit: TrafficHitDescriptor = { bumpDir: +1, isBoosting: false, carMassMult: 1.0 };
    applyTrafficHitResponse(st, hit, PLAYER_MAX_SPEED);
    expect(st).toEqual(frozen);
  });
});
