import { describe, it, expect, beforeAll } from 'vitest';
import { Road } from '../src/road';
import { SEGMENT_LENGTH, ROAD_CURVE } from '../src/constants';

describe('Road', () => {

  let road: Road;
  beforeAll(() => { road = new Road(); });

  it('builds segments on construction', () => {
    expect(road.count).toBeGreaterThan(0);
  });

  it('segment count is in the expected range for the current layout (~620)', () => {
    expect(road.count).toBeGreaterThan(400);
    expect(road.count).toBeLessThan(900);
  });

  it('findSegment(0) returns the first segment', () => {
    const seg = road.findSegment(0);
    expect(seg.index).toBe(0);
  });

  it('findSegment wraps seamlessly at the end of the track', () => {
    const trackLength = road.count * SEGMENT_LENGTH;
    const seg0 = road.findSegment(0);
    const segW = road.findSegment(trackLength);
    expect(seg0.index).toBe(segW.index);
  });

  it('findSegment handles a playerZ in the middle of the track', () => {
    const mid = (road.count / 2) * SEGMENT_LENGTH;
    const seg = road.findSegment(mid);
    expect(seg.index).toBeGreaterThanOrEqual(0);
    expect(seg.index).toBeLessThan(road.count);
  });

  it('all segment indices are sequential starting from 0', () => {
    road.segments.forEach((seg, i) => {
      expect(seg.index).toBe(i);
    });
  });

  it('each segment p1.world.z equals i * SEGMENT_LENGTH', () => {
    road.segments.forEach((seg, i) => {
      expect(seg.p1.world.z).toBeCloseTo(i * SEGMENT_LENGTH);
    });
  });

  it('each segment p2.world.z is exactly one SEGMENT_LENGTH ahead of p1', () => {
    road.segments.forEach((seg) => {
      expect(seg.p2.world.z - seg.p1.world.z).toBeCloseTo(SEGMENT_LENGTH);
    });
  });

  it('no segment curve magnitude exceeds ROAD_CURVE.HARD', () => {
    road.segments.forEach((seg) => {
      expect(Math.abs(seg.curve)).toBeLessThanOrEqual(ROAD_CURVE.HARD + 0.001);
    });
  });

  it('all segments have valid colour fields', () => {
    road.segments.forEach((seg) => {
      expect(seg.color.road).toBeTruthy();
      expect(seg.color.grass).toBeTruthy();
      expect(seg.color.rumble).toBeTruthy();
    });
  });

  it('hill heights do not produce unreasonable Y values relative to CAMERA_HEIGHT', () => {
    // World Y should stay within ±500 (half of CAMERA_HEIGHT=1000) across the whole track.
    // Values beyond this would push segments above the horizon and break occlusion.
    road.segments.forEach((seg) => {
      expect(Math.abs(seg.p1.world.y)).toBeLessThan(500);
      expect(Math.abs(seg.p2.world.y)).toBeLessThan(500);
    });
  });

});
