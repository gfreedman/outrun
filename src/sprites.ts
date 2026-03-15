/**
 * sprites.ts
 *
 * Sprite metadata and the SpriteLoader helper used by the renderer.
 *
 * Two sprite sheets are used:
 *   sprites/assets/cars/player_car_sprites_1x.png  — 37-frame Ferrari Testarossa animation strip.
 *   sprites/assets/sprite_sheet_transparent.png    — roadside objects (palm trees, etc.).
 *
 * The background colour of the roadside sheet has been zeroed out offline so
 * no runtime colour-keying is needed — straight alpha blending works correctly.
 */

// ── Rectangle type ────────────────────────────────────────────────────────────

/**
 * A rectangular region within a sprite sheet, in sheet pixels.
 * Used to tell drawImage() exactly which sub-image to copy.
 */
export interface SpriteRect
{
  x: number;
  y: number;
  w: number;
  h: number;
}

// ── Player car ────────────────────────────────────────────────────────────────

/**
 * The car sprite sheet is a single horizontal strip of 37 equal-width frames.
 * Frame 0  = car turned 90° left (hard left steer).
 * Frame 18 = car pointing straight ahead (neutral).
 * Frame 36 = car turned 90° right (hard right steer).
 *
 * Frames 1–17: left turns (sourced from left.png).
 * Frames 19–35: right turns (sourced from right.png, mirrored).
 *
 * At runtime, steerAngle (-1…+1) maps to a frame index via:
 *   index = Math.round(steerAngle * CAR_SPRITE_CENTER * 0.6) + CAR_SPRITE_CENTER
 * The 0.6 cap prevents the nose from pointing sideways at full lock.
 */
export const CAR_SPRITE_FRAME_W = 312;   // pixels per frame
export const CAR_SPRITE_FRAME_H = 149;   // pixels per frame
export const CAR_SPRITE_TOTAL   = 37;    // total frames in the strip
export const CAR_SPRITE_CENTER  = 18;    // index of the straight-ahead frame

/**
 * Returns the source rectangle for a given frame index.
 * Clamps index into the valid range [0, 36] so out-of-bounds calls are safe.
 *
 * @param index - Frame index in [0, CAR_SPRITE_TOTAL - 1].
 * @returns SpriteRect describing where that frame lives in the sheet.
 */
export function carFrameRect(index: number): SpriteRect
{
  const i = Math.max(0, Math.min(CAR_SPRITE_TOTAL - 1, index));
  return { x: i * CAR_SPRITE_FRAME_W, y: 0, w: CAR_SPRITE_FRAME_W, h: CAR_SPRITE_FRAME_H };
}

/**
 * Per-frame horizontal pivot offset, in sprite pixels from the cell centre.
 *
 * Because the car is not always centred within its bounding box (the body
 * shifts left or right as the car steers), a raw centre-of-cell placement
 * makes the rear axle wobble left and right across the screen.
 *
 * Positive offset → the pivot is to the LEFT of the cell centre →
 *   the renderer shifts the draw position rightward to compensate.
 *
 * Generated offline by sprites/build_sprite_sheet.py.
 */
export const CAR_PIVOT_OFFSETS: number[] = [
  3, -13, -12, -41, -41, -32, -31, -29, -33, -36, -36, -25, -28,
  -3, -10, -9, -9, 6, 3, 3, 9, 12, 12, 5, 30, 28, 38, 38,
  36, 31, 33, 34, 43, 43, 14, 15, -2,
];

// ── Roadside sprites ──────────────────────────────────────────────────────────

/**
 * Valid roadside sprite names.
 * Must match the keys in SPRITE_RECTS and SPRITE_WORLD_HEIGHT below.
 */
export type SpriteId = 'PALM_SMALL' | 'PALM_LARGE';

/**
 * Source rectangles for each roadside sprite within sprite_sheet_transparent.png.
 * Measured in sheet pixels from the top-left corner of the image.
 */
export const SPRITE_RECTS: Record<SpriteId, SpriteRect> =
{
  PALM_SMALL: { x:  976, y: 83, w: 38,  h: 130 },
  PALM_LARGE: { x: 1028, y: 83, w: 50,  h: 125 },
};

/**
 * Real-world height of each sprite in world units.
 * The renderer multiplies this by the perspective scale factor to get pixel height.
 * PALM_LARGE is taller so it appears bigger / more imposing than PALM_SMALL.
 */
export const SPRITE_WORLD_HEIGHT: Record<SpriteId, number> =
{
  PALM_SMALL: 320,
  PALM_LARGE: 480,
};

// ── Loader ────────────────────────────────────────────────────────────────────

/**
 * Wraps an HTMLImageElement and loads a sprite sheet from a URL.
 *
 * Usage:
 *   const sheet = new SpriteLoader('sprites/my_sheet.png');
 *   await sheet.ready;          // optional — isReady() works without awaiting
 *   sheet.draw(ctx, rect, ...); // no-op if image hasn't loaded yet
 */
export class SpriteLoader
{
  private img: HTMLImageElement | null = null;

  /** Resolves when the image has finished loading, or rejects on error. */
  readonly ready: Promise<void>;

  /**
   * Begins loading the image at the given URL.
   *
   * @param src - Path to the sprite sheet, relative to the HTML page.
   */
  constructor(src: string)
  {
    this.ready = new Promise<void>((resolve, reject) =>
    {
      const img    = new Image();
      img.onload   = () => { this.img = img; resolve(); };
      img.onerror  = reject;
      img.src      = src;
    });
  }

  /**
   * Returns true once the image has loaded and is ready to draw.
   * The renderer checks this each frame so it can skip drawing if not ready.
   */
  isReady(): boolean
  {
    return this.img !== null;
  }

  /**
   * Copies a sub-rectangle from the sprite sheet to the canvas.
   * Silently does nothing if the image hasn't loaded yet, or if the
   * destination size is zero or negative (which would throw a browser error).
   *
   * @param ctx  - The 2-D canvas context to draw into.
   * @param rect - Source rectangle within the sprite sheet.
   * @param dx   - Destination left edge in canvas pixels.
   * @param dy   - Destination top edge in canvas pixels.
   * @param dw   - Destination width in canvas pixels.
   * @param dh   - Destination height in canvas pixels.
   */
  draw(
    ctx: CanvasRenderingContext2D,
    rect: SpriteRect,
    dx: number, dy: number,
    dw: number, dh: number,
  ): void
  {
    if (!this.img || dw <= 0 || dh <= 0) return;
    ctx.drawImage(this.img, rect.x, rect.y, rect.w, rect.h, dx, dy, dw, dh);
  }
}
