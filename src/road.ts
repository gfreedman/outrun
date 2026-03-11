/**
 * road.ts
 *
 * Builds and stores the array of road segments that define the track layout.
 *
 * Key idea — pseudo-3D road geometry:
 *   The road is modelled as a long array of flat "slices", each SEGMENT_LENGTH
 *   world units deep.  Every slice knows its horizontal curve value and its
 *   vertical Y position.  The renderer projects each slice through a virtual
 *   camera to produce the 2-D trapezoid the player sees on screen.
 *
 *   Think of it like a deck of cards laid in a line stretching into the distance.
 *   Each card is one RoadSegment.  Bend or tilt the line of cards and you get
 *   curves and hills.
 */

import { RoadSegment, ProjectedPoint, SegmentColor } from './types';
import { SEGMENT_LENGTH, COLORS, ROAD_CURVE, ROAD_HILL } from './constants';

// ── Easing functions ──────────────────────────────────────────────────────────
//
// "Easing" makes transitions smooth — instead of snapping instantly from
// value A to value B, we glide between them following a curved path.
// percent goes from 0.0 (start) to 1.0 (end).

/**
 * Eases IN: starts slow, ends fast.  Like a car pulling away from rest.
 * Uses a quadratic curve: slow at the beginning, accelerating toward the end.
 *
 * @param a       - Start value.
 * @param b       - End value.
 * @param percent - Progress from 0 (at a) to 1 (at b).
 * @returns Interpolated value between a and b.
 */
function easeIn(a: number, b: number, percent: number): number
{
  return a + (b - a) * Math.pow(percent, 2);
}

/**
 * Eases IN and OUT: starts slow, accelerates, then slows again at the end.
 * Uses a cosine curve — the smoothest possible S-shaped transition.
 * Used for both curve and hill height changes so bends feel gradual.
 *
 * @param a       - Start value.
 * @param b       - End value.
 * @param percent - Progress from 0 (at a) to 1 (at b).
 * @returns Interpolated value between a and b.
 */
function easeInOut(a: number, b: number, percent: number): number
{
  return a + (b - a) * ((-Math.cos(percent * Math.PI) / 2) + 0.5);
}

// ── Internal factory helpers ───────────────────────────────────────────────────

/**
 * Creates a ProjectedPoint at a given world-space Z and Y position.
 * The screen fields are all zero at creation; the renderer fills them in each frame.
 *
 * @param worldZ - Depth along the road (how far ahead this point is).
 * @param worldY - Height above the flat ground (positive = uphill, negative = downhill).
 * @returns A fresh ProjectedPoint ready to be assigned to p1 or p2.
 */
function makeProjectedPoint(worldZ: number, worldY: number = 0): ProjectedPoint
{
  return {
    world:  { x: 0, y: worldY, z: worldZ },
    screen: { x: 0, y: 0, w: 0, scale: 0 },
  };
}

/**
 * Computes the colour set for segment number i.
 *
 * The road uses two alternating colour bands (groups of 8 segments each).
 * Within each band, the grass and rumble strip share the same light/dark state,
 * while the centre-line lane dash alternates twice as fast (groups of 4)
 * to give the classic dashed-line look as the road scrolls past.
 *
 * @param i - Segment index (0-based).
 * @returns SegmentColor with road, grass, rumble, and lane colours.
 */
function makeColor(i: number): SegmentColor
{
  const band = Math.floor(i / 8) % 2 === 0;
  const dash = Math.floor(i / 4) % 2 === 0;
  return {
    road:   band ? COLORS.ROAD_LIGHT  : COLORS.ROAD_DARK,
    grass:  band ? COLORS.SAND_LIGHT : COLORS.SAND_DARK,
    rumble: band ? COLORS.RUMBLE_RED  : COLORS.RUMBLE_WHITE,
    lane:   dash ? COLORS.LANE        : '',
  };
}

// ── Road class ────────────────────────────────────────────────────────────────

export class Road
{
  /** All segments in order from start to end of the track. */
  segments: RoadSegment[] = [];

  /**
   * The Y (height) coordinate of the last segment added.
   * Tracked so that hill sections chain smoothly — each new section
   * starts from where the previous one ended.
   */
  private lastY = 0;

  /** Builds the track layout immediately on construction. */
  constructor()
  {
    this.resetRoad();
  }

  /** Total number of segments in the track. Used for wrap-around maths. */
  get count(): number
  {
    return this.segments.length;
  }

  // ── Core builder ─────────────────────────────────────────────────────────

  /**
   * Appends one segment to the road array.
   *
   * p1 is the NEAR edge of the strip (worldZ = i * SEGMENT_LENGTH, y = lastY).
   * p2 is the FAR  edge of the strip (worldZ = (i+1) * SEGMENT_LENGTH, y = y).
   *
   * After adding, lastY is updated so the next segment starts at this segment's far end.
   *
   * @param curve - Horizontal bend strength for this segment (0 = straight, 6 = hard).
   * @param y     - World-space height of this segment's far edge.
   */
  private addSegment(curve: number, y: number): void
  {
    const i      = this.segments.length;
    const seg: RoadSegment =
    {
      index: i,
      p1:    makeProjectedPoint(i * SEGMENT_LENGTH, this.lastY),
      p2:    makeProjectedPoint((i + 1) * SEGMENT_LENGTH, y),
      curve,
      color: makeColor(i),
    };
    this.lastY = y;
    this.segments.push(seg);
  }

  /**
   * Adds a road section made of three phases: ease in → hold → ease out.
   *
   * This is what makes OutRun's curves feel natural — instead of snapping to a
   * fixed bend angle, the road gradually winds up to the target curve over
   * `enter` segments, holds it for `hold` segments, then unwinds over `leave`
   * segments.  Hills work the same way along the Y axis.
   *
   * @param enter - Number of segments to ease IN to the target curve/hill.
   * @param hold  - Number of segments to hold the target curve/hill constant.
   * @param leave - Number of segments to ease OUT back to zero curve/flat.
   * @param curve - Target horizontal bend during the hold phase.
   * @param hill  - Total world-unit height change over the whole section.
   *                Positive = uphill, negative = downhill.
   *                Small vs CAMERA_HEIGHT (1000): HIGH=60 ≈ 6% grade.
   */
  private addRoad(
    enter: number, hold: number, leave: number,
    curve: number, hill:  number,
  ): void
  {
    const startY = this.lastY;
    const endY   = startY + hill;   // total rise/fall, NOT per-segment

    for (let n = 0; n < enter; n++)
    {
      this.addSegment(
        easeIn(0, curve, n / enter),
        easeInOut(startY, endY, n / (enter + hold + leave)),
      );
    }
    for (let n = 0; n < hold; n++)
    {
      this.addSegment(
        curve,
        easeInOut(startY, endY, (enter + n) / (enter + hold + leave)),
      );
    }
    for (let n = 0; n < leave; n++)
    {
      this.addSegment(
        easeIn(curve, 0, n / leave),
        easeInOut(startY, endY, (enter + hold + n) / (enter + hold + leave)),
      );
    }
  }

  // ── Track layout ──────────────────────────────────────────────────────────

  /**
   * Clears all existing segments and builds the Nürburgring-inspired track.
   *
   * Layout pillars (like the real Nordschleife):
   *   • Long sustained corners — you're committed for 3–5 seconds.
   *   • Blind crests MID-corner — you cannot see the exit.
   *   • Long straights feed DIRECTLY into hard corners — no time to react.
   *   • Back-to-back hard sections with no breathing room in between.
   *
   * ~620 segments ≈ 14 seconds at max speed before the lap loops.
   */
  private resetRoad(): void
  {
    this.segments = [];
    this.lastY    = 0;

    const r = (enter: number, hold: number, leave: number, curve: number, hill: number) =>
      this.addRoad(enter, hold, leave, curve, hill);

    const CE = ROAD_CURVE.EASY;   // 2  — gentle sweeper
    const CM = ROAD_CURVE.MEDIUM; // 4  — committed corner
    const CH = ROAD_CURVE.HARD;   // 6  — survival corner
    const HL = ROAD_HILL.LOW;     // 20
    const HM = ROAD_HILL.MEDIUM;  // 40
    const HH = ROAD_HILL.HIGH;    // 60 — blind crest territory

    // ── 1. Launch straight ────────────────────────────────────────────────
    r(1,  18,  1,    0,   0);             // 20 — build speed, feel the car

    // ── 2. Flugplatz — long climbing right sweeper ────────────────────────
    // Feels manageable at first. At full speed it fights you the whole way.
    r(12, 55, 12,   CE,  HL);             // 79 — long easy right, climbing
    r(8,  10,  8,    0, -HL);             // 26 — crest and brief flat

    // ── 3. Hatzenbach — hard uphill left, blind entry ─────────────────────
    // The flat before it lures you in full throttle. Don't.
    r(1,  10,  1,    0,   0);             // 12 — false sense of safety
    r(10, 35, 10,  -CH,  HM);             // 55 — climbing hard left, no exit visible

    // ── 4. Blind downhill right — you're over the crest into a right ──────
    r(10, 25, 10,   CH, -HM);             // 45 — hard right, road drops away fast

    // ── 5. Long downhill straight ─────────────────────────────────────────
    r(1,  32,  1,    0, -HL);             // 34 — speed builds on the descent

    // ── 6. Adenauer Forst — long sustained medium-left sweeper ───────────
    // It keeps going. And going. This is where the drift happens.
    r(15, 55, 15,  -CM,   0);             // 85 — patience and commitment required

    // ── 7. Bergwerk — hard right then immediate hard left ─────────────────
    // Zero gap. If the car is still sliding from the right, the left takes you off.
    r(1,   5,  1,    0,   0);             // 7  — barely a breath
    r(10, 28, 10,   CH,   0);             // 48 — hard right
    r(10, 28, 10,  -CH,   0);             // 48 — hard left, immediate

    // ── 8. Döttinger Höhe — the long flat-out straight ────────────────────
    // Longest straight on the lap. Build maximum speed. You'll pay for it.
    r(1,  55,  1,    0,   0);             // 57 — go flat. All of it.

    // ── 9. Tiergarten — hard right over a blind hill crest ────────────────
    // Maximum speed. Hard right. Climbing. You cannot see the exit. Ever.
    r(10, 38, 10,   CH,  HH);             // 58 — the hardest moment on the lap

    // ── 10. Schwalbenschwanz — left, road drops beneath you ──────────────
    r(10, 32, 10,  -CH, -HM);             // 52 — hard left, downhill, drift trap

    // ── 11. Recovery medium right ─────────────────────────────────────────
    r(10, 22, 10,   CM,   0);             // 42 — breathe. Almost home.

    // ── 12. Finish straight ───────────────────────────────────────────────
    r(1,  38,  1,    0,   0);             // 40 — lap complete. Do it again.
  }

  // ── Lookup ────────────────────────────────────────────────────────────────

  /**
   * Returns the segment the player is currently standing on.
   *
   * playerZ increases as the player moves forward.  We divide by SEGMENT_LENGTH
   * to find which "slot" the player is in, then wrap around using modulo so the
   * track loops seamlessly when the player reaches the end.
   *
   * @param playerZ - Player's current depth position in world units.
   * @returns The RoadSegment beneath the player.
   */
  findSegment(playerZ: number): RoadSegment
  {
    const n   = this.count;
    const idx = Math.floor(playerZ / SEGMENT_LENGTH) % n;
    return this.segments[(idx + n) % n];
  }
}
