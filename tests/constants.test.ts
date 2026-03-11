import { describe, it, expect } from 'vitest';
import {
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

describe('Physics invariants', () => {

  it('OFFROAD_DECEL > PLAYER_ACCEL_MID — car cannot accelerate on grass', () => {
    expect(OFFROAD_DECEL).toBeGreaterThan(PLAYER_ACCEL_MID);
  });

  it('DRIFT_CATCH > DRIFT_DECAY — counter-steer resolves slide faster than passive decay', () => {
    expect(DRIFT_CATCH).toBeGreaterThan(DRIFT_DECAY);
  });

  it('DRIFT_ONSET is a valid fraction between 0 and 1', () => {
    expect(DRIFT_ONSET).toBeGreaterThan(0);
    expect(DRIFT_ONSET).toBeLessThan(1);
  });

  it('all speed / force values are positive', () => {
    expect(PLAYER_MAX_SPEED).toBeGreaterThan(0);
    expect(PLAYER_ACCEL_MID).toBeGreaterThan(0);
    expect(PLAYER_BRAKE_MAX).toBeGreaterThan(0);
    expect(PLAYER_COAST_RATE).toBeGreaterThan(0);
    expect(OFFROAD_DECEL).toBeGreaterThan(0);
    expect(PLAYER_STEERING).toBeGreaterThan(0);
  });

  it('PLAYER_BRAKE_RAMP is a positive duration', () => {
    expect(PLAYER_BRAKE_RAMP).toBeGreaterThan(0);
  });

  it('road geometry values are positive', () => {
    expect(CAMERA_HEIGHT).toBeGreaterThan(0);
    expect(CAMERA_DEPTH).toBeGreaterThan(0);
    expect(ROAD_WIDTH).toBeGreaterThan(0);
    expect(SEGMENT_LENGTH).toBeGreaterThan(0);
    expect(DRAW_DISTANCE).toBeGreaterThan(0);
  });

  it('DRAW_DISTANCE is a whole number', () => {
    expect(Number.isInteger(DRAW_DISTANCE)).toBe(true);
  });

  it('CENTRIFUGAL is positive', () => {
    expect(CENTRIFUGAL).toBeGreaterThan(0);
  });

  it('ROAD_CURVE values are non-negative and strictly ordered', () => {
    expect(ROAD_CURVE.NONE).toBe(0);
    expect(ROAD_CURVE.EASY).toBeGreaterThan(ROAD_CURVE.NONE);
    expect(ROAD_CURVE.MEDIUM).toBeGreaterThan(ROAD_CURVE.EASY);
    expect(ROAD_CURVE.HARD).toBeGreaterThan(ROAD_CURVE.MEDIUM);
  });

  it('ROAD_HILL values are non-negative and strictly ordered', () => {
    expect(ROAD_HILL.NONE).toBe(0);
    expect(ROAD_HILL.LOW).toBeGreaterThan(ROAD_HILL.NONE);
    expect(ROAD_HILL.MEDIUM).toBeGreaterThan(ROAD_HILL.LOW);
    expect(ROAD_HILL.HIGH).toBeGreaterThan(ROAD_HILL.MEDIUM);
  });

});
