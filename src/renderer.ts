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
 *     `maxy`.  Segments whose near edge projects above the ceiling are hidden
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
} from './constants';
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

// ── Module-level constants ─────────────────────────────────────────────────────

/**
 * 7-segment bitmask for each digit 0–9.
 *
 * A classic 7-segment display has seven rectangular segments labelled a–g:
 *    aaa
 *   f   b
 *   f   b
 *    ggg
 *   e   c
 *   e   c
 *    ddd
 *
 * Each entry below stores which segments should be LIT for that digit.
 * The bit positions are: bit0=a, bit1=b, bit2=c, bit3=d, bit4=e, bit5=f, bit6=g.
 * Example: '8' lights all 7 segments → 0x7F = 0111 1111.
 */
const SEG_DIGIT = [
  0x3F,  // 0: a b c d e f   (all except middle)
  0x06,  // 1: b c
  0x5B,  // 2: a b d e g
  0x4F,  // 3: a b c d g
  0x66,  // 4: b c f g
  0x6D,  // 5: a c d f g
  0x7D,  // 6: a c d e f g
  0x07,  // 7: a b c
  0x7F,  // 8: a b c d e f g  (all)
  0x6F,  // 9: a b c d f g
] as const;

/** Total number of rectangular segments in the speed bar. */
const BAR_SEGS = 20;

/**
 * Speed bar colour zones — sourced from the original OutRun (1986) Sega
 * System 16 hardware palette as faithfully as RGB hex allows:
 *   Steel-blue zone (~80%): pale desaturated cyan-blue — low to mid speed
 *   Green zone      (~20%): medium green               — high speed
 */
const BAR_BLUE_END    = Math.round(BAR_SEGS * 0.80);  // = 16  (steel-blue → green)
const BAR_LAST        = BAR_SEGS - 1;                  // = 19  (pink redline cap)
const BAR_COLOR_BLUE  = '#8899BB';            // pale steel-blue  (System 16 low–mid)
const BAR_COLOR_GREEN = '#33BB44';            // medium green     (System 16 high speed)
const BAR_COLOR_PINK  = '#FF44CC';            // pink             (redline cap, last seg)
const BAR_COLOR_UNLIT = 'rgba(80,80,80,0.5)'; // 50% transparent — background shows through

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
interface ProjectedSeg
{
  seg: RoadSegment;
  sc1: number;
  sx1: number; sy1: number; sw1: number;
  sx2: number; sy2: number; sw2: number;
}

// ── HudLayout ─────────────────────────────────────────────────────────────────

/**
 * All pixel positions and font strings needed to draw the HUD.
 * Computed once per canvas size and cached — recomputed only on resize.
 * Avoids recalculating layout values every single frame.
 */
interface HudLayout
{
  padX:      number;   // left edge of the entire HUD cluster
  // 7-segment speed digits
  digitH:    number;   // height of each digit cell in pixels
  digitW:    number;   // width of each digit cell in pixels
  digitT:    number;   // segment line thickness in pixels
  digitGap:  number;   // horizontal gap between adjacent digit cells
  digitY:    number;   // top Y of the digit row
  // "km/h" label (yellow, to the right of the digits)
  kphX:      number;   // left X of the "km/h" text
  kphY:      number;   // baseline Y of the "km/h" text
  kphFont:   string;   // CSS font string for the label
  // Single-row speed bar (below the digits)
  barX:      number;   // left X of the bar
  barY:      number;   // top Y of the bar
  barH:      number;   // height of each segment rectangle
  barSegW:   number;   // width of each segment rectangle
  barStride: number;   // barSegW + gap between segments
}

// ── Helper: fillSegment ───────────────────────────────────────────────────────

/**
 * Draws one rectangular 7-segment LED bar at the given position.
 * Module-level to avoid allocating a fresh closure object on each
 * drawSegDigit() call (~360 closures/sec at 60 fps, 6 calls/frame) (L8).
 *
 * @param ctx      - Canvas 2D rendering context.
 * @param mask     - Bitmask for the current digit (from SEG_DIGIT).
 * @param bit      - Which bit in mask this segment tests.
 * @param colorOn  - CSS colour for a lit segment.
 * @param colorOff - CSS colour for an unlit segment ('' = invisible).
 * @param rx, ry, rw, rh - Destination rectangle.
 */
function fillSegment(
  ctx:      CanvasRenderingContext2D,
  mask:     number,
  bit:      number,
  colorOn:  string,
  colorOff: string,
  rx: number, ry: number, rw: number, rh: number,
): void
{
  const color = (mask >> bit) & 1 ? colorOn : colorOff;
  if (!color || rw <= 0 || rh <= 0) return;
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(rx), Math.round(ry), Math.round(rw), Math.round(rh));
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

// ── Helper: drawSegDigit ──────────────────────────────────────────────────────

/**
 * Draws one 7-segment LED digit using filled rectangles.
 *
 * Each of the seven segments is a thin rectangle.  The SEG_DIGIT bitmask
 * (defined above) tells us which segments to light up for the given digit.
 * Active segments get colorOn; inactive ones get colorOff.
 * Setting colorOff to a very dark colour reproduces the classic "unlit LED"
 * look where you can faintly see the segment grid even when it is off.
 *
 * Segment layout inside the cell (width dw, height dh, thickness t):
 *
 *   |←—— dw ——→|
 *     t  a  t
 *    f        b     ← vertical segments span (dh/2 - t - gap) pixels
 *     t  g  t
 *    e        c     ← same height as b/f
 *     t  d  t
 *
 * @param ctx      - Canvas 2D rendering context.
 * @param digit    - Integer 0–9 to display.
 * @param x        - Left edge of the digit cell in pixels.
 * @param y        - Top edge of the digit cell in pixels.
 * @param dw       - Width of the digit cell in pixels.
 * @param dh       - Height of the digit cell in pixels.
 * @param t        - Segment thickness in pixels.
 * @param colorOn  - CSS colour string for lit (active) segments.
 * @param colorOff - CSS colour string for dark (inactive) segments.
 */
function drawSegDigit(
  ctx:      CanvasRenderingContext2D,
  digit:    number,
  x:        number, y: number,
  dw:       number, dh: number,
  t:        number,
  colorOn:  string,
  colorOff: string,
): void
{
  const mask = SEG_DIGIT[digit] ?? SEG_DIGIT[0];
  const g    = 1;      // hard 1-px tip gap — proportional gaps eat the segments at small sizes
  const hw   = dh / 2; // midpoint between top and bottom

  // fillSegment is module-level to avoid per-call closure allocation (L8).
  fillSegment(ctx, mask, 0, colorOn, colorOff, x + t + g,  y,              dw - 2*t - 2*g, t);           // a — top horizontal
  fillSegment(ctx, mask, 1, colorOn, colorOff, x + dw - t, y + t + g,      t,               hw - t - 2*g); // b — top-right
  fillSegment(ctx, mask, 2, colorOn, colorOff, x + dw - t, y + hw + g,     t,               hw - t - 2*g); // c — bot-right
  fillSegment(ctx, mask, 3, colorOn, colorOff, x + t + g,  y + dh - t,     dw - 2*t - 2*g, t);           // d — bottom horizontal
  fillSegment(ctx, mask, 4, colorOn, colorOff, x,           y + hw + g,     t,               hw - t - 2*g); // e — bot-left
  fillSegment(ctx, mask, 5, colorOn, colorOff, x,           y + t + g,      t,               hw - t - 2*g); // f — top-left
  fillSegment(ctx, mask, 6, colorOn, colorOff, x + t + g,  y + hw - t / 2, dw - 2*t - 2*g, t);           // g — middle horizontal
}

// ── Renderer ──────────────────────────────────────────────────────────────────

export class Renderer
{
  private ctx:              CanvasRenderingContext2D;

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

  // ── HUD layout cache ──────────────────────────────────────────────────────
  //
  // ~20 layout values (pixel positions, font strings) only need recomputing
  // when the canvas size changes — not 60 times per second.

  /** Cached layout; null until first render. */
  private hudLayout: HudLayout | null = null;

  /** Canvas width when hudLayout was last computed. */
  private hudW = 0;

  /** Canvas height when hudLayout was last computed. */
  private hudH = 0;

  /**
   * Accumulated horizontal sky-layer offset for curve parallax.
   * Clamped modulo a large period to prevent unbounded growth over long sessions.
   */
  private skyOffset = 0;

  /** Sprite sheets keyed by TrafficType — populated from SpriteSheetMap.trafficCars. */
  private readonly trafficCarSheets = new Map<TrafficType, SpriteLoader>();

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
    canvas:  HTMLCanvasElement,
    sprites: Partial<SpriteSheetMap> = {},
  )
  {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get 2D context');
    this.ctx              = ctx;
    this.carSprites       = sprites.car       ?? null;
    for (const [type, loader] of Object.entries(sprites.trafficCars ?? {}))
      this.trafficCarSheets.set(type as TrafficType, loader);
    this.roadSprites      = sprites.road      ?? null;
    this.billboardSprites = sprites.billboard ?? null;
    this.cactusSprites    = sprites.cactus    ?? null;
    this.cookieSprites    = sprites.cookie    ?? null;
    this.barneySprites    = sprites.barney    ?? null;
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
      sc1: 0,
      sx1: 0, sy1: 0, sw1: 0,
      sx2: 0, sy2: 0, sw2: 0,
    }));

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
   *   space.  Use `maxy` to skip segments hidden behind hill crests.
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

    // Solid grass fill — prevents a bare gap between the horizon and the
    // farthest visible road segment on flat sections.
    ctx.fillStyle = COLORS.SAND_LIGHT;
    ctx.fillRect(0, halfH, w, halfH);

    const startIndex  = Math.floor(playerZ / SEGMENT_LENGTH) % segmentCount;
    const baseSegment = segments[startIndex];
    const basePercent = (playerZ % SEGMENT_LENGTH) / SEGMENT_LENGTH;

    // Accumulate sky parallax offset; clamped to prevent unbounded growth.
    const speedPercent   = speed / PLAYER_MAX_SPEED;
    this.skyOffset       = (this.skyOffset + PARALLAX_SKY * baseSegment.curve * speedPercent) % 10000;

    // ── Pass 1: project front-to-back, determine visibility ───────────────
    //
    // `maxy` starts at the horizon (halfH).  Each time we see a segment
    // whose far edge is higher on screen (smaller Y) than maxy, we tighten
    // the ceiling.  Any segment whose near edge is above that ceiling is
    // hidden behind a hill and excluded from projPool.

    this.projCount = 0;   // reuse the pool — reset the counter, not the array
    let maxy   = halfH;
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

      // Vertical projection: world.y shifts segments up (uphill) or down (downhill)
      const sy1 = Math.round(halfH + (CAMERA_HEIGHT - seg.p1.world.y) * sc1 * halfH);
      const sy2 = Math.round(halfH + (CAMERA_HEIGHT - seg.p2.world.y) * sc2 * halfH);

      const sw1 = ROAD_WIDTH * sc1 * halfW;
      const sw2 = ROAD_WIDTH * sc2 * halfW;

      if (sy1 >= maxy)
      {
        // Write directly into the pre-allocated slot — no heap allocation
        const slot = this.projPool[this.projCount++];
        slot.seg = seg;
        slot.sc1 = sc1;   // stored so Pass 2 sprites don't need to re-derive it
        slot.sx1 = sx1; slot.sy1 = sy1; slot.sw1 = sw1;
        slot.sx2 = sx2; slot.sy2 = sy2; slot.sw2 = sw2;
        maxy = Math.min(maxy, sy2);
      }

      curveX += dx;
      dx     += seg.curve;
    }

    // ── Horizon cap ───────────────────────────────────────────────────────
    //
    // Fills the gap between halfH and the far edge of the farthest visible
    // segment so the road converges to a point at the horizon rather than
    // cutting off into flat grass.

    if (this.projCount > 0)
    {
      const far = this.projPool[this.projCount - 1];
      if (far.sy2 > halfH)
      {
        ctx.fillStyle = COLORS.SAND_LIGHT;
        ctx.fillRect(0, halfH, w, far.sy2 - halfH);
      }
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
    // maxy occlusion prevents it), so painter order within a batch is irrelevant.

    // ── A. Grass ───────────────────────────────────────────────────────────
    for (let i = this.projCount - 1; i >= 0; i--)
    {
      const { sy1, sy2, seg } = this.projPool[i];
      if (sy2 >= sy1) continue;
      if (seg.color.grass !== COLORS.SAND_LIGHT)
      {
        ctx.fillStyle = seg.color.grass;
        ctx.fillRect(0, sy2, w, sy1 - sy2);
      }
    }

    // Helper: add one trapezoid subpath into the currently open path.
    // All coordinates are pixel-snapped to eliminate sub-pixel anti-aliasing
    // seams between adjacent segments.  y2 is extended by 1px toward the
    // horizon so adjacent segment fills overlap — closing the 1px crack that
    // canvas anti-aliasing can leave at their shared horizontal boundary.
    const addTrap = (x1: number, y1: number, w1: number,
                     x2: number, y2: number, w2: number): void =>
    {
      const r2 = y2 - 1;   // 1px overlap toward horizon — seam-proof
      ctx.moveTo(Math.round(x1 - w1), y1);
      ctx.lineTo(Math.round(x1 + w1), y1);
      ctx.lineTo(Math.round(x2 + w2), r2);
      ctx.lineTo(Math.round(x2 - w2), r2);
      ctx.closePath();
    };

    // ── B. Road surface ────────────────────────────────────────────────────
    ctx.fillStyle = COLORS.ROAD_DARK;   // ROAD_LIGHT === ROAD_DARK, one uniform grey
    ctx.beginPath();
    for (let i = this.projCount - 1; i >= 0; i--)
    {
      const { sx1, sy1, sw1, sx2, sy2, sw2 } = this.projPool[i];
      if (sy2 >= sy1) continue;
      addTrap(sx1, sy1, sw1, sx2, sy2, sw2);
    }
    ctx.fill();

    // ── C. Rumble red ──────────────────────────────────────────────────────
    ctx.fillStyle = COLORS.RUMBLE_RED;
    ctx.beginPath();
    for (let i = this.projCount - 1; i >= 0; i--)
    {
      const { sx1, sy1, sw1, sx2, sy2, sw2, seg } = this.projPool[i];
      if (sy2 >= sy1 || seg.color.rumble !== COLORS.RUMBLE_RED || sw1 < 1) continue;
      const rw1 = sw1 * 0.09, rw2 = sw2 * 0.09;
      addTrap(sx1 - sw1, sy1, rw1, sx2 - sw2, sy2, rw2);
      addTrap(sx1 + sw1, sy1, rw1, sx2 + sw2, sy2, rw2);
    }
    ctx.fill();

    // ── D. Rumble white ────────────────────────────────────────────────────
    ctx.fillStyle = COLORS.RUMBLE_WHITE;
    ctx.beginPath();
    for (let i = this.projCount - 1; i >= 0; i--)
    {
      const { sx1, sy1, sw1, sx2, sy2, sw2, seg } = this.projPool[i];
      if (sy2 >= sy1 || seg.color.rumble !== COLORS.RUMBLE_WHITE || sw1 < 1) continue;
      const rw1 = sw1 * 0.09, rw2 = sw2 * 0.09;
      addTrap(sx1 - sw1, sy1, rw1, sx2 - sw2, sy2, rw2);
      addTrap(sx1 + sw1, sy1, rw1, sx2 + sw2, sy2, rw2);
    }
    ctx.fill();

    // ── E. Lane dashes ─────────────────────────────────────────────────────
    ctx.fillStyle = COLORS.LANE;
    ctx.beginPath();
    for (let i = this.projCount - 1; i >= 0; i--)
    {
      const { sx1, sy1, sw1, sx2, sy2, sw2, seg } = this.projPool[i];
      if (sy2 >= sy1 || !seg.color.lane || sw1 < 2) continue;
      const lw1 = sw1 * 0.06, lo1 = sw1 * 0.33;
      const lw2 = sw2 * 0.06, lo2 = sw2 * 0.33;
      addTrap(sx1 - lo1, sy1, lw1, sx2 - lo2, sy2, lw2);
      addTrap(sx1 + lo1, sy1, lw1, sx2 + lo2, sy2, lw2);
    }
    ctx.fill();

    // ── F. Edge track marks (white) ────────────────────────────────────────
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    for (let i = this.projCount - 1; i >= 0; i--)
    {
      const { sx1, sy1, sw1, sx2, sy2, sw2, seg } = this.projPool[i];
      if (sy2 >= sy1 || !seg.color.lane || sw1 < 4) continue;
      const etW1 = sw1 * 0.045, etO1 = sw1 * 0.915;
      const enW1 = sw1 * 0.020, enO1 = sw1 * 0.790;
      const etW2 = sw2 * 0.045, etO2 = sw2 * 0.915;
      const enW2 = sw2 * 0.020, enO2 = sw2 * 0.790;
      addTrap(sx1 - etO1, sy1, etW1, sx2 - etO2, sy2, etW2);
      addTrap(sx1 - enO1, sy1, enW1, sx2 - enO2, sy2, enW2);
      addTrap(sx1 + etO1, sy1, etW1, sx2 + etO2, sy2, etW2);
      addTrap(sx1 + enO1, sy1, enW1, sx2 + enO2, sy2, enW2);
    }
    ctx.fill();

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

        const sprH = worldH * si.scale! * sc1 * halfH;
        if (sprH < 4) continue;   // C8: raised from 2 — tiny sprites are invisible

        const sprW = sprH * (rect.w / rect.h) * (si.stretchX ?? 1);

        // Board sprites anchor from their road-facing inner edge.
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

      // ── Traffic vehicles at this segment depth ──────────────────────────
      if (trafficCars.length > 0)
      {
        const trafficSegIdx = seg.index;

        for (const car of trafficCars)
        {
          if (Math.floor(car.worldZ / SEGMENT_LENGTH) % segmentCount !== trafficSegIdx)
            continue;

          // Pick sheet + dimensions by vehicle type — O(1) map lookup, no allocation.
          const spec  = TRAFFIC_CAR_SPECS[car.type];
          const sheet = this.trafficCarSheets.get(car.type);
          if (!sheet?.isReady()) continue;

          const { frameW, frameH, worldH } = spec;
          const rect = { x: 0, y: 0, w: frameW, h: frameH };

          // Direct perspective projection from the car's actual world depth.
          let carRelZ = car.worldZ - cameraZ;
          if (carRelZ > totalLen / 2) carRelZ -= totalLen;
          if (carRelZ <= 0) continue;

          const scCar   = CAMERA_DEPTH / carRelZ;
          const syCar   = halfH + CAMERA_HEIGHT * scCar * halfH;
          const carScrX = sx1 + car.worldX * scCar * halfW;
          if (carScrX < -500 || carScrX > w + 500) continue;

          const sprH = worldH * scCar * halfH;
          if (sprH < 4) continue;

          const sprW  = sprH * (frameW / frameH);
          const drawW = Math.round(sprW);
          const drawH = Math.round(sprH);
          const drawX = Math.round(carScrX - sprW / 2);
          const drawY = Math.round(syCar - sprH);

          ctx.imageSmoothingEnabled = true;
          if (car.spinAngle !== 0)
          {
            ctx.save();
            ctx.translate(drawX + drawW / 2, drawY + drawH / 2);
            ctx.rotate(car.spinAngle);
            ctx.translate(-(drawX + drawW / 2), -(drawY + drawH / 2));
          }
          sheet.draw(ctx, rect, drawX, drawY, drawW, drawH);
          if (car.spinAngle !== 0) ctx.restore();
          ctx.imageSmoothingEnabled = false;
        }
      }
    }

    // Restore smoothing for the car sprite, which is continuously scaled
    // and benefits from bilinear filtering (L6).
    ctx.imageSmoothingEnabled = true;
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

  // ── HUD layout helper ─────────────────────────────────────────────────────

  /**
   * Computes all pixel positions and font strings for the HUD.
   * Called only when the canvas dimensions change — not every frame.
   * All values are derived from w and h so the HUD scales with the window.
   *
   * Layout is built upward from the bottom of the canvas:
   *   1. Speed bar — thin row, padY from the bottom.
   *   2. 7-segment digit row — immediately above the bar.
   *   3. "km/h" label — to the right of the digit block.
   *
   * @param w - Canvas width in pixels.
   * @param h - Canvas height in pixels.
   * @returns A HudLayout with every pre-computed value for renderHUD.
   */
  private computeHudLayout(w: number, h: number): HudLayout
  {
    const padX     = Math.round(w * 0.025);
    const padY     = Math.round(h * 0.028);

    // 7-segment digit sizing.
    // Height: 10% of canvas height so the digits are clearly legible.
    // Width:  65% of height — classic 7-segment displays are taller than wide.
    // Thickness: ~14% of height gives chunky, readable segments.
    // Gap between cells: small fixed proportion of width.
    const digitH   = Math.round(h * 0.075);              // −25% from previous 0.10
    const digitW   = Math.round(digitH * 0.55);          // slightly skinnier (was 0.65)
    const digitT   = Math.max(2, Math.round(digitH * 0.14));
    const digitGap = Math.max(2, Math.round(digitW * 0.14));

    // Speed bar — 30% skinnier segments than before (w*0.013 → w*0.0091).
    const barH      = Math.max(8, Math.round(h * 0.032));
    const barGap    = Math.max(4, Math.round(h * 0.010));
    const barSegGap = 2;
    const barSegW   = Math.max(6, Math.round(w * 0.0091));

    // Build positions upward from bottom edge
    const barBotY   = h - padY;
    const barY      = barBotY - barH;
    const digitBotY = barY - barGap;
    const digitY    = digitBotY - digitH;

    // "km/h" label: right of the 3-digit block, baseline at digit bottom
    const numBlockW = 3 * digitW + 2 * digitGap;
    const kphSize   = Math.max(10, Math.round(digitH * 0.38));
    const kphX      = padX + numBlockW + Math.max(3, Math.round(digitGap * 1.4));
    const kphY      = digitY + digitH;  // baseline aligned to bottom of digits

    return {
      padX, digitH, digitW, digitT, digitGap, digitY,
      kphX, kphY,
      kphFont: `bold ${kphSize}px Impact, 'Arial Black', sans-serif`,
      barX: padX, barY, barH,
      barSegW,
      barStride: barSegW + barSegGap,
    };
  }

  // ── HUD ───────────────────────────────────────────────────────────────────

  /**
   * Draws the OutRun-style HUD: 7-segment speed readout + single speed bar.
   *
   * Layout (bottom-left, transparent — no background panel):
   *   - Three fixed digit cells (hundreds / tens / ones), right-aligned.
   *     Leading zeros are left blank so "5" appears as "  5", not "005".
   *     Active segments are bright red; inactive segments are near-black.
   *   - "km/h" label in yellow, to the right of the digit block.
   *   - Single row of rectangular speed bar segments below the digits:
   *       cyan  (~60% of bar) → green (~35%) → pink cap (~5%).
   *     Only the segments up to current speed are lit; the rest are dark.
   *
   * Note: ctx.save/restore is NOT called here — the outer render() call
   * already wraps the entire frame in a single save/restore pair.
   *
   * @param w     - Canvas width in pixels.
   * @param h     - Canvas height in pixels.
   * @param speed - Current speed in world units per second.
   */
  private renderHUD(w: number, h: number, speed: number, raceTimer = 0, distanceKm = 0, btnQuit?: Button): void
  {
    const { ctx } = this;

    // Recompute layout only when canvas size has changed (resize events)
    if (w !== this.hudW || h !== this.hudH)
    {
      this.hudLayout = this.computeHudLayout(w, h);
      this.hudW = w;
      this.hudH = h;
    }
    const L = this.hudLayout!;

    // Display actual speed directly — physics integration is already smooth
    // enough that no smoothing filter is needed, and a filter causes the
    // readout to lag at 0 after returning from off-road.
    const kmh      = Math.min(999, Math.max(0, Math.round(speed * (DISPLAY_MAX_KMH / PLAYER_MAX_SPEED))));
    const hundreds = Math.floor(kmh / 100);
    const tens     = Math.floor((kmh % 100) / 10);
    const ones     = kmh % 10;

    // ── 7-segment digit row ────────────────────────────────────────────────
    //
    // Three fixed cells, always in the same screen positions so the HUD
    // never shifts as the number of significant digits changes.
    // Leading-zero cells are left completely blank.
    //
    // Drop shadow technique (same as the original arcade):
    //   Pass 1 — draw the same segments in solid black, offset 3px right
    //            and 3px down.  This sits behind the coloured segments.
    //   Pass 2 — draw the segments in bright red at the true position.
    // The black layer makes the digits readable on any background colour.

    const ON  = '#FF2200';   // lit segment colour
    const SHD = '#000000';   // drop-shadow colour
    const OFF = '';          // unlit segments are invisible

    const showHundreds = hundreds > 0;
    const showTens     = showHundreds || tens > 0;

    const so = 3;   // shadow offset in pixels (right and down)

    // Pass 1 — black shadow, offset
    if (showHundreds)
      drawSegDigit(ctx, hundreds, L.padX + so,                              L.digitY + so, L.digitW, L.digitH, L.digitT, SHD, OFF);
    if (showTens)
      drawSegDigit(ctx, tens,     L.padX + (L.digitW + L.digitGap) + so,   L.digitY + so, L.digitW, L.digitH, L.digitT, SHD, OFF);
    drawSegDigit(ctx, ones,       L.padX + 2*(L.digitW + L.digitGap) + so, L.digitY + so, L.digitW, L.digitH, L.digitT, SHD, OFF);

    // Pass 2 — red digits, true position
    if (showHundreds)
      drawSegDigit(ctx, hundreds, L.padX,                            L.digitY, L.digitW, L.digitH, L.digitT, ON, OFF);
    if (showTens)
      drawSegDigit(ctx, tens,     L.padX + (L.digitW + L.digitGap), L.digitY, L.digitW, L.digitH, L.digitT, ON, OFF);
    drawSegDigit(ctx, ones,       L.padX + 2*(L.digitW + L.digitGap), L.digitY, L.digitW, L.digitH, L.digitT, ON, OFF);

    // ── "km/h" label ──────────────────────────────────────────────────────
    //
    // Same two-pass drop shadow as the digits: black at +so offset first,
    // then yellow on top.

    ctx.font         = L.kphFont;
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle    = '#000000';
    ctx.fillText('km/h', L.kphX + so, L.kphY + so);
    ctx.fillStyle    = '#FFD700';
    ctx.fillText('km/h', L.kphX, L.kphY);

    // ── Single-row speed bar ───────────────────────────────────────────────
    //
    // BAR_SEGS rectangles in a single horizontal row, filled left-to-right
    // up to the current speed percentage.
    // Colour only changes at the two zone boundaries, so we track the last
    // colour used and skip the fillStyle call when it hasn't changed.
    //
    //   [0 … BAR_CYAN_END)  — cyan  (cruising)
    //   [BAR_CYAN_END … BAR_GREEN_END) — green (pushing)
    //   [BAR_GREEN_END … BAR_SEGS)    — pink  (redline cap)
    //   unlit segments — #111111 (near-black background)

    const filled   = Math.round((speed / PLAYER_MAX_SPEED) * BAR_SEGS);
    let lastColor  = '';

    for (let i = 0; i < BAR_SEGS; i++)
    {
      let color: string;
      if (i >= filled)           color = BAR_COLOR_UNLIT;
      else if (i === BAR_LAST)   color = BAR_COLOR_PINK;
      else if (i < BAR_BLUE_END) color = BAR_COLOR_BLUE;
      else                       color = BAR_COLOR_GREEN;

      // Only update fillStyle when the colour actually changes — avoids
      // redundant canvas state writes on the long run of same-colour segments.
      if (color !== lastColor)
      {
        ctx.fillStyle = color;
        lastColor     = color;
      }

      ctx.fillRect(L.barX + i * L.barStride, L.barY, L.barSegW, L.barH);
    }

    // ── Timer + distance (shown when race has started) ──────────────────────
    if (raceTimer > 0 || distanceKm > 0)
    {
      const mins    = Math.floor(raceTimer / 60);
      const secs    = (raceTimer % 60).toFixed(1).padStart(4, '0');
      const tStr    = `${mins}:${secs}`;
      const dStr    = `${distanceKm.toFixed(2)} km`;

      const fs      = Math.max(12, Math.round(h * 0.036));
      const padR    = Math.round(w * 0.015);
      const lineH   = fs + 4;
      const ty      = Math.round(h * 0.04);

      // Semi-transparent backing pill
      const tw = Math.round(fs * 4.8);
      ctx.fillStyle = 'rgba(0,0,0,0.50)';
      ctx.fillRect(w - tw - padR - 4, ty - fs, tw + 8, lineH * 2 + 8);

      ctx.font      = `bold ${fs}px Impact, monospace`;
      ctx.textAlign = 'right';
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText(tStr, w - padR, ty);
      ctx.font      = `${Math.round(fs * 0.85)}px monospace`;
      ctx.fillStyle = '#AADDFF';
      ctx.fillText(dStr, w - padR, ty + lineH);

      // ── Quit button — fixed top-LEFT corner (timer owns top-right) ───────
      // Hit rect: (0, 0) → (QUIT_BTN_W, QUIT_BTN_H) — see isOverQuitButton().
      const qfs  = Math.max(11, Math.round(h * 0.028));
      const qpad = Math.round(h * 0.012);
      const qStr = '✕  QUIT';
      ctx.font      = `bold ${qfs}px Impact, sans-serif`;
      ctx.textAlign = 'left';
      const qtw = ctx.measureText(qStr).width;
      const qbw = qtw + qpad * 2 + 4;
      const qbh = qfs + qpad * 2;
      btnQuit?.setRect(8, 8, qbw, qbh, 0);
      ctx.fillStyle = btnQuit?.hovered ? 'rgba(220,0,0,0.92)' : 'rgba(140,0,0,0.82)';
      ctx.fillRect(8, 8, qbw, qbh);
      ctx.strokeStyle = '#FF4400';
      ctx.lineWidth   = 1.5;
      ctx.strokeRect(8, 8, qbw, qbh);
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText(qStr, 8 + qpad + 2, 8 + qpad + qfs * 0.82);
    }
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
    segments:      readonly RoadSegment[],
    segmentCount:  number,
    playerZ:       number,
    playerX:       number,
    drawDistance:  number,
    w:             number,
    h:             number,
    speed:         number,
    steerAngle:    number,
    horizonOffset: number = 0,
    trafficCars:   readonly TrafficCar[] = [],
    raceTimer:     number = 0,
    distanceKm:    number = 0,
    btnQuit?:      Button,
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
    this.renderHUD(w, h, speed, raceTimer, distanceKm, btnQuit);
    ctx.restore();
  }

  // ── Preloader screen ───────────────────────────────────────────────────────

  renderPreloader(w: number, h: number, progress: number, error?: string): void
  {
    const { ctx } = this;
    ctx.save();
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h / 2;

    if (error)
    {
      ctx.fillStyle = '#FF2200';
      ctx.font      = 'bold 18px Impact, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('FAILED TO LOAD ASSETS', cx, cy - 20);
      ctx.fillStyle = '#FFFFFF';
      ctx.font      = '14px monospace';
      ctx.fillText(error, cx, cy + 10);
    }
    else
    {
      ctx.fillStyle = '#FFFFFF';
      ctx.font      = 'bold 28px Impact, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('LOADING…', cx, cy - 40);

      // Progress bar
      const bw = Math.min(600, w * 0.7);
      const bh = 20;
      const bx = cx - bw / 2;
      const by = cy - 10;
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth   = 2;
      ctx.strokeRect(bx, by, bw, bh);
      ctx.fillStyle = '#FF6600';
      ctx.fillRect(bx + 2, by + 2, Math.round((bw - 4) * Math.min(1, progress)), bh - 4);
    }

    ctx.restore();
  }

  // ── Intro / menu screen ────────────────────────────────────────────────────

  renderIntro(
    w: number, h: number,
    selectedItem:  'start' | 'mode' | 'settings',
    selectedMode:  string,
    soundEnabled:  boolean,
    subMenu:       'mode' | 'settings' | null,
    pulse:         boolean,
    heroImage:     HTMLImageElement | null = null,
    btns?: {
      mode: Button; settings: Button; start: Button;          // main menu
      easy: Button; medium: Button; hard: Button;             // mode submenu
      close: Button; sound: Button; github: Button;           // settings panel
    },
  ): void
  {
    const { ctx } = this;
    ctx.save();

    // ── Background ──────────────────────────────────────────────────────────
    if (heroImage && heroImage.complete && heroImage.naturalWidth > 0)
    {
      const iw = heroImage.naturalWidth;
      const ih = heroImage.naturalHeight;
      // Contain: fit the entire image inside the canvas, letterbox with black
      const scale = Math.min(w / iw, h / ih);
      const dw    = Math.round(iw * scale);
      const dh    = Math.round(ih * scale);
      const dx    = Math.round((w - dw) / 2);   // center horizontally
      const dy    = Math.round((h - dh) / 2);   // center vertically
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(heroImage, dx, dy, dw, dh);
    }
    else
    {
      // Fallback: sky gradient
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0,    '#0066AA');
      grad.addColorStop(0.6,  '#72D7EE');
      grad.addColorStop(1,    '#C8EEFF');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      // Road strip at bottom
      ctx.fillStyle = '#888888';
      ctx.fillRect(0, h * 0.70, w, h * 0.30);
      ctx.fillStyle = '#CC0000';
      ctx.fillRect(0, h * 0.70, w, 6);

      // Title (only when no hero image)
      const titleGrad = ctx.createLinearGradient(0, h * 0.06, 0, h * 0.22);
      titleGrad.addColorStop(0, '#FFE000');
      titleGrad.addColorStop(1, '#FF6600');
      ctx.font      = `bold ${Math.round(h * 0.16)}px Impact, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = '#000000';
      ctx.fillText('OUT RUN', w / 2 + 5, h * 0.22 + 5);
      ctx.fillStyle = titleGrad;
      ctx.fillText('OUT RUN', w / 2, h * 0.22);
    }

    // ── Hero image bounds — all menus are constrained to this region ─────────
    let imgX = 0, imgW = w;
    if (heroImage && heroImage.complete && heroImage.naturalWidth > 0)
    {
      const scale = Math.min(w / heroImage.naturalWidth, h / heroImage.naturalHeight);
      imgW = Math.round(heroImage.naturalWidth  * scale);
      imgX = Math.round((w - imgW) / 2);
    }

    // ── Sub-menus ────────────────────────────────────────────────────────────
    if (subMenu === 'mode')
    {
      this.drawModeMenu(w, h, imgX, imgW, selectedMode, btns);
    }
    else if (subMenu === 'settings')
    {
      this.drawSettingsPanel(w, h, soundEnabled, btns);
    }
    else
    {
      // ── Main menu — all three buttons share one horizontal row ────────────
      // START RACE stays centered; GAME MODE sits left, SETTINGS sits right.
      const startFs = Math.round(imgW * 0.060);
      const sideFs  = Math.round(imgW * 0.045);
      const baseY   = Math.round(h * 0.978);   // shared baseline — START RACE anchor

      ctx.lineJoin = 'round';

      // ── Pre-measure all three labels so we can size the background rect ──
      ctx.font = `bold ${startFs}px Impact, sans-serif`;
      const smStart = ctx.measureText('START RACE');
      const sAsc    = smStart.actualBoundingBoxAscent  ?? startFs * 0.78;
      const sDesc   = smStart.actualBoundingBoxDescent ?? startFs * 0.14;

      ctx.font = `bold ${sideFs}px Impact, sans-serif`;
      const smMode = ctx.measureText('GAME MODE');
      const smSet  = ctx.measureText('SETTINGS');

      // Side buttons are vertically centred with START RACE by aligning ascenders
      const sideAsc  = smMode.actualBoundingBoxAscent ?? sideFs * 0.78;
      const sideDesc = smMode.actualBoundingBoxDescent ?? sideFs * 0.14;
      // Offset side baselines so their cap-height lines up with START RACE cap-height
      const sideY    = baseY - sAsc + sideAsc;

      // Centre X positions — all relative to hero image bounds
      const startCx = Math.round(imgX + imgW * 0.50);
      const modeCx  = Math.round(imgX + imgW * 0.22);
      const setCx   = Math.round(imgX + imgW * 0.78);

      // ── Black semi-transparent bar behind all three buttons ───────────────
      const padV = Math.round(h * 0.022);
      const rectTop = baseY - sAsc - padV;
      const rectBot = baseY + sDesc + padV;
      ctx.fillStyle = 'rgba(0,0,0,0.20)';
      ctx.fillRect(imgX, rectTop, imgW, rectBot - rectTop);

      // ── Helper: draw a centred label with outline + optional glow ─────────
      const drawLabel = (
        label: string, cx: number, by: number,
        fontSize: number, color: string, btn?: Button,
      ): void =>
      {
        ctx.font = `bold ${fontSize}px Impact, sans-serif`;
        const m    = ctx.measureText(label);
        const lx   = Math.round(cx - m.width / 2);
        const asc  = m.actualBoundingBoxAscent  ?? fontSize * 0.78;
        const desc = m.actualBoundingBoxDescent ?? fontSize * 0.14;
        btn?.setRect(lx, by - asc, m.width, asc + desc);

        ctx.shadowColor = btn?.hovered ? 'rgba(255,160,0,0.9)' : 'transparent';
        ctx.shadowBlur  = btn?.hovered ? Math.round(fontSize * 0.65) : 0;

        ctx.textAlign   = 'left';
        ctx.lineWidth   = Math.round(fontSize * 0.18);
        ctx.strokeStyle = 'rgba(0,0,0,0.95)';
        ctx.strokeText(label, lx, by);
        ctx.fillStyle   = color;
        ctx.fillText(label, lx, by);

        ctx.shadowBlur  = 0;
        ctx.shadowColor = 'transparent';
      };

      drawLabel('GAME MODE',  modeCx,  sideY,  sideFs,  '#FFFFFF', btns?.mode);
      drawLabel('START RACE', startCx, baseY,  startFs, '#00EE44', btns?.start);
      drawLabel('SETTINGS',   setCx,   sideY,  sideFs,  '#FFFFFF', btns?.settings);
    }

    ctx.restore();
  }

  private drawModeMenu(w: number, h: number, imgX: number, imgW: number, selectedMode: string, btns?: { easy: Button; medium: Button; hard: Button }): void
  {
    const { ctx } = this;

    const MODES = [
      { key: 'easy',   label: 'EASY',   accent: '#00DD44', stars: 1,
        desc: 'Few cars  ·  gentle curves  ·  relaxed pace'      },
      { key: 'medium', label: 'MEDIUM', accent: '#FFB800', stars: 2,
        desc: 'Classic OutRun experience'                         },
      { key: 'hard',   label: 'HARD',   accent: '#FF2200', stars: 3,
        desc: 'Dense traffic  ·  sharp turns  ·  max speed'      },
    ];

    // ── Layout: three equal full-width bands, vertically centred ─────────────
    // MUST match modeCardAt() in game.ts exactly.
    const bandH   = Math.round(h * 0.18);
    const totalH  = bandH * 3;
    const bandTop = Math.round((h - totalH) / 2);

    // Dark scrim over entire canvas — hero image dims to silhouette
    ctx.fillStyle = 'rgba(0,0,0,0.80)';
    ctx.fillRect(0, 0, w, h);

    // Thin title above bands — centred within hero image
    ctx.font      = `bold ${Math.round(h * 0.040)}px Impact, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText('SELECT DIFFICULTY', imgX + imgW / 2, bandTop - Math.round(h * 0.04));

    MODES.forEach(({ key, label, accent, stars, desc }, i) =>
    {
      const btn = btns?.[key as 'easy' | 'medium' | 'hard'];
      const sel = selectedMode === key;
      const by  = bandTop + i * bandH;
      const mid = by + bandH / 2;

      // Hit area constrained to hero image width
      btn?.setRect(imgX, by, imgW, bandH, 0);

      // Band background — highlight on hover
      ctx.fillStyle = btn?.hovered ? 'rgba(255,255,255,0.12)' : sel ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0)';
      ctx.fillRect(imgX, by, imgW, bandH);

      // Left chevron stripe (selected only)
      if (sel)
      {
        ctx.fillStyle = accent;
        ctx.fillRect(imgX, by, 8, bandH);
      }

      // Separator line between bands — constrained to hero image width
      if (i > 0)
      {
        ctx.strokeStyle = 'rgba(255,255,255,0.10)';
        ctx.lineWidth   = 1;
        ctx.beginPath();
        ctx.moveTo(imgX, by);
        ctx.lineTo(imgX + imgW, by);
        ctx.stroke();
      }

      // Mode label — left-aligned within hero image
      const labelX  = Math.round(imgX + imgW * 0.08);
      const fontSize = Math.round(h * 0.090);
      ctx.font      = `bold ${fontSize}px Impact, sans-serif`;
      ctx.textAlign = 'left';
      ctx.fillStyle = sel ? accent : '#444444';
      ctx.fillText(label, labelX, mid + fontSize * 0.35);

      // Description — right of label, dimmed
      if (sel)
      {
        ctx.font      = `${Math.round(h * 0.026)}px monospace`;
        ctx.fillStyle = 'rgba(255,255,255,0.88)';
        ctx.textAlign = 'left';
        ctx.fillText(desc, labelX + Math.round(imgW * 0.28), mid + fontSize * 0.35);
      }
    });

    // Nav hint below bands — centred within hero image
    ctx.font      = `${Math.round(h * 0.024)}px monospace`;
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.textAlign = 'center';
    ctx.fillText(
      '↑ ↓ or hover  ·  ENTER or click to confirm  ·  ESC to cancel',
      imgX + imgW / 2,
      bandTop + totalH + Math.round(h * 0.05),
    );
  }

  private drawSettingsPanel(w: number, h: number, soundEnabled: boolean, btns?: { close: Button; sound: Button; github: Button }): void
  {
    const { ctx } = this;

    // ── Panel geometry ────────────────────────────────────────────────────
    const px = Math.round(w * 0.18);
    const py = Math.round(h * 0.16);
    const pw = Math.round(w * 0.64);
    const ph = Math.round(h * 0.62);
    const pad = Math.round(pw * 0.06);

    // Background + border
    ctx.fillStyle = 'rgba(0,0,8,0.88)';
    ctx.fillRect(px, py, pw, ph);
    ctx.strokeStyle = '#FF6600';
    ctx.lineWidth   = 3;
    ctx.strokeRect(px, py, pw, ph);
    // Inner highlight line
    ctx.strokeStyle = 'rgba(255,102,0,0.20)';
    ctx.lineWidth   = 1;
    ctx.strokeRect(px + 4, py + 4, pw - 8, ph - 8);

    // ── Title bar ─────────────────────────────────────────────────────────
    const titleH = Math.round(h * 0.072);
    ctx.fillStyle = '#FF6600';
    ctx.fillRect(px, py, pw, titleH);

    const titleFs = Math.round(h * 0.048);
    ctx.font      = `bold ${titleFs}px Impact, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#000000';
    ctx.fillText('OPTIONS', px + pw / 2 + 2, py + titleH * 0.72 + 2);
    ctx.fillStyle = '#FFE000';
    ctx.fillText('OPTIONS', px + pw / 2, py + titleH * 0.72);

    // ── Close button — top-right of title bar ─────────────────────────────
    const closeSize = Math.round(titleH * 0.72);
    const closeX    = px + pw - closeSize - Math.round(titleH * 0.18);
    const closeY    = py + Math.round(titleH * 0.14);
    btns?.close.setRect(closeX, closeY, closeSize, closeSize, 0);
    ctx.fillStyle   = btns?.close.hovered ? 'rgba(0,0,0,0.55)' : 'rgba(255,80,0,0.55)';
    ctx.fillRect(closeX, closeY, closeSize, closeSize);
    ctx.font        = `bold ${Math.round(closeSize * 0.75)}px Impact, sans-serif`;
    ctx.textAlign   = 'center';
    ctx.fillStyle   = '#FFFFFF';
    ctx.fillText('✕', closeX + closeSize / 2, closeY + closeSize * 0.78);

    // ── Section: SOUND toggle — top margin matches left/right pad ─────────
    const rowY   = py + titleH + pad;
    const labelFs = Math.round(h * 0.040);

    ctx.font      = `bold ${labelFs}px Impact, sans-serif`;
    ctx.textAlign = 'left';
    ctx.fillStyle = '#CCCCCC';
    ctx.fillText('SOUND', px + pad, rowY);

    // Toggle pill  ◀ ON ▶  /  ◀ OFF ▶
    const pillFs = Math.round(h * 0.032);
    const pillTxt = soundEnabled ? '◀  ON  ▶' : '◀  OFF  ▶';
    ctx.font      = `bold ${pillFs}px Impact, monospace`;
    const pillW   = ctx.measureText(pillTxt).width + 24;
    const pillH   = pillFs + 14;
    const pillX   = px + pw - pad - pillW;
    const pillY   = rowY - labelFs * 0.82;
    btns?.sound.setRect(pillX, pillY, pillW, pillH, 0);
    ctx.fillStyle = soundEnabled ? '#003322' : '#220000';
    ctx.fillRect(pillX, pillY, pillW, pillH);
    ctx.strokeStyle = soundEnabled ? '#00CC66' : '#882200';
    ctx.lineWidth   = 2;
    ctx.strokeRect(pillX, pillY, pillW, pillH);
    ctx.fillStyle = soundEnabled ? '#00FF88' : '#FF4400';
    ctx.textAlign = 'center';
    ctx.fillText(pillTxt, pillX + pillW / 2, pillY + pillFs * 0.88 + 7);

    // Divider
    const divY = rowY + Math.round(h * 0.034);
    ctx.strokeStyle = 'rgba(255,102,0,0.30)';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(px + pad, divY);
    ctx.lineTo(px + pw - pad, divY);
    ctx.stroke();

    // ── Section: ABOUT ────────────────────────────────────────────────────
    const aboutY  = divY + Math.round(h * 0.038);
    const aboutFs = Math.round(h * 0.028);
    const lineGap = Math.round(aboutFs * 1.55);

    ctx.font      = `bold ${aboutFs}px monospace`;
    ctx.textAlign = 'left';
    ctx.fillStyle = '#FF6600';
    ctx.fillText('ABOUT', px + pad, aboutY);

    const aboutLines = [
      { text: 'Built in TypeScript + HTML5 Canvas.', link: false },
      { text: 'No game engines. Pure pseudo-3D.',    link: false },
      { text: '⇒  github.com/gfreedman/outrun',      link: true  },
    ];
    ctx.font = `${aboutFs}px monospace`;
    aboutLines.forEach(({ text, link }, i) =>
    {
      const ty = aboutY + lineGap + i * lineGap;
      const asc = aboutFs * 0.78;
      if (link)
      {
        const tw = ctx.measureText(text).width;
        btns?.github.setRect(px + pad, ty - asc, tw, asc + aboutFs * 0.14);
        ctx.fillStyle = btns?.github.hovered ? '#99DDFF' : '#66BBFF';
        ctx.fillText(text, px + pad, ty);
        ctx.fillRect(px + pad, ty + 3, tw, 1);
      }
      else
      {
        ctx.fillStyle = '#888899';
        ctx.fillText(text, px + pad, ty);
      }
    });

    // ── Footer hint ───────────────────────────────────────────────────────
    ctx.font      = `${Math.round(h * 0.022)}px monospace`;
    ctx.fillStyle = 'rgba(255,255,255,0.20)';
    ctx.textAlign = 'center';
    ctx.fillText('ENTER / CLICK to toggle sound  ·  ESC to close', px + pw / 2, py + ph - 14);
  }

  // ── Countdown overlay ──────────────────────────────────────────────────────

  renderCountdown(w: number, h: number, value: number | 'GO!'): void
  {
    const { ctx } = this;
    const text = value === 'GO!' ? 'GO!' : String(value);
    const size = Math.round(h * 0.22);

    ctx.save();
    ctx.font      = `bold ${size}px Impact, sans-serif`;
    ctx.textAlign = 'center';

    // Thick black outline
    ctx.lineWidth   = size * 0.08;
    ctx.strokeStyle = '#000000';
    ctx.lineJoin    = 'round';
    ctx.strokeText(text, w / 2, h * 0.52);

    // Bright fill
    ctx.fillStyle = value === 'GO!' ? '#00FF88' : '#FFFFFF';
    ctx.fillText(text, w / 2, h * 0.52);

    ctx.restore();
  }

  // ── Finish overlay ─────────────────────────────────────────────────────────

  renderFinish(w: number, h: number, elapsedSec: number, distanceKm: number): void
  {
    const { ctx } = this;
    ctx.save();

    // Dim the road behind the panel
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(0, 0, w, h);

    const pw = Math.min(500, w * 0.7);
    const ph = 210;
    const px = (w - pw) / 2;
    const py = (h - ph) / 2;

    ctx.fillStyle = 'rgba(0,0,40,0.92)';
    ctx.fillRect(px, py, pw, ph);
    ctx.strokeStyle = '#FF6600';
    ctx.lineWidth   = 3;
    ctx.strokeRect(px, py, pw, ph);

    const mins = Math.floor(elapsedSec / 60);
    const secs = (elapsedSec % 60).toFixed(1).padStart(4, '0');
    const timeStr = `${mins}:${secs}`;
    const distStr = `${distanceKm.toFixed(2)} km`;

    const lines = [
      { text: 'RACE COMPLETE',    size: 0.060, color: '#FFE000', bold: true  },
      { text: `Time:  ${timeStr}`, size: 0.042, color: '#FFFFFF', bold: false },
      { text: `Dist:  ${distStr}`, size: 0.042, color: '#FFFFFF', bold: false },
    ];

    lines.forEach(({ text, size, color, bold }, i) =>
    {
      ctx.font      = `${bold ? 'bold ' : ''}${Math.round(h * size)}px Impact, monospace`;
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.fillText(text, w / 2, py + 52 + i * 52);
    });

    // Button hints
    const btnY = py + ph - 20;
    ctx.font      = `${Math.round(h * 0.034)}px monospace`;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#FFE000';
    ctx.fillText('ENTER = Play Again', w / 2 - pw / 5, btnY);
    ctx.fillStyle = '#AAAAFF';
    ctx.fillText('ESC = Menu', w / 2 + pw / 5, btnY);

    ctx.restore();
  }

  // ── Procedural gate drawing ────────────────────────────────────────────────

  /**
   * Draws a start or finish gate spanning the road, centred at (x, y).
   * Both gates use vertical posts + horizontal beam.
   * Start = red/white alternating vertical stripes.
   * Finish = black/white checkerboard.
   */
  private drawGate(isFinish: boolean, x: number, y: number, gw: number, gh: number): void
  {
    const { ctx } = this;
    const postW   = Math.max(4, Math.round(gw * 0.04));
    const beamH   = Math.max(4, Math.round(gh * 0.12));
    const postH   = gh - beamH;

    // Posts
    ctx.fillStyle = '#CCCCCC';
    ctx.fillRect(x,                    y + beamH, postW, postH);
    ctx.fillRect(x + gw - postW,       y + beamH, postW, postH);

    // Horizontal beam with alternating stripes
    const stripeCount = Math.max(4, Math.round(gw / beamH));
    const stripeW     = gw / stripeCount;
    for (let i = 0; i < stripeCount; i++)
    {
      const even = i % 2 === 0;
      ctx.fillStyle = isFinish
        ? (even ? '#FFFFFF' : '#222222')
        : (even ? '#DD0000' : '#FFFFFF');
      ctx.fillRect(Math.round(x + i * stripeW), y, Math.ceil(stripeW), beamH);
    }
    ctx.strokeStyle = '#333333';
    ctx.lineWidth   = 1;
    ctx.strokeRect(x, y, gw, beamH);

    // Banner text
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
