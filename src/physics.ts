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
  // Linear grip loss (was quadratic ×0.5): more planted feel at high speed.
  // At max speed: 75% grip retained vs. 50% before.
  const gripFactor = 1 - speedRatio * 0.25;

  // Trail braking: brake + steer = 25% grip bonus, rewards cornering skill.
  const trailBraking  = input.brake && (input.steerLeft || input.steerRight);
  const effectiveGrip = gripFactor * (trailBraking ? 1.25 : 1.0);

  // Steering inertia: velocity ramps when key held, springs back on release.
  // STEER_RAMP=24 → reaches PLAYER_STEERING in ~6 frames (100ms).
  // STEER_RETURN=20 → decays to ~5% in ~9 frames (150ms).
  const STEER_RAMP   = 24.0;
  const STEER_RETURN = 20.0;

  if (speed > 0)
  {
    if (input.steerLeft)
      steerVelocity = Math.max(steerVelocity - STEER_RAMP * dt, -PLAYER_STEERING);
    else if (input.steerRight)
      steerVelocity = Math.min(steerVelocity + STEER_RAMP * dt,  PLAYER_STEERING);
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
  const gripFactor       = 1 - preHitSpeedRatio * 0.25;
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
