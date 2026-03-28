/**
 * traffic.ts
 *
 * Dynamic traffic cars — the core gameplay challenge of OutRun.
 *
 * Architecture:
 *   - TrafficCar objects live in a fixed-size pool (TRAFFIC_COUNT default).
 *   - Each car has a world-Z depth, world-X lateral position, forward speed,
 *     and a behaviour archetype (Standard, Evader, Speedster, EdgeHugger,
 *     Wanderer, RoadHog) that drives distinct lane-selection logic.
 *   - updateTraffic() advances positions each frame and recycles cars that
 *     have been passed by the player back to a new spawn slot ahead.
 *   - checkTrafficCollision() runs a Z-depth + lateral overlap test using
 *     per-car hitbox widths derived from the type's profile.
 *
 * All values use the same world-unit coordinate system as the road:
 *   ROAD_WIDTH = 2000 (half-road), SEGMENT_LENGTH = 200.
 */

import {
  ROAD_WIDTH, SEGMENT_LENGTH, DRAW_DISTANCE,
  TRAFFIC_COUNT,
  TRAFFIC_HITBOX_X,
  TRAFFIC_HITBOX_SEGS, TRAFFIC_TRAIL_SEGS,
  TRAFFIC_SPEED_INTENSITY_FLOOR_SCALE, TRAFFIC_SPEED_INTENSITY_CEIL_SCALE,
  BARNEY_EVADE_SEGS_MIN, BARNEY_EVADE_SEGS_MAX,
  BARNEY_EVADE_RANGE, BARNEY_EVADE_RATE_MIN, BARNEY_EVADE_RATE_MAX,
  MEGA_CENTER_BIAS_MIN, MEGA_CENTER_BIAS_MAX,
  BANANA_WOBBLE_AMP, BANANA_WOBBLE_WAVELENGTH,
} from './constants';
import { TrafficBehavior, TrafficProfile } from './types';

// ── Car type enum ─────────────────────────────────────────────────────────────

/**
 * Vehicle type for a traffic car.
 * Enum (not string union) so Object.values(TrafficType) always reflects the full
 * set — adding a member here automatically includes it in randomType() and the
 * sprite loader loop in game.ts without needing to update a parallel array.
 */
export enum TrafficType
{
  /** Standard yellow traffic car -- the most common obstacle. */
  Car     = 'car',
  /** Purple dinosaur car -- awards afterburner boost on kill. */
  Barney  = 'barney',
  /** Small blue speedster -- fast-moving, erratic lane changes. */
  GottaGo = 'gottago',
  /** Green Yoshi-themed car -- prefers outer lanes, gentle behaviour. */
  Yoshi   = 'yoshi',
  /** Yellow banana car -- chaotic micro-wobble, unpredictable. */
  Banana  = 'banana',
  /** Blue mega car -- heavy, slow, hogs the centre of the road. */
  Mega    = 'mega',
}

// ── Per-type personality profiles ─────────────────────────────────────────────

/**
 * Stat block for each traffic type.
 * Lives in traffic.ts (not constants.ts) to avoid circular imports, since
 * constants.ts is already imported by traffic.ts.
 * Internal — use the TrafficProfile fields stored on each TrafficCar at spawn.
 */
const TRAFFIC_PROFILE: Record<TrafficType, TrafficProfile> =
{
  [TrafficType.Car]:     { speedMin: 1800, speedMax: 4200, weaveRate: 900,  laneTimerMin: 2.0, laneTimerMax: 4.5, hitboxMult: 1.00, massMult: 1.00 },
  [TrafficType.Barney]:  { speedMin: 1500, speedMax: 2800, weaveRate: 600,  laneTimerMin: 3.0, laneTimerMax: 5.0, hitboxMult: 0.85, massMult: 0.80 },
  [TrafficType.GottaGo]: { speedMin: 3200, speedMax: 6500, weaveRate: 1800, laneTimerMin: 0.8, laneTimerMax: 2.0, hitboxMult: 0.90, massMult: 0.70 },
  [TrafficType.Yoshi]:   { speedMin: 1000, speedMax: 2500, weaveRate: 700,  laneTimerMin: 2.5, laneTimerMax: 5.5, hitboxMult: 1.10, massMult: 0.90 },
  [TrafficType.Banana]:  { speedMin: 2000, speedMax: 4000, weaveRate: 2200, laneTimerMin: 0.4, laneTimerMax: 1.5, hitboxMult: 1.00, massMult: 0.90 },
  [TrafficType.Mega]:    { speedMin:  800, speedMax: 1800, weaveRate: 400,  laneTimerMin: 4.0, laneTimerMax: 8.0, hitboxMult: 1.30, massMult: 2.00 },
};

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface TrafficCar
{
  /** Vehicle type — determines sprite sheet and personality profile. */
  type:      TrafficType;
  /** World depth (same coordinate as playerZ; wraps modulo trackLength). */
  worldZ:    number;
  /** Lateral position in world units. Lanes: ±500 inner, ±1200 outer. */
  worldX:    number;
  /** Forward speed in world units / second. */
  speed:     number;
  /** Current lane-drift target (world units). */
  targetX:   number;
  /** Seconds until next lane-target change. */
  laneTimer: number;
  /** Lateral throw velocity after being hit (world units / sec). Decays over time. */
  hitVelX:   number;
  /** Cumulative spin angle in radians — accumulates while hitVelX is active. */
  spinAngle: number;
  /**
   * Collision mass multiplier (from type profile, set at spawn).
   * > 1 = heavy (Mega): player slows more, car barely moves.
   * < 1 = light (GottaGo): player barely slows, car rockets away.
   */
  massMult:  number;
  /**
   * Lateral hitbox half-width in world units (from type profile, set at spawn).
   * Derived as TRAFFIC_HITBOX_X * profile.hitboxMult.
   */
  hitboxX:   number;
  /** Behavioural archetype — drives lane selection and reactive AI. */
  behavior:  TrafficBehavior;
}

/**
 * Result returned by checkTrafficCollision() when a player-to-traffic
 * overlap is detected.
 */
export interface TrafficHitResult
{
  /**
   * +1 = traffic car is to the RIGHT of the player (player bounces left).
   * -1 = traffic car is to the LEFT  (player bounces right).
   */
  bumpDir:      number;
  /**
   * Closing speed in world units / second (player speed − car speed, ≥ 0).
   */
  closingSpeed: number;
  /** Reference to the car that was hit — caller applies lateral kick and type check. */
  hitCar:       TrafficCar;
}

/**
 * Configuration passed to updateTraffic() each frame.
 * Bundles all per-tick context so the function signature stays stable as
 * new parameters are added.
 */
export interface TrafficUpdateConfig
{
  /** Player's current world depth. */
  playerZ:      number;
  /** Player's normalised lateral position [-1..+1]. Used by Barney evasion AI. */
  playerX:      number;
  /** Player's forward speed (wu/s). Carried for future GottaGo speed-matching. */
  playerSpeed:  number;
  /** Total road segments — used to compute track wrap length. */
  segmentCount: number;
  /**
   * Difficulty intensity [0..1] from RACE_CONFIG[mode].trafficIntensity.
   * Scales speed ranges and behavioural aggressiveness.
   */
  intensity:    number;
  /** Frame delta-time in seconds. */
  dt:           number;
}

// ── Lane positions (world units) ──────────────────────────────────────────────

/** The four valid lane centre positions. */
const LANES        = [-1200, -500, 500, 1200] as const;
const CENTRE_LANES = [-500,  500 ] as const;
const OUTER_LANES  = [-1200, 1200] as const;

function randomLane(): number
{
  return LANES[Math.floor(Math.random() * LANES.length)];
}

/**
 * Returns a lane target biased by the car's behaviour.
 * RoadHog picks centre lanes with probability centerBias.
 * EdgeHugger picks outer lanes with 80% probability.
 * All others pick uniformly.
 */
function behaviorLane(behavior: TrafficBehavior, centerBias: number): number
{
  if (behavior === TrafficBehavior.RoadHog)
  {
    return Math.random() < centerBias
      ? CENTRE_LANES[Math.floor(Math.random() * CENTRE_LANES.length)]
      : OUTER_LANES [Math.floor(Math.random() * OUTER_LANES.length)];
  }
  if (behavior === TrafficBehavior.EdgeHugger)
  {
    return Math.random() < 0.80
      ? OUTER_LANES [Math.floor(Math.random() * OUTER_LANES.length)]
      : CENTRE_LANES[Math.floor(Math.random() * CENTRE_LANES.length)];
  }
  return randomLane();
}

/** Maps a TrafficType to its behavioural archetype. */
function behaviorForType(type: TrafficType): TrafficBehavior
{
  switch (type)
  {
    case TrafficType.Barney:  return TrafficBehavior.Evader;
    case TrafficType.GottaGo: return TrafficBehavior.Speedster;
    case TrafficType.Yoshi:   return TrafficBehavior.EdgeHugger;
    case TrafficType.Banana:  return TrafficBehavior.Wanderer;
    case TrafficType.Mega:    return TrafficBehavior.RoadHog;
    default:                  return TrafficBehavior.Standard;
  }
}

/** All valid TrafficType values; cached to avoid Object.values() on every spawn. */
const TRAFFIC_TYPES = Object.values(TrafficType);

function randomType(): TrafficType
{
  return TRAFFIC_TYPES[Math.floor(Math.random() * TRAFFIC_TYPES.length)];
}

// ── Private helpers ───────────────────────────────────────────────────────────

function lerp(a: number, b: number, t: number): number
{
  return a + (b - a) * t;
}

/**
 * Returns a random speed for the given type, scaled by difficulty intensity.
 * At intensity 0: uses the base profile range.
 * At intensity 1: floor raised by FLOOR_SCALE, ceiling raised by CEIL_SCALE.
 */
function profileSpeed(type: TrafficType, intensity: number): number
{
  const p     = TRAFFIC_PROFILE[type];
  const floor = p.speedMin * (1 + intensity * TRAFFIC_SPEED_INTENSITY_FLOOR_SCALE);
  const ceil  = p.speedMax * (1 + intensity * TRAFFIC_SPEED_INTENSITY_CEIL_SCALE);
  return floor + Math.random() * (ceil - floor);
}

/** Returns a random lane-timer duration within the type's profile range. */
function profileLaneTimer(type: TrafficType): number
{
  const p = TRAFFIC_PROFILE[type];
  return p.laneTimerMin + Math.random() * (p.laneTimerMax - p.laneTimerMin);
}

/**
 * Signed distance from playerZ to car.worldZ along the shortest arc of the
 * looping track.  Positive = car is ahead of the player.
 */
function relativeZ(carWorldZ: number, playerZ: number, trackLength: number): number
{
  let relZ = carWorldZ - playerZ;
  if (relZ >  trackLength / 2) relZ -= trackLength;
  if (relZ < -trackLength / 2) relZ += trackLength;
  return relZ;
}

// ── Pool management ───────────────────────────────────────────────────────────

/**
 * Creates the initial traffic pool with per-type personalities.
 *
 * @param segmentCount  Total road segments.
 * @param trafficCount  Pool size. Defaults to TRAFFIC_COUNT.
 * @param intensity     Difficulty intensity [0..1]. Defaults to 0.
 */
export function initTraffic(
  segmentCount: number,
  trafficCount  = TRAFFIC_COUNT,
  intensity     = 0,
): TrafficCar[]
{
  const trackLength  = segmentCount * SEGMENT_LENGTH;
  const cars: TrafficCar[] = [];
  const count        = Math.max(1, trafficCount);
  const centerBias   = lerp(MEGA_CENTER_BIAS_MIN, MEGA_CENTER_BIAS_MAX, intensity);

  for (let i = 0; i < count; i++)
  {
    const segOffset = 20 + Math.floor(i * (DRAW_DISTANCE - 30) / count);
    const worldZ    = (segOffset * SEGMENT_LENGTH) % trackLength;
    const type      = randomType();
    const behavior  = behaviorForType(type);
    const profile   = TRAFFIC_PROFILE[type];
    const worldX    = behaviorLane(behavior, centerBias);

    cars.push({
      type,
      worldZ,
      worldX,
      speed:     profileSpeed(type, intensity),
      targetX:   worldX,
      laneTimer: profileLaneTimer(type),
      hitVelX:   0,
      spinAngle: 0,
      massMult:  profile.massMult,
      hitboxX:   TRAFFIC_HITBOX_X * profile.hitboxMult,
      behavior,
    });
  }

  return cars;
}

// ── Per-frame update ──────────────────────────────────────────────────────────

/**
 * Advances all traffic cars one physics step.
 *
 * Each car:
 *   1. Moves forward by speed × dt (wrapping around the track).
 *   2. Executes behaviour-specific lane logic (or hit-reaction lateral throw).
 *   3. Is recycled to the far horizon if it falls too far behind or too far
 *      ahead of the player — receiving a fresh type and profile on respawn.
 */
export function updateTraffic(
  cars: TrafficCar[],
  cfg:  TrafficUpdateConfig,
): void
{
  const { playerZ, playerX, segmentCount, intensity, dt } = cfg;
  const trackLength  = segmentCount * SEGMENT_LENGTH;
  const maxAhead     = (DRAW_DISTANCE + 20) * SEGMENT_LENGTH;
  const playerWorldX = playerX * ROAD_WIDTH;

  // Intensity-scaled parameters computed once per frame (not per car).
  const barneyEvadeDepth = lerp(BARNEY_EVADE_SEGS_MIN, BARNEY_EVADE_SEGS_MAX, intensity)
                           * SEGMENT_LENGTH;
  const barneyEvadeRate  = lerp(BARNEY_EVADE_RATE_MIN, BARNEY_EVADE_RATE_MAX, intensity);
  const megaCenterBias   = lerp(MEGA_CENTER_BIAS_MIN,  MEGA_CENTER_BIAS_MAX,  intensity);

  for (const car of cars)
  {
    // ── Advance Z ────────────────────────────────────────────────────────
    car.worldZ = (car.worldZ + car.speed * dt) % trackLength;

    // ── Relative depth (shared by behaviour AI and recycle gate) ─────────
    const relZ = relativeZ(car.worldZ, playerZ, trackLength);

    // ── Hit reaction overrides lane weave ────────────────────────────────
    if (car.hitVelX !== 0)
    {
      car.worldX    += car.hitVelX * dt;
      car.spinAngle += Math.sign(car.hitVelX) * (Math.abs(car.hitVelX) / 1000) * 3.0 * dt;
      car.hitVelX   *= Math.exp(-1.2 * dt);
      if (Math.abs(car.hitVelX) < 30) car.hitVelX = 0;
    }
    else
    {
      // Decrement the lane timer once per frame regardless of behaviour.
      car.laneTimer -= dt;

      // ── Behaviour-specific lane AI ─────────────────────────────────────
      switch (car.behavior)
      {
        case TrafficBehavior.Evader:
        {
          // Barney: flees to the opposite outer lane when the player closes in.
          // Uses the type's slow weave rate so a committed player can still intercept.
          if (relZ > 0 && relZ < barneyEvadeDepth &&
              Math.abs(car.worldX - playerWorldX) < BARNEY_EVADE_RANGE)
          {
            // Force target to the outer lane furthest from the player.
            car.targetX   = playerWorldX >= 0 ? -1200 : 1200;
            // Prevent the timer from resetting the target until the flight is complete.
            car.laneTimer = Math.max(car.laneTimer, 0.8);
          }
          else if (car.laneTimer <= 0)
          {
            car.targetX   = randomLane();
            car.laneTimer = profileLaneTimer(TrafficType.Barney);
          }
          const barneyStep = barneyEvadeRate * dt;
          const barneyDx   = car.targetX - car.worldX;
          car.worldX = Math.abs(barneyDx) <= barneyStep
            ? car.targetX
            : car.worldX + Math.sign(barneyDx) * barneyStep;
          break;
        }

        case TrafficBehavior.Wanderer:
        {
          // Banana: update targetX normally but override worldX with a sine
          // oscillation keyed to forward progress — gives a permanently
          // unstable wobble with no position drift.
          if (car.laneTimer <= 0)
          {
            car.targetX   = randomLane();
            car.laneTimer = profileLaneTimer(TrafficType.Banana);
          }
          const phase = car.worldZ / BANANA_WOBBLE_WAVELENGTH;
          car.worldX  = car.targetX + Math.sin(phase) * BANANA_WOBBLE_AMP;
          break;
        }

        case TrafficBehavior.RoadHog:
        {
          // Mega: biased toward centre lanes.
          if (car.laneTimer <= 0)
          {
            car.targetX   = behaviorLane(TrafficBehavior.RoadHog, megaCenterBias);
            car.laneTimer = profileLaneTimer(TrafficType.Mega);
          }
          const megaProfile = TRAFFIC_PROFILE[TrafficType.Mega];
          const megaStep    = megaProfile.weaveRate * dt;
          const megaDx      = car.targetX - car.worldX;
          car.worldX = Math.abs(megaDx) <= megaStep
            ? car.targetX
            : car.worldX + Math.sign(megaDx) * megaStep;
          break;
        }

        default:
        {
          // Standard / EdgeHugger / Speedster — normal weave with per-type rate.
          if (car.laneTimer <= 0)
          {
            car.targetX   = behaviorLane(car.behavior, megaCenterBias);
            car.laneTimer = profileLaneTimer(car.type);
          }
          const profile = TRAFFIC_PROFILE[car.type];
          const step    = profile.weaveRate * dt;
          const dx      = car.targetX - car.worldX;
          car.worldX = Math.abs(dx) <= step
            ? car.targetX
            : car.worldX + Math.sign(dx) * step;
          break;
        }
      }
    }

    // ── Recycle ───────────────────────────────────────────────────────────
    const trailLimit = -(TRAFFIC_TRAIL_SEGS * SEGMENT_LENGTH);

    if (relZ < trailLimit || relZ > maxAhead)
    {
      const spawnSegs = DRAW_DISTANCE - 5 + Math.floor(Math.random() * 10);
      const type      = randomType();
      const behavior  = behaviorForType(type);
      const profile   = TRAFFIC_PROFILE[type];
      car.type      = type;
      car.worldZ    = (playerZ + spawnSegs * SEGMENT_LENGTH) % trackLength;
      car.worldX    = behaviorLane(behavior, megaCenterBias);
      car.speed     = profileSpeed(type, intensity);
      car.targetX   = car.worldX;
      car.laneTimer = profileLaneTimer(type);
      car.hitVelX   = 0;
      car.spinAngle = 0;
      car.massMult  = profile.massMult;
      car.hitboxX   = TRAFFIC_HITBOX_X * profile.hitboxMult;
      car.behavior  = behavior;
    }
  }
}

// ── Collision detection ───────────────────────────────────────────────────────

/**
 * Checks whether the player overlaps any traffic car.
 *
 * Uses the per-car hitboxX (derived from the type's profile at spawn), so
 * heavier/larger cars like Mega are easier to clip and smaller ones like Barney
 * require a more precise approach.
 */
export function checkTrafficCollision(
  playerX:      number,
  playerZ:      number,
  playerSpeed:  number,
  cars:         readonly TrafficCar[],
  segmentCount: number,
): TrafficHitResult | null
{
  const trackLength  = segmentCount * SEGMENT_LENGTH;
  const playerWorldX = playerX * ROAD_WIDTH;
  const depthWindow  = TRAFFIC_HITBOX_SEGS * SEGMENT_LENGTH;

  for (const car of cars)
  {
    const relZ = relativeZ(car.worldZ, playerZ, trackLength);

    if (relZ < 0 || relZ > depthWindow) continue;

    // Per-car hitbox width — set from type profile at spawn / recycle.
    if (Math.abs(playerWorldX - car.worldX) > car.hitboxX) continue;

    return {
      bumpDir:      car.worldX >= playerWorldX ? +1 : -1,
      closingSpeed: Math.max(0, playerSpeed - car.speed),
      hitCar:       car,
    };
  }

  return null;
}
