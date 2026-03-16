/**
 * road.test.ts
 *
 * Tests the Road class — the system that builds and stores every segment
 * of the track.
 *
 * Quick primer on how the road works (for a 1st-year CS student):
 *
 *   Imagine the road as a very long array of playing cards laid end-to-end.
 *   Each card = one RoadSegment.  Each segment knows:
 *     - Its index (card number from the start)
 *     - Its world Z position (how far along the road it sits)
 *     - Its curve value (how much it bends the road left or right)
 *     - Its world Y position (how high or low it sits — hills)
 *     - Its colour (alternating bands for visual rhythm)
 *
 *   The player drives forward by increasing their Z position.
 *   findSegment() works out which card the player is currently standing on.
 *   When Z exceeds the total track length, it wraps back to 0 — the road loops.
 *
 * These tests verify that the road is built correctly and that the
 * segment lookup works reliably under all conditions.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Road } from '../src/road';
import { SEGMENT_LENGTH, ROAD_CURVE } from '../src/constants';

// ── Road tests ────────────────────────────────────────────────────────────────

describe('Road', () =>
{
  /**
   * We build the road ONCE before all tests run (beforeAll), not before each
   * individual test.  Building the road is expensive (~600 segments of maths)
   * so sharing one instance across all tests is much faster.
   */
  let road: Road;
  beforeAll(() => { road = new Road(); });

  // ── Construction ──────────────────────────────────────────────────────────

  /**
   * The most basic check: after construction, the road must contain segments.
   * An empty road would cause the game to divide by zero when wrapping playerZ.
   */
  it('builds segments on construction', () =>
  {
    expect(road.count).toBeGreaterThan(0);
  });

  /**
   * The Nürburgring layout should produce roughly 600 segments.
   * This test guards against accidentally deleting or duplicating large
   * sections of the track layout in resetRoad().
   */
  it('segment count is in the expected range for the current layout (~1185)', () =>
  {
    expect(road.count).toBeGreaterThan(900);
    expect(road.count).toBeLessThan(1400);
  });

  // ── findSegment ───────────────────────────────────────────────────────────

  /**
   * At playerZ = 0 (the very start of the race), the player should be
   * standing on the first segment (index 0).
   */
  it('findSegment(0) returns the first segment', () =>
  {
    const seg = road.findSegment(0);
    expect(seg.index).toBe(0);
  });

  /**
   * When the player reaches the end of the track and playerZ equals the
   * total track length, it wraps back to the beginning.
   * This is what makes the road loop seamlessly — the last segment and the
   * first segment join up with no visible seam.
   */
  it('findSegment wraps seamlessly at the end of the track', () =>
  {
    const trackLength = road.count * SEGMENT_LENGTH;
    const segAtStart = road.findSegment(0);
    const segAtWrap  = road.findSegment(trackLength);
    expect(segAtStart.index).toBe(segAtWrap.index);
  });

  /**
   * findSegment must work at any position, including the middle of the track.
   * The returned index must be a valid array position — not negative, not
   * beyond the end of the segments array.
   */
  it('findSegment returns a valid index for a mid-track position', () =>
  {
    const mid = Math.floor(road.count / 2) * SEGMENT_LENGTH;
    const seg = road.findSegment(mid);
    expect(seg.index).toBeGreaterThanOrEqual(0);
    expect(seg.index).toBeLessThan(road.count);
  });

  // ── Segment geometry ──────────────────────────────────────────────────────

  /**
   * Every segment's index field must match its position in the array.
   * segment[5].index must equal 5, segment[42].index must equal 42, etc.
   * If these drift apart, segment lookup and colour banding both break.
   */
  it('all segment indices are sequential starting from 0', () =>
  {
    road.segments.forEach((seg, i) =>
    {
      expect(seg.index).toBe(i);
    });
  });

  /**
   * The near edge (p1) of segment i must sit at exactly i * SEGMENT_LENGTH
   * along the world Z axis.  This is how the renderer knows where each
   * segment starts in 3D space.
   */
  it('each segment p1.world.z equals index × SEGMENT_LENGTH', () =>
  {
    road.segments.forEach((seg, i) =>
    {
      // toBeCloseTo allows for tiny floating-point rounding errors
      expect(seg.p1.world.z).toBeCloseTo(i * SEGMENT_LENGTH);
    });
  });

  /**
   * The far edge (p2) of each segment must be exactly one SEGMENT_LENGTH
   * further along than the near edge (p1).  This ensures segments tile
   * perfectly with no gaps or overlaps.
   */
  it('each segment p2.world.z is exactly one SEGMENT_LENGTH ahead of p1', () =>
  {
    road.segments.forEach((seg) =>
    {
      expect(seg.p2.world.z - seg.p1.world.z).toBeCloseTo(SEGMENT_LENGTH);
    });
  });

  /**
   * No segment's curve should ever exceed ROAD_CURVE.HARD.
   * The addRoad() builder uses easeIn() which approaches but never exceeds
   * its target.  If this breaks, segments would bend harder than designed
   * and could make the road visually glitch.
   */
  it('no segment curve magnitude exceeds ROAD_CURVE.HARD', () =>
  {
    road.segments.forEach((seg) =>
    {
      // Small epsilon (0.001) accounts for floating-point easing overshoot
      expect(Math.abs(seg.curve)).toBeLessThanOrEqual(ROAD_CURVE.HARD + 0.001);
    });
  });

  /**
   * Hill heights (world Y values) must stay within ±500 world units.
   * CAMERA_HEIGHT is 1000, so ±500 is half the camera height.
   * Segments with world.y > CAMERA_HEIGHT would project ABOVE the horizon
   * and break the hill-occlusion (maxy) system in the renderer.
   */
  it('hill Y values stay within ±500 world units (safe relative to CAMERA_HEIGHT)', () =>
  {
    road.segments.forEach((seg) =>
    {
      expect(Math.abs(seg.p1.world.y)).toBeLessThan(500);
      expect(Math.abs(seg.p2.world.y)).toBeLessThan(500);
    });
  });

  // ── Colours ───────────────────────────────────────────────────────────────

  /**
   * Every segment must have non-empty colour strings for road, grass, and rumble.
   * The renderer draws these directly into the canvas.  An empty string passed
   * to ctx.fillStyle produces transparent fills — invisible road bands.
   */
  it('all segments have non-empty colour strings for road, grass, and rumble', () =>
  {
    road.segments.forEach((seg) =>
    {
      expect(seg.color.road).toBeTruthy();
      expect(seg.color.grass).toBeTruthy();
      expect(seg.color.rumble).toBeTruthy();
    });
  });

});
