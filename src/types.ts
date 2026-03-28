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
 * Sprite family — classifies a sprite's type at placement time so the renderer
 * can dispatch to the correct sheet and rect table with a single comparison
 * instead of repeated id.startsWith() scans in the hot render path (C7).
 */
export type SpriteFamily =
  | 'palm'
  | 'billboard'
  | 'cookie'
  | 'barney'
  | 'big'
  | 'cactus'
  | 'shrub'
  | 'sign'
  | 'house'
  | 'gate_start'
  | 'gate_finish';

/**
 * One roadside object (e.g. a palm tree) attached to a road segment.
 * id     = which sprite to look up in the appropriate RECTS table.
 * family = pre-classified type used by the renderer for O(1) dispatch.
 * worldX = left/right offset from road centre in world units.
 *          Negative = left side, positive = right side.
 */
export interface SpriteInstance
{
  id:        string;
  family:    SpriteFamily;
  worldX:    number;
  scale?:    number;    // height multiplier (1 = default world height, 3 = triple)
  flipX?:    boolean;   // mirror sprite horizontally (right-side buildings face the road)
  stretchX?: number;    // horizontal width multiplier (intentional aspect-ratio break)
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

// ── Collision ─────────────────────────────────────────────────────────────────

/**
 * Severity class for a roadside object collision.
 * ghost  = no effect (shrubs, signs).
 * glance = minor poke (cactus).
 * smack  = hard hit (palm, billboard).
 * crunch = building grind (house).
 */
/**
 * Enum (not string union) so the switch in game.ts can carry a `never` exhaustiveness
 * sentinel — same pattern as ROAD_CURVE / ROAD_HILL.  Adding a new member here
 * causes a compile error in the switch until a handler is written.
 */
export enum CollisionClass
{
  /** No physical effect -- shrubs, signs pass through the car. */
  Ghost  = 'ghost',
  /** Minor impact -- cactus: small speed scrub + lateral bump. */
  Glance = 'glance',
  /** Hard impact -- palm trunk or billboard post: speed cap + flick. */
  Smack  = 'smack',
  /** Building grind -- house: sustained drag + severe speed cap. */
  Crunch = 'crunch',
}

// ── Game state ────────────────────────────────────────────────────────────────

/**
 * Drives the top-level state machine in Game.
 * Each value corresponds to one tickXxx() method and one distinct screen.
 */
export enum GamePhase
{
  /** Sprite sheets downloading — progress bar shown, no input. */
  PRELOADING,
  /** Title / menu screen — GAME MODE, SETTINGS, START. */
  INTRO,
  /** 3-2-1-GO! countdown sequence — road visible, car frozen. */
  COUNTDOWN,
  /** Active race — full physics, timers, scoring, traffic. */
  PLAYING,
  /** Car crossed the finish line — cinematic deceleration + confetti. */
  FINISHING,
  /** GOAL! results panel — score + race time + buttons. */
  GOAL,
  /** Clock hit zero before the finish line — TIME UP overlay. */
  TIMEUP,
}

/**
 * Available difficulty levels.  Determines road course, traffic density,
 * speed cap, and hill/curve scaling.  Stored in localStorage via GameSettings.
 */
export enum GameMode
{
  /** Hard course, 293 km/h, 4 traffic cars. Sweeping corners and blind crests, no survival pressure. */
  EASY   = 'easy',
  /** Hard course, 358 km/h, 8 traffic cars. Genuine blind hills; active traffic AI. */
  MEDIUM = 'medium',
  /** The Cathedral — a new 5.3 km circuit. 410 km/h, 12 traffic cars. Survival mode. */
  HARD   = 'hard',
}

/**
 * Behavioural archetype for a traffic car.
 * Determines lane-selection bias and real-time reactive logic in updateTraffic.
 */
export enum TrafficBehavior
{
  /** Neutral — standard lane weave, no special logic. */
  Standard   = 'standard',
  /** Barney — flees the player's lane when approached closely. */
  Evader     = 'evader',
  /** GottaGo — high-speed profile, erratic lane changes. */
  Speedster  = 'speedster',
  /** Yoshi — prefers outer lanes, gentle and predictable. */
  EdgeHugger = 'edge_hugger',
  /** Banana — very short lane timer, micro-oscillation around target lane. */
  Wanderer   = 'wanderer',
  /** Mega — strongly prefers centre lanes, heavy and slow. */
  RoadHog    = 'road_hog',
}

/**
 * Per-type stat block used by the traffic system.
 * Stored alongside each TrafficCar so lookups are O(1) after spawn.
 */
export interface TrafficProfile
{
  /** Minimum forward speed (world units / second). */
  speedMin:     number;
  /** Maximum forward speed (world units / second). */
  speedMax:     number;
  /** Lateral drift rate toward lane target (world units / second). */
  weaveRate:    number;
  /** Minimum seconds between lane-target changes. */
  laneTimerMin: number;
  /** Maximum seconds between lane-target changes. */
  laneTimerMax: number;
  /**
   * Multiplier on TRAFFIC_HITBOX_X.
   * < 1 = harder to hit (smaller effective hitbox).
   * > 1 = easier to hit (larger effective hitbox).
   */
  hitboxMult:   number;
  /**
   * Collision mass multiplier.
   * Affects how far the car flies when hit AND how much the player
   * decelerates on impact.  Higher = heavier.
   */
  massMult:     number;
}

/**
 * Persisted user preferences, stored in localStorage between sessions.
 */
export interface GameSettings
{
  /** Currently selected difficulty. */
  mode:         GameMode;
  /** Whether engine/screech/crash audio is enabled. */
  soundEnabled: boolean;
}
