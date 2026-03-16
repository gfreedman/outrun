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
 * All nine palm varieties are laid out in sprites/assets/palm_sheet.png.
 * Built by sprites/build_palm_sheet.py — regenerate if source PNGs change.
 *
 *   T1  Straight  — full-grown, vertical trunk
 *   T2L Bent Left — trunk leans left (plant on right side of road)
 *   T2R Bent Right— trunk leans right (plant on left side of road)
 *   T3  Young     — shorter, slender trunk
 *   T4  Fruiting  — clustered coconuts at crown
 *   T6  Luxuriant — dense wide canopy
 *   T7  Slender   — extra tall, narrow silhouette
 *   T8  Medium    — compact mid-size
 *  T10  Large     — broad, imposing crown
 *
 * Billboard varieties are in sprites/assets/billboard_sheet.png.
 * Built by sprites/build_billboard_sheet.py — regenerate if source PNGs change.
 */
export type SpriteId =
  | 'PALM_T1_STRAIGHT'
  | 'PALM_T2_BENT_LEFT'
  | 'PALM_T2_BENT_RIGHT'
  | 'PALM_T3_YOUNG'
  | 'PALM_T4_FRUITING'
  | 'PALM_T6_LUXURIANT'
  | 'PALM_T7_SLENDER'
  | 'PALM_T8_MEDIUM'
  | 'PALM_T10_LARGE'
  | 'BILLBOARD_BEAGLE_PETS'
  | 'BILLBOARD_ADOPT_BEAGLE'
  | 'BILLBOARD_BEAGLE_POWER'
  | 'BILLBOARD_LOYAL_FRIENDLY'
  | 'BILLBOARD_FROG_TAVERN'
  | 'BILLBOARD_ALE_CROAK'
  | 'BILLBOARD_CELLAR_JUMPERS'
  | 'BILLBOARD_CROAK_TAILS'
  | 'BILLBOARD_RED_BOX'
  | 'BILLBOARD_FINE_TOBACCO'
  | 'BILLBOARD_SMOOTH_TASTE'
  | 'BILLBOARD_WRESTLING'
  | 'COOKIE_HAPPY_SMOKING'
  | 'COOKIE_PREMIUM_CIGS'
  | 'COOKIE_SMOKIN_NOW'
  | 'COOKIE_CIG_RESERVES'
  | 'BARNEY_METAL_TILLETIRE'
  | 'BARNEY_OUTRUN_PALETTE'
  | 'BIG_WRESTLING'
  | 'CACTUS_C1'
  | 'CACTUS_C2'
  | 'CACTUS_C3'
  | 'CACTUS_C4'
  | 'CACTUS_C5'
  | 'CACTUS_C6'
  | 'CACTUS_C7'
  | 'CACTUS_C8'
  | 'CACTUS_C9'
  | 'CACTUS_C10'
  | 'CACTUS_C11'
  | 'CACTUS_C12'
  | 'CACTUS_C13'
  | 'CACTUS_C14'
  | 'CACTUS_C15'
  | 'CACTUS_C16'
  | 'CACTUS_C17'
  | 'CACTUS_C18'
  | 'CACTUS_C19'
  | 'CACTUS_C20'
  | 'CACTUS_C21'
  | 'CACTUS_C22'
  | 'SHRUB_S1'
  | 'SHRUB_S2'
  | 'SHRUB_S6';

/**
 * Source rectangles for each palm within sprites/assets/palm_sheet.png.
 * Generated by sprites/build_palm_sheet.py — sheet is 1246×224 px.
 */
export const SPRITE_RECTS: Record<SpriteId, SpriteRect> =
{
  PALM_T1_STRAIGHT:  { x:    4, y:   4, w: 133, h: 216 },
  PALM_T2_BENT_LEFT: { x:  145, y:   9, w: 153, h: 205 },
  PALM_T2_BENT_RIGHT:{ x:  306, y:   9, w: 153, h: 205 },
  PALM_T3_YOUNG:     { x:  467, y:  32, w: 103, h: 160 },
  PALM_T4_FRUITING:  { x:  578, y:   6, w: 133, h: 212 },
  PALM_T6_LUXURIANT: { x:  719, y:   9, w: 152, h: 205 },
  PALM_T7_SLENDER:   { x:  879, y:   4, w: 114, h: 215 },
  PALM_T8_MEDIUM:    { x: 1001, y:  34, w: 107, h: 156 },
  PALM_T10_LARGE:    { x: 1116, y:  26, w: 126, h: 171 },
};

/**
 * Real-world height of each palm in world units.
 * The renderer multiplies this by the perspective scale to get pixel height.
 * At 30 segments ahead: sprH ≈ worldH × 0.042 at a 600 px canvas.
 */
export const SPRITE_WORLD_HEIGHT: Record<SpriteId, number> =
{
  PALM_T1_STRAIGHT:  1900,
  PALM_T2_BENT_LEFT: 1800,
  PALM_T2_BENT_RIGHT:1800,
  PALM_T3_YOUNG:     1300,
  PALM_T4_FRUITING:  1700,
  PALM_T6_LUXURIANT: 2100,
  PALM_T7_SLENDER:   2300,
  PALM_T8_MEDIUM:    1600,
  PALM_T10_LARGE:    2000,
};

// ── Billboard sprites ─────────────────────────────────────────────────────────

/** Source rectangles within sprites/assets/billboard_sheet.png (2522×230 px). */
export const BILLBOARD_RECTS: Partial<Record<SpriteId, SpriteRect>> =
{
  BILLBOARD_BEAGLE_PETS:     { x:    4, y: 217, w: 284, h: 200 },
  BILLBOARD_ADOPT_BEAGLE:    { x:  296, y: 217, w: 283, h: 200 },
  BILLBOARD_BEAGLE_POWER:    { x:  587, y: 217, w: 246, h: 200 },
  BILLBOARD_LOYAL_FRIENDLY:  { x:  841, y: 217, w: 239, h: 200 },
  BILLBOARD_FROG_TAVERN:     { x: 1088, y: 207, w: 276, h: 219 },
  BILLBOARD_ALE_CROAK:       { x: 1372, y: 209, w: 267, h: 215 },
  BILLBOARD_CELLAR_JUMPERS:  { x: 1647, y: 209, w: 272, h: 215 },
  BILLBOARD_CROAK_TAILS:     { x: 1927, y: 209, w: 264, h: 215 },
  BILLBOARD_RED_BOX:         { x: 2199, y: 206, w: 285, h: 222 },
  BILLBOARD_FINE_TOBACCO:    { x: 2492, y: 206, w: 274, h: 222 },
  BILLBOARD_SMOOTH_TASTE:    { x: 2774, y: 207, w: 270, h: 219 },
  BILLBOARD_WRESTLING:       { x: 3052, y:   4, w: 1089, h: 626 },
};

/** World-space height of each billboard in world units. */
export const BILLBOARD_WORLD_HEIGHT: Partial<Record<SpriteId, number>> =
{
  BILLBOARD_BEAGLE_PETS:     1800,
  BILLBOARD_ADOPT_BEAGLE:    1800,
  BILLBOARD_BEAGLE_POWER:    1800,
  BILLBOARD_LOYAL_FRIENDLY:  1800,
  BILLBOARD_FROG_TAVERN:     1900,
  BILLBOARD_ALE_CROAK:       1900,
  BILLBOARD_CELLAR_JUMPERS:  1900,
  BILLBOARD_CROAK_TAILS:     1900,
  BILLBOARD_RED_BOX:         2000,
  BILLBOARD_FINE_TOBACCO:    2000,
  BILLBOARD_SMOOTH_TASTE:    2000,
  BILLBOARD_WRESTLING:       2200,
};

// ── Cookie boards (portrait signs — distinct class from og billboard) ─────────

/** Source rectangles within sprites/assets/cookie_sheet.png (1069×382 px). */
export const COOKIE_RECTS: Partial<Record<SpriteId, SpriteRect>> =
{
  COOKIE_HAPPY_SMOKING:  { x:    4, y:   4, w: 240, h: 374 },
  COOKIE_PREMIUM_CIGS:   { x:  252, y:   4, w: 277, h: 374 },
  COOKIE_SMOKIN_NOW:     { x:  537, y:   4, w: 270, h: 374 },
  COOKIE_CIG_RESERVES:   { x:  815, y:   4, w: 250, h: 374 },
};

/** World-space height of each cookie board in world units. */
export const COOKIE_WORLD_HEIGHT: Partial<Record<SpriteId, number>> =
{
  COOKIE_HAPPY_SMOKING:  2400,
  COOKIE_PREMIUM_CIGS:   2400,
  COOKIE_SMOKIN_NOW:     2400,
  COOKIE_CIG_RESERVES:   2400,
};

// ── Barney boards (distinct class from og and cookie boards) ──────────────────

/** Source rectangles within sprites/assets/barney_sheet.png (539×314 px). */
export const BARNEY_RECTS: Partial<Record<SpriteId, SpriteRect>> =
{
  BARNEY_METAL_TILLETIRE:  { x:    4, y:  41, w: 261, h: 232 },
  BARNEY_OUTRUN_PALETTE:   { x:  273, y:   4, w: 262, h: 306 },
};

/** World-space height of each barney board in world units. */
export const BARNEY_WORLD_HEIGHT: Partial<Record<SpriteId, number>> =
{
  BARNEY_METAL_TILLETIRE:  2000,
  BARNEY_OUTRUN_PALETTE:   2200,
};

/** Sheet rects for big_boards billboards. */
export const BIG_RECTS: Partial<Record<SpriteId, SpriteRect>> =
{
  BIG_WRESTLING:           { x:    4, y:   4, w: 1089, h: 626 },
};

/** World-space height of each big board in world units. */
export const BIG_WORLD_HEIGHT: Partial<Record<SpriteId, number>> =
{
  BIG_WRESTLING:           5600,
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

// ── Cactus sprites ────────────────────────────────────────────────────────────

/**
 * Source rectangles within sprites/assets/cactus_sheet.png.
 * 8 distinct cactus shapes extracted from source_for_sprites/cactus.png.
 * Generated by sprites/build_cactus_sheet.py — sheet is 2171×504 px.
 */
export const CACTUS_RECTS: Partial<Record<SpriteId, SpriteRect>> =
{
  CACTUS_C1:    { x:    4, y: 119, w:  84, h: 125 },
  CACTUS_C2:    { x:   96, y: 123, w:  64, h: 117 },
  CACTUS_C3:    { x:  168, y: 106, w:  63, h: 150 },
  CACTUS_C4:    { x:  239, y: 116, w: 121, h: 131 },
  CACTUS_C5:    { x:  368, y: 100, w:  91, h: 163 },
  CACTUS_C6:    { x:  467, y: 104, w: 147, h: 155 },
  CACTUS_C7:    { x:  622, y:  94, w:  82, h: 175 },
  CACTUS_C8:    { x:  712, y:  98, w: 129, h: 166 },
  CACTUS_C9:    { x:  849, y: 109, w:  92, h: 145 },
  CACTUS_C10:   { x:  949, y:  93, w: 100, h: 177 },
  CACTUS_C11:   { x: 1057, y: 110, w: 131, h: 142 },
  CACTUS_C12:   { x: 1196, y: 128, w: 100, h: 107 },
  CACTUS_C13:   { x: 1304, y: 115, w: 144, h: 133 },
  CACTUS_C14:   { x: 1456, y:   4, w: 137, h: 355 },
  CACTUS_C15:   { x: 1601, y: 102, w: 140, h: 159 },
  CACTUS_C16:   { x: 1749, y:  92, w:  70, h: 178 },
  CACTUS_C17:   { x: 1827, y: 105, w: 175, h: 152 },
  CACTUS_C18:   { x: 2010, y:  95, w: 148, h: 173 },
  CACTUS_C19:   { x: 2166, y: 134, w: 166, h:  94 },
  CACTUS_C20:   { x: 2340, y:  99, w: 155, h: 164 },
  CACTUS_C21:   { x: 2503, y: 103, w: 134, h: 157 },
  CACTUS_C22:   { x: 2645, y:  91, w: 118, h: 181 },
};

/** Real-world height of each cactus in world units. */
export const CACTUS_WORLD_HEIGHT: Partial<Record<SpriteId, number>> =
{
  CACTUS_C1:    700,
  CACTUS_C2:    700,
  CACTUS_C3:    700,
  CACTUS_C4:    700,
  CACTUS_C5:    700,
  CACTUS_C6:    700,
  CACTUS_C7:    700,
  CACTUS_C8:    700,
  CACTUS_C9:    700,
  CACTUS_C10:   700,
  CACTUS_C11:   700,
  CACTUS_C12:   700,
  CACTUS_C13:   700,
  CACTUS_C14:   700,
  CACTUS_C15:   700,
  CACTUS_C16:   700,
  CACTUS_C17:   700,
  CACTUS_C18:   700,
  CACTUS_C19:   700,
  CACTUS_C20:   700,
  CACTUS_C21:   700,
  CACTUS_C22:   700,
};

// ── Shrubs (S1 Short Scrub, S2 Sagebrush Cluster, S6 Low Creosote) ───────────

/** Source rectangles within sprites/assets/shrub_sheet.png (444×79 px). */
export const SHRUB_RECTS: Partial<Record<SpriteId, SpriteRect>> =
{
  SHRUB_S1:    { x:    4, y:  20, w: 116, h:  38 },
  SHRUB_S2:    { x:  128, y:   4, w: 144, h:  71 },
  SHRUB_S6:    { x:  280, y:  23, w: 160, h:  32 },
};

/** World-space height of each shrub in world units. */
export const SHRUB_WORLD_HEIGHT: Partial<Record<SpriteId, number>> =
{
  SHRUB_S1:    350,
  SHRUB_S2:    500,
  SHRUB_S6:    300,
};
