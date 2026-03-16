/**
 * types.ts
 *
 * Shared data structures used across road, renderer, and game systems.
 * Think of each interface as a "blueprint" for an object — it says what fields
 * the object must have and what type each field is.
 */

// ── Coordinate types ──────────────────────────────────────────────────────────

/**
 * A point in 3-D world space.
 * x = left/right, y = up/down, z = depth into the screen (distance from player).
 */
export interface WorldPoint
{
  x: number;
  y: number;
  z: number;
}

/**
 * A point after it has been projected onto the 2-D screen.
 * x, y = pixel position.  w = half-width of the road in pixels at this depth.
 * scale = perspective divisor (CAMERA_DEPTH / worldZ) — bigger is closer.
 */
export interface ScreenPoint
{
  x: number;
  y: number;
  w: number;
  scale: number;
}

/**
 * Bundles a world-space point with its computed screen-space projection.
 * Road segments carry two of these — one for the near edge (p1) and one for
 * the far edge (p2) of the trapezoid strip.
 */
export interface ProjectedPoint
{
  world:  WorldPoint;
  screen: ScreenPoint;
}

// ── Road colour ───────────────────────────────────────────────────────────────

/**
 * The four colours needed to paint one road segment.
 * road   = asphalt fill.
 * grass  = verge fill on both sides.
 * rumble = kerb strip (red or white alternating).
 * lane   = centre-line dash colour, or '' to skip drawing a dash on this segment.
 */
export interface SegmentColor
{
  road:   string;
  grass:  string;
  rumble: string;
  lane:   string;
}

// ── Roadside sprites ──────────────────────────────────────────────────────────

/**
 * One roadside object (e.g. a palm tree) attached to a road segment.
 * id     = which sprite to look up in SPRITE_RECTS (must be a SpriteId).
 * worldX = left/right offset from road centre in world units.
 *          Negative = left side, positive = right side.
 */
export interface SpriteInstance
{
  id:     string;   // SpriteId value — 'PALM_SMALL' or 'PALM_LARGE'
  worldX: number;
  scale?: number;   // height multiplier (1 = default world height, 3 = triple)
}

// ── Road segment ──────────────────────────────────────────────────────────────

/**
 * One slice of the road, like a single plank in a long, curving runway.
 * The renderer draws each segment as a trapezoid between p1 (near edge)
 * and p2 (far edge).
 *
 * index   = sequential number from 0 upward (used for colour banding).
 * curve   = lateral bend strength; accumulated by the renderer to steer
 *           the road left or right across the screen.
 * color   = pre-computed colours for this segment's band.
 * sprites = optional roadside objects placed on this segment.
 */
export interface RoadSegment
{
  index:    number;
  p1:       ProjectedPoint;
  p2:       ProjectedPoint;
  curve:    number;
  color:    SegmentColor;
  sprites?: SpriteInstance[];
}

// ── Game state ────────────────────────────────────────────────────────────────

/**
 * Top-level game phases.
 * Only PLAYING exists for now; MENU and GAME_OVER can be added here later.
 */
export enum GamePhase
{
  PLAYING,
}
