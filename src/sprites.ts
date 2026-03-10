// Sprite sheet: sprite_sheet_transparent.png  (1408×768 px, RGBA, pre-keyed)
// Background color has been zeroed out offline — no runtime color-keying needed.

export interface SpriteRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ── Player car (Ferrari Testarossa Spider) ────────────────────────────────────
// sprites/player_car_sprites.png: 37 uniform frames in a single horizontal strip.
// Index 0 = 90° hard-left, 18 = straight (rear view), 36 = 90° hard-right.
// L1–L13 sourced from real left.png; L14–L19 flipped from right.png.
// Frame selection: index = Math.round(steeringValue * 18) + 18
export const CAR_SPRITE_FRAME_W = 299;
export const CAR_SPRITE_FRAME_H = 149;
export const CAR_SPRITE_TOTAL   = 37;
export const CAR_SPRITE_CENTER  = 18;

export function carFrameRect(index: number): SpriteRect {
  const i = Math.max(0, Math.min(CAR_SPRITE_TOTAL - 1, index));
  return { x: i * CAR_SPRITE_FRAME_W, y: 0, w: CAR_SPRITE_FRAME_W, h: CAR_SPRITE_FRAME_H };
}

// ── Roadside sprites (Section 3, x > 962) ────────────────────────────────────
export type SpriteId = 'PALM_SMALL' | 'PALM_LARGE';

export const SPRITE_RECTS: Record<SpriteId, SpriteRect> = {
  PALM_SMALL: { x:  976, y: 83, w: 38, h: 130 },
  PALM_LARGE: { x: 1028, y: 83, w: 50, h: 125 },
};

export const SPRITE_WORLD_HEIGHT: Record<SpriteId, number> = {
  PALM_SMALL: 320,
  PALM_LARGE: 480,
};

// ── Loader ────────────────────────────────────────────────────────────────────

export class SpriteLoader {
  private img: HTMLImageElement | null = null;
  readonly ready: Promise<void>;

  constructor(src: string) {
    this.ready = new Promise<void>((resolve, reject) => {
      const img = new Image();
      img.onload  = () => { this.img = img; resolve(); };
      img.onerror = reject;
      img.src = src;
    });
  }

  isReady(): boolean { return this.img !== null; }

  draw(
    ctx: CanvasRenderingContext2D,
    rect: SpriteRect,
    dx: number, dy: number,
    dw: number, dh: number,
  ): void {
    if (!this.img || dw <= 0 || dh <= 0) return;
    ctx.drawImage(this.img, rect.x, rect.y, rect.w, rect.h, dx, dy, dw, dh);
  }
}
