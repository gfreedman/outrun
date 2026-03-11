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
 *   scale = CAMERA_DEPTH / (worldZ - playerZ)   ← "how small does this look?"
 *   screenX = halfW - worldX * scale * halfW
 *   screenY = halfH + CAMERA_HEIGHT * scale * halfH
 *
 * Adjacent segments are drawn as filled trapezoids between their two
 * projected Y values, from the farthest visible segment toward the nearest
 * (painter's algorithm), so nearer geometry covers farther geometry correctly.
 *
 * ── Two-pass road rendering ─────────────────────────────────────────────────
 *
 * Hills require a trick: a segment behind a hill crest must NOT be drawn even
 * though it exists in the array.  We solve this with two passes:
 *
 *   Pass 1 (front-to-back): project each segment, track the highest (smallest Y)
 *     screen coordinate seen so far as `maxy`.  Any segment whose near edge
 *     projects ABOVE `maxy` is hidden behind a hill and skipped.
 *
 *   Pass 2 (back-to-front): draw only the visible segments using painter's
 *     algorithm so sprites and grass overlay correctly.
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

// ── Helper: drawTrapezoid ─────────────────────────────────────────────────────

/**
 * Fills a four-sided polygon (trapezoid) between two horizontal scan-lines.
 *
 * Used for every road band: asphalt, grass, rumble strips, and lane dashes.
 * The shape has two parallel horizontal edges:
 *   Top edge:    centred at (x2, y2), half-width w2.
 *   Bottom edge: centred at (x1, y1), half-width w1.
 *
 * When w1 > w2 (near edge wider than far edge) the result is the classic
 * converging-road perspective shape.
 *
 * @param ctx   - Canvas 2D context to draw into.
 * @param x1    - Screen X of near (bottom) edge centre.
 * @param y1    - Screen Y of near (bottom) edge.
 * @param w1    - Half-width of near edge in pixels.
 * @param x2    - Screen X of far (top) edge centre.
 * @param y2    - Screen Y of far (top) edge.
 * @param w2    - Half-width of far edge in pixels.
 * @param color - CSS colour string; if empty the call is a no-op.
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

  /** Smoothed speed value for the HUD display — prevents digit jitter. */
  private displaySpeed = 0;

  /**
   * Accumulated horizontal sky-layer offset for curve parallax.
   * Each frame the sky shifts slightly in the direction of the current curve,
   * giving the impression that the background recedes into the bend.
   */
  private skyOffset = 0;

  /**
   * Creates a Renderer attached to the given canvas.
   *
   * @param canvas      - The HTML canvas element to draw into.
   * @param carSprites  - Pre-constructed loader for the car sprite sheet.
   * @param roadSprites - Pre-constructed loader for the roadside sprite sheet.
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
  }

  // ── Sky ───────────────────────────────────────────────────────────────────

  /**
   * Draws a vertical colour gradient filling the sky area above the horizon.
   *
   * Three colour stops give the authentic OutRun look:
   *   Deep blue at the top → vibrant Caribbean blue in the middle →
   *   pale haze near the horizon.
   *
   * @param w        - Canvas width in pixels.
   * @param horizonY - Screen Y of the horizon line (sky fills 0…horizonY).
   */
  private renderSky(w: number, horizonY: number): void
  {
    const { ctx } = this;
    const grad    = ctx.createLinearGradient(0, 0, 0, horizonY);
    grad.addColorStop(0,    COLORS.SKY_TOP);
    grad.addColorStop(0.55, COLORS.SKY_MID);
    grad.addColorStop(1,    COLORS.SKY_HORIZON);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, horizonY);
  }

  // ── Road + roadside sprites ───────────────────────────────────────────────

  /**
   * Projects and draws the scrolling road, including:
   *   - Grass verges (full-width fillRect between segments).
   *   - Road surface trapezoids.
   *   - Rumble strips, lane dashes, and edge stripes.
   *   - Roadside palm tree sprites.
   *
   * Curve rendering:
   *   Two accumulators (`dx`, `curveX`) produce a quadratic horizontal offset
   *   so curves look like smooth parabolic bends, not linear skews.
   *   dx     = rate of change of offset (incremented by seg.curve each step).
   *   curveX = total accumulated offset (incremented by dx each step).
   *   These are second-order because curves in OutRun are essentially parabolas.
   *
   * Hill rendering:
   *   Each segment carries p1.world.y and p2.world.y.  Factoring those into
   *   the screen-Y formula (CAMERA_HEIGHT - world.y) shifts segments up when
   *   the road climbs and down when it descends.
   *
   * @param segments      - Full road segment array from Road.
   * @param segmentCount  - Total number of segments (used for modulo wrap).
   * @param playerZ       - Player's world Z (depth) position.
   * @param playerX       - Player's normalised lateral position (-1…+1).
   * @param speed         - Current speed (used for parallax rate).
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

    // Solid grass fill behind everything — prevents a bare canvas gap
    // between the horizon line and the farthest visible road segment.
    ctx.fillStyle = COLORS.GRASS_LIGHT;
    ctx.fillRect(0, halfH, w, halfH);

    // Index of the segment directly under the player
    const startIndex  = Math.floor(playerZ / SEGMENT_LENGTH) % segmentCount;
    const baseSegment = segments[startIndex];
    const basePercent = (playerZ % SEGMENT_LENGTH) / SEGMENT_LENGTH;

    // Accumulate sky parallax offset toward the direction of the current curve
    const speedPercent = speed / PLAYER_MAX_SPEED;
    this.skyOffset += PARALLAX_SKY * baseSegment.curve * speedPercent;

    // ── Pass 1: project front-to-back, compute visibility ─────────────────
    //
    // We step from the nearest segment (i=1) out to the farthest (i=drawDistance).
    // `maxy` is the lowest on-screen Y seen so far for far edges.
    // A segment is visible only if its near edge (sy1) projects at or below maxy,
    // meaning it hasn't been "eclipsed" by a hill crest closer to the camera.

    interface ProjectedSeg
    {
      seg: RoadSegment;
      sx1: number; sy1: number; sw1: number;
      sx2: number; sy2: number; sw2: number;
    }

    const projected: ProjectedSeg[] = [];
    let maxy   = halfH;                            // nothing rendered yet — horizon is ceiling
    let dx     = -(baseSegment.curve * basePercent); // interpolate within current segment
    let curveX = 0;

    for (let i = 1; i <= drawDistance; i++)
    {
      const absIdx = startIndex + i;
      const segIdx = absIdx % segmentCount;
      const wraps  = Math.floor(absIdx / segmentCount);  // how many times we've looped
      const seg    = segments[segIdx];

      // World Z coordinates for both edges of this segment, adjusted for track wrap
      const wz1 = seg.p1.world.z + wraps * totalLen;
      const wz2 = seg.p2.world.z + wraps * totalLen;

      // Camera-relative depth (positive = in front of camera)
      const cz1 = wz1 - cameraZ;
      const cz2 = wz2 - cameraZ;

      if (cz1 <= 0)
      {
        // Segment is behind the camera — advance accumulators and skip drawing
        curveX += dx;
        dx += seg.curve;
        continue;
      }

      // Perspective scale: larger value = closer to camera = larger on screen
      const sc1 = CAMERA_DEPTH / cz1;
      const sc2 = cz2 > 0 ? CAMERA_DEPTH / cz2 : 0;

      // Horizontal projection: subtract curveX so the road bends left/right
      const projX1 = (cameraX - curveX)       * sc1;
      const projX2 = (cameraX - curveX - dx)  * sc2;

      // Screen X (centre of road at this depth)
      const sx1 = Math.round(halfW - projX1 * halfW);
      const sx2 = Math.round(halfW - projX2 * halfW);

      // Screen Y: hills shift via (CAMERA_HEIGHT - world.y)
      //   world.y > 0 (uphill)   → smaller value → segment appears higher on screen
      //   world.y < 0 (downhill) → larger value  → segment appears lower on screen
      const sy1 = Math.round(halfH + (CAMERA_HEIGHT - seg.p1.world.y) * sc1 * halfH);
      const sy2 = Math.round(halfH + (CAMERA_HEIGHT - seg.p2.world.y) * sc2 * halfH);

      // Half-width of road in pixels at each edge depth
      const sw1 = ROAD_WIDTH * sc1 * halfW;
      const sw2 = ROAD_WIDTH * sc2 * halfW;

      // Visibility check: sy1 >= maxy means the near edge is at or below the
      // current "ceiling" (not hidden behind a hill crest closer to the camera)
      if (sy1 >= maxy)
      {
        projected.push({ seg, sx1, sy1, sw1, sx2, sy2, sw2 });
        maxy = Math.min(maxy, sy2);   // tighten ceiling to far edge of this segment
      }

      // Advance curve accumulators for next segment
      curveX += dx;
      dx     += seg.curve;
    }

    // ── Horizon cap ───────────────────────────────────────────────────────
    //
    // The grass fillRect and road trapezoid for each segment only cover
    // sy2→sy1 of that segment.  The thin strip from halfH down to the far
    // edge of the LAST visible segment would show only the initial solid
    // grass fill, leaving a flat-coloured bar at the horizon instead of a
    // proper vanishing point.  We plug that gap by drawing a tiny road
    // wedge and grass strip from halfH to that far edge.

    if (projected.length > 0)
    {
      const far = projected[projected.length - 1];
      if (far.sy2 > halfH)
      {
        ctx.fillStyle = COLORS.GRASS_LIGHT;
        ctx.fillRect(0, halfH, w, far.sy2 - halfH);
        drawTrapezoid(ctx, far.sx2, halfH, 0, far.sx2, far.sy2, far.sw2, COLORS.ROAD_LIGHT);
      }
    }

    // ── Pass 2: render back-to-front (painter's algorithm) ────────────────
    //
    // We iterate the projected array from last (farthest) to first (nearest).
    // Each nearer segment paints over segments behind it, so road markings
    // and sprites overlap correctly.

    for (let i = projected.length - 1; i >= 0; i--)
    {
      const p = projected[i];
      const { seg, sx1, sy1, sw1, sx2, sy2, sw2 } = p;

      // Skip degenerate segments (far edge not above near edge on screen)
      if (sy2 >= sy1) continue;

      const { color } = seg;

      // ── Grass verge (full canvas width) ────────────────────────────────
      ctx.fillStyle = color.grass;
      ctx.fillRect(0, sy2, w, sy1 - sy2);

      // ── Asphalt road surface ────────────────────────────────────────────
      drawTrapezoid(ctx, sx1, sy1, sw1, sx2, sy2, sw2, color.road);

      // ── Lane markings (only on "dash" segments) ─────────────────────────
      if (color.lane)
      {
        // Centre-line dashes: two thin strips, each offset from road centre
        const lw1 = sw1 * 0.06, lo1 = sw1 * 0.33;
        const lw2 = sw2 * 0.06, lo2 = sw2 * 0.33;
        drawTrapezoid(ctx, sx1 - lo1, sy1, lw1, sx2 - lo2, sy2, lw2, color.lane);
        drawTrapezoid(ctx, sx1 + lo1, sy1, lw1, sx2 + lo2, sy2, lw2, color.lane);

        // Edge stripes: a thick outer stripe and a thinner inner stripe per side.
        // These are also only drawn on "dash" segments for the dashed-stripe look.
        const etW1 = sw1 * 0.045, etO1 = sw1 * 0.915;
        const enW1 = sw1 * 0.020, enO1 = sw1 * 0.790;
        const etW2 = sw2 * 0.045, etO2 = sw2 * 0.915;
        const enW2 = sw2 * 0.020, enO2 = sw2 * 0.790;
        drawTrapezoid(ctx, sx1 - etO1, sy1, etW1, sx2 - etO2, sy2, etW2, '#FFFFFF');
        drawTrapezoid(ctx, sx1 - enO1, sy1, enW1, sx2 - enO2, sy2, enW2, '#FFFFFF');
        drawTrapezoid(ctx, sx1 + etO1, sy1, etW1, sx2 + etO2, sy2, etW2, '#FFFFFF');
        drawTrapezoid(ctx, sx1 + enO1, sy1, enW1, sx2 + enO2, sy2, enW2, '#FFFFFF');
      }

      // ── Roadside sprites ────────────────────────────────────────────────
      //
      // Sprites are scaled by the same perspective factor as the road.
      // sc1 is re-derived from sw1 (sw1 = ROAD_WIDTH * sc1 * halfW).
      // sx1 already incorporates the curve offset for this segment, so
      // si.worldX only needs the per-depth scale applied to position correctly.

      if (seg.sprites && this.roadSprites?.isReady() && sy1 >= halfH)
      {
        const sc1 = sw1 / (ROAD_WIDTH * halfW);

        for (const si of seg.sprites)
        {
          const rect   = SPRITE_RECTS[si.id as SpriteId];
          const worldH = SPRITE_WORLD_HEIGHT[si.id as SpriteId];
          if (!rect || !worldH) continue;   // unknown id — skip silently

          // Scale sprite height using perspective; skip tiny distant sprites
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
   * Draws the player's car sprite at the bottom-centre of the screen.
   *
   * Frame selection:
   *   steerAngle is in [-1, +1] where -1 = full left lock, +1 = full right lock.
   *   We map this to a frame index, capped at 60% of the full range so the
   *   car nose never appears to point sideways even at maximum steering input.
   *
   * Pivot correction:
   *   The rear axle of the car should stay fixed at screen centre as the
   *   steering changes.  Each frame's bounding box is a different width,
   *   so CAR_PIVOT_OFFSETS pre-computed the per-frame offset needed to
   *   re-align the axle.
   *
   * @param w          - Canvas width in pixels.
   * @param h          - Canvas height in pixels.
   * @param steerAngle - Continuous steering value in [-1, +1].
   */
  private renderCar(w: number, h: number, steerAngle: number): void
  {
    const { ctx } = this;

    if (!this.carSprites?.isReady()) return;

    // Cap frame range at 60%: steerAngle ±1 maps to ±60% of CAR_SPRITE_CENTER
    const frameIndex = Math.round(steerAngle * CAR_SPRITE_CENTER * 0.6) + CAR_SPRITE_CENTER;
    const rect       = carFrameRect(frameIndex);

    // Car display size: 20% of screen height, anchored just above the bottom
    const carH = Math.min(h * 0.20, 190);
    const carW = carH * (CAR_SPRITE_FRAME_W / CAR_SPRITE_FRAME_H);
    const bot  = h - h * 0.04;

    // Pivot correction: shift draw position so rear axle stays centred
    const pivotOffset     = CAR_PIVOT_OFFSETS[frameIndex] ?? 0;
    const pivotCorrection = (pivotOffset / CAR_SPRITE_FRAME_W) * carW;

    // Slight lateral nudge (5% of screen width) to reinforce steering feel
    const cx = w / 2 + steerAngle * w * 0.05 + pivotCorrection;

    const drawX = Math.round(cx - carW / 2);
    const drawY = Math.round(bot - carH);

    // Soft elliptical shadow under the car
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.beginPath();
    ctx.ellipse(cx, bot + 4, carW * 0.4, 6, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    this.carSprites.draw(ctx, rect, drawX, drawY, Math.round(carW), Math.round(carH));
  }

  // ── HUD — OutRun-style digital speedometer + 3-row tachometer ────────────

  /**
   * Draws the speed readout and animated tachometer bar display.
   *
   * Layout (bottom-left corner):
   *   - Large red speed number in km/h (Impact font with dark shadow).
   *   - "km/h" label beneath the number.
   *   - Three rows of segmented LED-style bars, colour-coded red→orange→green.
   *
   * The tach bars oscillate slightly to simulate real gauge noise:
   *   - Oscillation amplitude decreases as speed approaches maximum.
   *   - Oscillation frequency increases at lower speeds (engine hunting).
   *   - Each row oscillates at a slightly different phase for visual interest.
   *
   * @param w     - Canvas width in pixels.
   * @param h     - Canvas height in pixels.
   * @param speed - Current speed in world units per second.
   */
  private renderHUD(w: number, h: number, speed: number): void
  {
    const { ctx } = this;
    const time    = performance.now() / 1000;
    const ratio   = speed / PLAYER_MAX_SPEED;

    // Smooth the displayed speed toward the real speed over ~8 frames.
    // This prevents the digits from flickering when speed changes rapidly.
    this.displaySpeed += (speed - this.displaySpeed) * 0.10;
    const kmh = Math.round(this.displaySpeed * (290 / PLAYER_MAX_SPEED));

    ctx.save();
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'alphabetic';

    // ── Layout constants ──────────────────────────────────────────────────
    const padX     = Math.round(w * 0.025);
    const padY     = Math.round(h * 0.028);
    const NUM_SEGS = 20;
    const segW     = Math.round(w * 0.0095);
    const segH     = Math.round(h * 0.0135);
    const segGap   = Math.max(1, Math.round(w * 0.0022));
    const rowGap   = Math.round(h * 0.007);
    const barW     = NUM_SEGS * (segW + segGap) - segGap;

    // Build upward from the screen bottom
    const row3Bot  = h - padY;
    const row2Bot  = row3Bot - segH - rowGap;
    const row1Bot  = row2Bot - segH - rowGap;
    const numSize  = Math.round(h * 0.086);
    const lblSize  = Math.round(h * 0.030);
    const lblBot   = row1Bot - rowGap * 2;
    const numBot   = lblBot  - lblSize - Math.round(h * 0.004);
    const panelTop = numBot  - numSize - 4;

    // ── Background panel ──────────────────────────────────────────────────
    ctx.fillStyle = 'rgba(0,0,0,0.52)';
    ctx.fillRect(padX - 8, panelTop, barW + 16, row3Bot - panelTop + 4);

    // ── Speed number ──────────────────────────────────────────────────────
    // Drawn four times offset in each diagonal for a chunky shadow effect,
    // then once more in bright red on top.
    const numStr = `${kmh}`;
    ctx.font = `bold ${numSize}px Impact, 'Arial Black', sans-serif`;

    ctx.fillStyle = '#330000';
    ctx.fillText(numStr, padX + 2, numBot + 2);
    ctx.fillText(numStr, padX - 2, numBot + 2);
    ctx.fillText(numStr, padX + 2, numBot - 2);
    ctx.fillText(numStr, padX - 2, numBot - 2);

    ctx.fillStyle = '#FF2200';
    ctx.fillText(numStr, padX, numBot);

    // ── "km/h" label ──────────────────────────────────────────────────────
    ctx.font = `bold ${lblSize}px Impact, 'Arial Black', sans-serif`;
    ctx.fillStyle = '#550000';
    ctx.fillText('km/h', padX + 1, lblBot + 1);
    ctx.fillStyle = '#FF4422';
    ctx.fillText('km/h', padX, lblBot);

    // ── Static pixel-grain texture ─────────────────────────────────────────
    // Deterministic dot pattern (no Math.random) so it doesn't flicker.
    ctx.globalAlpha = 0.10;
    ctx.fillStyle   = '#FF2200';
    for (let gy = panelTop; gy < row3Bot; gy += 3)
    {
      for (let gx = padX; gx < padX + barW; gx += 3)
      {
        if ((gx * 7 + gy * 13) % 19 < 2) ctx.fillRect(gx, gy, 1, 1);
      }
    }
    ctx.globalAlpha = 1;

    // ── 3-row tachometer bars ─────────────────────────────────────────────
    // Each row oscillates at a different frequency and phase.
    // `amp` shrinks at high speed so the display steadies out near redline.
    const amp  = 0.04 * (1 - ratio * 0.65);
    const freq = 5 + (1 - ratio) * 12;

    const fills =
    [
      Math.max(0, Math.min(1, ratio * 0.92 + Math.sin(time * freq)             * amp)),
      Math.max(0, Math.min(1, ratio * 0.86 + Math.sin(time * freq * 0.87 + 1)  * amp)),
      Math.max(0, Math.min(1, ratio * 0.78 + Math.sin(time * freq * 0.73 + 2)  * amp)),
    ];
    const rowBots  = [row1Bot, row2Bot, row3Bot];
    const rowAlpha = [1.0, 0.82, 0.65];

    for (let row = 0; row < 3; row++)
    {
      const rBot   = rowBots[row];
      const filled = Math.round(fills[row] * NUM_SEGS);
      ctx.globalAlpha = rowAlpha[row];

      for (let i = 0; i < NUM_SEGS; i++)
      {
        const x = padX + i * (segW + segGap);
        const t = i / (NUM_SEGS - 1);

        if (i < filled)
        {
          // Lit segment: red → orange → green left to right
          ctx.fillStyle = t < 0.33 ? '#CC0000' : t < 0.66 ? '#FF6600' : '#00BB00';
        }
        else
        {
          // Unlit segment: dark tint in the zone's own colour
          ctx.fillStyle = t < 0.33 ? '#280000' : t < 0.66 ? '#281200' : '#002800';
        }
        ctx.fillRect(x, rBot - segH, segW, segH);
      }
    }

    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // ── Public entry point ────────────────────────────────────────────────────

  /**
   * Draws a complete frame.  Called every animation frame by game.ts.
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
   * @param horizonOffset  - Pixel offset to shift the horizon line up/down
   *                         (used for terrain bump jitter when off-road).
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
