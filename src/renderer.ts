/**
 * renderer.ts
 *
 * Draws every visual element of the game each frame:
 *   1. Sky gradient.
 *   2. Road (segments, rumble strips, lane dashes, roadside sprites).
 *   3. Player car sprite.
 *   4. HUD (speed number + tachometer bars).
 *
 * ── Rendering technique: pseudo-3D projection ──────────────────────────────
 *
 * There is no real 3D engine here.  Instead, each road segment is projected
 * to screen space using a simple perspective formula:
 *
 *   scale   = CAMERA_DEPTH / (worldZ - playerZ)
 *   screenX = halfW - worldX * scale * halfW
 *   screenY = halfH + CAMERA_HEIGHT * scale * halfH
 *
 * Adjacent segments are drawn as filled trapezoids between their projected Y
 * values, far-to-near (painter's algorithm), so nearer geometry covers farther.
 *
 * ── Two-pass road rendering ─────────────────────────────────────────────────
 *
 *   Pass 1 (front-to-back): project each segment, track the horizon ceiling
 *     `horizonCeiling`.  Segments whose near edge projects above the ceiling are hidden
 *     behind a hill crest and skipped.
 *
 *   Pass 2 (back-to-front): draw only the visible segments so sprites and
 *     grass overlay correctly.
 *
 * ── Performance notes ───────────────────────────────────────────────────────
 *
 *   projPool: A fixed-size array of ProjectedSeg objects allocated ONCE in the
 *     constructor and reused every frame.  Without this, each frame would
 *     allocate ~200 temporary objects → ~12,000 GC allocs/sec at 60 fps.
 *
 *   skyGradient: Cached and only recreated when horizonY changes (resize or
 *     off-road jitter).  createLinearGradient() is expensive to call 60×/sec.
 *
 *   hudLayout: All HUD pixel positions and font strings are cached and only
 *     recomputed when the canvas dimensions change (resize events only).
 */

import { RoadSegment, SpriteFamily } from './types';
import { TrafficCar, TrafficType }  from './traffic';
import { Button }                   from './ui';
import
{
  CAMERA_HEIGHT, CAMERA_DEPTH, ROAD_WIDTH,
  SEGMENT_LENGTH, COLORS,
  PLAYER_MAX_SPEED, DISPLAY_MAX_KMH,
  PARALLAX_SKY, DRAW_DISTANCE,
  RUMBLE_OUTER_FRAC, RUMBLE_INNER_FRAC,
  LANE_OUTER_FRAC, LANE_INNER_FRAC,
  MARK_ET_OUTER_FRAC, MARK_ET_INNER_FRAC,
  MARK_EN_OUTER_FRAC, MARK_EN_INNER_FRAC,
} from './constants';
import { HudRenderer }     from './renderer-hud';
import { MenuRenderer }    from './renderer-menu';
import { ScreenRenderer }  from './renderer-screens';
import
{
  SpriteLoader, SpriteSheetMap, SpriteId,
  carFrameRect, CAR_SPRITE_FRAME_W, CAR_SPRITE_FRAME_H, CAR_SPRITE_CENTER,
  TRAFFIC_CAR_SPECS,
  CAR_PIVOT_OFFSETS,
  SPRITE_RECTS, SPRITE_WORLD_HEIGHT,
  BILLBOARD_RECTS, BILLBOARD_WORLD_HEIGHT,
  COOKIE_RECTS, COOKIE_WORLD_HEIGHT,
  BARNEY_RECTS, BARNEY_WORLD_HEIGHT,
  BIG_RECTS, BIG_WORLD_HEIGHT,
  CACTUS_RECTS, CACTUS_WORLD_HEIGHT,
  SHRUB_RECTS, SHRUB_WORLD_HEIGHT,
  SIGN_RECTS, SIGN_WORLD_HEIGHT,
  HOUSE_RECTS, HOUSE_WORLD_HEIGHT,
} from './sprites';

// ── ProjectedSeg ──────────────────────────────────────────────────────────────

/**
 * Holds the screen-space projection of one road segment, computed in Pass 1
 * and consumed in Pass 2.
 *
 * We pre-allocate a fixed pool of these objects in the constructor and
 * overwrite them each frame — no new allocations at runtime.
 *
 * sc1 is stored here so Pass 2 can use it directly for sprite scaling
 * instead of re-deriving it from sw1 (which would require a division).
 */
export interface ProjectedSeg
{
  /** Reference to the source road segment (for colour, sprites, etc.). */
  seg: RoadSegment;
  /** Perspective scale at the near (p1) edge -- used by sprite sizing. */
  sc1: number;
  /** Perspective scale at the far (p2) edge. */
  sc2: number;
  /** Screen X centre of the near edge. */
  sx1: number;
  /** Screen Y of the near edge (larger = lower on screen). */
  sy1: number;
  /** Road half-width in pixels at the near edge. */
  sw1: number;
  /** Screen X centre of the far edge. */
  sx2: number;
  /** Screen Y of the far edge (smaller = higher on screen). */
  sy2: number;
  /** Road half-width in pixels at the far edge. */
  sw2: number;
}

// ── ColorRun ──────────────────────────────────────────────────────────────────

/**
 * A contiguous run of road segments that all share the same colour for a given
 * visual property (e.g., rumble strip colour or lane dash presence).
 *
 * Building runs lets us draw one polygon per run instead of one per segment,
 * eliminating hairline anti-aliasing seams at every segment boundary.
 *
 * Example: segments [RED, RED, RED, WHITE, WHITE] →
 *   [ { color:'RED',   startIdx:0, endIdx:2 },
 *     { color:'WHITE', startIdx:3, endIdx:4 } ]
 */
export interface ColorRun
{
  /** CSS colour string shared by all segments in this run. */
  color:    string;
  /** Index into projPool of the nearest (bottom) segment in the run. */
  startIdx: number;
  /** Index into projPool of the farthest (top) segment in the run. */
  endIdx:   number;
}

/**
 * Splits projPool[0..count-1] into contiguous same-colour runs.
 *
 * @param projPool  - Pre-allocated projection pool (only [0..count-1] are valid).
 * @param count     - Number of valid entries in projPool.
 * @param getColor  - Callback that returns the colour string for a segment.
 *                    The function is called once per segment.
 * @returns         Array of ColorRun objects, one per contiguous colour group.
 */
export function buildColorRuns(
  projPool: readonly ProjectedSeg[],
  count:    number,
  getColor: (seg: RoadSegment) => string,
): ColorRun[]
{
  if (count === 0) return [];

  const runs: ColorRun[] = [];
  let j = 0;
  while (j < count)
  {
    const color    = getColor(projPool[j].seg);
    const runStart = j;
    while (j < count && getColor(projPool[j].seg) === color) { j++; }
    runs.push({ color, startIdx: runStart, endIdx: j - 1 });
  }
  return runs;
}

// ── Helper: drawTrapezoid ─────────────────────────────────────────────────────

/**
 * Fills a four-sided polygon (trapezoid) between two horizontal scan-lines.
 *
 * Used for every road band: asphalt, grass, rumble strips, and lane dashes.
 *   Bottom edge: centred at (x1, y1), half-width w1.
 *   Top edge:    centred at (x2, y2), half-width w2.
 *
 * When w1 > w2 (near wider than far) the result is the classic perspective shape.
 *
 * @param ctx   - Canvas 2D context.
 * @param x1    - Screen X of near (bottom) edge centre.
 * @param y1    - Screen Y of near (bottom) edge.
 * @param w1    - Half-width of near edge in pixels.
 * @param x2    - Screen X of far (top) edge centre.
 * @param y2    - Screen Y of far (top) edge.
 * @param w2    - Half-width of far edge in pixels.
 * @param color - CSS colour string; empty string = no-op.
 */
function drawTrapezoid(
  ctx: CanvasRenderingContext2D,
  x1: number, y1: number, w1: number,
  x2: number, y2: number, w2: number,
  color: string,
): void
{
  if (!color) return;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x1 - w1, y1);
  ctx.lineTo(x1 + w1, y1);
  ctx.lineTo(x2 + w2, y2);
  ctx.lineTo(x2 - w2, y2);
  ctx.closePath();
  ctx.fill();
}

// ── Module-level render-pass functions ────────────────────────────────────────
//
// These are extracted from the renderRoad method so they can be unit-tested
// independently without spinning up a full Renderer instance.
// Each function operates on the pre-populated projPool.

/**
 * Adds one trapezoid subpath into the currently open canvas path.
 *
 * ── What is a trapezoid in road rendering? ────────────────────────────────────
 *
 * Each road segment covers a narrow band of depth in the world.  When projected
 * to screen space, the near edge (closer to the camera) appears wider and lower
 * on screen, while the far edge appears narrower and higher.  The resulting
 * four-sided shape — wide at the bottom, narrow at the top — is a trapezoid:
 *
 *           x2-w2 ┌─────┐ x2+w2      ← far  (top) edge
 *                /       \
 *               /         \
 *        x1-w1 └───────────┘ x1+w1   ← near (bottom) edge
 *
 * ── Winding direction ─────────────────────────────────────────────────────────
 *
 * The ORDER in which the four corners are listed is called "winding direction".
 * Canvas `fill()` uses the nonzero-winding-rule: it counts +1 for CW and -1 for
 * CCW crossings.  If two shapes in the same path wind in opposite directions and
 * they overlap, their shared edge scores 0 → transparent "gap".
 *
 * We need ALL trapezoids in a batch to wind the SAME direction (both CW).
 *
 * IMPORTANT: canvas Y-axis points DOWN (Y=0 is the top of the screen, larger
 * Y = lower on screen).  This INVERTS what you'd draw on paper.
 *
 *   Uphill / flat  (ry1 >= ry2 — near edge is AT OR BELOW far edge):
 *     BL → BR → TR → TL   (clockwise on screen)
 *
 *        TL  (x2-w2, ry2)  ──────  TR  (x2+w2, ry2)
 *            ↑                        ↑
 *        BL  (x1-w1, ry1)  ──────  BR  (x1+w1, ry1)
 *             start here  →  →  →  ↓  ↑  ←  ←  ←
 *
 *   Downhill (ry1 < ry2 — near edge is ABOVE far edge):
 *     TL → BL → BR → TR   (also clockwise on screen because Y is flipped)
 *
 * ── Why 1px extension? ────────────────────────────────────────────────────────
 *
 * Adjacent trapezoids share a horizontal edge.  Canvas sub-pixel rounding can
 * leave a 1px transparent crack between them.  Extending the far edge by 1px
 * toward the next segment (ry2-1 for uphill, ry2+1 for downhill) overlaps the
 * seam and closes the crack with no visible double-painting.
 *
 * @param ctx - Canvas 2D context (must have an open path — call beginPath first).
 * @param x1  - Screen X of near edge centre.
 * @param y1  - Screen Y of near edge.
 * @param w1  - Half-width of near edge in pixels.
 * @param x2  - Screen X of far edge centre.
 * @param y2  - Screen Y of far edge.
 * @param w2  - Half-width of far edge in pixels.
 */
export function addTrap(
  ctx: CanvasRenderingContext2D,
  x1: number, y1: number, w1: number,
  x2: number, y2: number, w2: number,
): void
{
  const ry1 = Math.round(y1);
  const ry2 = Math.round(y2);
  if (ry1 >= ry2)
  {
    // Uphill / flat — ry1 at bottom, ry2 at top.  CW: BL→BR→TR→TL
    const r2 = ry2 - 1;
    ctx.moveTo(Math.round(x1 - w1), ry1);
    ctx.lineTo(Math.round(x1 + w1), ry1);
    ctx.lineTo(Math.round(x2 + w2), r2);
    ctx.lineTo(Math.round(x2 - w2), r2);
  }
  else
  {
    // Downhill — ry1 at top, ry2 at bottom.  CW in canvas: TL→BL→BR→TR
    const r2 = ry2 + 1;
    ctx.moveTo(Math.round(x1 - w1), ry1);
    ctx.lineTo(Math.round(x2 - w2), r2);
    ctx.lineTo(Math.round(x2 + w2), r2);
    ctx.lineTo(Math.round(x1 + w1), ry1);
  }
  ctx.closePath();
}

/**
 * Draws the grass verge fillRects for all visible segments (Pass A).
 *
 * Each rect covers from the near edge of the segment to the near edge of the
 * next farther segment, closing any 1px rounding cracks.  The farthest segment
 * extends all the way to halfH (the horizon).
 *
 * The `coverTo` logic has two cases:
 *   - Farthest segment (i === count-1): cover all the way to halfH so no gap
 *     remains between the last visible segment and the horizon line.
 *   - All other segments: cover to the min of this segment's near Y and the
 *     next farther segment's near Y, minus 1px to close sub-pixel cracks.
 *
 * @param ctx     - Canvas 2D context.
 * @param pool    - Pre-populated projection pool.
 * @param count   - Number of valid entries.
 * @param halfH   - Horizon screen Y (grass rects are clamped above this).
 * @param canvasW - Full canvas width (grass fills edge-to-edge).
 */
export function drawGrass(
  ctx:     CanvasRenderingContext2D,
  pool:    readonly ProjectedSeg[],
  count:   number,
  halfH:   number,
  canvasW: number,
): void
{
  for (let i = count - 1; i >= 0; i--)
  {
    const { sy1, sy2, seg } = pool[i];
    const coverTo = i === count - 1
      ? halfH
      : Math.min(Math.min(sy1, sy2), pool[i + 1].sy1);
    const gTop = Math.max(halfH, Math.round(coverTo) - 1);
    const gBot = Math.round(Math.max(sy1, sy2));
    if (gBot <= gTop) continue;
    ctx.fillStyle = seg.color.grass;
    ctx.fillRect(0, gTop, canvasW, gBot - gTop);
  }
}

/**
 * Draws the road surface as one continuous closed polygon (Pass B).
 *
 * ── Why not one subpath per segment? ─────────────────────────────────────────
 *
 * The old approach drew each segment as a separate trapezoid subpath (beginPath
 * … fill).  Even with a 1px overlap between adjacent trapezoids, canvas still
 * anti-aliases every path edge independently.  Two adjacent subpaths each blur
 * their shared edge, producing a half-alpha "phantom line" (visible seam) at
 * every segment boundary when the road colour differs even slightly from the
 * background.
 *
 * ── How the single polygon fixes it ──────────────────────────────────────────
 *
 * Instead of drawing N separate trapezoids, we trace the OUTLINE of the entire
 * road surface as one closed polygon.  There are no internal shared edges —
 * only the outer boundary (left edge + right edge) exists in the path.  Canvas
 * anti-aliases only those outer edges, so no seams appear between segments.
 *
 * Traversal direction:
 *
 *   FAR   [farthest seg far-left]  ──► ... ──► [farthest seg near-left]
 *                                                              │ (down)
 *   NEAR                        [nearest near-left]  ◄────────┘
 *                                        │
 *                               [nearest near-right]
 *                                        │ (up)
 *   FAR   [farthest far-right]  ◄────────┘ ... ◄── closePath ─┘
 *
 * Left edge traversal: moveTo far-left of farthest segment, lineTo near-left
 * of each segment from farthest to nearest.
 * Right edge traversal: lineTo near-right of nearest, then lineTo far-right
 * of each segment from nearest to farthest, then closePath.
 *
 * @param ctx   - Canvas 2D context.
 * @param pool  - Pre-populated projection pool.
 * @param count - Number of valid entries.
 */
export function drawRoadSurface(
  ctx:   CanvasRenderingContext2D,
  pool:  readonly ProjectedSeg[],
  count: number,
): void
{
  ctx.beginPath();
  if (count > 0)
  {
    const n = count;
    // Left edge: start at top-left of farthest segment, step down to
    // the near-left of every segment (farthest → nearest).
    ctx.moveTo(Math.round(pool[n - 1].sx2 - pool[n - 1].sw2),
               pool[n - 1].sy2);
    for (let i = n - 1; i >= 0; i--)
    {
      const { sx1, sy1, sw1 } = pool[i];
      ctx.lineTo(Math.round(sx1 - sw1), sy1);
    }
    // Right edge: step up from near-right of nearest to far-right of
    // every segment (nearest → farthest), closing at top-right.
    ctx.lineTo(Math.round(pool[0].sx1 + pool[0].sw1),
               pool[0].sy1);
    for (let i = 0; i < n; i++)
    {
      const { sx2, sy2, sw2 } = pool[i];
      ctx.lineTo(Math.round(sx2 + sw2), sy2);
    }
    ctx.closePath();
  }
  ctx.fill();
}

/**
 * Draws rumble strips (kerb bands) as continuous polygons per colour-run
 * (Passes C + D).
 *
 * Each contiguous run of segments sharing the same rumble colour is drawn as
 * one polygon per side (left AND right in a single batched path).  One fill
 * per run = zero inter-segment seams.
 *
 * Kerb fractions (as multiples of road half-width sw):
 *   outer edge: sw * 1.09  (just outside the road edge)
 *   inner edge: sw * 0.91  (just inside the road edge)
 *
 * @param ctx   - Canvas 2D context.
 * @param pool  - Pre-populated projection pool.
 * @param count - Number of valid entries.
 */
export function drawRumble(
  ctx:   CanvasRenderingContext2D,
  pool:  readonly ProjectedSeg[],
  count: number,
): void
{
  let j = 0;
  while (j < count)
  {
    const runColor = pool[j].seg.color.rumble;
    const runStart = j;
    while (j < count && pool[j].seg.color.rumble === runColor) { j++; }
    const runEnd = j - 1;

    ctx.fillStyle = runColor;
    ctx.beginPath();

    for (const side of [-1, 1] as const)
    {
      // moveTo outer-far of farthest segment in run
      const far = pool[runEnd];
      ctx.moveTo(Math.round(far.sx2 + side * far.sw2 * RUMBLE_OUTER_FRAC), far.sy2);
      // outer near-ends farthest → nearest (going down the screen)
      for (let i = runEnd; i >= runStart; i--)
      {
        const p = pool[i];
        ctx.lineTo(Math.round(p.sx1 + side * p.sw1 * RUMBLE_OUTER_FRAC), p.sy1);
      }
      // cross to inner at near end of nearest
      const near = pool[runStart];
      ctx.lineTo(Math.round(near.sx1 + side * near.sw1 * RUMBLE_INNER_FRAC), near.sy1);
      // inner far-ends nearest → farthest (going up the screen)
      for (let i = runStart; i <= runEnd; i++)
      {
        const p = pool[i];
        ctx.lineTo(Math.round(p.sx2 + side * p.sw2 * RUMBLE_INNER_FRAC), p.sy2);
      }
      ctx.closePath();
    }

    ctx.fill();
  }
}

/**
 * Draws lane-centre dashes as continuous polygons per lane-on run (Pass E).
 *
 * Only segments where `seg.color.lane` is a non-empty string get a dash.
 * Contiguous lane-on segments are batched into one polygon per side to avoid
 * seams.  Lane-off runs are skipped entirely (0 fill calls).
 *
 * Lane dash fractions (as multiples of road half-width sw):
 *   outer fraction = 0.39  (centre offset 0.33 + half-width 0.06)
 *   inner fraction = 0.27  (centre offset 0.33 − half-width 0.06)
 *
 * @param ctx   - Canvas 2D context.
 * @param pool  - Pre-populated projection pool.
 * @param count - Number of valid entries.
 */
export function drawLaneDashes(
  ctx:   CanvasRenderingContext2D,
  pool:  readonly ProjectedSeg[],
  count: number,
): void
{
  let j = 0;
  while (j < count)
  {
    const hasLane = pool[j].seg.color.lane;
    const runStart = j;
    while (j < count && pool[j].seg.color.lane === hasLane) { j++; }
    const runEnd = j - 1;

    if (!hasLane) continue;

    ctx.fillStyle = COLORS.LANE;
    ctx.beginPath();

    for (const side of [-1, 1] as const)
    {
      const far = pool[runEnd];
      ctx.moveTo(Math.round(far.sx2  + side * far.sw2  * LANE_OUTER_FRAC), far.sy2);
      for (let i = runEnd; i >= runStart; i--)
      {
        const p = pool[i];
        ctx.lineTo(Math.round(p.sx1 + side * p.sw1 * LANE_OUTER_FRAC), p.sy1);
      }
      const near = pool[runStart];
      ctx.lineTo(Math.round(near.sx1 + side * near.sw1 * LANE_INNER_FRAC), near.sy1);
      for (let i = runStart; i <= runEnd; i++)
      {
        const p = pool[i];
        ctx.lineTo(Math.round(p.sx2 + side * p.sw2 * LANE_INNER_FRAC), p.sy2);
      }
      ctx.closePath();
    }

    ctx.fill();
  }
}

/**
 * Draws edge track marks (white stripes) as continuous polygons per lane-on
 * run (Pass F).
 *
 * Four stripes per run — outer+inner × left+right — all in a single batched
 * path (one fill call).  4 closePaths per lane-on run.
 *
 * Stripe geometry (centre at sx ± cFrac*sw, half-width hwFrac*sw):
 *   outer boundary = (cFrac+hwFrac)*sw
 *   inner boundary = (cFrac-hwFrac)*sw
 *
 *   Stripe          side  outerFrac            innerFrac
 *   left outer      -1    MARK_ET_OUTER_FRAC   MARK_ET_INNER_FRAC
 *   left inner      -1    MARK_EN_OUTER_FRAC   MARK_EN_INNER_FRAC
 *   right outer     +1    MARK_ET_OUTER_FRAC   MARK_ET_INNER_FRAC
 *   right inner     +1    MARK_EN_OUTER_FRAC   MARK_EN_INNER_FRAC
 *
 * @param ctx   - Canvas 2D context.
 * @param pool  - Pre-populated projection pool.
 * @param count - Number of valid entries.
 */
export function drawEdgeMarks(
  ctx:   CanvasRenderingContext2D,
  pool:  readonly ProjectedSeg[],
  count: number,
): void
{
  let j = 0;
  while (j < count)
  {
    const hasLane = pool[j].seg.color.lane;
    const runStart = j;
    while (j < count && pool[j].seg.color.lane === hasLane) { j++; }
    const runEnd = j - 1;

    if (!hasLane) continue;

    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();

    // Each entry: [side, outerFrac, innerFrac]
    // Fractions are named constants from constants.ts for designer-friendliness.
    const stripes: [number, number, number][] = [
      [-1, MARK_ET_OUTER_FRAC, MARK_ET_INNER_FRAC],   // left outer
      [-1, MARK_EN_OUTER_FRAC, MARK_EN_INNER_FRAC],   // left inner
      [+1, MARK_ET_OUTER_FRAC, MARK_ET_INNER_FRAC],   // right outer
      [+1, MARK_EN_OUTER_FRAC, MARK_EN_INNER_FRAC],   // right inner
    ];

    for (const [side, oFrac, iFrac] of stripes)
    {
      const far = pool[runEnd];
      ctx.moveTo(Math.round(far.sx2  + side * far.sw2  * oFrac), far.sy2);
      for (let i = runEnd; i >= runStart; i--)
      {
        const p = pool[i];
        ctx.lineTo(Math.round(p.sx1 + side * p.sw1 * oFrac), p.sy1);
      }
      const near = pool[runStart];
      ctx.lineTo(Math.round(near.sx1 + side * near.sw1 * iFrac), near.sy1);
      for (let i = runStart; i <= runEnd; i++)
      {
        const p = pool[i];
        ctx.lineTo(Math.round(p.sx2 + side * p.sw2 * iFrac), p.sy2);
      }
      ctx.closePath();
    }

    ctx.fill();
  }
}

// ── Renderer ──────────────────────────────────────────────────────────────────

/**
 * Stateless (per-frame) renderer for the OutRun game.
 *
 * Owns no game logic — receives all state as parameters to render().
 * All expensive objects (gradient, projection pool, HUD layout) are cached
 * internally and only rebuilt when dimensions or display state change.
 */
export class Renderer
{
  /** The 2-D canvas rendering context obtained from the canvas at construction. */
  private ctx:              CanvasRenderingContext2D;

  // One SpriteLoader per roadside object family.  null when the sheet was not
  // provided to the constructor — sprites of that family are silently skipped.
  private carSprites:       SpriteLoader | null;
  private roadSprites:      SpriteLoader | null;
  private billboardSprites: SpriteLoader | null;
  private cactusSprites:    SpriteLoader | null;
  private cookieSprites:    SpriteLoader | null;
  private barneySprites:    SpriteLoader | null;
  private bigSprites:       SpriteLoader | null;
  private shrubSprites:     SpriteLoader | null;
  private signSprites:      SpriteLoader | null;
  private houseSprites:     SpriteLoader | null;

  // ── Per-frame reusable projection pool ──────────────────────────────────
  //
  // projPool holds pre-allocated ProjectedSeg objects.
  // projCount tracks how many are populated this frame (reset to 0 each frame).
  // Size 300 gives headroom beyond DRAW_DISTANCE (200) for safety.

  /** Pre-allocated pool of projection slots.  Never grows after construction. */
  private readonly projPool: ProjectedSeg[];

  /** Number of valid entries in projPool for the current frame. */
  private projCount = 0;

  // ── Sky gradient cache ────────────────────────────────────────────────────
  //
  // createLinearGradient() is expensive — cache the result and only
  // regenerate it when the horizon Y position changes.

  /** Cached gradient object; null until first render. */
  private skyGradient:  CanvasGradient | null = null;

  /** The horizonY value the cached gradient was built for. */
  private skyGradientH  = -1;

  // ── Sub-renderers ──────────────────────────────────────────────────────────

  private readonly hud:     HudRenderer;
  private readonly menu:    MenuRenderer;
  private readonly screens: ScreenRenderer;

  /**
   * Accumulated horizontal sky-layer offset for curve parallax.
   * Clamped modulo a large period to prevent unbounded growth over long sessions.
   */
  private skyOffset = 0;

  /** Sprite sheets keyed by TrafficType — populated from SpriteSheetMap.trafficCars. */
  private readonly trafficCarSheets = new Map<TrafficType, SpriteLoader>();

  /**
   * Pre-allocated source rect reused by every traffic car draw call.
   * Avoids one heap allocation per visible car per frame (≈3 × 60 = 180/s).
   * x and y are always 0; w and h are overwritten before each use.
   */
  private readonly trafficRect = { x: 0, y: 0, w: 0, h: 0 };

  /**
   * Pre-allocated buffer for per-car effective projPool slot indices (Pass 4).
   * Size 16 >> TRAFFIC_COUNT (3) — never needs reallocation.
   * Cars whose segment was culled by horizonCeiling are mapped to the farthest
   * visible slot so they render at the hill crest instead of vanishing.
   */
  private readonly carSlotBuf: Int16Array;

  /**
   * Creates a Renderer attached to the given canvas and pre-allocates all
   * per-frame reusable buffers so the render loop makes zero heap allocations.
   *
   * @param canvas  - The HTML canvas element to draw into.
   * @param sprites - Named sprite sheet map.  Any omitted sheets are treated
   *                  as null — sprites of that family are silently skipped.
   *                  Using a named map prevents silent mis-ordering bugs when
   *                  sheets are added or rearranged (M9).
   */
  constructor(
    canvas:   HTMLCanvasElement,
    sprites:  Partial<SpriteSheetMap> = {},
    isMobile: boolean = false,
  )
  {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get 2D context');
    this.ctx              = ctx;
    this.hud              = new HudRenderer(ctx);
    this.screens          = new ScreenRenderer(ctx);
    this.carSprites       = sprites.car       ?? null;
    for (const [type, loader] of Object.entries(sprites.trafficCars ?? {}))
      this.trafficCarSheets.set(type as TrafficType, loader);
    this.roadSprites      = sprites.road      ?? null;
    this.billboardSprites = sprites.billboard ?? null;
    this.cactusSprites    = sprites.cactus    ?? null;
    this.cookieSprites    = sprites.cookie    ?? null;
    this.barneySprites    = sprites.barney    ?? null;
    this.menu             = new MenuRenderer(ctx, this.barneySprites, isMobile);
    this.bigSprites       = sprites.big       ?? null;
    this.shrubSprites     = sprites.shrub     ?? null;
    this.signSprites      = sprites.sign      ?? null;
    this.houseSprites     = sprites.house     ?? null;
    // Pre-allocate the projection pool once.  Every field is set to a dummy
    // value here; they are overwritten before use each frame.
    // Size is DRAW_DISTANCE + 100 — 100 slots of headroom beyond the draw
    // distance so hill occlusion never over-fills the pool (L3).
    this.projPool = Array.from({ length: DRAW_DISTANCE + 100 }, () => (
    {
      seg: null! as RoadSegment,
      sc1: 0, sc2: 0,
      sx1: 0, sy1: 0, sw1: 0,
      sx2: 0, sy2: 0, sw2: 0,
    }));
    this.carSlotBuf = new Int16Array(16);

    // Set once here; ctx.save/restore preserves these settings each frame
    // so there is no need to repeat them inside renderCar every frame.
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';
  }

  // ── Sky ───────────────────────────────────────────────────────────────────

  /**
   * Draws a vertical colour gradient filling the sky area above the horizon.
   *
   * The gradient is cached against the STABLE horizon (h/2, no jitter) so
   * it is not rebuilt every frame during off-road bouncing.  The fill rect
   * still uses the jittered horizonY — the ±4px discrepancy at the horizon
   * edge is imperceptible (that region is the near-white sky haze colour).
   *
   * @param w              - Canvas width in pixels.
   * @param horizonY       - Jittered screen Y used for the fill rect extent.
   * @param stableHorizonY - Unperturbed h/2 used as the gradient cache key.
   */
  private renderSky(w: number, horizonY: number, stableHorizonY: number): void
  {
    const { ctx } = this;

    // Rebuild only when the stable horizon changes (window resize), not on jitter.
    if (stableHorizonY !== this.skyGradientH)
    {
      const grad = ctx.createLinearGradient(0, 0, 0, stableHorizonY);
      grad.addColorStop(0,    COLORS.SKY_TOP);
      grad.addColorStop(0.55, COLORS.SKY_MID);
      grad.addColorStop(1,    COLORS.SKY_HORIZON);
      this.skyGradient  = grad;
      this.skyGradientH = stableHorizonY;
    }

    ctx.fillStyle = this.skyGradient!;
    ctx.fillRect(0, 0, w, horizonY);

  }

  // ── Road + roadside sprites ───────────────────────────────────────────────

  /**
   * Projects and draws the scrolling road in two passes.
   *
   * Pass 1 — front-to-back projection:
   *   Walk from the nearest segment outward.  Project each segment to screen
   *   space.  Use `horizonCeiling` to skip segments hidden behind hill crests.
   *   Store visible segments in the pre-allocated projPool.
   *
   * Pass 2 — back-to-front rendering (painter's algorithm):
   *   Draw from farthest to nearest so near geometry covers far geometry.
   *   Uses projPool; no new allocations.
   *
   * @param segments      - Full road segment array from Road.
   * @param segmentCount  - Total segment count (for modulo wrap).
   * @param playerZ       - Player's world Z position.
   * @param playerX       - Player's normalised lateral position (-1…+1).
   * @param speed         - Current speed (for parallax accumulation).
   * @param drawDistance  - How many segments ahead to render.
   * @param w             - Canvas width.
   * @param h             - Canvas height.
   * @param horizonY      - Screen Y of the horizon line.
   */
  private renderRoad(
    segments:     readonly RoadSegment[],
    segmentCount: number,
    playerZ:      number,
    playerX:      number,
    speed:        number,
    drawDistance: number,
    w:            number,
    h:            number,
    horizonY:     number,
    trafficCars:  readonly TrafficCar[],
  ): void
  {
    const { ctx }  = this;
    const halfW    = w / 2;
    const halfH    = horizonY;
    const cameraX  = playerX * ROAD_WIDTH;
    const cameraZ  = playerZ;
    const totalLen = segmentCount * SEGMENT_LENGTH;

    // Base fill for the lower half: SAND_LIGHT ensures any pixel the grass
    // rects fail to cover (e.g. near-horizon segments clamped by halfH) shows
    // sand rather than grey.  The halfH clamp on grass rects prevents sand
    // from painting above the horizon; the convergence triangle (below) fills
    // the road zone at the vanishing point with ROAD_DARK so no sand bleeds
    // into the road surface there.  Road-batch seams are closed by the CW
    // winding fix, so SAND_LIGHT base no longer bleeds onto the road surface.
    ctx.fillStyle = COLORS.ROAD_DARK;
    ctx.fillRect(0, halfH, w, h - halfH);

    const startIndex  = Math.floor(playerZ / SEGMENT_LENGTH) % segmentCount;
    const baseSegment = segments[startIndex];
    const basePercent = (playerZ % SEGMENT_LENGTH) / SEGMENT_LENGTH;

    // Accumulate sky parallax offset; clamped to prevent unbounded growth.
    const speedPercent   = speed / PLAYER_MAX_SPEED;
    this.skyOffset       = (this.skyOffset + PARALLAX_SKY * baseSegment.curve * speedPercent) % 10000;

    // Camera Y tracks the road surface so hills produce genuine undulation.
    // Without this the camera stays fixed at CAMERA_HEIGHT above y=0, making
    // all hills look flat.  Interpolate between p1 and p2 for sub-segment accuracy.
    const playerRoadY = baseSegment.p1.world.y +
      (baseSegment.p2.world.y - baseSegment.p1.world.y) * basePercent;
    const cameraY = playerRoadY + CAMERA_HEIGHT;

    // ── Pass 1: project front-to-back, determine visibility ───────────────
    //
    // WHY front-to-back?
    //   We need to know which segments are hidden before we draw anything.
    //   Walking near→far lets us track the "horizon ceiling" efficiently.
    //
    // ── What is `horizonCeiling`? (the horizon ceiling) ─────────────────────────────
    //
    // Canvas Y=0 is the TOP of the screen; larger Y = lower on screen.
    // The horizon sits at halfH (the vertical midpoint).
    //
    // `horizonCeiling` is the HIGHEST screen-Y we have seen so far for any segment's
    // far (upper) edge.  Because "higher on screen" = SMALLER Y value, a
    // smaller horizonCeiling means the ceiling has risen.
    //
    // Imagine driving toward a hill:
    //
    //   horizon       Y = halfH  ───────────────────────────────── horizonCeiling starts here
    //   hill crest    Y = 200    ─────────────  ← horizonCeiling tightens to 200
    //   slope below   Y = 350    ─────────────────────────── invisible (sy2 > horizonCeiling? no)
    //
    // More precisely: after recording a segment, horizonCeiling = min(horizonCeiling, sy2).
    // Any later segment whose near edge (sy1) is ABOVE horizonCeiling (sy1 < horizonCeiling)
    // is behind the crest — completely hidden — and is skipped.
    //
    // ── Why a pre-allocated pool? ──────────────────────────────────────────
    //
    // At 60 fps with 200 draw-distance segments, a naive implementation would
    // allocate ~200 new objects per frame → ~12,000 heap allocs per second.
    // Modern garbage collectors pause for 1–5 ms when collecting — at 60 fps
    // that's an entire frame budget.  Pre-allocating once in the constructor
    // and overwriting the same slots each frame avoids all GC pressure.
    // We reset `projCount` to 0 (not the array itself) so the objects stay
    // allocated and only the valid-entry count changes.

    this.projCount = 0;   // reuse the pool — reset the counter, not the array
    let horizonCeiling   = halfH;
    let dx     = -(baseSegment.curve * basePercent);
    let curveX = 0;

    for (let i = 1; i <= drawDistance; i++)
    {
      const absIdx = startIndex + i;
      const segIdx = absIdx % segmentCount;
      const wraps  = Math.floor(absIdx / segmentCount);
      const seg    = segments[segIdx];

      const wz1 = seg.p1.world.z + wraps * totalLen;
      const cz1 = wz1 - cameraZ;

      if (cz1 <= 0)
      {
        // Behind the camera — advance accumulators only
        curveX += dx;
        dx += seg.curve;
        continue;
      }

      const wz2 = seg.p2.world.z + wraps * totalLen;
      const cz2 = wz2 - cameraZ;

      // Perspective scale — larger means closer to camera
      const sc1 = CAMERA_DEPTH / cz1;
      const sc2 = cz2 > 0 ? CAMERA_DEPTH / cz2 : 0;

      // Horizontal projection: curve accumulator bends the road left/right
      const projX1 = (cameraX - curveX)      * sc1;
      const projX2 = (cameraX - curveX - dx) * sc2;

      const sx1 = Math.round(halfW - projX1 * halfW);
      const sx2 = Math.round(halfW - projX2 * halfW);

      // Vertical projection: camera tracks road Y so hills produce genuine crests/dips
      const sy1 = Math.round(halfH + (cameraY - seg.p1.world.y) * sc1 * halfH);
      const sy2 = Math.round(halfH + (cameraY - seg.p2.world.y) * sc2 * halfH);

      const sw1 = ROAD_WIDTH * sc1 * halfW;
      const sw2 = ROAD_WIDTH * sc2 * halfW;

      if (sy1 >= horizonCeiling)
      {
        // Write directly into the pre-allocated slot — no heap allocation
        const slot = this.projPool[this.projCount++];
        slot.seg = seg;
        slot.sc1 = sc1;   // stored so Pass 2 sprites don't need to re-derive it
        slot.sc2 = sc2;   // stored so traffic cars can interpolate within the segment
        slot.sx1 = sx1; slot.sy1 = sy1; slot.sw1 = sw1;
        slot.sx2 = sx2; slot.sy2 = sy2; slot.sw2 = sw2;
        horizonCeiling = Math.min(horizonCeiling, sy2);
      }

      curveX += dx;
      dx     += seg.curve;
    }

    // ── Pass 2: render back-to-front — six batched colour groups ──────────
    //
    // Instead of one beginPath/fill per trapezoid (~1 000+ API calls/frame),
    // we group all trapezoids of the same colour into a single batched path.
    // The sub-passes are ordered so far geometry is always under near geometry
    // even though we now draw each colour in a separate sweep:
    //
    //   A. Grass fillRects  — per-segment, but cheapest call type; no change
    //   B. Road surface     — one batch (uniform #888888 across all segments)
    //   C. Rumble red       — one batch (alternating band 0)
    //   D. Rumble white     — one batch (alternating band 1)
    //   E. Lane dashes      — one batch (COLORS.LANE segments only)
    //   F. Edge track marks — one batch (white, on lane segments only)
    //
    // The trapezoids within each batch don't overlap in screen space (Pass 1
    // horizonCeiling occlusion prevents it), so painter order within a batch is irrelevant.

    // ── A. Grass ───────────────────────────────────────────────────────────
    drawGrass(ctx, this.projPool, this.projCount, halfH, w);

    // ── B. Road surface (continuous polygon) ───────────────────────────────
    ctx.fillStyle = COLORS.ROAD_DARK;
    drawRoadSurface(ctx, this.projPool, this.projCount);

    // ── Horizon gap fill ───────────────────────────────────────────────────
    // The road polygon's top edge sits at sy2 of the farthest segment.  On
    // downhill sections that edge can be below halfH, leaving a gap between
    // the polygon top and the horizon.  A convergence triangle fills it.
    if (this.projCount > 0)
    {
      const far  = this.projPool[this.projCount - 1];
      const topY = Math.min(far.sy1, far.sy2);
      if (topY > halfH)
      {
        const topX = far.sy1 <= far.sy2 ? far.sx1 : far.sx2;
        const topW = far.sy1 <= far.sy2 ? far.sw1 : far.sw2;
        ctx.fillStyle = COLORS.ROAD_DARK;
        ctx.beginPath();
        addTrap(ctx, topX, topY, topW * RUMBLE_OUTER_FRAC, topX, halfH, 0);
        ctx.fill();
      }
    }

    // ── C + D. Rumble strips ───────────────────────────────────────────────
    drawRumble(ctx, this.projPool, this.projCount);

    // ── E. Lane dashes ─────────────────────────────────────────────────────
    drawLaneDashes(ctx, this.projPool, this.projCount);

    // ── F. Edge track marks ────────────────────────────────────────────────
    drawEdgeMarks(ctx, this.projPool, this.projCount);

    // ── Pass 3: roadside sprites ───────────────────────────────────────────
    //
    // Sprites are drawn in a SEPARATE pass after all road geometry is finished.
    //
    // Why not inline in Pass 2?
    //   The grass fill `ctx.fillRect(0, sy2, w, sy1-sy2)` is full-canvas-width.
    //   When hill occlusion creates gaps in projPool, the next visible closer
    //   segment's grass band starts ABOVE a farther sprite's base (sy1), painting
    //   directly over it.  Which segments are occluded changes every frame as the
    //   player moves, so the overpainting alternates → sprites "flicker like mad".
    //
    //   By running sprites only after every grass/road fill is committed, all
    //   sprites are painted on top of the finished geometry.  They are still
    //   iterated back-to-front (far → near) so closer sprites correctly occlude
    //   farther ones.  The road trapezoid does not occlude sprites in practice:
    //   at the distances where sprites are visible (~15–100 segs), the road is
    //   too narrow to reach trees positioned outside the road edge.
    //
    //   Palm trees are tall — their crowns naturally extend above the horizon
    //   into the sky area.  No clip is applied: the browser clips drawImage to
    //   canvas bounds automatically, and a tiny amount of crown peeking above
    //   the horizon on distant trees is far less jarring than sliced stumps.

    // Roadside sprites are pixel-art sourced from hardware-palette originals.
    // Bilinear smoothing gives them a watercolour softness instead of crisp
    // pixel fidelity.  Disable for the entire Pass 3; re-enable after for the
    // car which is continuously scaled and benefits from smoothing (L6).
    ctx.imageSmoothingEnabled = false;

    for (let i = this.projCount - 1; i >= 0; i--)
    {
      const p              = this.projPool[i];
      const { seg, sc1, sx1, sy1, sx2, sy2, sw1, sw2 } = p;

      if (sy1 < halfH) continue;

      for (const si of seg.sprites ?? [])
      {
        // ── C8: screen-space X-cull before any sheet/rect lookup ─────────
        // Compute world→screen X first; skip sprites that are entirely off-screen.
        // 500px margin accommodates the widest sprites (large houses, big boards).
        const sprX = sx1 + si.worldX * sc1 * halfW;
        if (sprX < -500 || sprX > w + 500) continue;

        // ── C7: dispatch by pre-classified family — one comparison per level ─
        const { family } = si;
        const id = si.id as SpriteId;

        let sheet: SpriteLoader | null;
        let rect:  { x: number; y: number; w: number; h: number } | undefined;
        let worldH: number | undefined;

        // ── Gate families: draw procedurally, no sheet needed ───────────
        if (family === 'gate_start' || family === 'gate_finish')
        {
          // Gate world height ≈ 3× a tall palm — imposing but in-scale.
          const gateWorldH = 2200;
          const gateWorldW = ROAD_WIDTH * 2.4;   // spans well beyond road edges
          const gH = Math.round(gateWorldH * sc1 * halfH);
          const gW = Math.round(gateWorldW * sc1 * halfW);
          if (gH < 8) continue;
          const gX = Math.round(sx1 - gW / 2);
          const gY = Math.round(sy1 - gH);
          this.drawGate(family === 'gate_finish', gX, gY, gW, gH);
          continue;
        }

        switch (family)
        {
          case 'billboard': sheet = this.billboardSprites; rect = BILLBOARD_RECTS[id]; worldH = BILLBOARD_WORLD_HEIGHT[id]; break;
          case 'cookie':    sheet = this.cookieSprites;    rect = COOKIE_RECTS[id];    worldH = COOKIE_WORLD_HEIGHT[id];    break;
          case 'barney':    sheet = this.barneySprites;    rect = BARNEY_RECTS[id];    worldH = BARNEY_WORLD_HEIGHT[id];    break;
          case 'big':       sheet = this.bigSprites;       rect = BIG_RECTS[id];       worldH = BIG_WORLD_HEIGHT[id];       break;
          case 'cactus':    sheet = this.cactusSprites;    rect = CACTUS_RECTS[id];    worldH = CACTUS_WORLD_HEIGHT[id];    break;
          case 'shrub':     sheet = this.shrubSprites;     rect = SHRUB_RECTS[id];     worldH = SHRUB_WORLD_HEIGHT[id];     break;
          case 'sign':      sheet = this.signSprites;      rect = SIGN_RECTS[id];      worldH = SIGN_WORLD_HEIGHT[id];      break;
          case 'house':     sheet = this.houseSprites;     rect = HOUSE_RECTS[id];     worldH = HOUSE_WORLD_HEIGHT[id];     break;
          default:          sheet = this.roadSprites;      rect = SPRITE_RECTS[id];    worldH = SPRITE_WORLD_HEIGHT[id];    break;
        }

        if (!sheet?.isReady()) continue;
        if (!rect || !worldH) continue;

        const sprH = worldH * (si.scale ?? 1) * sc1 * halfH;
        if (sprH < 4) continue;   // C8: raised from 2 — tiny sprites are invisible

        const sprW = sprH * (rect.w / rect.h) * (si.stretchX ?? 1);

        // Board sprites anchor from their road-facing inner edge so the
        // painted side faces the driver.  Non-board sprites (trees, etc.)
        // are centre-anchored so they look natural from either side.
        const isBoard  = family === 'billboard' || family === 'cookie' || family === 'barney' || family === 'big';
        const drawX = isBoard
          ? (si.worldX > 0 ? Math.round(sprX) : Math.round(sprX - sprW))
          : Math.round(sprX - sprW / 2);

        // Palms/cactuses/shrubs: shift down by transparent bottom padding so base = sy1.
        // Board sprites: groundOffset=0 — base at road level, no masking.
        // Houses: proportional to rect.h (20%) — isometric floor/step.
        const padPx        = family === 'house' ? Math.round(rect.h * 0.20) : family === 'cactus' ? 10 : 8;
        const groundOffset = isBoard ? 0 : Math.round(padPx / rect.h * sprH);

        const drawY = Math.round(sy1 - sprH) + groundOffset;
        const drawW = Math.round(sprW);
        const drawH = Math.round(sprH);

        if (si.flipX)
        {
          // Mirror horizontally using setTransform — avoids the save/restore
          // overhead incurred by every right-side house on each frame.
          // Canvas is CSS-pixel-only (no DPR scale), so identity is (1,0,0,1,0,0).
          ctx.setTransform(-1, 0, 0, 1, 0, 0);
          sheet.draw(ctx, rect, -(drawX + drawW), drawY, drawW, drawH);
          ctx.setTransform(1, 0, 0, 1, 0, 0);
        }
        else
        {
          sheet.draw(ctx, rect, drawX, drawY, drawW, drawH);
        }
      }

    }

    // Restore smoothing — traffic cars and the player car are continuously
    // scaled and benefit from bilinear filtering (L6).
    ctx.imageSmoothingEnabled = true;

    // ── Pass 4: Traffic vehicles ───────────────────────────────────────────
    //
    // WHY a dedicated pass instead of inline in the sprite loop (Pass 3)?
    //
    //   The sprite loop's per-segment iteration matched each traffic car by
    //   segment index:
    //     Math.floor(car.worldZ / SEGMENT_LENGTH) % segmentCount === seg.index
    //   When a car's worldZ crossed a segment boundary, the old segment's loop
    //   iteration had already executed and the new segment's hadn't yet — the
    //   car was invisible for exactly one frame.  At 60 fps this produced a
    //   one-frame flicker/ghost that was very noticeable.
    //
    //   By iterating projPool far→near in a separate pass, each car is matched
    //   to its segment exactly once per frame regardless of where in the segment
    //   it sits.  projPool is already in near→far order (index 0 = nearest), so
    //   iterating in reverse gives the correct painter's-algorithm draw order.
    //
    //   Road centre (sx1) and perspective scale (sc1) come from the projPool
    //   entry rather than from the sprite loop's current sx1, which also
    //   eliminates the one-segment horizontal jitter on curved road sections.
    //
    // PERFORMANCE NOTES
    //   • trafficRect is pre-allocated — no heap allocation per draw call.
    //   • imageSmoothingEnabled is set once above, not toggled per car.
    //   • Inner-loop work: projCount(≤150) × trafficCount(3) = ≤450 integer
    //     comparisons — trivially cheap.

    if (trafficCars.length > 0)
    {
      const nCars        = trafficCars.length;
      const farthestSlot = this.projCount - 1;  // -1 when projCount=0; draw loop won't fire

      // Assign each car to its effective projPool slot by scanning projPool.
      //
      // Why scan instead of an O(1) lookup array?
      //   A lookup array indexed by seg.index must be sized to the maximum segment
      //   count across all tracks.  Tracks range from 1225 (Easy) to 3764 (Legendary)
      //   segments — a fixed-size array smaller than 3764 silently returns undefined
      //   for out-of-range indices, causing every car on the affected segments to fall
      //   back to farthestSlot and render as a ghost at the horizon.  A scan over
      //   projPool (≤200 entries) × nCars (3) = ≤600 comparisons per frame is
      //   negligible and requires no knowledge of the maximum segment count.
      //
      // HILL OCCLUSION FIX: if the car's segment was culled by horizonCeiling
      //   (hidden behind a hill crest), it won't be found in projPool.  Fall back
      //   to farthestSlot so the car renders at the hill crest rather than vanishing.
      for (let c = 0; c < nCars; c++)
      {
        const segIdx = Math.floor(trafficCars[c].worldZ / SEGMENT_LENGTH) % segmentCount;
        let   slot   = farthestSlot;   // default: hill-crest fallback
        for (let s = 0; s < this.projCount; s++)
        {
          if (this.projPool[s].seg.index === segIdx) { slot = s; break; }
        }
        this.carSlotBuf[c] = slot;
      }

      // Iterate projPool far→near for correct painter's-algorithm draw order.
      // carSlotBuf guarantees each car is matched to exactly one slot per frame.
      for (let slot = this.projCount - 1; slot >= 0; slot--)
      {
        const p = this.projPool[slot];

        for (let c = 0; c < nCars; c++)
        {
          if (this.carSlotBuf[c] !== slot) continue;

          const car  = trafficCars[c];
          const spec = TRAFFIC_CAR_SPECS[car.type];
          const sheet = this.trafficCarSheets.get(car.type);
          if (!sheet?.isReady()) continue;

          const { frameW, frameH, worldH } = spec;

          // Interpolate within the segment using the car's fractional depth.
          // Without this the car snaps to p.sy1 (near edge Y) and jumps a
          // full slot delta every ~3 frames as it crosses segment boundaries —
          // the visible "vibration" reported at normal driving speeds.
          const t      = (car.worldZ % SEGMENT_LENGTH) / SEGMENT_LENGTH;
          const scCar  = p.sc1 + (p.sc2 - p.sc1) * t;
          const syCar  = p.sy1 + (p.sy2 - p.sy1) * t;
          const sxCar  = p.sx1 + (p.sx2 - p.sx1) * t;

          // Vertical cull: car foot above the horizon means it's in the sky.
          // Mirrors the `if (sy1 < halfH) continue` guard in the Pass 3 sprite loop.
          if (syCar < halfH) continue;

          const carScrX = sxCar + car.worldX * scCar * halfW;
          if (carScrX < -500 || carScrX > w + 500) continue;

          const sprH = worldH * scCar * halfH;
          if (sprH < 4) continue;

          const sprW  = sprH * (frameW / frameH);
          const drawW = Math.round(sprW);
          const drawH = Math.round(sprH);
          const drawX = Math.round(carScrX - sprW / 2);
          const drawY = Math.round(syCar - sprH);

          // Reuse the class-level pre-allocated rect object.
          const tr = this.trafficRect;
          tr.w = frameW;
          tr.h = frameH;

          if (car.spinAngle !== 0)
          {
            ctx.save();
            ctx.translate(drawX + drawW / 2, drawY + drawH / 2);
            ctx.rotate(car.spinAngle);
            ctx.translate(-(drawX + drawW / 2), -(drawY + drawH / 2));
            sheet.draw(ctx, tr, drawX, drawY, drawW, drawH);
            ctx.restore();
          }
          else
          {
            sheet.draw(ctx, tr, drawX, drawY, drawW, drawH);
          }
        }
      }
    }
  }

  // ── Player car ────────────────────────────────────────────────────────────

  /**
   * Draws the player's Ferrari at the bottom-centre of the screen.
   *
   * Frame selection: steerAngle (-1…+1) maps to a sprite frame, capped at
   * 60% of full range so the nose never points sideways at full lock.
   *
   * Pivot correction: CAR_PIVOT_OFFSETS keeps the rear axle fixed on screen
   * as the steering frame changes.
   *
   * @param w          - Canvas width.
   * @param h          - Canvas height.
   * @param steerAngle - Steering value in [-1, +1].
   */
  private renderCar(w: number, h: number, steerAngle: number): void
  {
    const { ctx } = this;
    if (!this.carSprites?.isReady()) return;

    const frameIndex      = Math.round(steerAngle * CAR_SPRITE_CENTER * 0.6) + CAR_SPRITE_CENTER;
    const rect            = carFrameRect(frameIndex);
    const carH            = Math.min(h * 0.30, 285);
    const carW            = carH * (CAR_SPRITE_FRAME_W / CAR_SPRITE_FRAME_H);
    const bot             = h - h * 0.01;
    const pivotOffset     = CAR_PIVOT_OFFSETS[frameIndex] ?? 0;
    const pivotCorrection = (pivotOffset / CAR_SPRITE_FRAME_W) * carW;
    const cx              = w / 2 + steerAngle * w * 0.05 + pivotCorrection;
    const drawX           = Math.round(cx - carW / 2);
    const drawY           = Math.round(bot - carH);

    // Soft elliptical ground shadow
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.beginPath();
    ctx.ellipse(cx, bot + 4, carW * 0.4, 6, 0, 0, Math.PI * 2);
    ctx.fill();

    this.carSprites.draw(ctx, rect, drawX, drawY, Math.round(carW), Math.round(carH));
  }

  // ── Public entry point ────────────────────────────────────────────────────

  /**
   * Draws a complete frame.  Called every animation frame by game.ts.
   *
   * A single ctx.save/restore pair wraps the entire frame — renderHUD no
   * longer needs its own nested pair.
   *
   * @param segments       - Full road segment array.
   * @param segmentCount   - Total segment count (for modulo wrap).
   * @param playerZ        - Player depth position in world units.
   * @param playerX        - Player lateral position, normalised -1…+1.
   * @param drawDistance   - How many segments ahead to render.
   * @param w              - Canvas width in pixels.
   * @param h              - Canvas height in pixels.
   * @param speed          - Current speed in world units per second.
   * @param steerAngle     - Continuous steering value in [-1, +1].
   * @param horizonOffset  - Pixel offset to shift the horizon (off-road jitter).
   */
  render(
    segments:          readonly RoadSegment[],
    segmentCount:      number,
    playerZ:           number,
    playerX:           number,
    drawDistance:      number,
    w:                 number,
    h:                 number,
    speed:             number,
    steerAngle:        number,
    horizonOffset:     number = 0,
    trafficCars:       readonly TrafficCar[] = [],
    raceTimer:         number = 0,
    distanceKm:        number = 0,
    raceLengthKm:      number = 0,
    timeRemaining:     number = 0,
    score:             number = 0,
    stageNameTimer:    number = 0,
    barneyBoostTimer:  number = 0,
    btnQuit?:          Button,
  ): void
  {
    const { ctx }  = this;
    const horizonY       = Math.round(h / 2 + horizonOffset);
    const stableHorizonY = Math.round(h / 2);   // immune to off-road jitter
    ctx.save();
    ctx.clearRect(0, 0, w, h);
    this.renderSky(w, horizonY, stableHorizonY);
    this.renderRoad(segments, segmentCount, playerZ, playerX, speed, drawDistance, w, h, horizonY, trafficCars);
    this.renderCar(w, h, steerAngle);
    if (barneyBoostTimer > 0)
      this.screens.renderAfterburner(w, h, barneyBoostTimer);
    this.hud.renderHUD(w, h, speed, raceTimer, distanceKm, raceLengthKm, timeRemaining, score, barneyBoostTimer, btnQuit);
    if (stageNameTimer > 0)
      this.menu.renderStageAnnouncement(w, h, stageNameTimer);
    ctx.restore();
  }

  // ── Public wrappers delegating to sub-renderers ───────────────────────────

  renderPreloader(w: number, h: number, progress: number, error?: string): void
    { this.screens.renderPreloader(w, h, progress, error); }

  renderIntro(
    w: number, h: number,
    selectedItem:  'start' | 'mode' | 'settings',
    selectedMode:  string,
    soundEnabled:  boolean,
    subMenu:       'mode' | 'settings' | null,
    pulse:         boolean,
    heroImage:     HTMLImageElement | null = null,
    btns?: {
      mode: Button; settings: Button; start: Button;
      easy: Button; medium: Button; hard: Button;
      close: Button; sound: Button; github: Button;
    },
  ): void
    { this.menu.renderIntro(w, h, selectedItem, selectedMode, soundEnabled, subMenu, pulse, heroImage, btns); }

  renderCountdown(w: number, h: number, value: number | 'GO!'): void
    { this.screens.renderCountdown(w, h, value); }

  renderGoalScreen(
    w: number, h: number,
    score: number, elapsedSec: number,
    barneyKills: number,
    timeRemaining: number,
    btnPlayAgain: Button, btnMenu: Button,
  ): void
    { this.screens.renderGoalScreen(w, h, score, elapsedSec, barneyKills, timeRemaining, btnPlayAgain, btnMenu); }

  renderTimeUpScreen(w: number, h: number, score: number, btnContinue: Button): void
    { this.screens.renderTimeUpScreen(w, h, score, btnContinue); }

  renderConfetti(w: number, h: number, t: number): void
    { this.screens.renderConfetti(w, h, t); }

  /**
   * Draws white pill-outline affordances over the canvas for mobile thumb zones.
   * Left pill (horizontal) = steer; right pill (vertical) = gas/brake.
   * Half-highlights when the corresponding input is active.
   *
   * Must be called AFTER render() so pills sit on top of the HUD.
   *
   * @param w          - Canvas width.
   * @param h          - Canvas height.
   * @param steerLeft  - Steer-left input active.
   * @param steerRight - Steer-right input active.
   * @param throttle   - Throttle active.
   * @param brake      - Brake active.
   * @param safeL      - Left safe-area inset (CSS px, equals canvas px on mobile).
   * @param safeR      - Right safe-area inset.
   * @param safeB      - Bottom safe-area inset.
   */
  renderTouchPills(
    w: number, h: number,
    steerLeft: boolean, steerRight: boolean,
    throttle:  boolean, brake:      boolean,
    safeL: number, safeR: number, safeB: number,
  ): void
  {
    const { ctx } = this;
    ctx.save();

    // Pills sized relative to the shorter screen dimension so they scale
    // sensibly across phone sizes.  pillThick is the narrow dimension shared
    // by both pills — used as the font size reference so arrows are identical.
    const pillThick = Math.round(Math.min(w, h) * 0.14);
    const pillLong  = Math.round(pillThick * 2.6);
    const arrowFs   = Math.round(pillThick * 0.65);
    // Flat radius so both pills look like one container, not two bubbles joined.
    const pillRadius = Math.round(pillThick * 0.18);

    // Anchored to bottom corners, clear of safe-area zones.
    // pillCy is the CENTER of both pills — use pillLong/2 to ensure the taller
    // vertical pill never clips above the canvas top.
    const pillCy      = h - safeB - pillLong / 2 - Math.round(h * 0.04);
    const leftPillCx  = safeL + pillLong / 2 + Math.round(w * 0.03);
    const rightPillCx = w - safeR - pillLong / 2 - Math.round(w * 0.03);

    // Shared draw helper
    const drawPill = (
      px: number, py: number, pw: number, ph: number,
      highlightLeft: boolean, highlightRight: boolean,
      highlightTop: boolean,  highlightBottom: boolean,
    ): void =>
    {
      const pr = pillRadius;

      ctx.beginPath();
      ctx.roundRect(px, py, pw, ph, pr);
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fill();

      if (highlightLeft || highlightRight || highlightTop || highlightBottom)
      {
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(px, py, pw, ph, pr);
        ctx.clip();
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        if (highlightLeft)   ctx.fillRect(px,          py, pw / 2, ph);
        if (highlightRight)  ctx.fillRect(px + pw / 2, py, pw / 2, ph);
        if (highlightTop)    ctx.fillRect(px, py,          pw, ph / 2);
        if (highlightBottom) ctx.fillRect(px, py + ph / 2, pw, ph / 2);
        ctx.restore();
      }

      ctx.beginPath();
      ctx.roundRect(px, py, pw, ph, pr);
      ctx.strokeStyle = 'rgba(255,255,255,0.70)';
      ctx.lineWidth   = 3;
      ctx.stroke();
    };

    ctx.fillStyle    = 'rgba(255,255,255,0.90)';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.font         = `${arrowFs}px sans-serif`;

    // ── Left pill — horizontal (steer) ──────────────────────────────────────
    {
      const pw = pillLong;
      const ph = pillThick;
      const px = Math.round(leftPillCx - pw / 2);
      const py = Math.round(pillCy     - ph / 2);
      drawPill(px, py, pw, ph, steerLeft, steerRight, false, false);
      ctx.fillStyle = 'rgba(255,255,255,0.90)';   // restore after drawPill overwrites it
      ctx.fillText('◀\uFE0E', px + pw * 0.25, py + ph / 2);
      ctx.fillText('▶\uFE0E', px + pw * 0.75, py + ph / 2);
    }

    // ── Right pill — vertical (throttle/brake) ───────────────────────────────
    {
      const pw = pillThick;
      const ph = pillLong;
      const px = Math.round(rightPillCx - pw / 2);
      const py = Math.round(pillCy      - ph / 2);
      drawPill(px, py, pw, ph, false, false, throttle, brake);
      ctx.fillStyle = 'rgba(255,255,255,0.90)';   // restore after drawPill overwrites it
      ctx.fillText('▲\uFE0E', px + pw / 2, py + ph * 0.25);
      ctx.fillText('▼\uFE0E', px + pw / 2, py + ph * 0.75);
    }

    ctx.textBaseline = 'alphabetic';
    ctx.restore();
  }

  // ── Procedural gate drawing ────────────────────────────────────────────────

  /**
   * Draws a start or finish gate spanning the road, centred at (x, y).
   * Both gates use vertical posts + horizontal beam.
   * Start = red/white alternating vertical stripes.
   * Finish = black/white checkerboard.
   *
   * @param isFinish - True for checkerboard finish gate, false for red/white start.
   * @param x        - Left edge of the gate in canvas pixels.
   * @param y        - Top edge of the gate in canvas pixels.
   * @param gw       - Total gate width in canvas pixels.
   * @param gh       - Total gate height in canvas pixels.
   */
  private drawGate(isFinish: boolean, x: number, y: number, gw: number, gh: number): void
  {
    const { ctx } = this;
    const postW   = Math.max(4, Math.round(gw * 0.04));
    const beamH   = Math.max(4, Math.round(gh * 0.12));
    const postH   = gh - beamH;

    // Vertical support posts on left and right sides
    ctx.fillStyle = '#CCCCCC';
    ctx.fillRect(x,                    y + beamH, postW, postH);
    ctx.fillRect(x + gw - postW,       y + beamH, postW, postH);

    // Horizontal beam: stripe count scales with gate width so stripes
    // remain roughly square regardless of perspective foreshortening.
    const stripeCount = Math.max(4, Math.round(gw / beamH));
    const stripeW     = gw / stripeCount;
    for (let i = 0; i < stripeCount; i++)
    {
      const even = i % 2 === 0;
      ctx.fillStyle = isFinish
        ? (even ? '#FFFFFF' : '#222222')   // checkerboard for finish
        : (even ? '#DD0000' : '#FFFFFF');  // red/white for start
      ctx.fillRect(Math.round(x + i * stripeW), y, Math.ceil(stripeW), beamH);
    }
    // Thin border around the entire beam
    ctx.strokeStyle = '#333333';
    ctx.lineWidth   = 1;
    ctx.strokeRect(x, y, gw, beamH);

    // Banner text centred on the beam (outlined for legibility)
    const label = isFinish ? 'FINISH' : 'START';
    const fs    = Math.min(beamH * 0.75, 28);
    ctx.font      = `bold ${Math.round(fs)}px Impact, sans-serif`;
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.strokeStyle = '#000000';
    ctx.lineWidth   = fs * 0.12;
    ctx.strokeText(label, x + gw / 2, y + beamH * 0.78);
    ctx.fillText(label,   x + gw / 2, y + beamH * 0.78);
  }
}
