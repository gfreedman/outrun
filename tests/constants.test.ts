/**
 * constants.test.ts
 *
 * Tests that the tuning values in constants.ts obey rules that the game
 * physics DEPEND on being true.  If someone changes a constant and breaks
 * one of these rules, the game will silently misbehave — these tests catch
 * that before the commit goes in.
 *
 * Think of each test as a "contract":
 *   "No matter what numbers a designer types into constants.ts,
 *    these relationships must always hold."
 */

import { describe, it, expect } from 'vitest';
import
{
  PLAYER_MAX_SPEED, PLAYER_ACCEL_MID,
  PLAYER_BRAKE_MAX, PLAYER_BRAKE_RAMP,
  PLAYER_STEERING, PLAYER_COAST_RATE,
  OFFROAD_DECEL,
  DRAW_DISTANCE, SEGMENT_LENGTH,
  CAMERA_HEIGHT, CAMERA_DEPTH, ROAD_WIDTH,
  ROAD_CURVE, ROAD_HILL,
  CENTRIFUGAL,
  DRIFT_ONSET, DRIFT_RATE, DRIFT_DECAY, DRIFT_CATCH,
} from '../src/constants';

// ── Physics invariants ────────────────────────────────────────────────────────
//
// "Invariant" means something that must ALWAYS be true.
// If any of these fail, the game physics are broken in a subtle way.

describe('Physics invariants', () =>
{

  /**
   * The grass deceleration must be stronger than the peak acceleration force.
   * If OFFROAD_DECEL ≤ PLAYER_ACCEL_MID, the player could hold the throttle
   * and accelerate while on grass — an obvious cheat / physics bug.
   */
  it('OFFROAD_DECEL > PLAYER_ACCEL_MID — car cannot accelerate on grass', () =>
  {
    expect(OFFROAD_DECEL).toBeGreaterThan(PLAYER_ACCEL_MID);
  });

  /**
   * Counter-steering (pressing opposite to the slide) must resolve a drift
   * faster than just waiting for the tyres to self-align.
   * If DRIFT_CATCH ≤ DRIFT_DECAY, there is no mechanical reward for
   * counter-steering — it would feel exactly the same as doing nothing.
   */
  it('DRIFT_CATCH > DRIFT_DECAY — counter-steer resolves slide faster than passive decay', () =>
  {
    expect(DRIFT_CATCH).toBeGreaterThan(DRIFT_DECAY);
  });

  /**
   * DRIFT_ONSET is a fraction (0–1) representing how much of available grip
   * must be overcome before a slide begins.
   * Outside this range the drift system either never triggers (> 1)
   * or always triggers (≤ 0), breaking the mechanic entirely.
   */
  it('DRIFT_ONSET is a valid fraction between 0 and 1', () =>
  {
    expect(DRIFT_ONSET).toBeGreaterThan(0);
    expect(DRIFT_ONSET).toBeLessThan(1);
  });

  /**
   * Every force and speed value must be positive.
   * A zero or negative value here would reverse the direction of the force
   * (e.g. brakes would accelerate, coasting would speed the car up).
   */
  it('all speed and force values are positive', () =>
  {
    expect(PLAYER_MAX_SPEED).toBeGreaterThan(0);
    expect(PLAYER_ACCEL_MID).toBeGreaterThan(0);
    expect(PLAYER_BRAKE_MAX).toBeGreaterThan(0);
    expect(PLAYER_COAST_RATE).toBeGreaterThan(0);
    expect(OFFROAD_DECEL).toBeGreaterThan(0);
    expect(PLAYER_STEERING).toBeGreaterThan(0);
  });

  /**
   * The brake ramp time must be a positive duration.
   * Zero or negative would cause a divide-by-zero (or instant brakes)
   * in the hydraulic ramp formula: t = brakeHeld / PLAYER_BRAKE_RAMP.
   */
  it('PLAYER_BRAKE_RAMP is a positive duration in seconds', () =>
  {
    expect(PLAYER_BRAKE_RAMP).toBeGreaterThan(0);
  });

  /**
   * All camera and road geometry values must be positive.
   * These feed directly into the perspective projection formula.
   * A zero SEGMENT_LENGTH would cause division by zero in findSegment().
   */
  it('road and camera geometry values are positive', () =>
  {
    expect(CAMERA_HEIGHT).toBeGreaterThan(0);
    expect(CAMERA_DEPTH).toBeGreaterThan(0);
    expect(ROAD_WIDTH).toBeGreaterThan(0);
    expect(SEGMENT_LENGTH).toBeGreaterThan(0);
    expect(DRAW_DISTANCE).toBeGreaterThan(0);
  });

  /**
   * DRAW_DISTANCE controls a loop counter (for i = 1; i <= drawDistance; i++).
   * A fractional draw distance would silently round differently on every platform.
   * It must be a whole number.
   */
  it('DRAW_DISTANCE is a whole number', () =>
  {
    expect(Number.isInteger(DRAW_DISTANCE)).toBe(true);
  });

  /**
   * CENTRIFUGAL must be positive.
   * A negative value would invert the centrifugal force, pushing the car
   * INWARD on corners — the opposite of real physics and very disorienting.
   */
  it('CENTRIFUGAL is positive', () =>
  {
    expect(CENTRIFUGAL).toBeGreaterThan(0);
  });

  /**
   * ROAD_CURVE preset values must be non-negative and strictly increasing.
   * NONE must be exactly 0 (the zero-curve check in road.ts uses === 0).
   * If the ordering is wrong, "MEDIUM" corners could bend less than "EASY" ones.
   */
  it('ROAD_CURVE values are non-negative and strictly ordered NONE < EASY < MEDIUM < HARD', () =>
  {
    expect(ROAD_CURVE.NONE).toBe(0);
    expect(ROAD_CURVE.EASY).toBeGreaterThan(ROAD_CURVE.NONE);
    expect(ROAD_CURVE.MEDIUM).toBeGreaterThan(ROAD_CURVE.EASY);
    expect(ROAD_CURVE.HARD).toBeGreaterThan(ROAD_CURVE.MEDIUM);
  });

  /**
   * Same ordering requirement for ROAD_HILL.
   * NONE must be 0 because addRoad() uses it as the zero-hill baseline.
   */
  it('ROAD_HILL values are non-negative and strictly ordered NONE < LOW < MEDIUM < HIGH', () =>
  {
    expect(ROAD_HILL.NONE).toBe(0);
    expect(ROAD_HILL.LOW).toBeGreaterThan(ROAD_HILL.NONE);
    expect(ROAD_HILL.MEDIUM).toBeGreaterThan(ROAD_HILL.LOW);
    expect(ROAD_HILL.HIGH).toBeGreaterThan(ROAD_HILL.MEDIUM);
  });

});
