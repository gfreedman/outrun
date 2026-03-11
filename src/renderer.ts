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

import { RoadSegment } from './types';
import
{
  CAMERA_HEIGHT, CAMERA_DEPTH, ROAD_WIDTH,
  SEGMENT_LENGTH, COLORS,
  PLAYER_MAX_SPEED,
  PARALLAX_SKY,
} from './constants';
import
{
  SpriteLoader, SpriteId,
  carFrameRect, CAR_SPRITE_FRAME_W, CAR_SPRITE_FRAME_H, CAR_SPRITE_CENTER,
  CAR_PIVOT_OFFSETS,
  SPRITE_RECTS, SPRITE_WORLD_HEIGHT,
} from './sprites';

// ── Module-level constants ─────────────────────────────────────────────────────

/**
 * Fixed alpha (opacity) for each of the three tachometer bar rows.
 * Declared outside the class so this array is created exactly ONCE,
 * not on every frame inside renderHUD().
 * Row 0 = top row (most prominent), row 2 = bottom row (most faded).
 */
const HUD_ROW_ALPHA = [1.0, 0.82, 0.65] as const;

/** Number of LED segments in each tachometer row. */
const HUD_NUM_SEGS = 20;

/**
 * Tachometer colour zone boundary indices (first segment of each new zone).
 * Zone 0 = red:    i ∈ [0, HUD_ZONE_SPLIT[0])
 * Zone 1 = orange: i ∈ [HUD_ZONE_SPLIT[0], HUD_ZONE_SPLIT[1])
 * Zone 2 = green:  i ∈ [HUD_ZONE_SPLIT[1], HUD_NUM_SEGS)
 *
 * Pre-computed at module load so the tach loop does zero arithmetic to find them.
 */
const HUD_ZONE_SPLIT  = [Math.round(HUD_NUM_SEGS * 0.33), Math.round(HUD_NUM_SEGS * 0.66)] as const;
const HUD_ZONE_S      = [0, HUD_ZONE_SPLIT[0], HUD_ZONE_SPLIT[1]]    as const;
const HUD_ZONE_E      = [HUD_ZONE_SPLIT[0], HUD_ZONE_SPLIT[1], HUD_NUM_SEGS] as const;
const HUD_COLOR_LIT   = ['#CC0000', '#FF6600', '#00BB00'] as const;
const HUD_COLOR_UNLIT = ['#280000', '#281200', '#002800'] as const;

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
 * Avoids recalculating ~20 values every single frame.
 */
interface HudLayout
{
  padX: number;
  segW: number; segH: number; segGap: number;
  /** segW + segGap, pre-added so the tachometer loop avoids repeated addition. */
  segStride: number;
  /** 1 / (HUD_NUM_SEGS - 1), pre-divided for the colour-zone ratio each segment. */
  tInv: number;
  barW: number;
  row3Bot: number; row2Bot: number; row1Bot: number;
  numSize: number; lblSize: number;
  lblBot: number; numBot: number; panelTop: number;
  /** Full CSS font string for the large speed number — e.g. "bold 74px Impact, ...". */
  fontNum: string;
  /** Full CSS font string for the "km/h" label. */
  fontLbl: string;
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

// ── Renderer ──────────────────────────────────────────────────────────────────

export class Renderer
{
  private ctx:         CanvasRenderingContext2D;
  private carSprites:  SpriteLoader | null;
  private roadSprites: SpriteLoader | null;

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
   * Pre-rendered offscreen grain texture for the HUD panel.
   * Built once on first render and again on resize — then composited each
   * frame with a single drawImage instead of ~70 individual fillRect calls.
   */
  private grainCanvas: OffscreenCanvas | null = null;

  /** Smoothed speed value for the HUD display — prevents digit jitter. */
  private displaySpeed = 0;

  /**
   * Accumulated horizontal sky-layer offset for curve parallax.
   * Clamped modulo a large period to prevent unbounded growth over long sessions.
   */
  private skyOffset = 0;

  /**
   * Creates a Renderer attached to the given canvas and pre-allocates all
   * per-frame reusable buffers so the render loop makes zero heap allocations.
   *
   * @param canvas      - The HTML canvas element to draw into.
   * @param carSprites  - Loader for the car sprite sheet.
   * @param roadSprites - Loader for the roadside sprite sheet.
   */
  constructor(
    canvas: HTMLCanvasElement,
    carSprites:  SpriteLoader | null = null,
    roadSprites: SpriteLoader | null = null,
  )
  {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get 2D context');
    this.ctx         = ctx;
    this.carSprites  = carSprites;
    this.roadSprites = roadSprites;

    // Pre-allocate the projection pool once.  Every field is set to a dummy
    // value here; they are overwritten before use each frame.
    this.projPool = Array.from({ length: 300 }, () => (
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
   * The gradient is cached: it is only rebuilt when horizonY changes, which
   * happens only on window resize or during off-road jitter.  At steady state
   * the same CanvasGradient object is reused every frame.
   *
   * @param w        - Canvas width in pixels.
   * @param horizonY - Screen Y of the horizon line (sky fills 0…horizonY).
   */
  private renderSky(w: number, horizonY: number): void
  {
    const { ctx } = this;

    // Only recreate the gradient if the horizon position has changed.
    if (horizonY !== this.skyGradientH)
    {
      const grad = ctx.createLinearGradient(0, 0, 0, horizonY);
      grad.addColorStop(0,    COLORS.SKY_TOP);
      grad.addColorStop(0.55, COLORS.SKY_MID);
      grad.addColorStop(1,    COLORS.SKY_HORIZON);
      this.skyGradient  = grad;
      this.skyGradientH = horizonY;
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
    segments:     RoadSegment[],
    segmentCount: number,
    playerZ:      number,
    playerX:      number,
    speed:        number,
    drawDistance: number,
    w:            number,
    h:            number,
    horizonY:     number,
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
    ctx.fillStyle = COLORS.GRASS_LIGHT;
    ctx.fillRect(0, halfH, w, halfH);

    const startIndex  = Math.floor(playerZ / SEGMENT_LENGTH) % segmentCount;
    const baseSegment = segments[startIndex];
    const basePercent = (playerZ % SEGMENT_LENGTH) / SEGMENT_LENGTH;

    // Accumulate sky parallax; clamp modulo a large period to prevent
    // the value growing unbounded over a long play session.
    const speedPercent = speed / PLAYER_MAX_SPEED;
    this.skyOffset     = (this.skyOffset + PARALLAX_SKY * baseSegment.curve * speedPercent) % 10000;

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
        ctx.fillStyle = COLORS.GRASS_LIGHT;
        ctx.fillRect(0, halfH, w, far.sy2 - halfH);
        drawTrapezoid(ctx, far.sx2, halfH, 0, far.sx2, far.sy2, far.sw2, COLORS.ROAD_LIGHT);
      }
    }

    // ── Pass 2: render back-to-front (painter's algorithm) ────────────────

    for (let i = this.projCount - 1; i >= 0; i--)
    {
      const p                                    = this.projPool[i];
      const { seg, sc1, sx1, sy1, sw1, sx2, sy2, sw2 } = p;

      if (sy2 >= sy1) continue;   // degenerate segment — skip

      const { color } = seg;

      // Full-width grass band behind this segment strip
      ctx.fillStyle = color.grass;
      ctx.fillRect(0, sy2, w, sy1 - sy2);

      // Asphalt road surface
      drawTrapezoid(ctx, sx1, sy1, sw1, sx2, sy2, sw2, color.road);

      // Lane markings — only drawn on alternating "dash" segments
      if (color.lane)
      {
        const lw1 = sw1 * 0.06, lo1 = sw1 * 0.33;
        const lw2 = sw2 * 0.06, lo2 = sw2 * 0.33;
        drawTrapezoid(ctx, sx1 - lo1, sy1, lw1, sx2 - lo2, sy2, lw2, color.lane);
        drawTrapezoid(ctx, sx1 + lo1, sy1, lw1, sx2 + lo2, sy2, lw2, color.lane);

        const etW1 = sw1 * 0.045, etO1 = sw1 * 0.915;
        const enW1 = sw1 * 0.020, enO1 = sw1 * 0.790;
        const etW2 = sw2 * 0.045, etO2 = sw2 * 0.915;
        const enW2 = sw2 * 0.020, enO2 = sw2 * 0.790;
        drawTrapezoid(ctx, sx1 - etO1, sy1, etW1, sx2 - etO2, sy2, etW2, '#FFFFFF');
        drawTrapezoid(ctx, sx1 - enO1, sy1, enW1, sx2 - enO2, sy2, enW2, '#FFFFFF');
        drawTrapezoid(ctx, sx1 + etO1, sy1, etW1, sx2 + etO2, sy2, etW2, '#FFFFFF');
        drawTrapezoid(ctx, sx1 + enO1, sy1, enW1, sx2 + enO2, sy2, enW2, '#FFFFFF');
      }

      // Roadside sprites — scaled by the perspective factor stored in sc1.
      // Using p.sc1 directly avoids the division sw1 / (ROAD_WIDTH * halfW)
      // that would otherwise re-derive the same value.
      if (seg.sprites && this.roadSprites?.isReady() && sy1 >= halfH)
      {
        for (const si of seg.sprites)
        {
          const rect   = SPRITE_RECTS[si.id as SpriteId];
          const worldH = SPRITE_WORLD_HEIGHT[si.id as SpriteId];
          if (!rect || !worldH) continue;

          const sprH = worldH * sc1 * halfH;
          if (sprH < 2) continue;

          const sprW = sprH * (rect.w / rect.h);
          const sprX = sx1 + si.worldX * sc1 * halfW;
          this.roadSprites.draw(ctx, rect, sprX - sprW / 2, sy1 - sprH, sprW, sprH);
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
    const carH            = Math.min(h * 0.20, 190);
    const carW            = carH * (CAR_SPRITE_FRAME_W / CAR_SPRITE_FRAME_H);
    const bot             = h - h * 0.04;
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
   * All values are derived from `w` and `h` so the HUD scales with the window.
   *
   * @param w - Canvas width in pixels.
   * @param h - Canvas height in pixels.
   * @returns A HudLayout object with every pre-computed value.
   */
  private computeHudLayout(w: number, h: number): HudLayout
  {
    const padX    = Math.round(w * 0.025);
    const padY    = Math.round(h * 0.028);
    const segW    = Math.round(w * 0.0095);
    const segH    = Math.round(h * 0.0135);
    const segGap  = Math.max(1, Math.round(w * 0.0022));
    const rowGap  = Math.round(h * 0.007);
    const barW    = HUD_NUM_SEGS * (segW + segGap) - segGap;
    const row3Bot = h - padY;
    const row2Bot = row3Bot - segH - rowGap;
    const row1Bot = row2Bot - segH - rowGap;
    const numSize = Math.round(h * 0.086);
    const lblSize = Math.round(h * 0.030);
    const lblBot  = row1Bot - rowGap * 2;
    const numBot  = lblBot  - lblSize - Math.round(h * 0.004);
    const panelTop = numBot - numSize - 4;

    return {
      padX,
      segW, segH, segGap,
      segStride: segW + segGap,   // pre-added: avoids repeated addition in the tach loop
      tInv: 1 / (HUD_NUM_SEGS - 1), // pre-divided: avoids repeated division in the tach loop
      barW,
      row3Bot, row2Bot, row1Bot,
      numSize, lblSize, lblBot, numBot, panelTop,
      fontNum: `bold ${numSize}px Impact, 'Arial Black', sans-serif`,
      fontLbl: `bold ${lblSize}px Impact, 'Arial Black', sans-serif`,
    };
  }

  // ── Grain canvas builder ──────────────────────────────────────────────────

  /**
   * Pre-renders the static pixel-grain texture for the HUD panel to an
   * OffscreenCanvas.  Called once on first render and on every window resize.
   *
   * Subsequent frames composite the result with a single ctx.drawImage() call
   * instead of iterating the grain loop (~70 fillRect calls) every frame.
   *
   * The pattern formula (ax * 7 + ay * 13) % 19 < 2 uses absolute canvas
   * coordinates so the texture is identical to the original per-frame version.
   *
   * @param L - Current HUD layout (provides barW, panelTop, row3Bot, padX).
   */
  private buildGrainCanvas(L: HudLayout): void
  {
    const gW   = L.barW;
    const gH   = L.row3Bot - L.panelTop;
    const off  = new OffscreenCanvas(gW, gH);
    const gCtx = off.getContext('2d')!;
    gCtx.fillStyle = '#FF2200';

    for (let gy = 0; gy < gH; gy += 3)
    {
      for (let gx = 0; gx < gW; gx += 3)
      {
        // Map local offscreen coords back to absolute canvas coords so the
        // grain pattern matches exactly what the original loop produced.
        const ax = gx + L.padX;
        const ay = gy + L.panelTop;
        if ((ax * 7 + ay * 13) % 19 < 2) gCtx.fillRect(gx, gy, 1, 1);
      }
    }

    this.grainCanvas = off;
  }

  // ── HUD ───────────────────────────────────────────────────────────────────

  /**
   * Draws the OutRun-style digital speedometer and 3-row tachometer.
   *
   * Layout (bottom-left):
   *   - Large red speed number in km/h.
   *   - "km/h" label.
   *   - Three rows of segmented LED bars (red → orange → green).
   *
   * The tach bars oscillate to simulate analogue gauge noise:
   *   amplitude shrinks near max speed; frequency rises at low speed.
   *   Each row has a different phase for visual interest.
   *
   * Note: ctx.save/restore is NOT called here — the outer render() call
   * already wraps the entire frame in a single save/restore pair.
   *
   * @param w     - Canvas width.
   * @param h     - Canvas height.
   * @param speed - Current speed in world units per second.
   */
  private renderHUD(w: number, h: number, speed: number): void
  {
    const { ctx } = this;

    // Recompute layout only when canvas size has changed (resize events)
    if (w !== this.hudW || h !== this.hudH)
    {
      this.hudLayout = this.computeHudLayout(w, h);
      this.buildGrainCanvas(this.hudLayout);
      this.hudW = w;
      this.hudH = h;
    }
    const L = this.hudLayout!;

    const time  = performance.now() / 1000;
    const ratio = speed / PLAYER_MAX_SPEED;

    // Smooth the displayed speed over ~8 frames to prevent digit flicker
    this.displaySpeed += (speed - this.displaySpeed) * 0.10;
    const kmh = Math.round(this.displaySpeed * (290 / PLAYER_MAX_SPEED));

    ctx.textAlign    = 'left';
    ctx.textBaseline = 'alphabetic';

    // Background panel
    ctx.fillStyle = 'rgba(0,0,0,0.52)';
    ctx.fillRect(L.padX - 8, L.panelTop, L.barW + 16, L.row3Bot - L.panelTop + 4);

    // Speed number — drawn 4× offset for a shadow, then once in bright red
    const numStr = `${kmh}`;
    ctx.font = L.fontNum;
    ctx.fillStyle = '#330000';
    ctx.fillText(numStr, L.padX + 2, L.numBot + 2);
    ctx.fillText(numStr, L.padX - 2, L.numBot + 2);
    ctx.fillText(numStr, L.padX + 2, L.numBot - 2);
    ctx.fillText(numStr, L.padX - 2, L.numBot - 2);
    ctx.fillStyle = '#FF2200';
    ctx.fillText(numStr, L.padX, L.numBot);

    // "km/h" label
    ctx.font = L.fontLbl;
    ctx.fillStyle = '#550000';
    ctx.fillText('km/h', L.padX + 1, L.lblBot + 1);
    ctx.fillStyle = '#FF4422';
    ctx.fillText('km/h', L.padX, L.lblBot);

    // Pre-rendered grain: one drawImage instead of ~70 fillRects every frame
    if (this.grainCanvas)
    {
      ctx.globalAlpha = 0.10;
      ctx.drawImage(this.grainCanvas, L.padX, L.panelTop);
      ctx.globalAlpha = 1;
    }

    // 3-row tachometer bars
    const amp  = 0.04 * (1 - ratio * 0.65);
    const freq = 5 + (1 - ratio) * 12;

    // Compute per-row fill fractions; each row uses a different oscillation phase
    const fill0 = Math.max(0, Math.min(1, ratio * 0.92 + Math.sin(time * freq)            * amp));
    const fill1 = Math.max(0, Math.min(1, ratio * 0.86 + Math.sin(time * freq * 0.87 + 1) * amp));
    const fill2 = Math.max(0, Math.min(1, ratio * 0.78 + Math.sin(time * freq * 0.73 + 2) * amp));

    const rowFills = [fill0, fill1, fill2];
    const rowBots  = [L.row1Bot, L.row2Bot, L.row3Bot];

    // 3-row tachometer — batched by colour zone.
    // Instead of 20 × (fillStyle + fillRect) per row, we group all segments
    // of each colour into one beginPath/rect.../fill pass.
    // Max 6 fillStyle changes per row (lit + unlit for each of 3 zones),
    // versus 20 previously — a 3× reduction in canvas state changes.
    for (let row = 0; row < 3; row++)
    {
      const rBot   = rowBots[row];
      const filled = Math.round(rowFills[row] * HUD_NUM_SEGS);
      ctx.globalAlpha = HUD_ROW_ALPHA[row];
      const y = rBot - L.segH;

      for (let zone = 0; zone < 3; zone++)
      {
        const zs  = HUD_ZONE_S[zone];
        const ze  = HUD_ZONE_E[zone];
        // `lit` = first unlit index in this zone (clamped to zone bounds)
        const lit = Math.max(zs, Math.min(filled, ze));

        // Draw the lit portion of this zone in one path
        if (lit > zs)
        {
          ctx.fillStyle = HUD_COLOR_LIT[zone];
          ctx.beginPath();
          for (let i = zs; i < lit; i++) ctx.rect(L.padX + i * L.segStride, y, L.segW, L.segH);
          ctx.fill();
        }

        // Draw the unlit portion of this zone in one path
        if (ze > lit)
        {
          ctx.fillStyle = HUD_COLOR_UNLIT[zone];
          ctx.beginPath();
          for (let i = lit; i < ze; i++) ctx.rect(L.padX + i * L.segStride, y, L.segW, L.segH);
          ctx.fill();
        }
      }
    }

    ctx.globalAlpha = 1;
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
    segments:      RoadSegment[],
    segmentCount:  number,
    playerZ:       number,
    playerX:       number,
    drawDistance:  number,
    w:             number,
    h:             number,
    speed:         number,
    steerAngle:    number,
    horizonOffset: number = 0,
  ): void
  {
    const { ctx }  = this;
    const horizonY = Math.round(h / 2 + horizonOffset);
    ctx.save();
    ctx.clearRect(0, 0, w, h);
    this.renderSky(w, horizonY);
    this.renderRoad(segments, segmentCount, playerZ, playerX, speed, drawDistance, w, h, horizonY);
    this.renderCar(w, h, steerAngle);
    this.renderHUD(w, h, speed);
    ctx.restore();
  }
}
