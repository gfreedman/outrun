/**
 * traffic.test.ts
 *
 * Tests the traffic car system — pool management, per-frame update, and
 * collision detection.
 *
 * Architecture overview — why a pool?
 * ─────────────────────────────────────
 * Traffic is represented as a fixed-size array of TrafficCar objects allocated
 * once at game start (initTraffic).  When a car passes behind the player it is
 * recycled (its fields are overwritten) rather than deleted and re-created.
 * This avoids GC pressure inside the 60 Hz update loop and keeps frame times
 * predictable on mobile.
 *
 * The traffic system has three contracts that must hold regardless of tuning:
 *
 *   1. Pool integrity  — initTraffic produces exactly TRAFFIC_COUNT cars, all
 *      with valid starting values.  An undersized pool means fewer cars on
 *      screen; invalid values (negative speed, out-of-bounds position) can
 *      crash the renderer or produce invisible cars.
 *
 *   2. Update logic    — worldZ advances correctly each frame; recycled cars
 *      always re-spawn at the far horizon (never mid-road).  Spawning too
 *      close would cause cars to "pop in" just ahead of the player.
 *
 *   3. Collision logic — checkTrafficCollision fires only when both the depth
 *      window AND the lateral overlap are satisfied simultaneously.  False
 *      positives cause phantom damage; false negatives let the player clip
 *      through cars with no consequence.
 *
 * Behaviour tests (Barney, Mega, Banana) verify that each TrafficBehavior
 * variant produces the correct per-type movement pattern.
 *
 * Naming conventions:
 *   SEG_COUNT / TRACK_LEN — a realistic 1200-segment track used throughout.
 *   makeCar(worldX, worldZ) — minimal TrafficCar for collision tests.
 *   makeCfg(overrides)      — minimal TrafficUpdateConfig for update tests.
 */

import { describe, it, expect } from 'vitest';
import {
  initTraffic,
  updateTraffic,
  checkTrafficCollision,
  TrafficType,
  type TrafficCar,
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
//
// initTraffic allocates the fixed-size car pool.  Every field of every car
// must be in a valid state before the first frame — any invalid value (NaN,
// negative speed, out-of-range worldZ) would silently corrupt the first tick.

describe('initTraffic', () =>
{
  const cars = initTraffic(SEG_COUNT);

  /**
   * The pool must be exactly TRAFFIC_COUNT long.  A shorter pool means fewer
   * visible cars (difficulty tuning broken); a longer pool wastes memory and
   * could exceed the renderer's draw budget.
   */
  it('produces exactly TRAFFIC_COUNT cars', () =>
  {
    expect(cars).toHaveLength(TRAFFIC_COUNT);
  });

  /**
   * Every car must have a positive starting speed.  Speed=0 means the car
   * never moves, effectively becoming a static obstacle — but without any
   * obstacle hitbox geometry, it would be invisible and non-collidable:
   * the worst kind of bug (silent and undetectable by the player).
   */
  it('all cars start with a positive speed', () =>
  {
    for (const car of cars)
    {
      expect(car.speed).toBeGreaterThan(0);
    }
  });

  /**
   * worldZ must be in [0, trackLength) at spawn.  A worldZ outside this range
   * would place the car at an invalid segment index, causing findSegment() to
   * return the wrong segment and the renderer to project the car at a garbage
   * screen position.
   */
  it('all cars start with worldZ within track bounds', () =>
  {
    for (const car of cars)
    {
      expect(car.worldZ).toBeGreaterThanOrEqual(0);
      expect(car.worldZ).toBeLessThan(TRACK_LEN);
    }
  });

  /**
   * hitVelX and spinAngle are the post-collision animation fields.  They must
   * both be zero at spawn — any nonzero value would cause the car to
   * immediately start spinning or drifting sideways before the player ever
   * touches it.
   */
  it('all cars start with hitVelX = 0 and spinAngle = 0', () =>
  {
    for (const car of cars)
    {
      expect(car.hitVelX).toBe(0);
      expect(car.spinAngle).toBe(0);
    }
  });

  /**
   * Every car must be assigned one of the authored TrafficType values.
   * An unrecognised type would cause TRAFFIC_CAR_SPECS lookup to return
   * undefined, making the renderer silently skip the car's draw call.
   */
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
//
// updateTraffic advances each car's worldZ by car.speed × dt modulo trackLength.
// Exact Z accuracy is critical: even a small systematic error compounded over
// thousands of frames would cause traffic cars to diverge from their intended
// positions, bunching up or spacing out unrealistically.

describe('updateTraffic — Z advancement', () =>
{
  /**
   * This test pins every car's speed to a known value (2000) and places them
   * all ahead of the player so the recycle branch does NOT fire.  After one
   * tick we can calculate the expected Z to floating-point precision and verify
   * the formula is exactly `(worldZ + speed × dt) % trackLength`.
   *
   * The 10–50 seg spacing (i×20) ensures no two cars share a segment, making
   * each car's Z independently verifiable.
   */
  it('each car worldZ advances by speed × dt', () =>
  {
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
//
// When a car falls behind the player beyond TRAFFIC_TRAIL_SEGS (25 segments),
// it is recycled and re-spawned in [DRAW_DISTANCE-15, DRAW_DISTANCE-6] segments
// ahead — strictly inside the render window (DRAW_DISTANCE = 200).
//
// The spawn range was intentionally tightened from the original ±5 band around
// DRAW_DISTANCE because that range could place cars 1–5 segments beyond the
// render window.  Those cars were invisible until the player closed in, then
// popped in suddenly.  The new range keeps all spawns inside the render window
// so cars are always visible the moment they are recycled.

describe('updateTraffic — recycle always spawns at horizon', () =>
{
  /**
   * Regression guard for the spawn-boundary pop-in bug: recycled cars must
   * always land strictly inside the render window ([DRAW_DISTANCE-15,
   * DRAW_DISTANCE-6] segments ahead) so they are never invisible at spawn.
   *
   * The old range extended up to DRAW_DISTANCE+5 segments; cars in the last
   * 5-segment band were in the pool but outside the renderer's projPool window,
   * causing a brief invisible period followed by a sudden visual pop-in.
   *
   * The test forces all cars 26 segs behind the player (> TRAFFIC_TRAIL_SEGS of
   * 25) to trigger the recycle path, then verifies each car lands in the valid
   * spawn band.  TRACK_LEN / 2 wrapping handles the circular track.
   */
  it('recycled cars spawn strictly within render distance (no pop-in band)', () =>
  {
    const cars    = initTraffic(SEG_COUNT);
    const playerZ = 5000;

    // Force every car far enough behind the player to exceed TRAFFIC_TRAIL_SEGS (25 segs)
    // Cars within 25 segs behind are intentionally NOT recycled (they can catch a slowing player)
    cars.forEach(car => { car.worldZ = playerZ - 26 * SEGMENT_LENGTH; });

    // Run enough frames for the recycle branch to fire
    updateTraffic(cars, { playerZ, playerX: 0, playerSpeed: 0, segmentCount: SEG_COUNT, intensity: 0, dt: 0.016 });

    const minSegs = DRAW_DISTANCE - 15;
    const maxSegs = DRAW_DISTANCE - 6;   // DRAW_DISTANCE - 15 + 9 (rand max is exclusive)

    for (const car of cars)
    {
      let relZ = car.worldZ - playerZ;
      if (relZ < -TRACK_LEN / 2) relZ += TRACK_LEN;
      if (relZ >  TRACK_LEN / 2) relZ -= TRACK_LEN;

      const relSegs = relZ / SEGMENT_LENGTH;
      expect(relSegs).toBeGreaterThanOrEqual(minSegs - 0.5);   // tiny float slack
      expect(relSegs).toBeLessThanOrEqual(maxSegs + 0.5);
      // Hard invariant: car must be within the render window, never outside it.
      expect(relSegs).toBeLessThan(DRAW_DISTANCE);
    }
  });
});

// ── Collision detection ───────────────────────────────────────────────────────
//
// checkTrafficCollision does a depth-window scan (0..TRAFFIC_HITBOX_SEGS segs
// ahead) followed by a lateral overlap check (|playerWorldX - carWorldX| <
// car.hitboxX + playerHitboxX).  Both conditions must be true simultaneously.
// Returning a hit when the car is behind, beside, or in an adjacent lane is
// a false positive that unfairly damages the player.

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

  /**
   * When no cars are in the depth window, the function must return null.
   * A car placed at TRAFFIC_HITBOX_SEGS + 5 is 5 segments beyond the scan
   * limit — it must be ignored even if it is directly in the player's lane.
   */
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

  /**
   * The most basic positive case: same lateral position (both centred),
   * 2 segments ahead (well within the depth window), higher player speed
   * (player is actively catching the car).  If this test fails, the entire
   * traffic collision system is broken.
   */
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
   * Adjacent-lane safety: inner lanes are at ±500 wu (world units).
   * TRAFFIC_HITBOX_X = 400 wu, so the combined hitbox (800 wu) is less than
   * the inter-lane gap (1000 wu).  A car in the adjacent lane must NOT trigger
   * a collision — this is verified geometrically before the test runs.
   *
   * Without this test, a change to TRAFFIC_HITBOX_X could silently widen the
   * hitbox to the point where the player in the inner-left lane always gets
   * hit by cars in the inner-right lane, even with clean spacing.
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

  /**
   * bumpDir indicates which side of the player the car is on.  When the car is
   * to the right (positive worldX relative to player), bumpDir must be +1 so
   * that the collision response pushes the player leftward.  If bumpDir has the
   * wrong sign, the player is pushed into the car rather than away from it.
   */
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

  /**
   * Symmetric bumpDir check: when the car is to the left, bumpDir must be -1
   * so the player bounces rightward.
   */
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

  /**
   * closingSpeed = playerSpeed - carSpeed, and must be non-negative: the
   * player must be overtaking, not being overtaken, for a collision to fire.
   * The exact value (6000) is used downstream in the momentum formula —
   * an incorrect closing speed would miscalculate the impulse transferred.
   */
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

  /**
   * A car behind the player (negative relZ) must never trigger a collision.
   * If it did, the player would get hit by cars they have already passed —
   * physically nonsensical and deeply frustrating to experience.
   */
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
//
// TRAFFIC_CAR_SPECS maps each TrafficType to its sprite sheet metadata.
// The renderer uses this table exclusively — a missing or malformed entry
// is invisible at compile time but causes a silent draw skip at runtime.

describe('TRAFFIC_CAR_SPECS', () =>
{
  /**
   * Every TrafficType that traffic.ts can spawn must have a spec entry.
   * Adding a new TrafficType without a corresponding spec causes the renderer
   * to silently skip drawing that car (undefined property access).
   * This test catches the missing entry at test time rather than at runtime
   * hours into a play session.
   */
  it('has an entry for every TrafficType', () =>
  {
    for (const type of Object.values(TrafficType))
    {
      expect(TRAFFIC_CAR_SPECS).toHaveProperty(type);
    }
  });

  /**
   * frameW and frameH must be positive so the sprite UV rectangle is non-zero.
   * worldH must be positive so the perspective scale formula (worldH / CAMERA_HEIGHT)
   * produces a finite positive value.  Any zero value would make the car
   * invisible (zero-height sprite).
   */
  it('all specs have positive frameW, frameH, and worldH', () =>
  {
    for (const [, spec] of Object.entries(TRAFFIC_CAR_SPECS))
    {
      expect(spec.frameW).toBeGreaterThan(0);
      expect(spec.frameH).toBeGreaterThan(0);
      expect(spec.worldH).toBeGreaterThan(0);
    }
  });

  /**
   * assetPath must end in .png so the asset loader builds the correct URL.
   * A missing or wrong extension would cause a 404 at load time, leaving a
   * blank image slot for that car type throughout the entire session.
   */
  it('all specs have a non-empty assetPath ending in .png', () =>
  {
    for (const [, spec] of Object.entries(TRAFFIC_CAR_SPECS))
    {
      expect(spec.assetPath).toBeTruthy();
      expect(spec.assetPath.endsWith('.png')).toBe(true);
    }
  });

  /**
   * worldH must be less than CAMERA_HEIGHT (1000 world units).
   * The perspective projection formula is `screenH = worldH / CAMERA_HEIGHT × screenScale`.
   * A car taller than the camera height (worldH >= 1000) would project ABOVE
   * the horizon line and break the y-clipping in the renderer.
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
//
// Each TrafficType carries type-specific gameplay properties: massMult affects
// the momentum formula, hitboxX affects collision width, and behavior controls
// the lane-change AI.  These are set at spawn time from a per-type profile
// table and must be positive and valid from the very first frame.

describe('initTraffic — per-type profile fields', () =>
{
  /**
   * massMult feeds directly into the momentum calculation in
   * applyTrafficHitResponse.  A zero massMult would cause a divide-by-zero
   * (or an infinite carThrowVelocity), crashing the frame.  A negative value
   * would reverse the direction of the impulse.
   */
  it('each spawned car has a positive massMult', () =>
  {
    const cars = initTraffic(SEG_COUNT, 12);
    for (const car of cars)
      expect(car.massMult).toBeGreaterThan(0);
  });

  /**
   * hitboxX is the car's lateral collision radius in world units.  A zero or
   * negative value would make the car un-hittable from any direction —
   * effectively turning it into a Ghost even though it's a normal car.
   */
  it('each spawned car has a positive hitboxX', () =>
  {
    const cars = initTraffic(SEG_COUNT, 12);
    for (const car of cars)
      expect(car.hitboxX).toBeGreaterThan(0);
  });

  /**
   * behavior must be a known TrafficBehavior value.  An unrecognised behavior
   * enum value would fall through to the default lane-change branch in
   * updateTraffic, producing Standard behavior regardless of the car's type —
   * Barney wouldn't evade, Mega wouldn't hog the road.
   */
  it('each spawned car has a recognised TrafficBehavior', () =>
  {
    const valid = new Set(Object.values(TrafficBehavior));
    const cars = initTraffic(SEG_COUNT, 12);
    for (const car of cars)
      expect(valid.has(car.behavior)).toBe(true);
  });

  /**
   * Mega (semi-truck) must weigh more than GottaGo (sports car).
   * This drives the momentum asymmetry: hitting a Mega slows the player
   * dramatically; hitting a GottaGo barely matters.  If massMult were
   * equal, the player would have no reason to prefer one lane over another.
   */
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

  /**
   * Mega must have a wider hitbox than Barney.  A Mega occupies more of the
   * road width visually; if its hitbox were narrower than Barney's the player
   * could clip through a Mega's visible sprite without triggering a collision.
   */
  it('Mega hitboxX is larger than Barney hitboxX', () =>
  {
    const cars = initTraffic(SEG_COUNT, 50);
    const mega   = cars.find(c => c.type === TrafficType.Mega);
    const barney = cars.find(c => c.type === TrafficType.Barney);
    if (mega && barney)
      expect(mega.hitboxX).toBeGreaterThan(barney.hitboxX);
  });

  /**
   * GottaGo (sports car) is the "fast traffic" archetype — it must always be
   * faster than Yoshi (slow compact).  The speed ranges must not overlap at
   * their extremes: GottaGo's minimum spawn speed (3200) must exceed Yoshi's
   * maximum spawn speed (2500) at intensity 0.  Overlap would make it
   * impossible to distinguish the two types by their behaviour on the road.
   */
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

  /**
   * At intensity=1 (late-game, harder difficulty), all cars should spawn
   * faster on average than at intensity=0.  Without this, the difficulty
   * ramp from the game's session-level intensity system would have no effect
   * on traffic density/speed, breaking the progression feel.
   */
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
//
// Barney is the "nervous driver" archetype.  When the player approaches within
// BARNEY_EVADE_SEGS_MIN segments AND within BARNEY_EVADE_RANGE world units
// laterally, Barney flees to the opposite side of the road.  This creates
// the OutRun "scattering traffic" fantasy — cars react to the player.

describe('updateTraffic — Barney EVADER behaviour', () =>
{
  /**
   * Core Barney evasion: player approaching from the right side causes Barney
   * to set targetX to a negative (left-side) value.  This test uses barneyX=500
   * (inner-right lane) and playerWorldX=600 (right of Barney) — both on the
   * right side and within BARNEY_EVADE_RANGE of each other.
   *
   * After one updateTraffic tick, Barney's targetX must be negative (fled
   * left).  Without this mechanic, Barney drives straight and the player just
   * runs into it — none of the "nervous Barney" feel survives.
   */
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

  /**
   * Depth guard: evasion must NOT trigger when Barney is far ahead
   * (beyond BARNEY_EVADE_SEGS_MIN).  Evasion from far away would look
   * unnatural — Barney would react to the player before the player is
   * even visible.  A laneTimer=10 ensures the normal lane-change branch
   * doesn't fire during this test.
   */
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

  /**
   * Lateral guard: evasion must NOT trigger when the player is laterally
   * far from Barney (gap > BARNEY_EVADE_RANGE).  A player in the far-left
   * lane should not cause Barney in the far-right lane to flee — that would
   * produce chaotic, unpredictable behaviour with no causal connection.
   */
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
//
// Mega (semi-truck) preferentially occupies the centre lanes.  It uses a
// biased random target selection with probability MEGA_CENTER_BIAS (0.65 at
// intensity 0) when its laneTimer expires.  This makes Mega a persistent
// centre-lane obstacle that the player must navigate around.

describe('updateTraffic — Mega ROAD_HOG behaviour', () =>
{
  /**
   * Over 200 independent trials (each forcing laneTimer to expire) we count
   * how many times Mega selects a centre-lane target (|targetX| ≤ 500 wu).
   * At bias 0.65 the expected proportion is 65%; the test uses a conservative
   * 50% threshold to allow for statistical noise without requiring a fixed
   * random seed.
   *
   * Using laneTimer=0.0001 (near zero) ensures the timer expires every tick,
   * triggering a new target selection each iteration.  Starting Mega far
   * from centre (worldX=−1200) prevents the target from defaulting to the
   * current position rather than sampling the bias distribution.
   */
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
//
// Banana is the "erratic driver" archetype.  Its worldX is offset from its
// targetX by a sinusoidal wobble: it lerps toward targetX + sin(worldZ / λ) × AMP
// each frame at weaveRate speed.
//
// WHY lerp instead of direct assignment?
//   The original formula `worldX = targetX + sin(phase) × AMP` teleported the
//   car up to 2400 wu the instant laneTimer fired a new targetX.  At 3–5 seg
//   distance this produced 800+ px screen jumps — the car flashed off-screen.
//   Lerping at weaveRate (2200 wu/s) is fast enough to track the oscillation
//   (max rate ≈ 667 wu/s) while eliminating lane-change teleportation.

describe('updateTraffic — Banana WANDERER behaviour', () =>
{
  /**
   * The Banana car must lerp toward the wobble target, not teleport.
   *
   * Setup: place worldZ at exactly π/2 × λ so sin(phase) = 1 immediately,
   * avoiding the need to Z-advance into phase.  Start worldX = targetX so
   * there is a known 100 wu gap to the wobble target (targetX + AMP).
   *
   * After one tick at dt = 1/60 the car should have advanced by exactly
   * weaveRate × dt ≈ 36.7 wu — NOT the full 100 wu to the target.
   * If it equals targetX + AMP the implementation has regressed to the
   * old direct-assign teleport formula.
   */
  it('Banana worldX lerps toward sine-wobble target at weaveRate (no teleport)', () =>
  {
    const targetX = 500;
    const dt      = 1 / 60;
    // worldZ = π/2 × λ so sin(phase) = 1 immediately — wobble target = targetX + AMP.
    // Using speed=0 keeps the phase constant for a clean single-frame measurement.
    const worldZ  = (Math.PI / 2) * BANANA_WOBBLE_WAVELENGTH;

    const car: TrafficCar = {
      type:      TrafficType.Banana,
      worldZ,
      worldX:    targetX,   // starts at lane center, 100 wu from wobble target
      speed:     0,
      targetX,
      laneTimer: 99,        // no lane-change during this tick
      hitVelX:   0,
      spinAngle: 0,
      massMult:  0.9,
      hitboxX:   TRAFFIC_HITBOX_X,
      behavior:  TrafficBehavior.Wanderer,
    };

    updateTraffic([car], {
      playerZ: 0, playerX: 0, playerSpeed: 0,
      segmentCount: SEG_COUNT, intensity: 0, dt,
    });

    // The wobble target is targetX + BANANA_WOBBLE_AMP = 600.
    // With weaveRate = 2200 wu/s, one step = 2200 × dt ≈ 36.7 wu.
    // worldX should advance by exactly one step (not teleport the full 100 wu).
    const expectedStep = 2200 * dt;
    expect(car.worldX).toBeCloseTo(targetX + expectedStep, 1);
    // Regression guard: if this equals targetX + AMP, the code has reverted to
    // the direct-assign teleport formula that caused the brown car flicker bug.
    expect(car.worldX).toBeLessThan(targetX + BANANA_WOBBLE_AMP);
  });
});
