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
  TrafficType,
  type TrafficCar,
  type TrafficUpdateConfig,
} from '../src/traffic';
import {
  TRAFFIC_COUNT,
  TRAFFIC_HITBOX_X,
  TRAFFIC_HITBOX_SEGS,
  SEGMENT_LENGTH,
  DRAW_DISTANCE,
  ROAD_WIDTH,
  CAMERA_HEIGHT,
  BARNEY_EVADE_SEGS_MIN,
  BARNEY_EVADE_RANGE,
  BANANA_WOBBLE_AMP,
  BANANA_WOBBLE_WAVELENGTH,
} from '../src/constants';
import { TRAFFIC_CAR_SPECS } from '../src/sprites';
import { TrafficBehavior } from '../src/types';

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

  it('all cars start with a positive speed', () =>
  {
    for (const car of cars)
    {
      expect(car.speed).toBeGreaterThan(0);
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
    updateTraffic(cars, { playerZ, playerX: 0, playerSpeed: 0, segmentCount: SEG_COUNT, intensity: 0, dt });

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
    updateTraffic(cars, { playerZ, playerX: 0, playerSpeed: 0, segmentCount: SEG_COUNT, intensity: 0, dt: 0.016 });

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
      type:      TrafficType.Car,
      worldZ,
      worldX,
      speed:     2000,
      targetX:   worldX,
      laneTimer: 2,
      hitVelX:   0,
      spinAngle: 0,
      massMult:  1.0,
      hitboxX:   TRAFFIC_HITBOX_X,   // Car type: hitboxMult = 1.0
      behavior:  TrafficBehavior.Standard,
    };
  }

  /** Helper: build a default TrafficUpdateConfig for tests. */
  function makeCfg(overrides: Partial<TrafficUpdateConfig> = {}): TrafficUpdateConfig
  {
    return {
      playerZ:     0,
      playerX:     0,
      playerSpeed: 5000,
      segmentCount: SEG_COUNT,
      intensity:   0,
      dt:          0.016,
      ...overrides,
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

// ── Per-type profiles ─────────────────────────────────────────────────────────

describe('initTraffic — per-type profile fields', () =>
{
  it('each spawned car has a positive massMult', () =>
  {
    const cars = initTraffic(SEG_COUNT, 12);
    for (const car of cars)
      expect(car.massMult).toBeGreaterThan(0);
  });

  it('each spawned car has a positive hitboxX', () =>
  {
    const cars = initTraffic(SEG_COUNT, 12);
    for (const car of cars)
      expect(car.hitboxX).toBeGreaterThan(0);
  });

  it('each spawned car has a recognised TrafficBehavior', () =>
  {
    const valid = new Set(Object.values(TrafficBehavior));
    const cars = initTraffic(SEG_COUNT, 12);
    for (const car of cars)
      expect(valid.has(car.behavior)).toBe(true);
  });

  it('Mega cars have higher massMult than GottaGo cars (heavy vs light)', () =>
  {
    // Spawn a large pool and find at least one of each type.
    // Seeded positions guarantee coverage across 50 cars.
    const cars = initTraffic(SEG_COUNT, 50);
    const mega    = cars.find(c => c.type === TrafficType.Mega);
    const gottago = cars.find(c => c.type === TrafficType.GottaGo);
    if (mega && gottago)
      expect(mega.massMult).toBeGreaterThan(gottago.massMult);
  });

  it('Mega hitboxX is larger than Barney hitboxX', () =>
  {
    const cars = initTraffic(SEG_COUNT, 50);
    const mega   = cars.find(c => c.type === TrafficType.Mega);
    const barney = cars.find(c => c.type === TrafficType.Barney);
    if (mega && barney)
      expect(mega.hitboxX).toBeGreaterThan(barney.hitboxX);
  });

  it('GottaGo spawns faster than Yoshi on average (speed ranges do not overlap at low end)', () =>
  {
    // At intensity 0: GottaGo min = 3200, Yoshi max = 2500 → no overlap
    // Run enough spawns to collect a sample of each
    const cars = initTraffic(SEG_COUNT, 100);
    const gottago = cars.filter(c => c.type === TrafficType.GottaGo);
    const yoshi   = cars.filter(c => c.type === TrafficType.Yoshi);
    if (gottago.length > 0 && yoshi.length > 0)
    {
      const minGottaGo = Math.min(...gottago.map(c => c.speed));
      const maxYoshi   = Math.max(...yoshi.map(c => c.speed));
      expect(minGottaGo).toBeGreaterThan(maxYoshi);
    }
  });

  it('trafficIntensity > 0 produces higher speeds than intensity 0 on average', () =>
  {
    const carsEasy = initTraffic(SEG_COUNT, 50, 0);
    const carsHard = initTraffic(SEG_COUNT, 50, 1);
    const avgEasy  = carsEasy.reduce((s, c) => s + c.speed, 0) / carsEasy.length;
    const avgHard  = carsHard.reduce((s, c) => s + c.speed, 0) / carsHard.length;
    expect(avgHard).toBeGreaterThan(avgEasy);
  });
});

// ── Behaviour: Barney evasion ─────────────────────────────────────────────────

describe('updateTraffic — Barney EVADER behaviour', () =>
{
  it('Barney moves targetX away from player when player is within evade range', () =>
  {
    // Player on the right side of the road (+X).  Barney starts in the same zone.
    // After one tick Barney's targetX should flip to the left side.
    const playerWorldX = 600;
    const playerXNorm  = playerWorldX / ROAD_WIDTH;
    const barneyX      = 500;   // inner-right lane — close to player

    const car: TrafficCar = {
      type:      TrafficType.Barney,
      worldZ:    10 * SEGMENT_LENGTH,   // 10 segs ahead of player
      worldX:    barneyX,
      speed:     2000,
      targetX:   barneyX,
      laneTimer: 3.0,
      hitVelX:   0,
      spinAngle: 0,
      massMult:  0.8,
      hitboxX:   TRAFFIC_HITBOX_X * 0.85,
      behavior:  TrafficBehavior.Evader,
    };

    // 10 segs ahead < BARNEY_EVADE_SEGS_MIN (25) so evasion should trigger
    updateTraffic([car], {
      playerZ:     0,
      playerX:     playerXNorm,
      playerSpeed: 5000,
      segmentCount: SEG_COUNT,
      intensity:   0,
      dt:          0.016,
    });

    // Barney should have fled to a negative (left-side) target
    expect(car.targetX).toBeLessThan(0);
  });

  it('Barney does NOT evade when player is far away (beyond evade trigger depth)', () =>
  {
    const playerXNorm  = 500 / ROAD_WIDTH;

    const car: TrafficCar = {
      type:      TrafficType.Barney,
      worldZ:    (BARNEY_EVADE_SEGS_MIN + 10) * SEGMENT_LENGTH,  // well beyond trigger
      worldX:    500,
      speed:     2000,
      targetX:   500,
      laneTimer: 10.0,   // won't expire during test
      hitVelX:   0,
      spinAngle: 0,
      massMult:  0.8,
      hitboxX:   TRAFFIC_HITBOX_X * 0.85,
      behavior:  TrafficBehavior.Evader,
    };

    updateTraffic([car], {
      playerZ:     0,
      playerX:     playerXNorm,
      playerSpeed: 5000,
      segmentCount: SEG_COUNT,
      intensity:   0,
      dt:          0.016,
    });

    // targetX should be unchanged (no evasion triggered)
    expect(car.targetX).toBe(500);
  });

  it('Barney does NOT evade when player is laterally far away', () =>
  {
    // Player far left, Barney far right — gap > BARNEY_EVADE_RANGE
    const gap = BARNEY_EVADE_RANGE + 200;
    const barneyX      = 1200;
    const playerWorldX = barneyX - gap;
    const playerXNorm  = playerWorldX / ROAD_WIDTH;

    const car: TrafficCar = {
      type:      TrafficType.Barney,
      worldZ:    5 * SEGMENT_LENGTH,
      worldX:    barneyX,
      speed:     2000,
      targetX:   barneyX,
      laneTimer: 10.0,
      hitVelX:   0,
      spinAngle: 0,
      massMult:  0.8,
      hitboxX:   TRAFFIC_HITBOX_X * 0.85,
      behavior:  TrafficBehavior.Evader,
    };

    updateTraffic([car], {
      playerZ:     0,
      playerX:     playerXNorm,
      playerSpeed: 5000,
      segmentCount: SEG_COUNT,
      intensity:   0,
      dt:          0.016,
    });

    expect(car.targetX).toBe(barneyX);
  });
});

// ── Behaviour: Mega road-hog ──────────────────────────────────────────────────

describe('updateTraffic — Mega ROAD_HOG behaviour', () =>
{
  it('Mega prefers centre lanes when selecting a new target (at least 50% of the time)', () =>
  {
    // Force laneTimer to expire every tick so we collect many target samples.
    const car: TrafficCar = {
      type:      TrafficType.Mega,
      worldZ:    20 * SEGMENT_LENGTH,
      worldX:    -1200,
      speed:     1200,
      targetX:   -1200,
      laneTimer: 0.0001,
      hitVelX:   0,
      spinAngle: 0,
      massMult:  2.0,
      hitboxX:   TRAFFIC_HITBOX_X * 1.3,
      behavior:  TrafficBehavior.RoadHog,
    };

    let centreCount = 0;
    const trials    = 200;

    for (let i = 0; i < trials; i++)
    {
      car.laneTimer = 0.0001;   // expire every tick
      updateTraffic([car], {
        playerZ:     0,
        playerX:     0,
        playerSpeed: 0,
        segmentCount: SEG_COUNT,
        intensity:   0,         // MEGA_CENTER_BIAS_MIN = 0.65 at intensity 0
        dt:          0.016,
      });
      if (Math.abs(car.targetX) <= 500) centreCount++;
    }

    // At 0.65 bias expect >50% centre — use a safe lower bound for statistical noise
    expect(centreCount / trials).toBeGreaterThan(0.50);
  });
});

// ── Behaviour: Banana wanderer ────────────────────────────────────────────────

describe('updateTraffic — Banana WANDERER behaviour', () =>
{
  it('Banana worldX is offset from targetX by a sine of worldZ progress', () =>
  {
    // Set worldZ so that after Z advance (speed * dt) it lands at π/2 phase.
    // sin(π/2) = 1.0 → worldX ≈ targetX + BANANA_WOBBLE_AMP
    const dt      = 0.016;
    const speed   = 3000;
    const targetX = 500;
    const arrivalZ = (Math.PI / 2) * BANANA_WOBBLE_WAVELENGTH;
    const startZ   = arrivalZ - speed * dt;

    const car: TrafficCar = {
      type:      TrafficType.Banana,
      worldZ:    startZ > 0 ? startZ : startZ + SEG_COUNT * SEGMENT_LENGTH,
      worldX:    targetX,
      speed,
      targetX,
      laneTimer: 5.0,   // won't expire
      hitVelX:   0,
      spinAngle: 0,
      massMult:  0.9,
      hitboxX:   TRAFFIC_HITBOX_X,
      behavior:  TrafficBehavior.Wanderer,
    };

    updateTraffic([car], {
      playerZ:     0,
      playerX:     0,
      playerSpeed: 0,
      segmentCount: SEG_COUNT,
      intensity:   0,
      dt,
    });

    // sin(π/2) * AMP = AMP, so worldX ≈ targetX + BANANA_WOBBLE_AMP
    expect(car.worldX).toBeCloseTo(targetX + BANANA_WOBBLE_AMP, 0);
  });
});
