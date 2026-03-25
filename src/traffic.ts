/**
 * traffic.ts
 *
 * Dynamic traffic cars — the core gameplay challenge of OutRun.
 *
 * Architecture:
 *   - TrafficCar objects live in a fixed-size pool (TRAFFIC_COUNT = 3).
 *   - Each car has a world-Z depth, world-X lateral position, forward speed,
 *     and a lazy lane-weave AI (picks a new target lane every 1.5–4.5 s).
 *   - updateTraffic() advances positions each frame and recycles cars that
 *     have been passed by the player back to a new spawn slot ahead.
 *   - checkTrafficCollision() runs a separate Z-depth + lateral overlap test
 *     that is independent of the static sprite collision system.
 *
 * All values use the same world-unit coordinate system as the road:
 *   ROAD_WIDTH = 2000 (half-road), SEGMENT_LENGTH = 200.
 */

import {
  ROAD_WIDTH, SEGMENT_LENGTH, DRAW_DISTANCE,
  TRAFFIC_COUNT,
  TRAFFIC_SPEED_MIN, TRAFFIC_SPEED_MAX,
  TRAFFIC_LANE_TIMER_MIN, TRAFFIC_LANE_TIMER_MAX, TRAFFIC_WEAVE_RATE,
  TRAFFIC_HITBOX_X, TRAFFIC_HITBOX_SEGS, TRAFFIC_TRAIL_SEGS,
} from './constants';

// ── Types ─────────────────────────────────────────────────────────────────────

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
  /** Small blue speedster -- fast-moving, harder to catch. */
  GottaGo = 'gottago',
  /** Green Yoshi-themed car -- standard traffic behaviour. */
  Yoshi   = 'yoshi',
  /** Yellow banana car -- standard traffic behaviour. */
  Banana  = 'banana',
  /** Blue mega car -- standard traffic behaviour. */
  Mega    = 'mega',
}

export interface TrafficCar
{
  /** Vehicle type — determines which sprite sheet and world height to use. */
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
}

/**
 * Result returned by checkTrafficCollision() when a player-to-traffic
 * overlap is detected.  Contains the bump direction, closing speed, and
 * a reference to the struck car so the caller can apply lateral kick.
 */
export interface TrafficHitResult
{
  /**
   * +1 = traffic car is to the RIGHT of the player (player bounces left).
   * -1 = traffic car is to the LEFT  (player bounces right).
   */
  bumpDir:      number;
  /**
   * Closing speed in world units / second (player speed − car speed).
   * Higher closing speed → bigger penalty.
   */
  closingSpeed: number;
  /** Reference to the car that was hit — caller applies the lateral kick. */
  hitCar:       TrafficCar;
}

// ── Lane positions (world units) ──────────────────────────────────────────────

/** The four valid lane centre positions. */
const LANES = [-1200, -500, 500, 1200] as const;

/** Returns a randomly chosen lane centre X from the four valid positions. */
function randomLane(): number
{
  return LANES[Math.floor(Math.random() * LANES.length)];
}

/** Returns a random forward speed in [TRAFFIC_SPEED_MIN, TRAFFIC_SPEED_MAX]. */
function randomSpeed(): number
{
  return TRAFFIC_SPEED_MIN + Math.random() * (TRAFFIC_SPEED_MAX - TRAFFIC_SPEED_MIN);
}

/** Returns a random seconds-until-next-lane-change in [TIMER_MIN, TIMER_MAX]. */
function randomLaneTimer(): number
{
  return TRAFFIC_LANE_TIMER_MIN + Math.random() * (TRAFFIC_LANE_TIMER_MAX - TRAFFIC_LANE_TIMER_MIN);
}

/** All valid TrafficType values; cached to avoid Object.values() on every spawn. */
const TRAFFIC_TYPES = Object.values(TrafficType);

/** Returns a uniformly random TrafficType from the full enum. */
function randomType(): TrafficType
{
  return TRAFFIC_TYPES[Math.floor(Math.random() * TRAFFIC_TYPES.length)];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Signed distance from playerZ to car.worldZ along the shortest arc of the
 * looping track.  Positive = car is ahead of the player.
 *
 * Used by both updateTraffic (recycle gate) and checkTrafficCollision (depth
 * window).  Centralised here so the two sites can't drift apart.
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
 * Creates the initial traffic pool.
 * @param segmentCount  - Total road segments (used to compute track wrap length).
 * @param trafficCount  - Number of cars to spawn.  Defaults to TRAFFIC_COUNT.
 */
export function initTraffic(segmentCount: number, trafficCount = TRAFFIC_COUNT): TrafficCar[]
{
  const trackLength = segmentCount * SEGMENT_LENGTH;
  const cars: TrafficCar[] = [];
  const count = Math.max(1, trafficCount);

  for (let i = 0; i < count; i++)
  {
    // Spread evenly over [20, DRAW_DISTANCE - 10] segments ahead at start.
    const segOffset = 20 + Math.floor(i * (DRAW_DISTANCE - 30) / count);
    const worldZ    = (segOffset * SEGMENT_LENGTH) % trackLength;
    const worldX    = randomLane();

    cars.push({
      type:      randomType(),
      worldZ,
      worldX,
      speed:     randomSpeed(),
      targetX:   worldX,
      laneTimer: randomLaneTimer(),
      hitVelX:   0,
      spinAngle: 0,
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
 *   2. May pick a new lane target (lazy weave AI).
 *   3. Applies lateral throw velocity if the car was recently hit (with spin).
 *   4. Is recycled to the far horizon if it falls too far behind or shoots
 *      too far ahead of the player.
 *
 * @param cars         - Mutable traffic car pool.
 * @param playerZ      - Player's current world depth.
 * @param segmentCount - Total road segments (used to compute track wrap length).
 * @param dt           - Frame delta-time in seconds.
 */
export function updateTraffic(
  cars:         TrafficCar[],
  playerZ:      number,
  segmentCount: number,
  dt:           number,
): void
{
  const trackLength = segmentCount * SEGMENT_LENGTH;
  const maxAhead    = (DRAW_DISTANCE + 20) * SEGMENT_LENGTH;

  for (const car of cars)
  {
    // ── Advance Z ────────────────────────────────────────────────────────
    car.worldZ = (car.worldZ + car.speed * dt) % trackLength;

    // ── Lane weave AI ─────────────────────────────────────────────────
    car.laneTimer -= dt;
    if (car.laneTimer <= 0)
    {
      car.targetX   = randomLane();
      car.laneTimer = randomLaneTimer();
    }

    // ── Hit reaction — lateral throw + spin ───────────────────────────
    if (car.hitVelX !== 0)
    {
      car.worldX    += car.hitVelX * dt;
      // Spin accumulates proportional to lateral velocity (faster throw = faster spin)
      car.spinAngle += Math.sign(car.hitVelX) * (Math.abs(car.hitVelX) / 1000) * 3.0 * dt;
      // Exponential decay — car keeps flying for ~2 seconds before settling
      car.hitVelX   *= Math.exp(-1.2 * dt);
      if (Math.abs(car.hitVelX) < 30) car.hitVelX = 0;
    }
    else
    {
      // Normal lane-weave only when not in hit reaction
      const dx   = car.targetX - car.worldX;
      const step = TRAFFIC_WEAVE_RATE * dt;
      car.worldX  = Math.abs(dx) <= step ? car.targetX : car.worldX + Math.sign(dx) * step;
    }

    // ── Recycle if too far behind or too far ahead ────────────────────
    //
    // relZ is the signed distance ahead of the player (shortest arc).
    // Cars are allowed to trail TRAFFIC_TRAIL_SEGS behind the player so that
    // a slowing player can be caught up by recently-passed traffic.  Only
    // recycle once the trailing gap exceeds that window.
    const relZ      = relativeZ(car.worldZ, playerZ, trackLength);
    const trailLimit = -(TRAFFIC_TRAIL_SEGS * SEGMENT_LENGTH);

    if (relZ < trailLimit || relZ > maxAhead)
    {
      // Always spawn at the far horizon so cars are never seen popping in.
      // Jitter ±5 segs so cars don't all materialise at the exact same depth.
      const spawnSegs = DRAW_DISTANCE - 5 + Math.floor(Math.random() * 10);
      car.type      = randomType();
      car.worldZ    = (playerZ + spawnSegs * SEGMENT_LENGTH) % trackLength;
      car.worldX    = randomLane();
      car.speed     = randomSpeed();
      car.targetX   = car.worldX;
      car.laneTimer = randomLaneTimer();
      car.hitVelX   = 0;
      car.spinAngle = 0;
    }
  }
}

// ── Collision detection ───────────────────────────────────────────────────────

/**
 * Checks whether the player is colliding with any traffic car.
 *
 * Returns the worst (first found) hit, or null if clear.
 * Completely separate from checkCollisions() which only scans static sprites.
 *
 * @param playerX     Normalised lateral position (-1…+1).
 * @param playerZ     World depth of player.
 * @param playerSpeed World units / second.
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
    // Signed relative depth (shortest arc)
    const relZ = relativeZ(car.worldZ, playerZ, trackLength);

    // Must be in the window directly ahead of the player
    if (relZ < 0 || relZ > depthWindow) continue;

    // Lateral overlap
    if (Math.abs(playerWorldX - car.worldX) > TRAFFIC_HITBOX_X) continue;

    return {
      bumpDir:      car.worldX >= playerWorldX ? +1 : -1,
      closingSpeed: Math.max(0, playerSpeed - car.speed),
      hitCar:       car,
    };
  }

  return null;
}
