import { RoadSegment } from './types';
import {
  CAMERA_HEIGHT, CAMERA_DEPTH, ROAD_WIDTH,
  SEGMENT_LENGTH, SEGMENT_COUNT, COLORS,
  PLAYER_MAX_SPEED,
} from './constants';
import {
  SpriteLoader, SpriteId,
  carFrameRect, CAR_SPRITE_FRAME_W, CAR_SPRITE_FRAME_H, CAR_SPRITE_CENTER,
  CAR_PIVOT_OFFSETS,
  SPRITE_RECTS, SPRITE_WORLD_HEIGHT,
} from './sprites';

// ── helpers ───────────────────────────────────────────────────────────────────

function drawTrapezoid(
  ctx: CanvasRenderingContext2D,
  x1: number, y1: number, w1: number,
  x2: number, y2: number, w2: number,
  color: string,
): void {
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

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private carSprites: SpriteLoader | null;
  private roadSprites: SpriteLoader | null;
  private displaySpeed = 0; // interpolated for smooth digit transition

  constructor(
    canvas: HTMLCanvasElement,
    carSprites: SpriteLoader | null = null,
    roadSprites: SpriteLoader | null = null,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get 2D context');
    this.ctx = ctx;
    this.carSprites  = carSprites;
    this.roadSprites = roadSprites;
  }

  // ── sky ───────────────────────────────────────────────────────────────────

  private renderSky(w: number, horizonY: number): void {
    const { ctx } = this;
    const grad = ctx.createLinearGradient(0, 0, 0, horizonY);
    grad.addColorStop(0,    COLORS.SKY_TOP);
    grad.addColorStop(0.55, COLORS.SKY_MID);
    grad.addColorStop(1,    COLORS.SKY_HORIZON);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, horizonY);
  }

  // ── road + roadside sprites ───────────────────────────────────────────────

  private renderRoad(
    segments: RoadSegment[],
    playerZ: number,
    playerX: number,
    drawDistance: number,
    w: number,
    h: number,
    horizonY: number,
  ): void {
    const { ctx } = this;
    const halfW   = w / 2;
    const halfH   = horizonY;
    const cameraX = playerX * ROAD_WIDTH;
    const cameraZ = playerZ;
    const totalLen = SEGMENT_COUNT * SEGMENT_LENGTH;

    // Solid grass fill — ensures no gap between horizon and first segment
    ctx.fillStyle = COLORS.GRASS_LIGHT;
    ctx.fillRect(0, halfH, w, halfH);

    const startIndex = Math.floor(playerZ / SEGMENT_LENGTH) % SEGMENT_COUNT;

    for (let i = drawDistance; i >= 1; i--) {
      const absIdx = startIndex + i;
      const segIdx = absIdx % SEGMENT_COUNT;
      const wraps  = Math.floor(absIdx / SEGMENT_COUNT);
      const seg    = segments[segIdx];

      const wz1 = seg.p1.world.z + wraps * totalLen;
      const wz2 = seg.p2.world.z + wraps * totalLen;
      const cz1 = wz1 - cameraZ;
      const cz2 = wz2 - cameraZ;
      if (cz1 <= 0 || cz2 <= 0) continue;

      const sc1 = CAMERA_DEPTH / cz1;
      const sc2 = CAMERA_DEPTH / cz2;

      const sx1 = halfW - cameraX * sc1 * halfW;
      const sy1 = Math.round(halfH + CAMERA_HEIGHT * sc1 * halfH); // integer y → no sub-pixel bleed
      const sw1 = ROAD_WIDTH * sc1 * halfW;

      const sx2 = halfW - cameraX * sc2 * halfW;
      const sy2 = Math.round(halfH + CAMERA_HEIGHT * sc2 * halfH); // integer y → no sub-pixel bleed
      const sw2 = ROAD_WIDTH * sc2 * halfW;

      if (sy2 >= sy1) continue;

      const { color } = seg;

      ctx.fillStyle = color.grass;
      ctx.fillRect(0, sy2, w, sy1 - sy2);

      drawTrapezoid(ctx, sx1, sy1, sw1, sx2, sy2, sw2, color.road);

      if (color.lane) {
        // centre lane dashes
        const lw1 = sw1 * 0.06, lo1 = sw1 * 0.33;
        const lw2 = sw2 * 0.06, lo2 = sw2 * 0.33;
        drawTrapezoid(ctx, sx1 - lo1, sy1, lw1, sx2 - lo2, sy2, lw2, color.lane);
        drawTrapezoid(ctx, sx1 + lo1, sy1, lw1, sx2 + lo2, sy2, lw2, color.lane);

        // edge stripes — dashed (same period as centre lanes): thick + thin per side
        const etW1 = sw1 * 0.045, etO1 = sw1 * 0.915;
        const enW1 = sw1 * 0.020, enO1 = sw1 * 0.790;
        const etW2 = sw2 * 0.045, etO2 = sw2 * 0.915;
        const enW2 = sw2 * 0.020, enO2 = sw2 * 0.790;
        drawTrapezoid(ctx, sx1 - etO1, sy1, etW1, sx2 - etO2, sy2, etW2, '#FFFFFF');
        drawTrapezoid(ctx, sx1 - enO1, sy1, enW1, sx2 - enO2, sy2, enW2, '#FFFFFF');
        drawTrapezoid(ctx, sx1 + etO1, sy1, etW1, sx2 + etO2, sy2, etW2, '#FFFFFF');
        drawTrapezoid(ctx, sx1 + enO1, sy1, enW1, sx2 + enO2, sy2, enW2, '#FFFFFF');
      }

      // ── roadside sprites ──────────────────────────────────────────────────
      if (seg.sprites && this.roadSprites?.isReady() && sy1 >= halfH) {
        for (const si of seg.sprites) {
          const rect   = SPRITE_RECTS[si.id as SpriteId];
          const worldH = SPRITE_WORLD_HEIGHT[si.id as SpriteId];
          if (!rect || !worldH) continue;

          const sprH = worldH * sc1 * halfH;
          if (sprH < 2) continue;

          const sprW = sprH * (rect.w / rect.h);
          const sprX = halfW + (si.worldX - cameraX) * sc1 * halfW;

          this.roadSprites.draw(ctx, rect, sprX - sprW / 2, sy1 - sprH, sprW, sprH);
        }
      }
    }
  }

  // ── player car ────────────────────────────────────────────────────────────
  //
  // Uses sprite sheet when loaded.  Falls back to procedural drawing.
  // steerDir: -1 = left, 0 = straight, +1 = right
  // speedRatio: 0–1 (determines hard vs slight turn frame)

  private renderCar(w: number, h: number, steerAngle: number): void {
    const { ctx } = this;

    if (!this.carSprites?.isReady()) return;

    // steerAngle is continuous -1…+1; map directly to 37-frame index
    const frameIndex = Math.round(steerAngle * CAR_SPRITE_CENTER) + CAR_SPRITE_CENTER;
    const rect       = carFrameRect(frameIndex);

    const carH = Math.min(h * 0.20, 190);
    const carW = carH * (CAR_SPRITE_FRAME_W / CAR_SPRITE_FRAME_H);
    const bot  = h - h * 0.04;

    // Apply per-frame pivot correction so the rear axle stays centred on screen
    // rather than the bounding box centre drifting as the car turns.
    const pivotOffset     = CAR_PIVOT_OFFSETS[frameIndex] ?? 0;
    const pivotCorrection = (pivotOffset / CAR_SPRITE_FRAME_W) * carW;
    const cx = w / 2 + steerAngle * w * 0.05 + pivotCorrection;

    const drawX = Math.round(cx - carW / 2);
    const drawY = Math.round(bot - carH);

    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.beginPath();
    ctx.ellipse(cx, bot + 4, carW * 0.4, 6, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    this.carSprites.draw(ctx, rect, drawX, drawY, Math.round(carW), Math.round(carH));
  }

  // ── HUD — OutRun-style bottom-left: speed number + segmented tach bar ────

  // ── HUD — retro OutRun digital speedometer + 3-row RPM visualizer ───────

  private renderHUD(w: number, h: number, speed: number): void {
    const { ctx } = this;
    const time  = performance.now() / 1000;
    const ratio = speed / PLAYER_MAX_SPEED;

    // Smooth digit interpolation (~8-frame half-life)
    this.displaySpeed += (speed - this.displaySpeed) * 0.10;
    const kmh = Math.round(this.displaySpeed * (290 / PLAYER_MAX_SPEED));

    ctx.save();
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'alphabetic';

    // ── layout constants ──────────────────────────────────────────────────
    const padX    = Math.round(w * 0.025);
    const padY    = Math.round(h * 0.028);
    const NUM_SEGS = 20;
    const segW    = Math.round(w * 0.0095);
    const segH    = Math.round(h * 0.0135);
    const segGap  = Math.max(1, Math.round(w * 0.0022));
    const rowGap  = Math.round(h * 0.007);
    const barW    = NUM_SEGS * (segW + segGap) - segGap;

    // positions — build upward from screen bottom
    const row3Bot = h - padY;
    const row2Bot = row3Bot - segH - rowGap;
    const row1Bot = row2Bot - segH - rowGap;
    const numSize = Math.round(h * 0.086);
    const lblSize = Math.round(h * 0.030);
    const lblBot  = row1Bot - rowGap * 2;
    const numBot  = lblBot - lblSize - Math.round(h * 0.004);
    const panelTop = numBot - numSize - 4;

    // ── background panel ──────────────────────────────────────────────────
    ctx.fillStyle = 'rgba(0,0,0,0.52)';
    ctx.fillRect(padX - 8, panelTop, barW + 16, row3Bot - panelTop + 4);

    // ── speed number — Impact font with dark shadow for chunky retro look ─
    const numStr = `${kmh}`;
    ctx.font = `bold ${numSize}px Impact, 'Arial Black', sans-serif`;

    ctx.fillStyle = '#330000';   // thick shadow (drawn at 4 diagonal offsets)
    ctx.fillText(numStr, padX + 2, numBot + 2);
    ctx.fillText(numStr, padX - 2, numBot + 2);
    ctx.fillText(numStr, padX + 2, numBot - 2);
    ctx.fillText(numStr, padX - 2, numBot - 2);

    ctx.fillStyle = '#FF2200';   // main saturated red
    ctx.fillText(numStr, padX, numBot);

    // ── km/h label ────────────────────────────────────────────────────────
    ctx.font = `bold ${lblSize}px Impact, 'Arial Black', sans-serif`;
    ctx.fillStyle = '#550000';
    ctx.fillText('km/h', padX + 1, lblBot + 1);
    ctx.fillStyle = '#FF4422';
    ctx.fillText('km/h', padX, lblBot);

    // ── static pixel-grain texture (deterministic — no per-frame flicker) ─
    ctx.globalAlpha = 0.10;
    ctx.fillStyle   = '#FF2200';
    for (let gy = panelTop; gy < row3Bot; gy += 3) {
      for (let gx = padX; gx < padX + barW; gx += 3) {
        if ((gx * 7 + gy * 13) % 19 < 2) ctx.fillRect(gx, gy, 1, 1);
      }
    }
    ctx.globalAlpha = 1;

    // ── 3-row RPM / tachometer bars ───────────────────────────────────────
    // Each row oscillates at a different frequency simulating analog noise.
    // Higher speed → higher base fill; oscillation amplitude shrinks at max.
    const amp   = 0.04 * (1 - ratio * 0.65);
    const freq  = 5 + (1 - ratio) * 12;   // faster oscillation at low speed

    const fills = [
      Math.max(0, Math.min(1, ratio * 0.92 + Math.sin(time * freq)             * amp)),
      Math.max(0, Math.min(1, ratio * 0.86 + Math.sin(time * freq * 0.87 + 1)  * amp)),
      Math.max(0, Math.min(1, ratio * 0.78 + Math.sin(time * freq * 0.73 + 2)  * amp)),
    ];
    const rowBots  = [row1Bot, row2Bot, row3Bot];
    const rowAlpha = [1.0, 0.82, 0.65];

    for (let row = 0; row < 3; row++) {
      const rBot   = rowBots[row];
      const filled = Math.round(fills[row] * NUM_SEGS);
      ctx.globalAlpha = rowAlpha[row];
      for (let i = 0; i < NUM_SEGS; i++) {
        const x = padX + i * (segW + segGap);
        const t = i / (NUM_SEGS - 1);
        if (i < filled) {
          // Red (left) → Orange (mid) → Green (right)
          ctx.fillStyle = t < 0.33 ? '#CC0000' : t < 0.66 ? '#FF6600' : '#00BB00';
        } else {
          // Dark inactive tint matches zone colour
          ctx.fillStyle = t < 0.33 ? '#280000' : t < 0.66 ? '#281200' : '#002800';
        }
        ctx.fillRect(x, rBot - segH, segW, segH);
      }
    }

    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // ── public ────────────────────────────────────────────────────────────────

  render(
    segments: RoadSegment[],
    playerZ: number,
    playerX: number,
    drawDistance: number,
    w: number,
    h: number,
    speed: number,
    steerAngle: number,
    horizonOffset: number = 0,
  ): void {
    const { ctx } = this;
    const horizonY = Math.round(h / 2 + horizonOffset);
    ctx.save();
    ctx.clearRect(0, 0, w, h);
    this.renderSky(w, horizonY);
    this.renderRoad(segments, playerZ, playerX, drawDistance, w, h, horizonY);
    this.renderCar(w, h, steerAngle);
    this.renderHUD(w, h, speed);
    ctx.restore();
  }
}
