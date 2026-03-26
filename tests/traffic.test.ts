/**
 * traffic.test.ts
 *
 * Tests the traffic car system — pool management, per-frame update, and
 * collision detection.
 *
 * The traffic system has three contracts that must hold regardless of tuning:
 *
 *   1. Pool integrity  — initTraffic produces exactly TRAFFIC_COUNT cars, all
 *      with valid starting values.
 *   2. Update logic    — worldZ advances correctly each frame; recycled cars
 *      always re-spawn at the far horizon (never mid-road).
 *   3. Collision logic — checkTrafficCollision fires only when both the depth
 *      window AND the lateral overlap are satisfied simultaneously.
 */

import { describe, it, expect } from 'vitest';
import {
  initTraffic,
  updateTraffic,
  checkTrafficCollision,
  type TrafficCar,
} from '../src/traffic';
import {
  TRAFFIC_COUNT,
  TRAFFIC_SPEED_MIN,
  TRAFFIC_SPEED_MAX,
  TRAFFIC_HITBOX_X,
  TRAFFIC_HITBOX_SEGS,
  SEGMENT_LENGTH,
  DRAW_DISTANCE,
  ROAD_WIDTH,
  CAMERA_HEIGHT,
} from '../src/constants';
import { TRAFFIC_CAR_SPECS } from '../src/sprites';
import { TrafficType } from '../src/traffic';

// Arbitrary but realistic segment count (matches typical Coconut Beach layout)
const SEG_COUNT  = 1200;
const TRACK_LEN  = SEG_COUNT * SEGMENT_LENGTH;

// ── Pool integrity ────────────────────────────────────────────────────────────

describe('initTraffic', () =>
{
  const cars = initTraffic(SEG_COUNT);

  it('produces exactly TRAFFIC_COUNT cars', () =>
  {
    expect(cars).toHaveLength(TRAFFIC_COUNT);
  });

  it('all cars start with speed in [TRAFFIC_SPEED_MIN, TRAFFIC_SPEED_MAX]', () =>
  {
    for (const car of cars)
    {
      expect(car.speed).toBeGreaterThanOrEqual(TRAFFIC_SPEED_MIN);
      expect(car.speed).toBeLessThanOrEqual(TRAFFIC_SPEED_MAX);
    }
  });

  it('all cars start with worldZ within track bounds', () =>
  {
    for (const car of cars)
    {
      expect(car.worldZ).toBeGreaterThanOrEqual(0);
      expect(car.worldZ).toBeLessThan(TRACK_LEN);
    }
  });

  it('all cars start with hitVelX = 0 and spinAngle = 0', () =>
  {
    for (const car of cars)
    {
      expect(car.hitVelX).toBe(0);
      expect(car.spinAngle).toBe(0);
    }
  });

  it('all cars start with a recognised TrafficType', () =>
  {
    const valid = new Set(Object.values(TrafficType));
    for (const car of cars)
    {
      expect(valid.has(car.type)).toBe(true);
    }
  });
});

// ── Update — Z advancement ────────────────────────────────────────────────────

describe('updateTraffic — Z advancement', () =>
{
  it('each car worldZ advances by speed × dt', () =>
  {
    // Pin a car at a known speed so we can calculate the exact expected delta.
    const cars  = initTraffic(SEG_COUNT);
    const dt    = 0.016;                // one 60 fps frame

    // Fix all cars to a known speed and predictable worldZ so the recycle
    // branch (relZ < 0) does NOT fire — put them all safely ahead of the player.
    const playerZ = 0;
    cars.forEach((car, i) =>
    {
      car.speed  = 2000;
      car.worldZ = (10 + i * 20) * SEGMENT_LENGTH;   // 10–50 segs ahead
    });

    const beforeZ = cars.map(c => c.worldZ);
    updateTraffic(cars, playerZ, SEG_COUNT, dt);

    for (let i = 0; i < cars.length; i++)
    {
      const expected = (beforeZ[i] + 2000 * dt) % TRACK_LEN;
      expect(cars[i].worldZ).toBeCloseTo(expected, 1);
    }
  });
});

// ── Update — spawn horizon ────────────────────────────────────────────────────

describe('updateTraffic — recycle always spawns at horizon', () =>
{
  /**
   * Place every car behind the player so all of them are recycled in one tick.
   * After update, every car must be between (DRAW_DISTANCE - 5) and
   * (DRAW_DISTANCE + 5) segments ahead — never closer.
   *
   * This is the regression test for the original bug where recycled cars could
   * spawn at random positions 20–195 segs ahead, appearing out of nowhere.
   */
  it('recycled cars spawn at DRAW_DISTANCE ± 5 segs ahead, never closer', () =>
  {
    const cars    = initTraffic(SEG_COUNT);
    const playerZ = 5000;

    // Force every car far enough behind the player to exceed TRAFFIC_TRAIL_SEGS (25 segs)
    // Cars within 25 segs behind are intentionally NOT recycled (they can catch a slowing player)
    cars.forEach(car => { car.worldZ = playerZ - 26 * SEGMENT_LENGTH; });

    // Run enough frames for the recycle branch to fire
    updateTraffic(cars, playerZ, SEG_COUNT, 0.016);

    const minSegs = DRAW_DISTANCE - 5;
    const maxSegs = DRAW_DISTANCE + 5;

    for (const car of cars)
    {
      let relZ = car.worldZ - playerZ;
      if (relZ < -TRACK_LEN / 2) relZ += TRACK_LEN;
      if (relZ >  TRACK_LEN / 2) relZ -= TRACK_LEN;

      const relSegs = relZ / SEGMENT_LENGTH;
      expect(relSegs).toBeGreaterThanOrEqual(minSegs - 0.5);   // tiny float slack
      expect(relSegs).toBeLessThanOrEqual(maxSegs + 0.5);
    }
  });
});

// ── Collision detection ───────────────────────────────────────────────────────

describe('checkTrafficCollision', () =>
{
  /** Helper: build a minimal TrafficCar at a known position. */
  function makeCar(worldX: number, worldZ: number): TrafficCar
  {
    return {
      type: TrafficType.Car,
      worldZ,
      worldX,
      speed:     2000,
      targetX:   worldX,
      laneTimer: 2,
      hitVelX:   0,
      spinAngle: 0,
    };
  }

  it('returns null when no cars are in range', () =>
  {
    const playerX     = 0;   // normalised
    const playerZ     = 0;
    const playerSpeed = 5000;
    // Place car just beyond the depth window
    const cars = [makeCar(0, (TRAFFIC_HITBOX_SEGS + 5) * SEGMENT_LENGTH)];
    const result = checkTrafficCollision(playerX, playerZ, playerSpeed, cars, SEG_COUNT);
    expect(result).toBeNull();
  });

  it('detects a direct hit (same lane, within depth window)', () =>
  {
    const playerX     = 0;   // centred
    const playerZ     = 0;
    const playerSpeed = 8000;
    // Place car 2 segs ahead, same lateral position
    const cars = [makeCar(0, 2 * SEGMENT_LENGTH)];
    const result = checkTrafficCollision(playerX, playerZ, playerSpeed, cars, SEG_COUNT);
    expect(result).not.toBeNull();
  });

  /**
   * Inner lanes are at ±500 wu, so adjacent gap = 1000 wu.
   * TRAFFIC_HITBOX_X = 400, so the gap (1000) > 2 × TRAFFIC_HITBOX_X (800).
   * A car in the adjacent lane must NOT trigger a collision.
   */
  it('does not fire for a car in an adjacent lane (gap > 2 × TRAFFIC_HITBOX_X)', () =>
  {
    const innerLeft   = -500;                          // inner-left lane (world units)
    const innerRight  =  500;                          // inner-right lane (world units)
    const playerX     = innerLeft / ROAD_WIDTH;        // normalised
    const playerZ     = 0;
    const playerSpeed = 8000;
    // Verify the geometry: adjacent gap must exceed the combined hitbox so no hit fires
    expect(Math.abs(innerRight - innerLeft)).toBeGreaterThan(2 * TRAFFIC_HITBOX_X);
    // Car in inner-right lane, within depth window
    const cars = [makeCar(innerRight, 2 * SEGMENT_LENGTH)];
    const result = checkTrafficCollision(playerX, playerZ, playerSpeed, cars, SEG_COUNT);
    expect(result).toBeNull();
  });

  it('returns correct bumpDir: +1 when car is to the right of player', () =>
  {
    const playerX     = -200 / ROAD_WIDTH;   // slightly left of centre
    const playerZ     = 0;
    const playerSpeed = 8000;
    // Car centred, 1 seg ahead — to the right of player
    const cars = [makeCar(0, SEGMENT_LENGTH)];
    const result = checkTrafficCollision(playerX, playerZ, playerSpeed, cars, SEG_COUNT);
    expect(result?.bumpDir).toBe(+1);
  });

  it('returns correct bumpDir: -1 when car is to the left of player', () =>
  {
    const playerX     = 200 / ROAD_WIDTH;    // slightly right of centre
    const playerZ     = 0;
    const playerSpeed = 8000;
    // Car centred, 1 seg ahead — to the left of player
    const cars = [makeCar(0, SEGMENT_LENGTH)];
    const result = checkTrafficCollision(playerX, playerZ, playerSpeed, cars, SEG_COUNT);
    expect(result?.bumpDir).toBe(-1);
  });

  it('closingSpeed is non-negative (player catches car, not vice versa)', () =>
  {
    const playerSpeed = 8000;
    const carSpeed    = 2000;
    const playerX     = 0;
    const playerZ     = 0;
    const car         = { ...makeCar(0, SEGMENT_LENGTH), speed: carSpeed };
    const result = checkTrafficCollision(playerX, playerZ, playerSpeed, [car], SEG_COUNT);
    expect(result?.closingSpeed).toBeGreaterThanOrEqual(0);
    expect(result?.closingSpeed).toBeCloseTo(playerSpeed - carSpeed);
  });

  it('returns null when car is behind the player (relZ < 0)', () =>
  {
    const playerX     = 0;
    const playerZ     = 10 * SEGMENT_LENGTH;
    const playerSpeed = 5000;
    // Car placed behind the player
    const cars = [makeCar(0, 5 * SEGMENT_LENGTH)];
    const result = checkTrafficCollision(playerX, playerZ, playerSpeed, cars, SEG_COUNT);
    expect(result).toBeNull();
  });
});

// ── TRAFFIC_CAR_SPECS completeness ───────────────────────────────────────────

describe('TRAFFIC_CAR_SPECS', () =>
{
  /**
   * Every TrafficType that traffic.ts can spawn must have a spec entry.
   * A missing entry would cause the renderer to silently skip that car.
   */
  it('has an entry for every TrafficType', () =>
  {
    for (const type of Object.values(TrafficType))
    {
      expect(TRAFFIC_CAR_SPECS).toHaveProperty(type);
    }
  });

  it('all specs have positive frameW, frameH, and worldH', () =>
  {
    for (const [, spec] of Object.entries(TRAFFIC_CAR_SPECS))
    {
      expect(spec.frameW).toBeGreaterThan(0);
      expect(spec.frameH).toBeGreaterThan(0);
      expect(spec.worldH).toBeGreaterThan(0);
    }
  });

  it('all specs have a non-empty assetPath ending in .png', () =>
  {
    for (const [, spec] of Object.entries(TRAFFIC_CAR_SPECS))
    {
      expect(spec.assetPath).toBeTruthy();
      expect(spec.assetPath.endsWith('.png')).toBe(true);
    }
  });

  /**
   * The worldH of every traffic car must be less than CAMERA_HEIGHT (1000).
   * A car taller than the camera height would project above the horizon line
   * and break the perspective scaling formula.
   */
  it('all worldH values are less than CAMERA_HEIGHT (1000)', () =>
  {
    for (const [, spec] of Object.entries(TRAFFIC_CAR_SPECS))
    {
      expect(spec.worldH).toBeLessThan(CAMERA_HEIGHT);
    }
  });
});
