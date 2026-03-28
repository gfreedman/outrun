/**
 * physics.ts
 *
 * Pure, testable physics functions extracted from game.ts.
 *
 * Every function in this module is a pure function: it takes immutable inputs
 * and returns new objects without side effects.  Audio, DOM, and road lookups
 * stay in game.ts — this module only computes the next physics state.
 */

import { CollisionClass } from './types';
import {
  PLAYER_MAX_SPEED,
  PLAYER_ACCEL_LOW, PLAYER_ACCEL_MID,
  PLAYER_COAST_RATE,
  PLAYER_BRAKE_MAX, PLAYER_BRAKE_RAMP,
  PLAYER_STEERING, PLAYER_STEER_RATE,
  ACCEL_LOW_BAND, ACCEL_HIGH_BAND,
  OFFROAD_MAX_RATIO, OFFROAD_DECEL, OFFROAD_RECOVERY_TIME,
  OFFROAD_CRAWL_RATIO, OFFROAD_JITTER_BLEND, OFFROAD_JITTER_DECAY,
  CENTRIFUGAL,
  DRIFT_ONSET, DRIFT_RATE, DRIFT_DECAY, DRIFT_CATCH,
  HIT_GLANCE_SPEED_MULT, HIT_GLANCE_BUMP, HIT_GLANCE_COOLDOWN,
  HIT_SMACK_SPEED_MULT, HIT_SMACK_SPEED_CAP,
  HIT_SMACK_COOLDOWN, HIT_SMACK_RECOVERY_BOOST, HIT_SMACK_RECOVERY_TIME,
  HIT_SMACK_RESTITUTION, HIT_SMACK_FLICK_BASE,
  HIT_CRUNCH_SPEED_CAP, HIT_CRUNCH_GRIND_TIME, HIT_CRUNCH_GRIND_DECEL,
  HIT_CRUNCH_COOLDOWN,
  HIT_CRUNCH_RECOVERY_BOOST, HIT_CRUNCH_RECOVERY_TIME,
  HIT_CRUNCH_RESTITUTION, HIT_CRUNCH_FLICK_BASE,
  HIT_SPEED_FLOOR,
  SHAKE_GLANCE_INTENSITY, SHAKE_GLANCE_DURATION,
  SHAKE_SMACK_INTENSITY, SHAKE_SMACK_DURATION,
  SHAKE_CRUNCH_INTENSITY, SHAKE_CRUNCH_DURATION,
  BARNEY_BOOST_MULTIPLIER,
  TRAFFIC_HIT_SPEED_CAP, TRAFFIC_HIT_FLICK_BASE,
  TRAFFIC_HIT_COOLDOWN, TRAFFIC_HIT_COOLDOWN_BOOSTING,
  TRAFFIC_HIT_RECOVERY_TIME, TRAFFIC_HIT_RECOVERY_BOOST,
  SHAKE_TRAFFIC_DURATION, SHAKE_TRAFFIC_INTENSITY,
  TRAFFIC_CAR_THROW_BASE,
  STEER_AUTHORITY_SPEED_FACTOR, STEER_AUTHORITY_MIN,
} from './constants';

// ── Interfaces ──────────────────────────────────────────────────────────────

/** Snapshot of all player physics state for one tick. */
export interface PhysicsState {
  speed:              number;
  playerX:            number;
  playerZ:            number;
  steerAngle:         number;
  steerVelocity:      number;   // lateral steering momentum (road-widths/sec)
  brakeHeld:          number;
  offRoad:            boolean;
  offRoadRecovery:    number;
  slideVelocity:      number;
  jitterY:            number;
  hitCooldown:        number;
  grindTimer:         number;
  hitRecoveryTimer:   number;
  hitRecoveryBoost:   number;
  shakeTimer:         number;
  shakeIntensity:     number;
  barneyBoostTimer:   number;
  distanceTravelled:  number;
}

/** Keyboard input snapshot for one tick — decouples pure physics from InputManager. */
export interface InputSnapshot {
  throttle:   boolean;
  brake:      boolean;
  steerLeft:  boolean;
  steerRight: boolean;
}

/** Per-tick configuration derived from mode and road state before calling advancePhysics. */
export interface PhysicsConfig {
  maxSpeed:        number;
  accelMultiplier: number;
  trackLength:     number;
  segmentCurve:    number;
}

/** Minimal hit descriptor for static-sprite collision response. */
export interface StaticHitDescriptor {
  cls:     CollisionClass;
  bumpDir: number;  // +1 = hit from left, -1 = hit from right
}

// ── advancePhysics ──────────────────────────────────────────────────────────

/**
 * Advances all player physics state by one tick.
 *
 * Pure function — does NOT mutate the input `state`.  Returns a new
 * PhysicsState and a screechRatio for audio feedback.
 */
export function advancePhysics(
  state: PhysicsState,
  input: InputSnapshot,
  dt:    number,
  cfg:   PhysicsConfig,
): { state: PhysicsState; screechRatio: number }
{
  let speed            = state.speed;
  let playerX          = state.playerX;
  let playerZ          = state.playerZ;
  let steerAngle       = state.steerAngle;
  let steerVelocity    = state.steerVelocity;
  let brakeHeld        = state.brakeHeld;
  let offRoad          = state.offRoad;
  let offRoadRecovery  = state.offRoadRecovery;
  let slideVelocity    = state.slideVelocity;
  let jitterY          = state.jitterY;
  let hitCooldown      = state.hitCooldown;
  let grindTimer       = state.grindTimer;
  let hitRecoveryTimer = state.hitRecoveryTimer;
  let hitRecoveryBoost = state.hitRecoveryBoost;
  let shakeTimer       = state.shakeTimer;
  let shakeIntensity   = state.shakeIntensity;
  let barneyBoostTimer = state.barneyBoostTimer;
  let distanceTravelled = state.distanceTravelled;

  // ── Tick all timers ──────────────────────────────────────────────────────
  // All timer decrements live here so advancePhysics is the single, complete
  // physics state machine.  Timers run BEFORE any physics that reads them,
  // so the "active" window is always [set → first tick → ... → zero → off].
  barneyBoostTimer  = Math.max(0, barneyBoostTimer  - dt);
  hitCooldown       = Math.max(0, hitCooldown       - dt);
  grindTimer        = Math.max(0, grindTimer        - dt);
  hitRecoveryTimer  = Math.max(0, hitRecoveryTimer  - dt);
  shakeTimer        = Math.max(0, shakeTimer        - dt);

  // Timer-driven state transition: recovery boost expires with its timer.
  if (hitRecoveryTimer <= 0) hitRecoveryBoost = 1.0;

  const { maxSpeed, accelMultiplier, trackLength, segmentCurve } = cfg;
  const speedRatio = speed / maxSpeed;

  // ── Throttle / brake ───────────────────────────────────────────────────

  if (input.throttle)
  {
    let accel: number;
    if (speedRatio < ACCEL_LOW_BAND)
    {
      const t      = speedRatio / ACCEL_LOW_BAND;
      const smooth = t * t * (3 - 2 * t);
      accel = PLAYER_ACCEL_LOW + (PLAYER_ACCEL_MID - PLAYER_ACCEL_LOW) * smooth;
    }
    else if (speedRatio < ACCEL_HIGH_BAND)
    {
      accel = PLAYER_ACCEL_MID;
    }
    else
    {
      accel = PLAYER_ACCEL_MID * (1 - speedRatio) / (1 - ACCEL_HIGH_BAND);
    }

    speed    += accel * accelMultiplier * hitRecoveryBoost * dt;
    brakeHeld = 0;
  }
  else if (input.brake)
  {
    brakeHeld = Math.min(brakeHeld + dt, PLAYER_BRAKE_RAMP);
    const t   = brakeHeld / PLAYER_BRAKE_RAMP;
    speed    -= PLAYER_BRAKE_MAX * t * t * dt;
  }
  else
  {
    // Low-speed coast is gentler so the car rolls naturally below 30% speed
    const coastRate = PLAYER_COAST_RATE * Math.max(0.3, speedRatio);
    speed    -= coastRate * dt;
    brakeHeld = Math.max(0, brakeHeld - dt * 4);
  }

  // ── Barney afterburner boost ─────────────────────────────────────────

  if (barneyBoostTimer > 0)
  {
    const boostMax = maxSpeed * BARNEY_BOOST_MULTIPLIER;
    speed = Math.min(boostMax, speed + maxSpeed * 2.0 * dt);
  }

  speed = Math.max(0, Math.min(speed,
    barneyBoostTimer > 0 ? maxSpeed * BARNEY_BOOST_MULTIPLIER : maxSpeed));

  // ── Grind deceleration (crunch aftermath) ────────────────────────────
  // Applied after the Barney boost section so the speed clamp above does not
  // immediately cancel out grind penalty.  grindTimer was already decremented
  // at the top of this function, so the guard is false on the final expiry tick.
  if (grindTimer > 0) speed -= HIT_CRUNCH_GRIND_DECEL * dt;

  // ── Steering ─────────────────────────────────────────────────────────
  // Quadratic grip loss: gentler at mid-speed, sharper near the top end.
  // At 50% speed: 91% grip (more planted than linear).
  // At 100% speed: 65% grip (pronounced floatiness at 400+ km/h).
  const gripFactor = 1 - speedRatio * speedRatio * 0.35;

  // Trail braking: brake + steer = 25% grip bonus, rewards cornering skill.
  const trailBraking  = input.brake && (input.steerLeft || input.steerRight);
  const effectiveGrip = gripFactor * (trailBraking ? 1.25 : 1.0);

  // Steering inertia: velocity ramps when key held, springs back on release.
  // STEER_RAMP=24 → reaches PLAYER_STEERING in ~6 frames (100ms).
  // STEER_RETURN=20 → decays to ~5% in ~9 frames (150ms).
  const STEER_RAMP   = 24.0;
  const STEER_RETURN = 20.0;

  // Steering authority: full at low speed, attenuated at high speed.
  // The car feels planted and committed at 400 km/h — needs wider, earlier inputs.
  // Below STEER_AUTHORITY_MIN (70%) the reduction stops so it never goes to zero.
  const steerAuthority = PLAYER_STEERING *
    Math.max(STEER_AUTHORITY_MIN, 1.0 - speedRatio * STEER_AUTHORITY_SPEED_FACTOR);

  if (speed > 0)
  {
    if (input.steerLeft)
      steerVelocity = Math.max(steerVelocity - STEER_RAMP * dt, -steerAuthority);
    else if (input.steerRight)
      steerVelocity = Math.min(steerVelocity + STEER_RAMP * dt,  steerAuthority);
    else
      steerVelocity *= Math.exp(-STEER_RETURN * dt);

    playerX += steerVelocity * effectiveGrip * dt;
  }
  else
  {
    steerVelocity = 0;
  }
  playerX = Math.max(-2, Math.min(2, playerX));

  // ── Centrifugal force ────────────────────────────────────────────────

  playerX -= segmentCurve * speedRatio * CENTRIFUGAL * dt;

  // ── Drift ────────────────────────────────────────────────────────────

  if (speedRatio > 0.5 && Math.abs(segmentCurve) > 0)
  {
    const centForce = Math.abs(segmentCurve * speedRatio * CENTRIFUGAL);
    const availGrip = PLAYER_STEERING * effectiveGrip;
    if (centForce > availGrip * DRIFT_ONSET)
    {
      const excess   = centForce - availGrip * DRIFT_ONSET;
      const slideDir = segmentCurve > 0 ? -1 : 1;
      slideVelocity += slideDir * excess * DRIFT_RATE * dt;
    }
  }
  playerX += slideVelocity * dt;

  const counterSteering =
    (slideVelocity >  0.02 && input.steerLeft) ||
    (slideVelocity < -0.02 && input.steerRight);
  let decayRate = counterSteering ? DRIFT_CATCH : DRIFT_DECAY;
  if (hitCooldown > 0) decayRate = Math.min(decayRate, 2.5);
  slideVelocity *= Math.exp(-decayRate * dt);

  // ── Screech ratio ────────────────────────────────────────────────────

  let screechRatio = 0;
  if (speedRatio > 0.4 && Math.abs(segmentCurve) > 0)
  {
    const centForce = Math.abs(segmentCurve * speedRatio * CENTRIFUGAL);
    const availGrip = PLAYER_STEERING * effectiveGrip;
    screechRatio = centForce / availGrip;
  }

  // ── Slide cap ────────────────────────────────────────────────────────

  const slideCap = hitCooldown > 0 ? 0.75 : 0.5;
  slideVelocity = Math.max(-slideCap, Math.min(slideCap, slideVelocity));

  // ── Steer angle (visual) ─────────────────────────────────────────────

  if (input.steerLeft)        steerAngle -= PLAYER_STEER_RATE * dt;
  else if (input.steerRight)  steerAngle += PLAYER_STEER_RATE * dt;
  else                        steerAngle *= Math.exp(-PLAYER_STEER_RATE * 4 * dt);
  steerAngle = Math.max(-1, Math.min(1, steerAngle));

  // ── Off-road ─────────────────────────────────────────────────────────

  offRoad = Math.abs(playerX) > 1;

  if (offRoad)
  {
    speed -= OFFROAD_DECEL * dt;
    if (input.throttle)
      speed = Math.max(speed, maxSpeed * OFFROAD_CRAWL_RATIO);
    offRoadRecovery = 0;
    const jitterTarget = speed > 0 ? (Math.random() - 0.5) * 10 : 0;
    jitterY += (jitterTarget - jitterY) * (1 - Math.exp(-OFFROAD_JITTER_BLEND * dt));
  }
  else
  {
    offRoadRecovery = Math.min(1, offRoadRecovery + dt / OFFROAD_RECOVERY_TIME);
    if (offRoadRecovery < 1)
    {
      const recoveryMax = maxSpeed * (OFFROAD_MAX_RATIO + (1 - OFFROAD_MAX_RATIO) * offRoadRecovery);
      speed = Math.min(speed, recoveryMax);
    }
    jitterY *= Math.exp(-OFFROAD_JITTER_DECAY * dt);
  }

  speed = Math.max(0, Math.min(speed,
    barneyBoostTimer > 0 ? maxSpeed * BARNEY_BOOST_MULTIPLIER : maxSpeed));

  // ── Shake jitter (collision aftermath) ───────────────────────────────
  // Overwrites off-road jitter when a collision shake is active.  shakeTimer
  // was decremented at the top of this function, so jitter stops automatically
  // on the tick after it expires.
  //
  // shakeIntensity decays exponentially each frame so the camera jolts hard
  // on impact and smoothly settles, rather than vibrating at constant amplitude
  // (which reads as traffic-car "jitter" at 60 fps).
  if (shakeTimer > 0)
    jitterY = (Math.random() - 0.5) * shakeIntensity * 2;

  // ── High-speed straight rumble (speed sensation) ──────────────────────
  // Subtle vertical jitter above 90% speed on a straight — gives velocity
  // presence without distracting on corners or at lower speeds.
  if (shakeTimer <= 0 && !offRoad && speedRatio > 0.90 && segmentCurve === 0)
  {
    const rumble = (speedRatio - 0.90) / 0.10;   // 0→1 from 90% to 100%
    jitterY = (Math.random() - 0.5) * 2.0 * rumble;
  }

  // ── Advance ──────────────────────────────────────────────────────────

  const stepWU       = speed * dt;
  playerZ            = ((playerZ + stepWU) % trackLength + trackLength) % trackLength;
  distanceTravelled += stepWU;

  return {
    state: {
      speed,
      playerX,
      playerZ,
      steerAngle,
      steerVelocity,
      brakeHeld,
      offRoad,
      offRoadRecovery,
      slideVelocity,
      jitterY,
      hitCooldown,
      grindTimer,
      hitRecoveryTimer,
      hitRecoveryBoost,
      shakeTimer,
      shakeIntensity,
      barneyBoostTimer,
      distanceTravelled,
    },
    screechRatio,
  };
}

// ── applyCollisionResponse ──────────────────────────────────────────────────

/**
 * Computes the physics state after a static-sprite collision.
 *
 * Pure function — does NOT mutate the input `state`.  Returns a new
 * PhysicsState with speed, playerX, hitCooldown, grindTimer, etc. updated
 * according to the collision class.
 */
export function applyCollisionResponse(
  state:    PhysicsState,
  hit:      StaticHitDescriptor,
  maxSpeed: number,
): PhysicsState
{
  let speed            = state.speed;
  let playerX          = state.playerX;
  let hitCooldown      = state.hitCooldown;
  let grindTimer       = state.grindTimer;
  let hitRecoveryTimer = state.hitRecoveryTimer;
  let hitRecoveryBoost = state.hitRecoveryBoost;
  let shakeTimer       = state.shakeTimer;
  let shakeIntensity   = state.shakeIntensity;
  let slideVelocity    = state.slideVelocity;

  // Pre-compute approach: how fast the player was moving laterally toward the
  // object at impact — higher approach = larger restitution flick.
  const preHitSpeedRatio = speed / maxSpeed;
  const gripFactor       = 1 - preHitSpeedRatio * preHitSpeedRatio * 0.35;
  const bumpSign         = -hit.bumpDir;
  const steerApproach    = hit.bumpDir * state.steerAngle * PLAYER_STEERING * gripFactor;
  const slideApproach    = hit.bumpDir * state.slideVelocity;
  const approach         = Math.max(0, steerApproach + slideApproach);

  switch (hit.cls)
  {
    case CollisionClass.Glance:
    {
      speed   *= HIT_GLANCE_SPEED_MULT;
      playerX += bumpSign * HIT_GLANCE_BUMP;
      shakeTimer     = SHAKE_GLANCE_DURATION;
      shakeIntensity = SHAKE_GLANCE_INTENSITY;
      hitCooldown    = HIT_GLANCE_COOLDOWN;
      break;
    }
    case CollisionClass.Smack:
    {
      speed *= HIT_SMACK_SPEED_MULT;
      speed  = Math.min(speed, maxSpeed * HIT_SMACK_SPEED_CAP);
      const flick    = Math.max(0.08, approach * HIT_SMACK_RESTITUTION + preHitSpeedRatio * HIT_SMACK_FLICK_BASE);
      slideVelocity  = bumpSign * Math.min(flick, 0.45);
      shakeTimer       = SHAKE_SMACK_DURATION;
      shakeIntensity   = SHAKE_SMACK_INTENSITY;
      hitCooldown      = HIT_SMACK_COOLDOWN;
      hitRecoveryTimer = HIT_SMACK_RECOVERY_TIME;
      hitRecoveryBoost = HIT_SMACK_RECOVERY_BOOST;
      break;
    }
    case CollisionClass.Crunch:
    {
      speed = Math.min(speed, maxSpeed * HIT_CRUNCH_SPEED_CAP);
      grindTimer = HIT_CRUNCH_GRIND_TIME;
      const flick    = Math.max(0.14, approach * HIT_CRUNCH_RESTITUTION + preHitSpeedRatio * HIT_CRUNCH_FLICK_BASE);
      slideVelocity  = bumpSign * Math.min(flick, 0.45);
      shakeTimer       = SHAKE_CRUNCH_DURATION;
      shakeIntensity   = SHAKE_CRUNCH_INTENSITY;
      hitCooldown      = HIT_CRUNCH_COOLDOWN;
      hitRecoveryTimer = HIT_CRUNCH_RECOVERY_TIME;
      hitRecoveryBoost = HIT_CRUNCH_RECOVERY_BOOST;
      break;
    }
    case CollisionClass.Ghost:
      break;
    default:
    {
      const _exhaustive: never = hit.cls;
      void _exhaustive;
    }
  }

  if (speed > 0)
    speed = Math.max(speed, maxSpeed * HIT_SPEED_FLOOR);
  playerX = Math.max(-2, Math.min(2, playerX));

  return {
    ...state,
    speed,
    playerX,
    hitCooldown,
    grindTimer,
    hitRecoveryTimer,
    hitRecoveryBoost,
    shakeTimer,
    shakeIntensity,
    slideVelocity,
  };
}

// ── applyTrafficHitResponse ──────────────────────────────────────────────────

/**
 * Describes the live traffic car the player just collided with.
 * Passed to applyTrafficHitResponse — pure, no DOM or audio.
 */
export interface TrafficHitDescriptor
{
  /** +1 = struck car is to the RIGHT of the player (player bounces left). */
  bumpDir:     number;
  /** True when the Barney afterburner boost is currently active. */
  isBoosting:  boolean;
  /** Mass multiplier of the struck traffic car (from TrafficCar.massMult). */
  carMassMult: number;
}

/**
 * Computes the updated player physics state after a live traffic collision,
 * and the lateral throw velocity to apply to the struck car.
 *
 * Pure function — does NOT mutate the input state.  Audio, scoring, and
 * Barney-specific logic (boost timer, kill count) remain in game.ts.
 *
 * Two core design principles applied here:
 *
 *   1. Speed is armour (OutRun):  going fast = higher effective player mass =
 *      less deceleration penalty.  Barely moving = fragile.
 *
 *   2. Car mass matters (Mario Kart): hitting Mega (heavy) is catastrophic;
 *      hitting GottaGo (light) barely slows you and they rocket sideways.
 */
export function applyTrafficHitResponse(
  state:    PhysicsState,
  hit:      TrafficHitDescriptor,
  maxSpeed: number,
): { state: PhysicsState; carThrowVelocity: number }
{
  const speedRatio = state.speed / maxSpeed;

  if (hit.isBoosting)
  {
    // Boosting: bulldoze through — no speed penalty, no lateral kick, short cooldown.
    // slideVelocity explicitly zeroed so a pre-existing drift doesn't persist through the hit.
    return {
      state: {
        ...state,
        slideVelocity:    0,
        shakeTimer:       SHAKE_TRAFFIC_DURATION * 0.4,
        shakeIntensity:   SHAKE_TRAFFIC_INTENSITY * 0.5,
        hitCooldown:      TRAFFIC_HIT_COOLDOWN_BOOSTING,
        hitRecoveryTimer: 0,
        hitRecoveryBoost: 1.0,
      },
      carThrowVelocity: hit.bumpDir * TRAFFIC_CAR_THROW_BASE * 2.0,
    };
  }

  // ── Normal hit ──────────────────────────────────────────────────────────────

  // Player effective mass scales with speed.
  // 0% speed → mass 0.50 (fragile).  100% → mass 1.50.  Clamp at 1.5 for boost.
  const playerMass = 0.5 + Math.min(speedRatio, 1.0) * 1.0;

  // Fractional speed penalty: lose a fraction of current speed, not a fraction of max.
  // Fast player (high playerMass) → smaller penalty fraction → retains more speed (speed is armour).
  // Heavy traffic car (high carMassMult) → larger penalty fraction → more speed lost.
  const penaltyFraction = Math.min(1.0, TRAFFIC_HIT_SPEED_CAP * hit.carMassMult / playerMass);
  let speed = state.speed * Math.max(0, 1.0 - penaltyFraction);
  if (speed > 0)
    speed = Math.max(speed, maxSpeed * HIT_SPEED_FLOOR);

  // Lateral flick decreases at high speed — directional stability under load.
  // flickScale → 1.0 at low speed, 0.3 at full speed.  No restitution term so
  // flick strictly decreases with speed (fast car is more planted, less lateral kick).
  const flickScale    = Math.max(0.3, 1.0 - speedRatio * 0.5);
  const bumpSign      = -hit.bumpDir;
  const slideVelocity = bumpSign * Math.min(TRAFFIC_HIT_FLICK_BASE * flickScale, 0.75);

  // Recovery boost is inversely proportional to carMassMult:
  // light car hit → snappy rebound; heavy car hit → sluggish recovery.
  const recoveryBoost = Math.max(1.0, TRAFFIC_HIT_RECOVERY_BOOST / hit.carMassMult);

  // Struck car throw: lighter cars fly further.
  const carThrowVelocity = hit.bumpDir * (TRAFFIC_CAR_THROW_BASE / hit.carMassMult);

  return {
    state: {
      ...state,
      speed,
      slideVelocity,
      shakeTimer:       SHAKE_TRAFFIC_DURATION,
      shakeIntensity:   SHAKE_TRAFFIC_INTENSITY,
      hitCooldown:      TRAFFIC_HIT_COOLDOWN,
      hitRecoveryTimer: TRAFFIC_HIT_RECOVERY_TIME,
      hitRecoveryBoost: recoveryBoost,
    },
    carThrowVelocity,
  };
}
