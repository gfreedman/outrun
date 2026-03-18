/**
 * traffic.ts
 *
 * Dynamic traffic cars — the core gameplay challenge of OutRun.
 *
 * Architecture:
 *   - TrafficCar objects live in a fixed-size pool (TRAFFIC_COUNT = 6).
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
  TRAFFIC_HITBOX_X, TRAFFIC_HITBOX_SEGS,
} from './constants';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TrafficCar
{
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

function randomLane(): number
{
  return LANES[Math.floor(Math.random() * LANES.length)];
}

function randomSpeed(): number
{
  return TRAFFIC_SPEED_MIN + Math.random() * (TRAFFIC_SPEED_MAX - TRAFFIC_SPEED_MIN);
}

function randomLaneTimer(): number
{
  return TRAFFIC_LANE_TIMER_MIN + Math.random() * (TRAFFIC_LANE_TIMER_MAX - TRAFFIC_LANE_TIMER_MIN);
}

// ── Pool management ───────────────────────────────────────────────────────────

/** Creates the initial pool of TRAFFIC_COUNT cars spread evenly ahead. */
export function initTraffic(segmentCount: number): TrafficCar[]
{
  const trackLength = segmentCount * SEGMENT_LENGTH;
  const cars: TrafficCar[] = [];

  for (let i = 0; i < TRAFFIC_COUNT; i++)
  {
    // Spread evenly over [20, DRAW_DISTANCE - 10] segments ahead at start.
    const segOffset = 20 + Math.floor(i * (DRAW_DISTANCE - 30) / TRAFFIC_COUNT);
    const worldZ    = (segOffset * SEGMENT_LENGTH) % trackLength;
    const worldX    = randomLane();

    cars.push({
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

    // ── Recycle if behind or too far ahead ────────────────────────────
    //
    // relZ is the signed distance ahead of the player (shortest arc around loop).
    // If negative, the car is behind the player — respawn it ahead.
    let relZ = car.worldZ - playerZ;
    if (relZ >  trackLength / 2) relZ -= trackLength;
    if (relZ < -trackLength / 2) relZ += trackLength;

    if (relZ < 0 || relZ > maxAhead)
    {
      const spawnSegs = 20 + Math.floor(Math.random() * (DRAW_DISTANCE - 25));
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
    let relZ = car.worldZ - playerZ;
    if (relZ >  trackLength / 2) relZ -= trackLength;
    if (relZ < -trackLength / 2) relZ += trackLength;

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
