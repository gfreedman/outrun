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

    this.plantPalms();
    this.plantBillboards();
    this.plantCactuses();
  }

  // ── Palm placement ────────────────────────────────────────────────────────

  /**
   * Decorates every segment with palm tree sprites using a Sega-style rubric.
   *
   * ── Design rules ─────────────────────────────────────────────────────────
   *
   *   Hard corners (|curve| ≥ 2)
   *     Outside of the bend gets bent palms (T2_BENT_LEFT or T2_BENT_RIGHT)
   *     in groups of 3 or 5.  Trees within a group are spaced 3–7 segments
   *     apart.  A long cooldown (12–20 segments) separates groups.  30% of
   *     placements add a tall background palm (T6/T7/T10) further off-road.
   *     Inside of the bend gets a sparse scatter of small palms (15% chance,
   *     16–26 segment gaps) so it never feels completely bare.
   *
   *   Gentle curve / straight (|curve| < 2)
   *     Both sides are managed independently.  Each side fires a 38–50%
   *     trigger once its gap counter reaches zero.  A successful trigger
   *     places a cluster of 1 tree (72%) or 2–3 trees (28%) spaced 2–5
   *     segments apart.  25% of clusters use background varieties
   *     (T6/T7/T10) at greater distance; the rest use the general mix at
   *     road-edge distance.  Gaps between clusters: 9–17 segments.
   *
   * ── World-X ranges (ROAD_WIDTH = 2000, road edge = ±2000) ────────────────
   *
   *   Bent corner palms:      outside ±2 500 – 3 100
   *   Straight/close palms:   ±2 500 – 3 500
   *   Background tall palms:  ±3 600 – 5 200
   *   Inside sparse:          ±2 400 – 2 900
   *
   * ── PRNG ─────────────────────────────────────────────────────────────────
   *
   *   Mulberry32 seeded at 0xDEADBEEF — deterministic, same layout every run.
   */
  private plantPalms(): void
  {
    // ── Seeded PRNG (Mulberry32) ──────────────────────────────────────────
    let seed = 0xDEADBEEF;
    const rand = (): number =>
    {
      seed += 0x6D2B79F5;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967295;
    };
    const rInt = (lo: number, hi: number): number =>
      Math.floor(rand() * (hi - lo + 1)) + lo;
    const pick = <T>(arr: readonly T[]): T =>
      arr[Math.floor(rand() * arr.length)];

    // ── Palm variety pools ────────────────────────────────────────────────
    const GENERAL: readonly string[] = [
      'PALM_T1_STRAIGHT', 'PALM_T4_FRUITING',
      'PALM_T6_LUXURIANT', 'PALM_T7_SLENDER',
      'PALM_T8_MEDIUM',   'PALM_T10_LARGE',
    ];
    const BG: readonly string[] = [
      'PALM_T6_LUXURIANT', 'PALM_T7_SLENDER', 'PALM_T10_LARGE',
    ];
    const CLOSE: readonly string[] = [
      'PALM_T3_YOUNG', 'PALM_T8_MEDIUM', 'PALM_T1_STRAIGHT',
    ];

    const plant = (seg: RoadSegment, id: string, worldX: number): void =>
    {
      // Scale each palm randomly 1×–3× to mimic the size variety in the OG game.
      const scale = 1 + rand() * 2;   // uniform [1, 3]
      (seg.sprites ??= []).push({ id, worldX, scale });
    };

    // ── Weighted distance sampler ─────────────────────────────────────────────
    //
    // wX(...tiers) — each tier is [weight, minDist, maxDist].
    // Picks a tier by weight, then samples uniformly within it.
    // Returns an unsigned distance; multiply by sign(s) at the call site.
    //
    // Three-tier approach mimics real palm forest structure:
    //   Near  — tight to the road edge (dramatic, arcade feel)
    //   Mid   — comfortable mid-distance (most common)
    //   Far   — deep background silhouettes (depth, atmosphere)
    type Tier = [number, number, number]; // [weight, minDist, maxDist]
    const wX = (...tiers: Tier[]): number =>
    {
      const total = tiers.reduce((s, [w]) => s + w, 0);
      let r = rand() * total;
      for (const [w, lo, hi] of tiers)
      {
        r -= w;
        if (r <= 0) return rInt(lo, hi);
      }
      return rInt(tiers[tiers.length - 1][1], tiers[tiers.length - 1][2]);
    };

    // ── Per-side state ────────────────────────────────────────────────────
    //
    // Index 0 = left side (negative worldX).
    // Index 1 = right side (positive worldX).
    //
    // gap[s]    — segments remaining before next placement is allowed.
    // grpRem[s] — trees left to place in the current corner group.

    const gap    = [rInt(3, 10), rInt(3, 10)];
    const grpRem = [0, 0];

    const sign = (s: number): number => s === 1 ? +1 : -1;

    for (let i = 0; i < this.segments.length; i++)
    {
      const seg      = this.segments[i];
      const curve    = seg.curve;
      const absCurve = Math.abs(curve);

      // Side index for the OUTSIDE of the current bend.
      // Positive curve = turning right.  On a right turn the centre of curvature
      // is to the RIGHT, so centrifugal force pushes the car OUTWARD = LEFT.
      // Outside of a right bend → left side (index 0, negative worldX).
      // Outside of a left  bend → right side (index 1, positive worldX).
      // Confirmed by the physics: playerX -= curve * CENTRIFUGAL * dt pushes
      // the player left (negative) for positive curve = outside is left.
      const outerS = curve >= 0 ? 0 : 1;
      const innerS = 1 - outerS;

      // Tick counters
      gap[0] = Math.max(0, gap[0] - 1);
      gap[1] = Math.max(0, gap[1] - 1);

      // ── HARD CORNER — bent palms in groups of 3 or 5 ─────────────────
      if (absCurve >= 2)
      {
        // Outside: fire when gap hits zero
        if (gap[outerS] === 0)
        {
          // Begin a new group if none is active
          if (grpRem[outerS] === 0)
            grpRem[outerS] = rand() < 0.5 ? 3 : 5;

          // Place one bent palm — mostly close, occasionally mid or far back
          const bentId = outerS === 1 ? 'PALM_T2_BENT_LEFT' : 'PALM_T2_BENT_RIGHT';
          plant(seg, bentId, sign(outerS) * wX([4, 2200, 2700], [4, 2700, 3300], [2, 3300, 4200]));
          grpRem[outerS]--;

          // Optionally add a background tall palm — wide range for depth
          if (rand() < 0.30)
            plant(seg, pick(BG), sign(outerS) * wX([3, 3800, 4800], [7, 4800, 7000]));

          // Advance gap: intra-group if more remain, inter-group if done
          gap[outerS] = grpRem[outerS] > 0 ? rInt(3, 7) : rInt(12, 20);
        }

        // Inside: sparse small palms
        if (gap[innerS] === 0 && rand() < 0.15)
        {
          // Inside of corner: hug the road edge with occasional mid-distance
          plant(seg, pick(CLOSE), sign(innerS) * wX([6, 2200, 2700], [4, 2700, 3600]));
          gap[innerS] = rInt(16, 26);
        }
      }

      // ── GENTLE CURVE / STRAIGHT — scattered general palms ────────────
      else
      {
        for (let s = 0; s < 2; s++)
        {
          if (gap[s] > 0) continue;

          // Outside of a gentle curve fires a little more readily
          const isCurve  = absCurve >= 0.5;
          const isOuter  = isCurve && s === outerS;
          const density  = isOuter ? 0.50 : 0.38;

          if (rand() >= density) { gap[s] = rInt(4, 9); continue; }

          // 28% chance: cluster of 2–3; otherwise a single tree
          const clSize = rand() < 0.28 ? rInt(2, 3) : 1;
          for (let c = 0; c < clSize; c++)
          {
            const ti = i + c * rInt(2, 5);
            if (ti >= this.segments.length) break;
            const tseg = this.segments[ti];

            if (rand() < 0.25)
              // Background palms: deep silhouettes spanning a wide range
              plant(tseg, pick(BG),      sign(s) * wX([3, 3400, 4500], [7, 4500, 7000]));
            else
              // General palms: full spread from road edge to mid-background
              plant(tseg, pick(GENERAL), sign(s) * wX([3, 2200, 2700], [5, 2700, 4000], [2, 4000, 5500]));
          }

          gap[s] = rInt(9, 17);
        }
      }
    }
  }

  // ── Billboard placement ───────────────────────────────────────────────────

  /**
   * Scatters billboard sprites alongside the road.
   * Follows the same pattern as plantPalms() — seeded PRNG, per-side gap counters.
   * One billboard at a time, suppressed on hard corners (|curve| ≥ 4).
   * Themed pools loosely by track section (beagle → tavern → tobacco).
   * Seeded independently (0xCAFEBABE) so palm changes don't reshuffle signs.
   */
  private plantBillboards(): void
  {
    let seed = Date.now() >>> 0;   // random each page load
    const rand = (): number =>
    {
      seed += 0x6D2B79F5;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967295;
    };
    const rInt = (lo: number, hi: number): number =>
      Math.floor(rand() * (hi - lo + 1)) + lo;
    const pick = <T>(arr: readonly T[]): T =>
      arr[Math.floor(rand() * arr.length)];

    const plant = (seg: RoadSegment, id: string, worldX: number): void =>
    {
      (seg.sprites ??= []).push({ id, worldX });
    };

    const BEAGLE:  readonly string[] = ['BILLBOARD_BEAGLE_PETS', 'BILLBOARD_ADOPT_BEAGLE', 'BILLBOARD_BEAGLE_POWER', 'BILLBOARD_LOYAL_FRIENDLY'];
    const TAVERN:  readonly string[] = ['BILLBOARD_FROG_TAVERN', 'BILLBOARD_ALE_CROAK', 'BILLBOARD_CELLAR_JUMPERS', 'BILLBOARD_CROAK_TAILS'];
    const TOBACCO: readonly string[] = ['BILLBOARD_RED_BOX', 'BILLBOARD_FINE_TOBACCO', 'BILLBOARD_SMOOTH_TASTE', 'BILLBOARD_WRESTLING'];

    const poolFor = (i: number): readonly string[] =>
      i < 200 ? BEAGLE : i < 400 ? TAVERN : TOBACCO;

    const gap = [rInt(15, 30), rInt(20, 40)];

    for (let i = 0; i < this.segments.length; i++)
    {
      const seg      = this.segments[i];
      const absCurve = Math.abs(seg.curve);

      if (absCurve >= 4) { gap[0] = Math.max(gap[0], 8); gap[1] = Math.max(gap[1], 8); continue; }

      gap[0] = Math.max(0, gap[0] - 1);
      gap[1] = Math.max(0, gap[1] - 1);

      for (let s = 0; s < 2; s++)
      {
        if (gap[s] > 0) continue;
        const density = absCurve < 1 ? 0.45 : 0.35;
        if (rand() >= density) { gap[s] = rInt(10, 20); continue; }
        const sign   = s === 1 ? +1 : -1;
        const worldX = sign * rInt(2000, 2600);
        plant(seg, pick(poolFor(i)), worldX);
        gap[s] = rInt(30, 55);
      }
    }
  }

  // ── Cactus placement ─────────────────────────────────────────────────────

  /**
   * Sprinkles cactus sprites alongside the road, interspersed with palms and
   * billboards.  Uses a dedicated PRNG seed (0xBADC0FFE) so cactus layout is
   * independent of palm and billboard passes.
   *
   * Placement rules:
   *   - Random gap of 8–25 segments between cactuses on each side.
   *   - Suppressed on tight curves (|curve| ≥ 4).
   *   - WorldX: 1800–3500 wu from road centre (shoulder + verge).
   *   - Random scale 0.6–1.8× so they feel naturally varied in size.
   */
  private plantCactuses(): void
  {
    // Mulberry32 PRNG — independent seed from palms/billboards.
    let s32 = 0xBADC0FFE;
    const rand = () => { s32 |= 0; s32 = s32 + 0x6D2B79F5 | 0; let t = Math.imul(s32 ^ s32 >>> 15, 1 | s32); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    const rInt = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

    const CACTI: string[] = [
      'CACTUS_C1',  'CACTUS_C2',  'CACTUS_C3',  'CACTUS_C4',
      'CACTUS_C5',  'CACTUS_C6',  'CACTUS_C7',  'CACTUS_C8',
      'CACTUS_C9',  'CACTUS_C10', 'CACTUS_C11', 'CACTUS_C12',
      'CACTUS_C13', 'CACTUS_C14', 'CACTUS_C15', 'CACTUS_C16',
      'CACTUS_C17', 'CACTUS_C18', 'CACTUS_C19', 'CACTUS_C20',
      'CACTUS_C21', 'CACTUS_C22',
    ];
    const pick = (pool: string[]) => pool[Math.floor(rand() * pool.length)];

    const plant = (seg: RoadSegment, id: string, worldX: number): void =>
    {
      const scale = 0.8 + rand() * 0.8;   // [0.8, 1.6]
      (seg.sprites ??= []).push({ id, worldX, scale });
    };

    const count = this.segments.length;
    // Three independent cooldown tracks per side: near, mid, far
    const gap   = [0, 0, 0, 0, 0, 0];   // [near-L, near-R, mid-L, mid-R, far-L, far-R]

    for (let i = 0; i < count; i++)
    {
      const seg      = this.segments[i];
      const absCurve = Math.abs(seg.curve);

      for (let g = 0; g < 6; g++) gap[g] = Math.max(0, gap[g] - 1);

      if (absCurve >= 4) continue;

      for (let s = 0; s < 2; s++)
      {
        const sign = s === 1 ? +1 : -1;

        // Near band: tight to road shoulder (1800–3000)
        if (gap[s] === 0)
        {
          if (rand() < 0.65) {
            plant(seg, pick(CACTI), sign * rInt(1800, 3000));
          }
          gap[s] = rInt(3, 8);
        }

        // Mid band: into the sand (3500–6000)
        if (gap[2 + s] === 0)
        {
          if (rand() < 0.75) {
            plant(seg, pick(CACTI), sign * rInt(3500, 6000));
          }
          gap[2 + s] = rInt(2, 6);
        }

        // Far band: deep desert edge (7000–12000)
        if (gap[4 + s] === 0)
        {
          if (rand() < 0.80) {
            plant(seg, pick(CACTI), sign * rInt(7000, 12000));
          }
          gap[4 + s] = rInt(2, 5);
        }
      }
    }
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
