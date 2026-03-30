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

import { RoadSegment, ProjectedPoint, SegmentColor, SpriteFamily, SpriteInstance, GameMode } from './types';
import { SEGMENT_LENGTH, COLORS, ROAD_CURVE, ROAD_HILL, COLOR_BAND_PERIOD, RACE_CONFIG } from './constants';
import { SpriteId } from './sprites';

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
 * WHY smoothstep (cosine) rather than plain linear interpolation?
 *   Linear interpolation produces a constant rate of change, so when the road
 *   transitions from a flat section (curve=0) into a bend, the curvature jumps
 *   instantaneously.  At typical road speeds that step is visible as a jarring
 *   "snap" — the steering force appears and disappears without warning.
 *
 *   The cosine S-curve has a ZERO derivative at both endpoints (percent=0 and
 *   percent=1), so the curvature rate starts at zero, peaks mid-transition, then
 *   eases back to zero.  The result is perceptually smooth: curves "come in" the
 *   way they do on real roads and in the original 1986 arcade hardware.
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
 * WHY period = 8 for grass and rumble?
 *   At typical play speed (~40–60 segments/sec visible scroll rate) an 8-segment
 *   band takes ~130–200 ms to pass the player — just long enough for the eye to
 *   register green/sand alternation without the strips becoming a blur.  This
 *   closely matches the stripe cadence visible in the original OutRun PCB video
 *   captures: the grass rhythm is readable at any speed without strobing.
 *
 * WHY period = 4 for lane dashes (half the grass period)?
 *   The dashed centre line must look like distinct marks, not a solid stripe.
 *   Halving the period (4 segments on, 4 off) doubles the frequency so the
 *   dashes remain clearly separated even at high speed, matching the arcade.
 *   The grass/rumble period stays at 8 — their larger area needs a slower
 *   rhythm to read as "chunks" rather than flicker.
 *
 * @param i - Segment index (0-based).
 * @returns SegmentColor with road, grass, rumble, and lane colours.
 */
function makeColor(i: number): SegmentColor
{
  // Every COLOR_BAND_PERIOD (8) segments forms one colour band (alternating 0/1).
  // Grass and rumble share this period; lane dashes use period/2 (4) so they
  // appear as distinct marks at speed rather than blending into a solid line.
  const band = Math.floor(i / COLOR_BAND_PERIOD) % 2 === 0;
  return {
    road:   band ? COLORS.ROAD_LIGHT  : COLORS.ROAD_DARK,
    grass:  band ? COLORS.SAND_LIGHT  : COLORS.SAND_DARK,
    rumble: band ? COLORS.RUMBLE_RED  : COLORS.RUMBLE_WHITE,
    lane:   band ? COLORS.LANE        : '',
  };
}

// ── PRNG factory ──────────────────────────────────────────────────────────────

/**
 * Creates a seeded Mulberry32 PRNG with rand / rInt / pick helpers.
 *
 * Pass any 32-bit integer seed.  XOR with Date.now() at the call site for
 * per-load randomisation while keeping distinct seeds for each planter:
 *   makePRNG(Date.now() ^ 0xC00C1E5)
 *
 * Deterministic planters (palms, cactuses) pass a fixed constant directly:
 *   makePRNG(0xDEADBEEF)
 */
function makePRNG(seed: number): {
  rand: () => number;
  rInt: (lo: number, hi: number) => number;
  pick: <T>(arr: readonly T[]) => T;
}
{
  // Force to unsigned 32-bit integer for bitwise operations
  let s = seed >>> 0;

  /**
   * Returns a pseudo-random float in [0, 1).
   * Uses the Mulberry32 algorithm: three mix/multiply rounds on a
   * single 32-bit state variable.  Period is 2^32 before repeating.
   */
  const rand = (): number =>
  {
    s += 0x6D2B79F5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967295;
  };

  /** Returns a pseudo-random integer in [lo, hi] inclusive. */
  const rInt = (lo: number, hi: number): number =>
    Math.floor(rand() * (hi - lo + 1)) + lo;

  /** Returns a uniformly random element from the given array. */
  const pick = <T>(arr: readonly T[]): T =>
    arr[Math.floor(rand() * arr.length)];

  return { rand, rInt, pick };
}

// ── Serialized segment format (for prebuild road-data.ts) ─────────────────────

/**
 * Minimal per-segment data needed to reconstruct a RoadSegment at runtime.
 * Screen-space projection fields (p1.screen, p2.screen) are excluded because
 * the renderer's Pass 1 overwrites them every frame anyway.
 *
 * Generated by `scripts/generate-road.ts` → `src/road-data.ts`.
 */
export interface SerializedSegment
{
  /** Sequential segment index (0-based). */
  index:   number;
  /** Horizontal curve strength for this segment. */
  curve:   number;
  /** Pre-computed colour set (road, grass, rumble, lane). */
  color:   SegmentColor;
  /** Roadside objects attached to this segment (empty array if none). */
  sprites: SpriteInstance[];
  /** Near edge (p1) world Y coordinate (height above ground). */
  p1y:     number;
  /** Near edge (p1) world Z coordinate (depth along road). */
  p1z:     number;
  /** Far edge (p2) world Y coordinate (height above ground). */
  p2y:     number;
  /** Far edge (p2) world Z coordinate (depth along road). */
  p2z:     number;
}

// ── Road class ────────────────────────────────────────────────────────────────

export class Road
{
  /** All segments in order from start to end of the track. */
  private _segments: RoadSegment[] = [];

  /** Read-only view of the segment array — prevents external mutation. */
  get segments(): readonly RoadSegment[] { return this._segments; }

  /**
   * The Y (height) coordinate of the last segment added.
   * Tracked so that hill sections chain smoothly — each new section
   * starts from where the previous one ended.
   */
  private lastY = 0;

  /**
   * Cross-type board spacing: tracks the last segment index where a board was
   * placed on each side [left, right].  Used by plantBillboards() and
   * plantBigBoards() only — cookie and barney boards use independent gap
   * tracking so they are never starved out by the more frequent og boards.
   */
  private boardLastPlaced: [number, number] = [-999, -999];
  private static readonly MIN_BOARD_GAP = 45;

  /**
   * Builds the track layout immediately on construction.
   *
   * @param variant - 'default' for the Coconut Beach / Nurburgring course,
   *                  'hard' for the extended hard-mode course.
   */
  constructor(variant: 'default' | 'hard' | 'legendary' = 'default')
  {
    if (variant === 'hard')      this.resetHardRoad();
    else if (variant === 'legendary') this.resetLegendaryRoad();
    else                         this.resetRoad();
  }

  /**
   * Total number of segments in the current track.  Used for modulo wrap-around
   * maths in the renderer (e.g. `segIdx = absIdx % road.count`).
   *
   * WHY a dynamic getter rather than a constant?
   *   Different track variants (default / hard / legendary) have different segment
   *   counts, and the count also changes whenever resetRoad / resetHardRoad /
   *   resetLegendaryRoad is called.  Caching it as a constant would go stale the
   *   moment the road is rebuilt.  The getter always reads the live array length,
   *   so callers never need to know which variant is active.
   */
  get count(): number
  {
    return this._segments.length;
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
   * ── World-unit coordinate convention ────────────────────────────────────────
   *   All positions in the segment array use the same world-space unit system:
   *
   *   • Z axis — depth along the road.  Increases away from the player.
   *     One segment = SEGMENT_LENGTH (200) world units deep.
   *     ROAD_WIDTH = 2000 world units → the road is 10 segments wide in Z terms.
   *
   *   • Y axis — height above the flat baseline (y = 0).
   *     Positive Y = above ground (uphill crest), negative Y = below (valley).
   *     CAMERA_HEIGHT = 1000 world units above the road surface.
   *     A HIGH hill (ROAD_HILL.HIGH = 60) raises the road 60 units — just 6% of
   *     camera height, which produces a convincing but not extreme crest.
   *
   *   • X axis — lateral offset from road centre.
   *     Sprite worldX values use the same units: a palm at worldX = ±1200 sits
   *     600 units beyond the road edge (road half-width = 1000).  The renderer
   *     converts worldX → screen pixels via:  sprX = sx1 + worldX * sc1 * halfW
   *     where sc1 = CAMERA_DEPTH / cameraZ is the perspective scale at that segment.
   *
   * @param curve - Horizontal bend strength for this segment (0 = straight, 6 = hard).
   * @param y     - World-space height of this segment's far edge.
   */
  private addSegment(curve: number, y: number): void
  {
    const i      = this._segments.length;
    const seg: RoadSegment =
    {
      index: i,
      p1:    makeProjectedPoint(i * SEGMENT_LENGTH, this.lastY),
      p2:    makeProjectedPoint((i + 1) * SEGMENT_LENGTH, y),
      curve,
      color: makeColor(i),
    };
    this.lastY = y;
    this._segments.push(seg);
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
   * ~1185 segments ≈ 22 seconds at max speed before the lap loops.
   */
  private resetRoad(): void
  {
    this._segments = [];
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
    // 100 segments ensures the first corner trigger lands at seg ~108,
    // giving all 6 warning signs positive indices (need trigger >= 96 for
    // SPACING=16 × 6 signs).
    r(1,  98,  1,    0,   0);             // 100 — build speed, feel the car

    // ── 2. Flugplatz — long climbing right sweeper ────────────────────────
    // Feels manageable at first. At full speed it fights you the whole way.
    r(12, 110, 12,   CE,  HL);            // 134 — long easy right, climbing
    r(8,  10,  8,    0, -HL);             // 26  — crest and brief flat

    // ── 3. Hatzenbach — hard uphill left, blind entry ─────────────────────
    // The flat before it lures you in full throttle. Don't.
    r(1,  10,  1,    0,   0);             // 12 — false sense of safety
    r(10, 55, 10,  -CH,  HM);             // 75 — climbing hard left, no exit visible

    // ── 4. Blind downhill right — you're over the crest into a right ──────
    r(10, 45, 10,   CH, -HM);             // 65 — hard right, road drops away fast

    // ── 5. Long downhill straight ─────────────────────────────────────────
    r(1,  58,  1,    0, -HL);             // 60 — speed builds on the descent

    // ── 6. Adenauer Forst — long sustained medium-left sweeper ───────────
    // It keeps going. And going. This is where the drift happens.
    r(15, 120, 15,  -CM,   0);            // 150 — patience and commitment required

    // ── 7. Bergwerk — hard right then immediate hard left ─────────────────
    // Zero gap. If the car is still sliding from the right, the left takes you off.
    r(1,   5,  1,    0,   0);             // 7  — barely a breath
    r(10, 60, 10,   CH,   0);             // 80 — hard right
    r(10, 60, 10,  -CH,   0);             // 80 — hard left, immediate

    // ── 8. Döttinger Höhe — the long flat-out straight ────────────────────
    // Longest straight on the lap. Build maximum speed. You'll pay for it.
    r(1,  110,  1,   0,   0);             // 112 — go flat. All of it.

    // ── 9. Tiergarten — hard right over a blind hill crest ────────────────
    // Maximum speed. Hard right. Climbing. You cannot see the exit. Ever.
    r(10, 76, 10,   CH,  HH);             // 96 — the hardest moment on the lap

    // ── 10. Schwalbenschwanz — left, road drops beneath you ──────────────
    r(10, 64, 10,  -CH, -HM);             // 84 — hard left, downhill, drift trap

    // ── 11. Recovery medium right ─────────────────────────────────────────
    r(10, 44, 10,   CM,   0);             // 64 — breathe. Almost home.

    // ── 12. Finish straight ───────────────────────────────────────────────
    r(1,  78,  1,    0,   0);             // 80 — lap complete. Do it again.

    this.boardLastPlaced = [-999, -999];

    this.plantSigns();
    this.plantShrubs();
    this.plantPalms();
    this.plantBillboards();
    this.plantCookieBoards();
    this.plantBarneyBoards();
    this.plantBigBoards();
    this.plantCactuses();
    this.plantHouses();
  }

  /**
   * Hard-mode course — a completely different track to EASY/MEDIUM.
   *
   * Design pillars:
   *   • Mega sweepers: 200+ segment curves — you commit for 10+ seconds.
   *   • Blind crests: hill goes HIGH then drops sharply, mid-corner.
   *   • Chicanes: rapid left-right-left snaps with minimal transition.
   *   • Hilly S-curves: elevation changes WHILE the road alternates direction.
   *   • Almost no breathing room — one challenge feeds directly into the next.
   *
   * ~2000 segments before the lap loops.
   */
  private resetHardRoad(): void
  {
    this._segments = [];
    this.lastY    = 0;

    const r = (enter: number, hold: number, leave: number, curve: number, hill: number) =>
      this.addRoad(enter, hold, leave, curve, hill);

    const CE = ROAD_CURVE.EASY;   // 2  — sweeper
    const CM = ROAD_CURVE.MEDIUM; // 4  — committed corner
    const CH = ROAD_CURVE.HARD;   // 6  — survival turn
    const HL = ROAD_HILL.LOW;     // 20
    const HM = ROAD_HILL.MEDIUM;  // 40
    const HH = ROAD_HILL.HIGH;    // 60 — blind crest / big drop

    // ── 1. Launch straight ────────────────────────────────────────────────────
    // Long enough that warning signs for the first curve fit (need ≥96 segs).
    r(1,  98,  1,    0,   0);     // 100 — build speed, absorb the length ahead

    // ── 2. MEGA SWEEPER LEFT — the opening commitment ──────────────────────
    // 220 hold segments. You forget you're still in it.
    r(25, 220, 25,  -CE,  0);     // 270 — vast left bend, flat

    // ── 3. Blind crest MID-SWEEP — road rises then disappears ─────────────
    // You're still deep in the left when the hill swallows your view.
    r(10,  70, 10,  -CE, HH);     //  90 — left bend + big climb
    r( 8,  30,  8,    0,-HH);     //  46 — crest, then sharp drop into flat

    // ── 4. CHICANE 1 — hard right-left-right snap sequence ────────────────
    r( 8,  15,  8,   CH,  0);     //  31 — snap hard right
    r( 8,  15,  8,  -CH,  0);     //  31 — snap hard left
    r( 8,  15,  8,   CH,  0);     //  31 — snap hard right again

    // ── 5. Brief flat ─────────────────────────────────────────────────────
    r( 5,  20,  5,    0,  0);     //  30

    // ── 6. MEGA SWEEPER RIGHT — climbing all the way ──────────────────────
    // The corner seems easy at first. The hill just keeps coming.
    r(25, 180, 25,   CE, HM);     // 230 — vast right bend, going up steadily

    // ── 7. Crest + sharp drop, still in the right bend ────────────────────
    // You are at max speed. The road drops out from under you.
    r(10,  50, 10,   CE,-HH);     //  70 — right bend + dramatic downhill

    // ── 8. S-CURVE SEQUENCE 1 — four alternating medium corners ───────────
    r(15,  60, 15,   CM,  0);     //  90 — medium right
    r(15,  60, 15,  -CM,  0);     //  90 — medium left
    r(15,  60, 15,   CM,  0);     //  90 — medium right
    r(15,  60, 15,  -CM,  0);     //  90 — medium left

    // ── 9. Flat breather ──────────────────────────────────────────────────
    r( 1,  25,  1,    0,  0);     //  27

    // ── 10. Blind rise into hard left ────────────────────────────────────
    // The hill is perfectly straight — begs you to hold flat.
    // The hard left waits at the very top where you have no sight line.
    r(15,  90, 15,    0, HH);     // 120 — straight up
    r(10,  50, 10,  -CH,-HH);     //  70 — hard left + dramatic drop together

    // ── 11. CHICANE 2 — four-part alternating, no rest between ────────────
    r( 6,  14,  6,  -CH,  0);     //  26
    r( 6,  14,  6,   CH,  0);     //  26
    r( 6,  14,  6,  -CH,  0);     //  26
    r( 6,  14,  6,   CH,  0);     //  26

    // ── 12. MEGA SWEEPER RIGHT — long medium corner ───────────────────────
    r(20, 160, 20,   CM,  0);     // 200 — medium right, extended hold

    // ── 13. HILLY S-CURVES — elevation changes while direction alternates ─
    // The road tilts, crests, drops, and turns simultaneously.
    r(12,  50, 12,   CM, HM);     //  74 — medium right + climb
    r(12,  50, 12,  -CM,-HM);     //  74 — medium left + drop
    r(12,  50, 12,   CE, HH);     //  74 — easy right + big climb
    r(12,  50, 12,  -CE,-HH);     //  74 — easy left + big drop

    // ── 14. Final blast to the line ────────────────────────────────────────
    r(10,  80, 10,    0,  0);     // 100 — flat out

    this.boardLastPlaced = [-999, -999];

    this.plantSigns();
    this.plantShrubs();
    this.plantPalms();
    this.plantBillboards();
    this.plantCookieBoards();
    this.plantBarneyBoards();
    this.plantBigBoards();
    this.plantCactuses();
    this.plantHouses();
  }

  /**
   * THE CATHEDRAL — legendary hard-mode course.
   *
   * Spa-Francorchamps × Nürburgring Nordschleife.  Three acts:
   *
   *   ACT 1 — SPA OPENING
   *     La Source hairpin → Eau Rouge / Raidillon blind climb →
   *     Kemmel Straight blast → Les Combes chicane →
   *     Pouhon mega-sweeper → Blanchimont → Bus Stop surprise.
   *
   *   ACT 2 — NORDSCHLEIFE TRANSITION
   *     Hatzenbach technical sequence → Quiddelbacher Höhe blind crest+surprise →
   *     Schwedenkreuz THE mega left sweeper (220 hold) →
   *     Aremberg downhill → Fuchsröhre blind downhill → Adenauer tight section.
   *
   *   ACT 3 — THE GREEN HELL CAULDRON
   *     Das Karussell (220-hold hard left going up — THE WALL) →
   *     Hohe Acht summit blind drop → Pflanzgarten compression jumps →
   *     Stefan Bellof S-bends → Kesselchen downhill blast →
   *     Klostertal climber → final home straight.
   *
   * ~3 500 segments ≈ 5.3 km.  No rest zones.  Every long straight feeds
   * directly into the hardest corner of its act.
   */
  private resetLegendaryRoad(): void
  {
    this._segments = [];
    this.lastY    = 0;

    const r = (enter: number, hold: number, leave: number, curve: number, hill: number) =>
      this.addRoad(enter, hold, leave, curve, hill);

    const CE = ROAD_CURVE.EASY;   // 2  — sweeper
    const CM = ROAD_CURVE.MEDIUM; // 4  — committed corner
    const CH = ROAD_CURVE.HARD;   // 6  — survival turn
    const HL = ROAD_HILL.LOW;     // 150
    const HM = ROAD_HILL.MEDIUM;  // 350
    const HH = ROAD_HILL.HIGH;    // 600 — blind crest territory

    // ══════════════════════════════════════════════════════════════════════
    // ACT 1 — SPA OPENING
    // ══════════════════════════════════════════════════════════════════════

    // ── Pre-grid straight ─────────────────────────────────────────────────
    r( 1, 80,  1,    0,   0);     //  82 — build speed, read the wall ahead

    // ── La Source — hard right hairpin ────────────────────────────────────
    // The most famous braking point on the calendar. No gradual entry.
    r(10, 28, 10,   CH,   0);     //  48 — snap hard right

    // ── Eau Rouge valley — flat slight left ───────────────────────────────
    // The dip before the fury. Easy, fast.
    r( 8, 28,  8,  -CE,   0);     //  44 — flat slight left, floor it

    // ── Raidillon — blind uphill sweeping right ───────────────────────────
    // Heart of Spa. You commit at 250 km/h. The crest swallows the exit.
    r(10, 65, 10,   CE,  HH);     //  85 — climbing right, sight line gone
    r( 8, 22,  8,    0,  HM);     //  38 — blind crest straight over the top

    // ── Kemmel Straight — 140-hold flat blast ─────────────────────────────
    // Longest flat run on the circuit. Pedal flat. Traffic ahead.
    r( 1,140,  1,    0,   0);     // 142 — maximum speed

    // ── Les Combes chicane ────────────────────────────────────────────────
    // Hard braking zone into a right-left snap. No run-off.
    r( 8, 22,  8,   CH,   0);     //  38 — hard right
    r( 8, 22,  8,  -CH,   0);     //  38 — hard left mirror

    // ── Rivage — medium right going down ──────────────────────────────────
    r(12, 48, 12,   CM, -HL);     //  72 — medium right, slight descent

    // ── Pouhon — vast double-left sweeper ────────────────────────────────
    // Two apexes, flat out in a modern car. Here you are committed.
    // The road rises gently — you arrive at the second apex blind.
    r(22,165, 22,  -CE,  HL);     // 209 — the great left

    // ── Brief flat before Blanchimont ────────────────────────────────────
    r( 1, 40,  1,    0,   0);     //  42

    // ── Blanchimont — very fast right sweeper ────────────────────────────
    // Almost flat out. One mistake and you find the barrier.
    r(15,105, 15,   CE,   0);     // 135 — flat-out right

    // ── Bus Stop chicane — tight surprise ────────────────────────────────
    // The lap's only slow corner, and it always catches you by surprise.
    r( 6, 15,  6,   CH,   0);     //  27 — hard right
    r( 6, 15,  6,  -CH,   0);     //  27 — hard left

    // ── Connector — short straight to link into Nordschleife ─────────────
    r( 1, 35,  1,    0,   0);     //  37

    // ══════════════════════════════════════════════════════════════════════
    // ACT 2 — NORDSCHLEIFE TRANSITION
    // ══════════════════════════════════════════════════════════════════════

    // ── Hatzenbach — fast technical sequence ──────────────────────────────
    // Three medium corners with no recovery gap. Rhythm required.
    r(10, 42, 10,   CM,   0);     //  62 — medium right
    r(10, 42, 10,  -CM,   0);     //  62 — medium left
    r(10, 32, 10,   CE,  HL);     //  52 — easy right, slight rise

    // ── Hocheichen — fast right over a small rise ─────────────────────────
    r( 8, 52,  8,   CE,  HM);     //  68 — climbing right

    // ── Quiddelbacher Höhe — blind straight crest then HARD LEFT ─────────
    // The hill is perfectly straight — it screams at you to hold flat.
    // The hard left waits at the very top. No warning. No run-off.
    r( 1, 75,  1,    0,  HH);     //  77 — straight climb, no braking point visible
    r(10, 32, 10,  -CH, -HH);     //  52 — SURPRISE: hard left + massive drop

    // ── Flugplatz — double compression bump ──────────────────────────────
    // Short undulations that unsettle the car mid-corner.
    r( 1, 55,  1,    0,  HM);     //  57 — up
    r( 1, 22,  1,    0, -HM);     //  24 — down

    // ── Schwedenkreuz — THE MEGA LEFT SWEEPER ────────────────────────────
    // 220 hold segments. You forget you are still in it.
    // Flat, fast, relentless. This is what a F1 car was built for.
    r(25,220, 25,  -CE,   0);     // 270 — vast left, 10+ seconds at full speed

    // ── Aremberg — fast downhill right ───────────────────────────────────
    // Drops away into the valley. Don't brake too late.
    r(12, 58, 12,   CM, -HM);     //  82 — medium right, falling fast

    // ── Fuchsröhre — long blind downhill straight ─────────────────────────
    // The road keeps dropping. You are going faster than feels safe.
    // No corners. No shelter. Just commitment.
    r( 1,115,  1,    0, -HH);     // 117 — long fall, maximum speed

    // ── Adenauer Forst — tight technical section ──────────────────────────
    // Three snappy corners, back to back. This is why the Nordschleife
    // has killed more cars than any other track on earth.
    r( 6, 15,  6,  -CH,   0);     //  27
    r( 6, 15,  6,   CH,  HM);     //  27 — right + climbing
    r( 6, 15,  6,  -CM, -HM);     //  27 — medium left + dropping

    // ── Brief recovery valley ─────────────────────────────────────────────
    r( 1, 30,  1,    0,   0);     //  32

    // ══════════════════════════════════════════════════════════════════════
    // ACT 3 — THE GREEN HELL CAULDRON
    // ══════════════════════════════════════════════════════════════════════

    // ── Metzgesfeld — flowing right with slight rise ───────────────────────
    r(15, 85, 15,   CM,  HL);     // 115 — medium right, building

    // ── Kallenhard / Wehrseifen — alternating medium pace ─────────────────
    r(12, 52, 12,  -CM,   0);     //  76
    r(10, 42, 10,   CE, -HL);     //  62 — easy right, slight drop

    // ── DAS KARUSSELL — THE WALL ──────────────────────────────────────────
    // A 220-hold hard LEFT climbing corner.
    // You are in it forever. The wall on the outside rises with you.
    // A mistake here is a DNF. This is the signature of the Green Hell.
    r(20,220, 20,  -CH,  HM);     // 260 — THE wall corner

    // ── Exit straight — brief oxygen ─────────────────────────────────────
    r( 1, 32,  1,    0,   0);     //  34

    // ── Hohe Acht — highest point of the track ────────────────────────────
    // Straight climb to the summit. The view from the top is spectacular
    // for approximately 0.1 seconds before the road drops away.
    r( 1, 95,  1,    0,  HH);     //  97 — straight up

    // ── Summit drop + hard right ──────────────────────────────────────────
    // You crest the hill. There is nothing ahead but sky. Then the road
    // reappears, turning hard right, plunging downhill.
    r(10, 42, 10,   CH, -HH);     //  62 — HARD RIGHT + massive drop

    // ── Wippermann / Eschbach — fast downhill sequence ────────────────────
    r(10, 52, 10,   CM, -HM);     //  72 — right, dropping
    r(10, 52, 10,  -CE, -HL);     //  72 — easy left, still descending

    // ── Pflanzgarten — compression / jump sequence ────────────────────────
    // The road bucks. Three hills in quick succession.
    // Each crest launches the car slightly off the road.
    r( 5, 28,  5,    0,  HM);     //  38 — up
    r( 5, 22,  5,  -CE, -HM);     //  32 — down + left kink
    r( 5, 28,  5,   CE,  HM);     //  38 — up + right kink
    r( 5, 22,  5,    0, -HH);     //  32 — BIG DROP, no corner — pure speed

    // ── Stefan Bellof S — fast flowing S-bends ────────────────────────────
    // Named after the man who lapped the Ring in 6:11. Respect the name.
    r(12, 58, 12,   CM,   0);     //  82 — medium right
    r(12, 58, 12,  -CM,   0);     //  82 — medium left

    // ── Kesselchen — long straight downhill blast ─────────────────────────
    // The fastest part of the lap. The road drops 600 metres of elevation
    // in what feels like 5 seconds. Traffic is very bad here.
    r( 1,135,  1,    0, -HH);     // 137 — falling flat out

    // ── Klostertal — fast right, climbing back up ─────────────────────────
    r(15, 95, 15,   CM,  HM);     // 125 — right and rising

    // ── Caracciola S — medium left then medium right ──────────────────────
    r(12, 62, 12,  -CE,  HL);     //  86 — left, slight rise
    r(10, 45, 10,   CE, -HL);     //  65 — right, slight drop

    // ── Final home straight ───────────────────────────────────────────────
    // You have survived the Cathedral. One last flat-out blast to the line.
    r( 1, 95,  1,    0, -HL);     //  97 — slight downhill, full throttle

    this.boardLastPlaced = [-999, -999];

    this.plantSigns();
    this.plantShrubs();
    this.plantPalms();
    this.plantBillboards();
    this.plantCookieBoards();
    this.plantBarneyBoards();
    this.plantBigBoards();
    this.plantCactuses();
    this.plantHouses();
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
    // ── Seeded PRNG (Mulberry32) — deterministic, same layout every run ──
    const { rand, rInt, pick } = makePRNG(0xDEADBEEF);

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
      (seg.sprites ??= []).push({ id, family: 'palm' as SpriteFamily, worldX, scale });
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

    for (let i = 0; i < this._segments.length; i++)
    {
      const seg      = this._segments[i];
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
            if (ti >= this._segments.length) break;
            const tseg = this._segments[ti];

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

    // ── Deep-background palm scatter (6 000 – 16 000) ────────────────────────
    // Sprinkles palms of all varieties at varying scales far from the road.
    // Uses the same seeded PRNG so the layout is deterministic.
    const ALL: readonly string[] = [
      'PALM_T1_STRAIGHT', 'PALM_T3_YOUNG',
      'PALM_T4_FRUITING',  'PALM_T6_LUXURIANT',
      'PALM_T7_SLENDER',   'PALM_T8_MEDIUM', 'PALM_T10_LARGE',
    ];
    const deepGap = [rInt(2, 6), rInt(2, 6)];

    for (let i = 0; i < this._segments.length; i++)
    {
      const seg = this._segments[i];
      if (Math.abs(seg.curve) >= 5) continue;

      deepGap[0] = Math.max(0, deepGap[0] - 1);
      deepGap[1] = Math.max(0, deepGap[1] - 1);

      for (let s = 0; s < 2; s++)
      {
        if (deepGap[s] > 0) continue;

        // Drop 1–3 palms spread across the deep range with varied scale
        const count = rInt(1, 3);
        for (let c = 0; c < count; c++)
        {
          const worldX = sign(s) * rInt(6000, 16000);
          const scale  = 0.4 + rand() * 2.2;   // 0.4× tiny to 2.6× towering
          (seg.sprites ??= []).push({ id: pick(ALL), family: 'palm' as SpriteFamily, worldX, scale });
        }

        deepGap[s] = rInt(2, 5);
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
    const { rand, rInt, pick } = makePRNG(0xCAFEBABE);

    const plant = (seg: RoadSegment, id: string, worldX: number): void =>
    {
      (seg.sprites ??= []).push({ id, family: 'billboard' as SpriteFamily, worldX, scale: 1 });
    };

    const BEAGLE:  readonly string[] = ['BILLBOARD_BEAGLE_PETS', 'BILLBOARD_ADOPT_BEAGLE', 'BILLBOARD_BEAGLE_POWER', 'BILLBOARD_LOYAL_FRIENDLY'];
    const TAVERN:  readonly string[] = ['BILLBOARD_FROG_TAVERN', 'BILLBOARD_ALE_CROAK', 'BILLBOARD_CELLAR_JUMPERS', 'BILLBOARD_CROAK_TAILS'];
    const TOBACCO: readonly string[] = ['BILLBOARD_RED_BOX', 'BILLBOARD_FINE_TOBACCO', 'BILLBOARD_SMOOTH_TASTE', 'BILLBOARD_WRESTLING'];

    const poolFor = (i: number): readonly string[] =>
      i < 200 ? BEAGLE : i < 400 ? TAVERN : TOBACCO;

    const gap = [rInt(15, 30), rInt(20, 40)];

    for (let i = 0; i < this._segments.length; i++)
    {
      const seg      = this._segments[i];
      const absCurve = Math.abs(seg.curve);

      if (absCurve >= 4) { gap[0] = Math.max(gap[0], 8); gap[1] = Math.max(gap[1], 8); continue; }

      gap[0] = Math.max(0, gap[0] - 1);
      gap[1] = Math.max(0, gap[1] - 1);

      for (let s = 0; s < 2; s++)
      {
        if (gap[s] > 0) continue;
        if (i - this.boardLastPlaced[s] < Road.MIN_BOARD_GAP) { gap[s] = rInt(10, 20); continue; }
        const density = absCurve < 1 ? 0.45 : 0.35;
        if (rand() >= density) { gap[s] = rInt(10, 20); continue; }
        const sign   = s === 1 ? +1 : -1;
        const worldX = sign * rInt(2000, 2600);
        plant(seg, pick(poolFor(i)), worldX);
        this.boardLastPlaced[s] = i;
        gap[s] = rInt(30, 55);
      }
    }
  }

  // ── Cookie board placement ────────────────────────────────────────────────

  /**
   * Places portrait cookie boards alongside the road.
   * Entirely separate from plantBillboards() — own PRNG seed, own pool,
   * own gap rules, own worldX range.  Sparser than regular billboards so
   * they feel like a surprise when they appear.
   */
  private plantCookieBoards(): void
  {
    const { rand, rInt, pick } = makePRNG(0xC00C1E5);

    const plant = (seg: RoadSegment, id: string, worldX: number): void =>
    {
      (seg.sprites ??= []).push({ id, family: 'cookie' as SpriteFamily, worldX, scale: 1 });
    };

    const POOL: readonly string[] = [
      'COOKIE_HAPPY_SMOKING', 'COOKIE_PREMIUM_CIGS',
      'COOKIE_SMOKIN_NOW',    'COOKIE_CIG_RESERVES',
    ];

    // Sparse — only one side at a time, long gaps between appearances.
    // Start with a large forced gap so no cookies appear while Barney's ads
    // are dominating the opening stretch (first ~150 segments).
    const gap = [150, 165];

    for (let i = 0; i < this._segments.length; i++)
    {
      const seg      = this._segments[i];
      const absCurve = Math.abs(seg.curve);

      if (absCurve >= 4) { gap[0] = Math.max(gap[0], 12); gap[1] = Math.max(gap[1], 12); continue; }

      gap[0] = Math.max(0, gap[0] - 1);
      gap[1] = Math.max(0, gap[1] - 1);

      for (let s = 0; s < 2; s++)
      {
        if (gap[s] > 0) continue;
        if (rand() >= 0.30) { gap[s] = rInt(25, 50); continue; }
        const sign   = s === 1 ? +1 : -1;
        const worldX = sign * rInt(2000, 2500);
        plant(seg, pick(POOL), worldX);
        gap[s] = rInt(50, 100);   // long gap — these are rare
      }
    }
  }

  // ── Barney board placement ────────────────────────────────────────────────

  /**
   * Places barney boards alongside the road.
   * Entirely separate from all other board types — own PRNG seed, own pool,
   * own gap rules.  Very rare: one side at a time, long gaps.
   */
  private plantBarneyBoards(): void
  {
    const { rand, rInt, pick } = makePRNG(0xBA121E5);

    const plant = (seg: RoadSegment, id: string, worldX: number): void =>
    {
      (seg.sprites ??= []).push({ id, family: 'barney' as SpriteFamily, worldX, scale: 1 });
    };

    const POOL: readonly string[] = [
      'BARNEY_METAL_TILLETIRE',
      'BARNEY_OUTRUN_PALETTE',
    ];

    // First board at segment ~15 (left) and ~28 (right) — close enough to hit
    // immediately, but past the perspective dead-zone where nearby sprites fall
    // off-screen before the cull check can save them.  Regular billboards use
    // the same ~15–30 seg minimum for the same reason.
    const gap = [15, 28];

    for (let i = 0; i < this._segments.length; i++)
    {
      const seg      = this._segments[i];
      const absCurve = Math.abs(seg.curve);

      if (absCurve >= 4) { gap[0] = Math.max(gap[0], 15); gap[1] = Math.max(gap[1], 15); continue; }

      gap[0] = Math.max(0, gap[0] - 1);
      gap[1] = Math.max(0, gap[1] - 1);

      // First 120 segments: high appearance rate — Barney is EVERYWHERE at the
      // start of the race so the player gets the hint to target his car.
      // Beyond 120: back to the normal sparse cadence.
      const prob      = i < 120 ? 0.70 : 0.25;
      const afterGap  = i < 120 ? rInt(18, 35) : rInt(70, 140);

      for (let s = 0; s < 2; s++)
      {
        if (gap[s] > 0) continue;
        if (rand() >= prob) { gap[s] = rInt(15, 30); continue; }
        const sign   = s === 1 ? +1 : -1;
        const worldX = sign * rInt(2000, 2500);
        plant(seg, pick(POOL), worldX);
        gap[s] = afterGap;
      }
    }
  }

  // ── Big board placement ───────────────────────────────────────────────────

  /**
   * Places big_boards alongside the road. Extremely rare — ultra-wide landscape
   * billboards that demand attention. Completely independent from all other board types.
   */
  private plantBigBoards(): void
  {
    const { rand, rInt, pick } = makePRNG(0xB163B04D);

    const plant = (seg: RoadSegment, id: string, worldX: number): void =>
    {
      (seg.sprites ??= []).push({ id, family: 'big' as SpriteFamily, worldX, scale: 1 });
    };

    const POOL: readonly string[] = [
      'BIG_WRESTLING',
    ];

    const gap = [rInt(100, 200), rInt(110, 210)];

    for (let i = 0; i < this._segments.length; i++)
    {
      const seg      = this._segments[i];
      const absCurve = Math.abs(seg.curve);

      if (absCurve >= 4) { gap[0] = Math.max(gap[0], 20); gap[1] = Math.max(gap[1], 20); continue; }

      gap[0] = Math.max(0, gap[0] - 1);
      gap[1] = Math.max(0, gap[1] - 1);

      for (let s = 0; s < 2; s++)
      {
        if (gap[s] > 0) continue;
        if (i - this.boardLastPlaced[s] < Road.MIN_BOARD_GAP) { gap[s] = rInt(50, 100); continue; }
        if (rand() >= 0.20) { gap[s] = rInt(50, 100); continue; }
        const sign   = s === 1 ? +1 : -1;
        const worldX = sign * rInt(2200, 2800);
        plant(seg, pick(POOL), worldX);
        this.boardLastPlaced[s] = i;
        gap[s] = rInt(100, 200);   // extremely rare — big boards dominate visually
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
    // TODO (L10): Cactus is a desert/Southwest biome element — thematically
    // inconsistent with this Mediterranean coastal track.  Replace with
    // agave, sea-grape, or bougainvillea if the setting stays Coconut Beach,
    // OR change the track theme to a desert/Arizona setting where cacti fit.
    // For now, cactuses remain as an arcade abstraction.

    // Mulberry32 PRNG — deterministic, independent seed from palms/billboards.
    const { rand, rInt, pick } = makePRNG(0xBADC0FFE);

    const CACTI: string[] = [
      'CACTUS_C1',  'CACTUS_C2',  'CACTUS_C3',  'CACTUS_C4',
      'CACTUS_C5',  'CACTUS_C6',  'CACTUS_C7',  'CACTUS_C8',
      'CACTUS_C9',  'CACTUS_C10', 'CACTUS_C11', 'CACTUS_C12',
      'CACTUS_C13', 'CACTUS_C14', 'CACTUS_C15', 'CACTUS_C16',
      'CACTUS_C17', 'CACTUS_C18', 'CACTUS_C19', 'CACTUS_C20',
      'CACTUS_C21', 'CACTUS_C22',
    ];

    const plant = (seg: RoadSegment, id: string, worldX: number): void =>
    {
      const scale = 0.8 + rand() * 0.8;   // [0.8, 1.6]
      (seg.sprites ??= []).push({ id, family: 'cactus' as SpriteFamily, worldX, scale });
    };

    const count = this._segments.length;
    // Four independent cooldown tracks per side: near, mid, far, ultra-far
    const gap   = [0, 0, 0, 0, 0, 0, 0, 0];   // [near-L, near-R, mid-L, mid-R, far-L, far-R, ufar-L, ufar-R]

    for (let i = 0; i < count; i++)
    {
      const seg      = this._segments[i];
      const absCurve = Math.abs(seg.curve);

      for (let g = 0; g < 8; g++) gap[g] = Math.max(0, gap[g] - 1);

      if (absCurve >= 4) continue;

      for (let s = 0; s < 2; s++)
      {
        const sign = s === 1 ? +1 : -1;

        // Near band: tight to road shoulder (1800–3000)
        if (gap[s] === 0)
        {
          if (rand() < 0.80) {
            const clusterSize = rand() < 0.30 ? 2 : 1;
            for (let c = 0; c < clusterSize; c++)
              plant(seg, pick(CACTI), sign * rInt(1800, 3000));
          }
          gap[s] = rInt(2, 5);
        }

        // Mid band: into the sand (3500–7000)
        if (gap[2 + s] === 0)
        {
          if (rand() < 0.85) {
            const clusterSize = rand() < 0.40 ? rInt(2, 3) : 1;
            for (let c = 0; c < clusterSize; c++)
              plant(seg, pick(CACTI), sign * rInt(3500, 7000));
          }
          gap[2 + s] = rInt(1, 4);
        }

        // Far band: deep desert edge (7000–16000)
        if (gap[4 + s] === 0)
        {
          if (rand() < 0.90) {
            const clusterSize = rInt(1, 3);
            for (let c = 0; c < clusterSize; c++)
              plant(seg, pick(CACTI), sign * rInt(7000, 16000));
          }
          gap[4 + s] = rInt(1, 4);
        }

        // Ultra-far band: screen edges (12000–22000) — small silhouettes
        // sprH ≈ 700 * scale * 400 / worldX. worldX=12000, scale=0.35 → ~8px ✓
        if (gap[6 + s] === 0)
        {
          const clusterSize = rInt(2, 4);
          for (let c = 0; c < clusterSize; c++)
          {
            const worldX = sign * rInt(12000, 22000);
            const scale  = 0.30 + rand() * 0.20;   // [0.30, 0.50]
            (seg.sprites ??= []).push({ id: pick(CACTI), family: 'cactus' as SpriteFamily, worldX, scale });
          }
          gap[6 + s] = rInt(0, 2);
        }
      }
    }
  }

  // ── Turn-sign placement ───────────────────────────────────────────────────

  /**
   * Places groups of six turn-warning signs before each significant curve.
   *
   * Algorithm:
   *  1. Scan segments looking for the START of a new curve — defined as
   *     |curve| crossing above CURVE_THRESHOLD after a run of straight/gentle road.
   *  2. At each detected curve-start at index i, plant SIGN_COUNT signs on the
   *     outside shoulder at SPACING-segment intervals before the corner apex.
   *  3. The sign type matches the curve direction (TURN_RIGHT / TURN_LEFT).
   *  4. A minimum cooldown prevents double-groups for back-to-back curves.
   *  5. Signs are rendered at 1.5× their default world height for visibility.
   *  6. Indices wrap modulo track length — corner near track start places its
   *     early signs at the track end, visible on lap 2+.
   */
  private plantSigns(): void
  {
    /** Minimum curve magnitude to trigger warning signs. */
    const CURVE_THRESHOLD = 1.5;
    /** Segments between each sign in the group. */
    const SPACING         = 16;
    /** Signs per corner group. */
    const SIGN_COUNT      = 6;
    /** Minimum segments between groups (avoids re-triggering on a long curve). */
    const GROUP_COOLDOWN  = 110;
    /** WorldX distance from road centre for sign placement (clearly on sand/grass verge). */
    const SIGN_X          = 2500;

    const plant = (seg: RoadSegment, id: string, worldX: number): void =>
    {
      (seg.sprites ??= []).push({ id, family: 'sign' as SpriteFamily, worldX, scale: 1.5 });
    };

    let prevAbsCurve  = 0;
    let lastGroupAt   = -GROUP_COOLDOWN;  // segment index of last placed group
    const total       = this._segments.length;

    for (let i = 0; i < total; i++)
    {
      const curve    = this._segments[i].curve;
      const absCurve = Math.abs(curve);

      // Detect curve start: magnitude rises past threshold and cooldown has elapsed
      const curveStarting = absCurve >= CURVE_THRESHOLD
                         && prevAbsCurve < CURVE_THRESHOLD
                         && i - lastGroupAt >= GROUP_COOLDOWN;

      if (curveStarting)
      {
        const isRight = curve > 0;
        const signId  = isRight ? 'SIGN_TURN_RIGHT' : 'SIGN_TURN_LEFT';
        // Signs sit on the OUTSIDE of the upcoming curve (where the car would drift).
        // Right bend → outside is the left shoulder; left bend → outside is the right.
        const worldX  = isRight ? -SIGN_X : SIGN_X;

        for (let n = SIGN_COUNT; n >= 1; n--)
        {
          const si = ((i - n * SPACING) % total + total) % total;
          plant(this._segments[si], signId, worldX);
        }

        lastGroupAt = i;
      }

      prevAbsCurve = absCurve;
    }
  }

  // ── Shrub placement ───────────────────────────────────────────────────────

  /**
   * Scatters shrubs thickly across both sides of the road.
   * Shrubs are small ground-cover plants placed well away from the road edge
   * (worldX 2800–5500) at high density.  They overlap freely — no cross-type
   * gap enforcement is applied and intra-type gaps are short.
   * Uses its own PRNG seed so placement is independent of all other passes.
   */
  private plantShrubs(): void
  {
    const { rand, rInt, pick } = makePRNG(0x5B2B5);

    const plant = (seg: RoadSegment, id: string, worldX: number, scale = 1): void =>
    {
      (seg.sprites ??= []).push({ id, family: 'shrub' as SpriteFamily, worldX, scale });
    };

    const POOL: readonly string[] = [
      'SHRUB_S1', 'SHRUB_S1',   // short scrub — most common
      'SHRUB_S6', 'SHRUB_S6',   // low creosote — wide, very common
      'SHRUB_S2',                // sagebrush — less frequent, taller
    ];

    // ── Pass 1: mid-range shrubs (2500–5000) — dense scatter ─────────────────
    const gap = [rInt(1, 3), rInt(1, 3)];

    for (let i = 0; i < this._segments.length; i++)
    {
      const seg      = this._segments[i];
      const absCurve = Math.abs(seg.curve);

      if (absCurve >= 5) { gap[0] = Math.max(gap[0], 2); gap[1] = Math.max(gap[1], 2); continue; }

      gap[0] = Math.max(0, gap[0] - 1);
      gap[1] = Math.max(0, gap[1] - 1);

      for (let s = 0; s < 2; s++)
      {
        if (gap[s] > 0) continue;
        if (rand() >= 0.88) { gap[s] = rInt(1, 2); continue; }

        const sign  = s === 1 ? +1 : -1;
        const count = rand() < 0.45 ? rInt(2, 3) : 1;
        for (let c = 0; c < count; c++)
          plant(seg, pick(POOL), sign * rInt(2500, 5000));

        gap[s] = rInt(1, 4);
      }
    }

    // ── Pass 2: far shrubs (5000–10000) — thick continuous band ──────────────
    for (let i = 0; i < this._segments.length; i++)
    {
      const seg = this._segments[i];
      if (Math.abs(seg.curve) >= 5) continue;

      for (let s = 0; s < 2; s++)
      {
        const sign  = s === 1 ? +1 : -1;
        const count = rInt(3, 5);
        for (let c = 0; c < count; c++)
          plant(seg, pick(POOL), sign * rInt(5000, 10000), 0.7);
      }
    }

    // ── Pass 3: extreme-edge shrubs (10000–20000) — fills the horizon wall ───
    // Scaled down to ~40% so they read as small distant ground-cover, not giants.
    for (let i = 0; i < this._segments.length; i++)
    {
      const seg = this._segments[i];
      if (Math.abs(seg.curve) >= 5) continue;

      for (let s = 0; s < 2; s++)
      {
        const sign  = s === 1 ? +1 : -1;
        const count = rInt(4, 7);
        for (let c = 0; c < count; c++)
          plant(seg, pick(POOL), sign * rInt(10000, 20000), 0.4);
      }
    }

    // ── Pass 4: screen-edge shrubs (12000–22000) — covers the bare far desert ─
    // sprH ≈ worldH(~600) * scale * halfH / worldX.
    // worldX=12000, scale=0.35 → ~7px;  worldX=18000, scale=0.45 → ~6px.
    // Dense (every segment, 5–8 per side) to fill the edge band continuously.
    for (let i = 0; i < this._segments.length; i++)
    {
      const seg = this._segments[i];
      if (Math.abs(seg.curve) >= 5) continue;

      for (let s = 0; s < 2; s++)
      {
        const sign  = s === 1 ? +1 : -1;
        const count = rInt(5, 8);
        for (let c = 0; c < count; c++)
          plant(seg, pick(POOL), sign * rInt(12000, 22000), 0.35 + rand() * 0.15);
      }
    }
  }

  // ── House placement ───────────────────────────────────────────────────────

  /**
   * Scatters houses and buildings along both sides of the road.
   *
   * All 25 sprite varieties are drawn from a single mixed pool so types
   * are distributed randomly across the whole track rather than bunched
   * by section.  The seed is re-rolled each page load (Date.now()) so
   * the layout is different every run.
   *
   * Facing rule — all sprites have their facade pointing RIGHT in the sheet:
   *   Left side (worldX < 0)  → as-is, facade already faces road centre.
   *   Right side (worldX > 0) → flipX=true, mirrors sprite to face left.
   *
   * Text-bearing sprites (SHOP, BAKERY, SURF, CAFE, ARCADE) must NEVER be
   * flipped — they only appear on the LEFT side where reading is correct.
   *
   * Distance: 3000–5500 wu primary, 5500–9000 wu for background depth.
   * Gap: 10–30 segments — buildings feel like a continuous roadside presence.
   */
  private plantHouses(): void
  {
    const { rand, rInt, pick } = makePRNG(0xD1CE5EED);

    const plant = (seg: RoadSegment, id: string, worldX: number, flipX = false): void =>
    {
      (seg.sprites ??= []).push({ id, family: 'house' as SpriteFamily, worldX, flipX, scale: 1 });
    };

    // Text on facade — left side only, never flip.
    const TEXT: readonly string[] = [
      'HOUSE_SHOP', 'HOUSE_BAKERY', 'HOUSE_SURF', 'HOUSE_CAFE', 'HOUSE_ARCADE',
    ];

    // No legible text — safe to flip and place on either side.
    const SAFE: readonly string[] = [
      'HOUSE_PURPLE', 'HOUSE_TEAL', 'HOUSE_YELLOW', 'HOUSE_GREEN', 'HOUSE_PINK',
    ];

    // LEFT pool = TEXT + SAFE; RIGHT pool = SAFE only.
    const LEFT:  readonly string[] = [...TEXT, ...SAFE];
    const RIGHT: readonly string[] = SAFE;

    const gap = [rInt(15, 35), rInt(20, 45)];

    for (let i = 0; i < this._segments.length; i++)
    {
      const seg      = this._segments[i];
      const absCurve = Math.abs(seg.curve);

      if (absCurve >= 3) { gap[0] = Math.max(gap[0], 10); gap[1] = Math.max(gap[1], 10); continue; }

      gap[0] = Math.max(0, gap[0] - 1);
      gap[1] = Math.max(0, gap[1] - 1);

      for (let s = 0; s < 2; s++)
      {
        if (gap[s] > 0) continue;
        if (rand() >= 0.70) { gap[s] = rInt(12, 25); continue; }

        const isLeft = s === 0;
        const sign   = isLeft ? -1 : +1;
        const pool   = isLeft ? LEFT : RIGHT;

        plant(seg, pick(pool), sign * rInt(3000, 5500), !isLeft);

        // 40% chance: second building behind for depth
        if (rand() < 0.40)
          plant(seg, pick(SAFE), sign * rInt(5500, 9000), !isLeft);

        gap[s] = rInt(20, 45);
      }
    }

    // ── Ultra-far pass: adobe + desert structures at screen edges ─────────────
    // sprH ≈ worldH * scale * halfH / worldX (at screen edge, sc1 ≈ 1/worldX).
    // worldH ≈ 1800, halfH ≈ 400: worldX=10000 scale=0.25 → ~18px ✓
    //                              worldX=20000 scale=0.35 → ~13px ✓
    // Gap 4–12 segs so they feel like scattered distant settlements.
    const DISTANT: readonly string[] = [
      'HOUSE_ADOBE_1', 'HOUSE_ADOBE_2', 'HOUSE_ADOBE_3', 'HOUSE_ADOBE_4',
      'HOUSE_ADOBE_5', 'HOUSE_ADOBE_6', 'HOUSE_ADOBE_7', 'HOUSE_ADOBE_8',
      'HOUSE_ADOBE_9', 'HOUSE_ADOBE_10',
      'HOUSE_DOME',    'HOUSE_TENT_L',  'HOUSE_HUT',     'HOUSE_TENT_S',  'HOUSE_BUNKER',
    ];

    const farGap = [rInt(4, 10), rInt(5, 12)];

    for (let i = 0; i < this._segments.length; i++)
    {
      const seg = this._segments[i];
      if (Math.abs(seg.curve) >= 4) continue;

      farGap[0] = Math.max(0, farGap[0] - 1);
      farGap[1] = Math.max(0, farGap[1] - 1);

      for (let s = 0; s < 2; s++)
      {
        if (farGap[s] > 0) continue;
        if (rand() >= 0.80) { farGap[s] = rInt(3, 8); continue; }

        const sign  = s === 1 ? +1 : -1;
        const scale = 0.60 + rand() * 0.60;   // [0.60, 1.20] — visible distant buildings
        (seg.sprites ??= []).push({ id: pick(DISTANT), family: 'house' as SpriteFamily, worldX: sign * rInt(10000, 20000), scale, stretchX: 1.25 });

        farGap[s] = rInt(4, 12);
      }
    }
  }

  // ── Lookup ────────────────────────────────────────────────────────────────

  /**
   * Returns the index of the segment beneath a world-space Z position.
   *
   * playerZ increases as the player moves forward.  We divide by SEGMENT_LENGTH
   * to find which "slot" the player is in, then wrap modulo the track length so
   * the road loops seamlessly.  The double-modulo (+n % n) guards against
   * negative Z before the first frame.
   *
   * @param z - World-space depth position (may be negative before first frame).
   * @returns Segment index in [0, count).
   */
  findSegmentIndex(z: number): number
  {
    const n = this.count;
    return ((Math.floor(z / SEGMENT_LENGTH) % n) + n) % n;
  }

  /**
   * Returns the RoadSegment beneath a world-space Z position.
   * Convenience wrapper around findSegmentIndex().
   *
   * @param playerZ - World-space depth position.
   * @returns The RoadSegment the player is currently on.
   */
  findSegment(playerZ: number): RoadSegment
  {
    return this._segments[this.findSegmentIndex(playerZ)];
  }

  // ── Static factory: load from pre-built data ──────────────────────────────

  /**
   * Constructs a Road from pre-serialized segment data generated at build time.
   *
   * Bypasses all nine plant passes (palm, billboard, cactus, house, etc.) that
   * normally run synchronously on the main thread during `new Road()`.  On
   * mid-range mobile these passes take 50–200 ms.  Loading a pre-built array
   * instead makes startup near-instant (M15).
   *
   * The generate-road.ts build script produces src/road-data.ts; game.ts
   * imports that module and calls Road.fromData(ROAD_DATA).
   *
   * @param data - Array of SerializedSegment objects from road-data.ts.
   * @returns A fully-initialised Road ready for the game loop.
   */
  /**
   * The segment index where the start gate sprite is placed.
   * Always 8 segments ahead of the player's spawn position (Z = 0).
   */
  static readonly START_GATE_SEGMENT = 8;

  /**
   * Reconstructs a Road from pre-built serialised data.
   *
   * When `mode` is supplied the road data is filtered to match the difficulty:
   *   EASY   — hard course at hillScale 1.80 (full curves, committed hills).
   *   MEDIUM — hard course at hillScale 2.60 (blind crests begin).
   *   HARD   — legendary course at hillScale 3.50 (genuine altitude, full speed).
   *
   * A start gate sprite is injected at segment START_GATE_SEGMENT regardless
   * of mode.  The caller uses `distanceTravelled` to detect finish — no finish
   * gate segment is needed in the road data.
   */
  static fromData(data: SerializedSegment[], mode: GameMode = GameMode.MEDIUM): Road
  {
    const cfg  = RACE_CONFIG[mode];
    const road = Object.create(Road.prototype) as Road;

    road._segments = data.map(d =>
    {
      // Scale curve and hill magnitude per difficulty.
      let curve = d.curve * cfg.curveScale;
      // Clamp to the engine's hard limit so the renderer never gets
      // extreme values that blow up the projection maths.
      curve = Math.max(-ROAD_CURVE.HARD, Math.min(ROAD_CURVE.HARD, curve));

      // Hill: scale the Y-delta between p1 and p2.
      const rawDeltaY  = d.p2y - d.p1y;
      const scaledDy   = rawDeltaY * cfg.hillScale;

      // Rebuild sprites, injecting gate_start at the designated segment.
      let sprites: SpriteInstance[] | undefined = d.sprites.length > 0
        ? [...d.sprites]
        : undefined;

      if (d.index === Road.START_GATE_SEGMENT)
      {
        const gateSprite: SpriteInstance = {
          id:     'gate_start',
          family: 'gate_start',
          worldX: 0,    // centred on road
        };
        sprites = sprites ? [gateSprite, ...sprites] : [gateSprite];
      }

      return {
        index:   d.index,
        curve,
        color:   d.color,
        sprites,
        p1:      makeProjectedPoint(d.p1z, d.p1y),
        p2:      makeProjectedPoint(d.p2z, d.p1y + scaledDy),
      };
    });

    return road;
  }

  /**
   * Injects a dense crowd of celebration billboards and palms around the
   * start/finish gate so the car is surrounded by sprites when it stops.
   * Called once from beginRace() so it layers on top of the static road data.
   */
  injectFinishCelebration(): void
  {
    // Segments to decorate — the gate is at START_GATE_SEGMENT; spread ±20 around it
    const gateIdx   = Road.START_GATE_SEGMENT;
    const spread    = 20;
    const startSeg  = Math.max(0, gateIdx - spread);
    const endSeg    = Math.min(this._segments.length - 1, gateIdx + spread);

    const BILLBOARDS: SpriteId[] = [
      'BILLBOARD_BEAGLE_PETS', 'BILLBOARD_ADOPT_BEAGLE', 'BILLBOARD_BEAGLE_POWER',
      'BILLBOARD_FROG_TAVERN', 'BILLBOARD_RED_BOX', 'BILLBOARD_FINE_TOBACCO',
      'BILLBOARD_WRESTLING', 'BILLBOARD_SMOOTH_TASTE', 'BILLBOARD_ALE_CROAK',
    ];
    const BIGS: SpriteId[]  = ['BIG_WRESTLING'];
    const PALMS: SpriteId[] = [
      'PALM_T1_STRAIGHT', 'PALM_T10_LARGE', 'PALM_T6_LUXURIANT',
      'PALM_T2_BENT_LEFT', 'PALM_T2_BENT_RIGHT',
    ];
    const BARNEYS: SpriteId[] = [
      'BARNEY_METAL_TILLETIRE', 'BARNEY_OUTRUN_PALETTE',
    ];

    // Simple seeded-ish pick helper
    const pick = (arr: SpriteId[], n: number) => arr[n % arr.length];

    // Barney boards: placed at 3 specific distances per side so they're
    // unmissable but not wall-to-wall.  worldX ±2100 puts them just outside
    // the road edge, large and readable.
    const barneySlots = [
      { rel: 4,  side: -1 },
      { rel: 8,  side: +1 },
      { rel: 14, side: -1 },
      { rel: 20, side: +1 },
      { rel: 28, side: -1 },
      { rel: 34, side: +1 },
    ];
    for (const { rel, side } of barneySlots)
    {
      const idx = startSeg + rel;
      const seg = this._segments[idx];
      if (!seg || idx === gateIdx) continue;
      (seg.sprites ??= []).push({
        id:     pick(BARNEYS, rel),
        family: 'barney',
        worldX: side * 1700,
        scale:  2.0,
      });
    }

    // Walk the ±spread window around the gate, layering in celebration sprites.
    // `rel` is the distance from startSeg (0 = nearest before spread, spread*2 = end).
    for (let idx = startSeg; idx <= endSeg; idx++)
    {
      const seg = this._segments[idx];
      if (!seg) continue;

      const sprites = (seg.sprites ??= []);
      const rel     = idx - startSeg;  // 0..spread*2

      // Skip gate segment itself so the gate sprite remains clean
      if (idx === gateIdx) continue;

      // Every 4th segment: palm cluster near the road
      if (rel % 4 === 0)
      {
        sprites.push({ id: pick(PALMS, rel),     family: 'palm', worldX: -1200, scale: 1.2 });
        sprites.push({ id: pick(PALMS, rel + 1), family: 'palm', worldX:  1200, scale: 1.2 });
      }
    }
  }

  /**
   * Serializes all segments to the minimal format understood by fromData().
   * Called by scripts/generate-road.ts at build time -- not used at runtime.
   *
   * @returns Array of SerializedSegment objects suitable for JSON.stringify().
   */
  toJSON(): SerializedSegment[]
  {
    return this._segments.map(s => ({
      index:   s.index,
      curve:   s.curve,
      color:   s.color,
      sprites: s.sprites ?? [],
      p1y:     s.p1.world.y,
      p1z:     s.p1.world.z,
      p2y:     s.p2.world.y,
      p2z:     s.p2.world.z,
    }));
  }
}
