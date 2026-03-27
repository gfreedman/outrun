/**
 * constants.ts
 *
 * Every magic number in the game lives here.
 * Changing a value here affects all systems that import it,
 * so this is the one file a designer tweaks to re-tune the feel.
 */

import { GameMode } from './types';

// ── Camera & perspective ──────────────────────────────────────────────────────

/** Height of the camera above the road surface, in world units. */
export const CAMERA_HEIGHT  = 1000;

/** Half-width of the visible road, in world units. */
export const ROAD_WIDTH     = 2000;

/** Length of one road segment, in world units. */
export const SEGMENT_LENGTH = 200;

/** How many segments ahead of the player are drawn each frame. */
export const DRAW_DISTANCE  = 200;

/**
 * Horizontal field-of-view in degrees.
 * 100° gives the wide, dramatic perspective of the original arcade cabinet.
 */
export const FOV_DEG        = 100;

/**
 * Converts FOV to a perspective depth scalar.
 * CAMERA_DEPTH = 1 / tan(FOV/2).  Smaller value = wider FOV = more dramatic depth.
 * At 100° this is approximately 0.839.
 */
export const CAMERA_DEPTH   = 1 / Math.tan((FOV_DEG / 2) * Math.PI / 180);

// ── Speed ─────────────────────────────────────────────────────────────────────

/**
 * Top speed in world units per second.
 * Calibrated so the road scrolls at roughly 293 km/h (≈54 segments/sec).
 */
export const PLAYER_MAX_SPEED   = 10800;

/**
 * Speed shown on the HUD at PLAYER_MAX_SPEED, in km/h.
 * Matches the Ferrari Testarossa's period top speed figure.
 */
export const DISPLAY_MAX_KMH    = 293;

// ── Three-phase throttle — speed band boundaries ──────────────────────────────

/**
 * speedRatio below this threshold uses the low-speed smoothstep ramp (tyres
 * finding grip).  Above it, full MID thrust applies.
 * Changing this shifts the transition between launch-feel and power-band.
 */
export const ACCEL_LOW_BAND  = 0.15;

/**
 * speedRatio above this threshold tapers MID thrust linearly down to 0
 * (simulates peak-power then aero-drag falloff near top speed).
 * Must be greater than ACCEL_LOW_BAND and less than 1.
 */
export const ACCEL_HIGH_BAND = 0.80;

/**
 * Minimum speed ratio maintained when the player holds throttle on grass.
 * Prevents a fully-stopped car on the verge — the engine always has a crawl.
 * 0.05 ≈ 15 km/h at PLAYER_MAX_SPEED 293 km/h.
 */
export const OFFROAD_CRAWL_RATIO = 0.05;

// ── Acceleration — three-phase "Alive & Kinetic" curve ───────────────────────

/**
 * Acceleration at low speed (0–15% of max).
 * Tyres are still finding grip so power delivery is limited.
 * A smoothstep ramp blends from ACCEL_LOW up to ACCEL_MID over this band.
 */
export const PLAYER_ACCEL_LOW   = 2160;

/**
 * Peak acceleration during the main thrust band (15–80% of max).
 * Also used as the starting point of the terminal taper (80–100%).
 */
export const PLAYER_ACCEL_MID   = 4320;

// ── Coasting (lift-off deceleration) ─────────────────────────────────────────

/**
 * Deceleration rate when the player lifts off the throttle, in world units/s².
 * Scales with current speed: 50% at rest → 100% at max speed.
 * Gives a natural aerodynamic-drag feel without feeling sticky at low speeds.
 */
export const PLAYER_COAST_RATE  = 2640;

// ── Braking ───────────────────────────────────────────────────────────────────

/**
 * Maximum braking force, in world units/s².
 * Applied at full pedal pressure after the ramp-up period.
 */
export const PLAYER_BRAKE_MAX   = 8400;

/**
 * How long (seconds) the brakes take to develop full force.
 * Near-instant feel — arcade-style snappy response.
 */
export const PLAYER_BRAKE_RAMP  = 0.02;

// ── Steering ─────────────────────────────────────────────────────────────────

/**
 * How fast the player can move laterally across the full road width,
 * measured in road-widths per second at maximum speed.
 * 2.0 = the car can cross the entire road in roughly one second at top speed.
 */
export const PLAYER_STEERING    = 2.42;

/**
 * Rate at which the visual steer angle ramps to ±1 and springs back to 0.
 * 3.0 = reaches full lock in ~0.33 seconds.
 * Drives car sprite frame selection only — not lateral physics.
 */
export const PLAYER_STEER_RATE  = 3.0;

// ── Off-road friction ─────────────────────────────────────────────────────────

/**
 * Speed is soft-capped at this fraction of PLAYER_MAX_SPEED while on grass.
 * 0.30 = the car is dragged down to 30% of top speed on grass.
 */
export const OFFROAD_MAX_RATIO      = 0.30;

/**
 * Extra deceleration force applied while the car is on grass, in world units/s².
 * Must be greater than PLAYER_ACCEL_MID so the car cannot accelerate off-road.
 */
export const OFFROAD_DECEL          = 6600;

/**
 * Time in seconds for full speed recovery after returning to the asphalt.
 * Short window so punishment is the grass decel itself, not a lingering tax.
 */
export const OFFROAD_RECOVERY_TIME  = 0.6;

// ── Curves & Hills ────────────────────────────────────────────────────────────

/**
 * Preset segment counts used when building straight road sections.
 * Passed as the "enter", "hold", and "leave" counts to addRoad().
 */
export const ROAD_LENGTH = { NONE: 0, SHORT: 25, MEDIUM: 50, LONG: 100 } as const;

/**
 * Horizontal curve intensity values for road sections.
 * Each unit shifts each successive segment a little sideways in the renderer.
 * Accumulated quadratically so even small values produce a visible bend.
 * Enum (not const object) so switch statements get exhaustiveness checking (L2).
 */
export enum ROAD_CURVE  { NONE = 0, EASY = 2, MEDIUM = 4, HARD = 6 }

/**
 * Vertical hill height values, in world units total rise/fall for a section.
 * CAMERA_HEIGHT = 1000.  To get a visually dramatic hill, world.y must approach
 * CAMERA_HEIGHT so the crest converges toward the horizon.
 *
 * Projection formula:  sy = halfH + (CAMERA_HEIGHT - world.y) * sc * halfH
 * A flat road (y=0) sits well below the horizon; y approaching 1000 raises the
 * segment toward horizon height — the blind-crest effect of the original arcade.
 *
 * LOW   = 150 → gentle, rolling shoulder
 * MEDIUM= 350 → committed hill — you lose sight of the exit
 * HIGH  = 600 → 60% of CAMERA_HEIGHT — genuine blind crest / big drop
 *
 * Enum (not const object) so switch statements get exhaustiveness checking (L2).
 */
export enum ROAD_HILL   { NONE = 0, LOW = 150, MEDIUM = 350, HIGH = 600 }

/**
 * Maximum frame delta-time cap in seconds.
 * Prevents a huge physics jump if the tab loses focus and returns.
 * Currently 33 ms → 30 fps floor.  Raising this above ~66 ms (15 fps)
 * makes centrifugal / slide physics noticeably frame-rate-dependent (L1).
 */
export const MAX_FRAME_DT = 1 / 30;   // 33 ms — 30 fps physics floor

/**
 * How hard curves push the player's car outward (centrifugal drift).
 * Formula: playerX -= curve * speedPercent * CENTRIFUGAL * dt
 * At 0.22, a hard curve (6) at full speed drifts at ~1.32 rw/sec.
 * Steering authority at full speed is ~1.82 rw/sec (linear grip model),
 * leaving a 0.5 rw/sec margin — tight but winnable with precise inputs.
 */
export const CENTRIFUGAL    = 0.22;

// ── Drift / oversteer ─────────────────────────────────────────────────────────

/**
 * Fraction of available grip at which the rear steps out and slide begins.
 * 0.5 = slide starts when centrifugal force exceeds 50% of steering grip.
 * Lower = more slidey. Higher = more planted.
 */
export const DRIFT_ONSET = 0.93;

/**
 * How fast lateral slide velocity accumulates when over the drift threshold.
 * Higher = rear snaps out more aggressively.
 */
export const DRIFT_RATE  = 3.0;

/**
 * How fast the slide decays on its own (tyres self-aligning torque).
 * Lower = longer, looser slides. Higher = car catches itself quickly.
 */
export const DRIFT_DECAY = 5.0;

/**
 * How fast the slide decays when the player actively counter-steers.
 * Higher than DRIFT_DECAY so counter-steer input meaningfully shortens the slide.
 */
export const DRIFT_CATCH = 10.0;

/**
 * How fast the sky background shifts horizontally when on a curve.
 * Accumulated each frame: skyOffset += PARALLAX_SKY * segmentCurve * speedPercent.
 * Ready for future sky texture layers; currently drives the skyOffset accumulator.
 */
export const PARALLAX_SKY   = 0.001;

// ── Collision window ──────────────────────────────────────────────────────────

/**
 * Segment index offsets scanned around the player each frame for collision
 * detection and solid-object blocking.
 *
 * The window is ASYMMETRIC [-1, 0, 1, 2] — intentionally biased one segment
 * ahead of the player.  The extra forward segment (+2) catches fast-moving
 * objects that the player will reach BEFORE the next frame; the backward
 * segment (-1) catches objects the player may have partially passed this frame.
 * A symmetric [-2,-1,0,1,2] window would fire collisions on objects already
 * fully behind the car; a forward-only [0,1,2] window can ghost-pass at high
 * speed.  Changing this to symmetric is a KNOWN gotcha — do not "fix" (L5).
 *
 * Defined here so collision.ts and game.ts always share the same window.
 */
export const COLLISION_WINDOW = [-1, 0, 1, 2] as const;

// ── Hit detection — lateral hitbox half-widths (world units) ─────────────────

/** Lateral half-width for cactus collision detection (world units). */
export const HITBOX_CACTUS    = 450;
/** Lateral half-width for palm tree collision detection (world units). */
export const HITBOX_PALM      = 550;
/** Lateral half-width for billboard collision detection (world units). */
export const HITBOX_BILLBOARD = 700;
/** Lateral half-width for house collision detection (world units). */
export const HITBOX_HOUSE     = 950;

/**
 * Player must be at least this far off-road (|playerX| >= this) before any
 * roadside collision can fire.  Prevents on-road drivers from clipping objects
 * that are placed just off the road edge (worldX 2000–2400).
 */
export const COLLISION_MIN_OFFSET = 1.0;

/**
 * Physical blocking radius for smack-class objects (palm trunk / billboard post).
 * Smaller than HITBOX_PALM so the detection zone is more forgiving than the wall.
 */
export const BLOCK_SMACK = 250;

/**
 * Physical blocking radius for houses.
 * MUST be smaller than HITBOX_HOUSE so the player is always inside the detection
 * zone at the blocking boundary — otherwise delta == HITBOX_HOUSE exactly and
 * the `delta < radius` check fails, making houses feel transparent.
 */
export const BLOCK_HOUSE = 750;

// ── Near-miss zone ────────────────────────────────────────────────────────────
/** Ratio of hitbox radius that triggers a cosmetic wobble (no speed penalty). */
export const NEAR_MISS_RATIO  = 1.5;
/** Lateral nudge applied during near-miss (road-widths). */
export const NEAR_MISS_WOBBLE = 0.015;

// ── Glance (cactus) ───────────────────────────────────────────────────────────

/** Speed multiplier on cactus impact (0.87 = 13% speed loss). */
export const HIT_GLANCE_SPEED_MULT    = 0.87;
/** Lateral bump magnitude (road-widths) applied on cactus impact. */
export const HIT_GLANCE_BUMP          = 0.04;
/** Collision cooldown (seconds) after a cactus hit before next detection. */
export const HIT_GLANCE_COOLDOWN      = 0.30;

// ── Smack (palm / billboard) ──────────────────────────────────────────────────

/** Speed multiplier on palm/billboard impact (0.52 = 48% speed loss). */
export const HIT_SMACK_SPEED_MULT     = 0.52;
/** Hard speed cap after smack, as a fraction of PLAYER_MAX_SPEED. */
export const HIT_SMACK_SPEED_CAP      = 0.55;
/** Lateral bump magnitude (road-widths) applied on smack impact. */
export const HIT_SMACK_BUMP           = 0.14;
/** Collision cooldown (seconds) after a smack before next detection. */
export const HIT_SMACK_COOLDOWN       = 0.85;
/** Acceleration multiplier during the post-smack recovery window. */
export const HIT_SMACK_RECOVERY_BOOST = 1.5;
/** Duration (seconds) of boosted acceleration after a smack. */
export const HIT_SMACK_RECOVERY_TIME  = 1.2;

// ── Crunch (house) ────────────────────────────────────────────────────────────

/** Hard speed cap after house crunch, as a fraction of PLAYER_MAX_SPEED. */
export const HIT_CRUNCH_SPEED_CAP      = 0.08;
/** Sustained drag (wu/s²) applied during the grind timer. */
export const HIT_CRUNCH_GRIND_DECEL    = 7800;
/** Duration (seconds) of the sustained grind drag after a house hit. */
export const HIT_CRUNCH_GRIND_TIME     = 2.0;
/** Lateral bump magnitude (road-widths) applied on house crunch. */
export const HIT_CRUNCH_BUMP           = 0.22;
/** Collision cooldown (seconds) after a house crunch before next detection. */
export const HIT_CRUNCH_COOLDOWN       = 1.50;
/** Acceleration multiplier during the post-crunch recovery window. */
export const HIT_CRUNCH_RECOVERY_BOOST = 2.0;
/** Duration (seconds) of boosted acceleration after a house crunch. */
export const HIT_CRUNCH_RECOVERY_TIME  = 2.0;

// ── Collision restitution factors ─────────────────────────────────────────────
//
// These combine with the player's lateral approach speed to compute the flick
// (lateral velocity imparted at impact).  flick = approach × RESTITUTION + speed × BASE.
// Lower restitution = object absorbs more energy.  Lower base = glancing hits matter more.

/** Smack (palm / billboard) restitution: fairly springy post. */
export const HIT_SMACK_RESTITUTION   = 0.55;
/** Smack minimum speed-component base even on a head-on hit. */
export const HIT_SMACK_FLICK_BASE    = 0.10;
/** Crunch (house) restitution: concrete absorbs more energy than a post. */
export const HIT_CRUNCH_RESTITUTION  = 0.30;
/** Crunch minimum speed-component base — car always bounces off a wall. */
export const HIT_CRUNCH_FLICK_BASE   = 0.15;

// ── Off-road terrain jitter ───────────────────────────────────────────────────

/**
 * Exponential blend rate toward a new jitter target while on grass.
 * Higher = more responsive, choppier feel.  8 ≈ 12% progress per 60 fps frame.
 */
export const OFFROAD_JITTER_BLEND    = 8;

/**
 * Exponential decay rate applied to jitter when the player returns to asphalt.
 * Higher = jitter fades out faster after re-joining the road.
 */
export const OFFROAD_JITTER_DECAY    = 15;

// ── Camera shake ──────────────────────────────────────────────────────────────

/** Maximum screen pixel offset during a glance (cactus) camera shake. */
export const SHAKE_GLANCE_INTENSITY   = 4;
/** Duration (seconds) of cactus camera shake. */
export const SHAKE_GLANCE_DURATION    = 0.08;
/** Maximum screen pixel offset during a smack (palm/billboard) camera shake. */
export const SHAKE_SMACK_INTENSITY    = 14;
/** Duration (seconds) of smack camera shake. */
export const SHAKE_SMACK_DURATION     = 0.25;
/** Maximum screen pixel offset during a crunch (house) camera shake. */
export const SHAKE_CRUNCH_INTENSITY   = 10;
/** Duration (seconds) of house crunch camera shake. */
export const SHAKE_CRUNCH_DURATION    = 1.00;

// ── Speed floor during any collision ─────────────────────────────────────────
/** The car never drops below this fraction of max speed from a hit. Law 2. */
export const HIT_SPEED_FLOOR          = 0.04;   // always keeps 4% — feels alive

// ── Traffic cars ──────────────────────────────────────────────────────────────

/** Number of traffic cars maintained on the road at all times. */
export const TRAFFIC_COUNT             = 3;

/** Minimum forward speed for a traffic car (world units / sec ≈ 40 km/h). */
export const TRAFFIC_SPEED_MIN         = 1200;

/** Maximum forward speed for a traffic car (world units / sec ≈ 180 km/h). */
export const TRAFFIC_SPEED_MAX         = 5400;

/** Min seconds between lane-weave target changes. */
export const TRAFFIC_LANE_TIMER_MIN    = 1.5;

/** Max seconds between lane-weave target changes. */
export const TRAFFIC_LANE_TIMER_MAX    = 4.5;

/** Lateral drift rate toward new lane target (world units / sec). */
export const TRAFFIC_WEAVE_RATE        = 900;

/**
 * Half-width of traffic car lateral collision hitbox (world units).
 * Lanes are spaced 700 wu apart (inner: ±500, outer: ±1200).
 * 400 means same-lane hits register; adjacent-lane near-misses do not.
 */
export const TRAFFIC_HITBOX_X          = 400;

/**
 * Depth window (segments) for traffic collision detection.
 */
export const TRAFFIC_HITBOX_SEGS       = 5;

/**
 * How many segments behind the player a traffic car is allowed to trail before
 * it is recycled to the far horizon.  A non-zero trail window means cars that
 * were recently passed can catch up when the player slows down, instead of
 * immediately teleporting ahead.
 */
export const TRAFFIC_TRAIL_SEGS        = 25;

/** Speed cap (fraction of PLAYER_MAX_SPEED) immediately after a traffic hit. */
export const TRAFFIC_HIT_SPEED_CAP     = 0.20;

/** Base lateral flick magnitude for a traffic hit (road-widths/sec). */
export const TRAFFIC_HIT_FLICK_BASE    = 0.35;

/**
 * Restitution factor: scales flick by pre-hit speed ratio.
 * At 80% max speed → flick = 0.64. At 40% → 0.35 (falls back to base).
 */
export const TRAFFIC_HIT_FLICK_RESTITUTION = 0.80;

/** Cooldown seconds after traffic hit before next collision registers. */
export const TRAFFIC_HIT_COOLDOWN      = 1.50;

/** Camera shake duration (seconds) for a traffic hit. */
export const SHAKE_TRAFFIC_DURATION    = 0.35;

/** Camera shake intensity (max px offset) for a traffic hit. */
export const SHAKE_TRAFFIC_INTENSITY   = 20;

/** Post-traffic-hit speed recovery boost duration (seconds). */
export const TRAFFIC_HIT_RECOVERY_TIME = 2.0;

/** Speed recovery boost multiplier after traffic hit. */
export const TRAFFIC_HIT_RECOVERY_BOOST = 2.0;

// ── Color palette — authentic OutRun / Jake Gordon reference values ───────────

export const COLORS =
{
  // Sky gradient (top to horizon)
  SKY_TOP:      '#0066AA',  // deep blue at zenith
  SKY_MID:      '#72D7EE',  // vibrant caribbean blue mid-sky
  SKY_HORIZON:  '#C8EEFF',  // pale haze near the horizon

  // Road surface — both values are identical so the road is one uniform grey.
  // Visual rhythm comes from the alternating grass and rumble bands only.
  ROAD_LIGHT:   '#888888',
  ROAD_DARK:    '#888888',

  // Rumble strips — the classic red/white alternating OutRun kerbing
  RUMBLE_RED:   '#CC0000',  // saturated arcade red — matches the original System 16 kerbing
  RUMBLE_WHITE: '#FFFFFF',  // pure white — stark contrast, no warmth

  // Sand / shoulder — Coconut Beach palette from the Sega System 16 hardware.
  // Two warm alternating tones create the scrolling banding rhythm.
  SAND_LIGHT:  '#EDE0C8',  // warm pale sand (dominant shoulder colour)
  SAND_DARK:   '#E0CEB0',  // slightly deeper amber-tan (alternating stripe)

  // Centre lane dash colour
  LANE:         '#CCCCCC',
} as const;

// ── Road marking width fractions ─────────────────────────────────────────────
//
// All fractions are multiplied by the road half-width (sw) at each segment.
// Values > 1.0 reach OUTSIDE the road edge; values < 1.0 sit INSIDE the road.

/**
 * Outer edge of the kerb rumble strip, as a fraction of road half-width sw.
 * 1.09 places the outer kerb boundary just beyond the road edge — the kerb
 * overlaps the verge slightly, matching the original OutRun kerb geometry.
 */
export const RUMBLE_OUTER_FRAC = 1.09;

/**
 * Inner edge of the kerb rumble strip, as a fraction of road half-width sw.
 * 0.91 places the inner kerb boundary just inside the road edge.
 */
export const RUMBLE_INNER_FRAC = 0.91;

/**
 * Outer edge of the lane-centre dash, as a fraction of road half-width sw.
 * Derived from: centre offset 0.33 + half-dash-width 0.06 = 0.39.
 */
export const LANE_OUTER_FRAC = 0.39;

/**
 * Inner edge of the lane-centre dash, as a fraction of road half-width sw.
 * Derived from: centre offset 0.33 − half-dash-width 0.06 = 0.27.
 */
export const LANE_INNER_FRAC = 0.27;

/**
 * Outer boundary of the OUTER edge track stripe, as a fraction of sw.
 * = cFrac (0.915) + hwFrac (0.045) = 0.960.
 */
export const MARK_ET_OUTER_FRAC = 0.960;

/**
 * Inner boundary of the OUTER edge track stripe, as a fraction of sw.
 * = cFrac (0.915) − hwFrac (0.045) = 0.870.
 */
export const MARK_ET_INNER_FRAC = 0.870;

/**
 * Outer boundary of the INNER edge track stripe, as a fraction of sw.
 * = cFrac (0.790) + hwFrac (0.020) = 0.810.
 */
export const MARK_EN_OUTER_FRAC = 0.810;

/**
 * Inner boundary of the INNER edge track stripe, as a fraction of sw.
 * = cFrac (0.790) − hwFrac (0.020) = 0.770.
 */
export const MARK_EN_INNER_FRAC = 0.770;

// ── Road colour banding ───────────────────────────────────────────────────────

/**
 * Number of consecutive segments that share one colour band before the
 * alternating pattern flips.  Controls the frequency of the red/white rumble
 * strips, the sand/light-sand grass rhythm, and the lane-dash spacing.
 * Higher = longer bands (more spaced out), lower = faster rhythm.
 */
export const COLOR_BAND_PERIOD = 8;

// ── Cloud parallax ────────────────────────────────────────────────────────────

/**
 * Width of the virtual scrolling sky canvas, in multiples of screen width.
 * Clouds are placed across this virtual canvas and wrap seamlessly.
 * 3× means a cloud can be up to 2 full screens off-screen before re-appearing.
 */
export const CLOUD_VIRTUAL_W     = 3.0;

/**
 * Curve-parallax factor for the far cloud layer (upper sky).
 * 0.25 = far clouds shift at 25% of the accumulated skyOffset on curves.
 */
export const CLOUD_PARALLAX_FAR  = 0.25;

/**
 * Curve-parallax factor for the near cloud layer (mid-sky).
 * 0.75 = near clouds shift at 75% of the accumulated skyOffset on curves.
 */
export const CLOUD_PARALLAX_NEAR = 0.75;

/**
 * Per-frame forward drift accumulation at max speed, in virtual-width fractions.
 * Gives the gentle overhead-passing sensation when driving on a straight road.
 * 0.0006 ≈ 46 px/s at 1280px wide — one full virtual wrap takes ~83 seconds.
 */
export const CLOUD_DRIFT_RATE    = 0.0006;

/**
 * Normalized sky-height threshold below which cloud alpha fades to 0.
 * Clouds whose bottom edge falls below this fraction dissolve into the horizon haze,
 * integrating them naturally with the sky gradient.
 */
export const CLOUD_HORIZON_FADE  = 0.72;

// ── Race configuration ────────────────────────────────────────────────────────

/**
 * World units per kilometre, derived from the speed calibration constants.
 * PLAYER_MAX_SPEED wu/s = DISPLAY_MAX_KMH km/h, therefore:
 *   1 km = PLAYER_MAX_SPEED * 3600 / DISPLAY_MAX_KMH world units.
 */
export const WU_PER_KM = PLAYER_MAX_SPEED * 3600 / DISPLAY_MAX_KMH;   // ≈ 132,696

/**
 * Per-difficulty race parameters.  Used by Game to configure traffic density,
 * speed cap, race distance, and road curve/hill scaling at mode start.
 */
export interface RaceConfig
{
  /** Fraction of PLAYER_MAX_SPEED allowed in this mode. */
  maxSpeedRatio:   number;
  /** Number of traffic cars on the road simultaneously. */
  trafficCount:    number;
  /** Race distance in km — tracked via cumulative distanceTravelled. */
  raceLengthKm:    number;
  /** Multiplier applied to each segment's curve value when loading road data. */
  curveScale:      number;
  /** Multiplier applied to each segment's hill (Y-delta) when loading road data. */
  hillScale:       number;
  /** Multiplier applied to the throttle acceleration constants. */
  accelMultiplier: number;
}

/**
 * Seconds the player has to reach the finish line in each difficulty.
 * Calibrated so finishing requires sustained near-max-speed driving with
 * minimal crash time — tight but achievable on a clean run.
 */
export const RACE_TIME_LIMIT: Record<GameMode, number> =
{
  [GameMode.EASY]:   120,   // was 90 — now running the full hard course
  [GameMode.MEDIUM]: 120,
  [GameMode.HARD]:   165,   // longer track — The Cathedral is ~5.3 km
};

// ── Finish-line cinematic (FINISHING phase) ────────────────────────────────────

/** Total duration (seconds) of the finishing cinematic before the GOAL screen. */
export const FINISHING_DURATION = 2.8;

/**
 * Deceleration (WU/s²) applied once the player crosses the finish line.
 * At 13 000 the car stops from max speed in under a second — dramatic but brief.
 */
export const FINISHING_DECEL = 13_000;

// ── Scoring ────────────────────────────────────────────────────────────────────

/** Base points awarded per second of driving (regardless of speed). */
export const SCORE_BASE_PER_SEC       = 100;

/** Additional points per second at maximum speed (0 = stopped, this = max). */
export const SCORE_SPEED_PER_SEC      = 200;

/** Points deducted on any collision hit (clamped at zero). */
export const SCORE_CRASH_PENALTY      = 500;

/** Seconds deducted from the race clock on a traffic car hit (not Barney). */
export const TIME_PENALTY_HIT         = 1;

/** Speed multiplier applied during the Barney afterburner boost. 1.5 = 50% over normal max. */
export const BARNEY_BOOST_MULTIPLIER  = 1.5;

/** Duration in seconds of the Barney afterburner speed boost. */
export const BARNEY_BOOST_DURATION    = 3.0;

/** Bonus points awarded per Barney killed, shown on the GOAL end screen. */
export const BARNEY_KILL_BONUS        = 5_000;

/** Flat bonus awarded the moment the player crosses the finish line. */
export const SCORE_FINISH_BASE        = 50_000;

/** Extra points per second remaining on the clock at finish. */
export const SCORE_TIME_BONUS_PER_SEC = 1_000;

// ── TIME UP physics ────────────────────────────────────────────────────────────

/** Deceleration (WU/s²) when time runs out — stops the car quickly. */
export const TIMEUP_DECEL = 19_800;   // ≈ 3 × OFFROAD_DECEL

export const RACE_CONFIG: Record<GameMode, RaceConfig> =
{
  // EASY — Hard course at full speed; 293 km/h; 4 traffic cars; hills 1.8×.
  // The old Medium — now the entry point.  Sweepers and blind crests, but
  // no survival pressure.  One complete lap of the hard course (≈3.33 km).
  [GameMode.EASY]:
  {
    maxSpeedRatio:   1.0,     // 293 km/h — authentic Testarossa top speed
    trafficCount:    4,
    raceLengthKm:    3.20,   // one loop of the hard road
    curveScale:      1.00,
    hillScale:       1.80,   // 1.8× — hills noticeably rise and drop
    accelMultiplier: 1.00,
  },
  // MEDIUM — Hard course; boosted speed 358 km/h; 8 traffic; hills 2.6×.
  // The old Hard — crests now exceed CAMERA_HEIGHT.  Genuine blind hills.
  [GameMode.MEDIUM]:
  {
    maxSpeedRatio:   1.222,   // ≈ 358 km/h
    trafficCount:    8,
    raceLengthKm:    3.20,
    curveScale:      1.00,
    hillScale:       2.60,   // 2.6× — crests exceed CAMERA_HEIGHT → blind hills
    accelMultiplier: 1.25,
  },
  // HARD — THE CATHEDRAL: Spa-Francorchamps × Nürburgring Nordschleife.
  // A completely new 5.3 km circuit.  410 km/h.  12 traffic.  Hills 3.5×.
  // Eau Rouge / Raidillon → Kemmel → Schwedenkreuz → Das Karussell →
  // Hohe Acht → Pflanzgarten → Kesselchen → home straight.
  // No rest zones.  Every straight feeds directly into the hardest corner.
  [GameMode.HARD]:
  {
    maxSpeedRatio:   1.40,    // ≈ 410 km/h — you are a missile
    trafficCount:    12,
    raceLengthKm:    5.20,   // one loop of The Cathedral
    curveScale:      1.00,
    hillScale:       3.50,   // 3.5× — summit drops exceed 2× CAMERA_HEIGHT
    accelMultiplier: 1.50,
  },
};
