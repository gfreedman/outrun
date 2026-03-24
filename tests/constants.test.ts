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
  COLOR_BAND_PERIOD,
  ACCEL_LOW_BAND, ACCEL_HIGH_BAND,
  RUMBLE_OUTER_FRAC, RUMBLE_INNER_FRAC,
  LANE_OUTER_FRAC, LANE_INNER_FRAC,
  MARK_ET_OUTER_FRAC, MARK_ET_INNER_FRAC,
  MARK_EN_OUTER_FRAC, MARK_EN_INNER_FRAC,
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

  // ── Visual / rendering invariants ─────────────────────────────────────────

  /**
   * COLOR_BAND_PERIOD drives the rumble-strip and lane-dash rhythm.
   * It must be a positive whole number — fractional values would make
   * Math.floor(i / COLOR_BAND_PERIOD) % 2 produce inconsistent banding.
   */
  it('COLOR_BAND_PERIOD is a positive integer', () =>
  {
    expect(COLOR_BAND_PERIOD).toBeGreaterThan(0);
    expect(Number.isInteger(COLOR_BAND_PERIOD)).toBe(true);
  });

  /**
   * Three-phase throttle band boundaries must be ordered and in (0, 1).
   * ACCEL_LOW_BAND < ACCEL_HIGH_BAND < 1 ensures the three phases never
   * overlap and the taper formula (1 - speedRatio) / (1 - ACCEL_HIGH_BAND)
   * doesn't divide by zero.
   */
  it('ACCEL_LOW_BAND < ACCEL_HIGH_BAND < 1 — throttle phases are non-overlapping', () =>
  {
    expect(ACCEL_LOW_BAND).toBeGreaterThan(0);
    expect(ACCEL_HIGH_BAND).toBeGreaterThan(ACCEL_LOW_BAND);
    expect(ACCEL_HIGH_BAND).toBeLessThan(1);
  });

});

// ── Road marking fraction constants ───────────────────────────────────────────
//
// These fractions are multiplied by the road half-width (sw) at each segment.
// The relationships between them are load-bearing: incorrect values would
// produce visually wrong kerb widths or overlapping stripes without a compile
// or runtime error — only these tests catch the mistake.

describe('Road marking fraction constants', () =>
{

  /**
   * RUMBLE_INNER_FRAC < 1.0: the inner kerb edge must sit INSIDE the road.
   * A value >= 1.0 would place the inner kerb at or beyond the road edge,
   * making the kerb invisible (hidden by the road surface polygon).
   */
  it('RUMBLE_INNER_FRAC < 1.0 — kerb inner edge is inside the road', () =>
  {
    expect(RUMBLE_INNER_FRAC).toBeLessThan(1.0);
  });

  /**
   * RUMBLE_OUTER_FRAC > 1.0: the outer kerb edge must reach OUTSIDE the road.
   * A value <= 1.0 would make the kerb invisible against the road surface.
   */
  it('RUMBLE_OUTER_FRAC > 1.0 — kerb outer edge is outside the road', () =>
  {
    expect(RUMBLE_OUTER_FRAC).toBeGreaterThan(1.0);
  });

  /**
   * LANE_OUTER_FRAC < 1.0: lane dashes sit inside the road boundary.
   * A value >= 1.0 would draw the dash on the verge, not the asphalt.
   */
  it('LANE_OUTER_FRAC < 1.0 — lane dash is inside the road', () =>
  {
    expect(LANE_OUTER_FRAC).toBeLessThan(1.0);
  });

  /**
   * LANE_INNER_FRAC > 0 && < LANE_OUTER_FRAC: the dash has positive width and
   * inner < outer (normal orientation).  If LANE_INNER_FRAC >= LANE_OUTER_FRAC
   * the dash would have zero or negative width and be invisible.
   */
  it('LANE_INNER_FRAC > 0 && < LANE_OUTER_FRAC — dash has positive width', () =>
  {
    expect(LANE_INNER_FRAC).toBeGreaterThan(0);
    expect(LANE_INNER_FRAC).toBeLessThan(LANE_OUTER_FRAC);
  });

  /**
   * MARK_ET_INNER_FRAC < MARK_ET_OUTER_FRAC: the outer track stripe has positive
   * width.  Reversing these would make the stripe zero-width and invisible.
   */
  it('MARK_ET_INNER_FRAC < MARK_ET_OUTER_FRAC — outer track stripe has positive width', () =>
  {
    expect(MARK_ET_INNER_FRAC).toBeLessThan(MARK_ET_OUTER_FRAC);
  });

  /**
   * MARK_EN_INNER_FRAC < MARK_EN_OUTER_FRAC: the inner track stripe has positive
   * width.  Same reasoning as above.
   */
  it('MARK_EN_INNER_FRAC < MARK_EN_OUTER_FRAC — inner track stripe has positive width', () =>
  {
    expect(MARK_EN_INNER_FRAC).toBeLessThan(MARK_EN_OUTER_FRAC);
  });

  /**
   * MARK_EN_OUTER_FRAC < MARK_ET_INNER_FRAC: the inner stripe must be closer to
   * the road centre than the outer stripe.  If this is violated the two stripes
   * would overlap or swap positions, destroying the intended track-mark geometry.
   */
  it('MARK_EN_OUTER_FRAC < MARK_ET_INNER_FRAC — inner mark is further from edge than outer', () =>
  {
    expect(MARK_EN_OUTER_FRAC).toBeLessThan(MARK_ET_INNER_FRAC);
  });

});
