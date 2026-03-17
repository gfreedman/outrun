/**
 * constants.ts
 *
 * Every magic number in the game lives here.
 * Changing a value here affects all systems that import it,
 * so this is the one file a designer tweaks to re-tune the feel.
 */

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
 * Models the feel of hydraulic brake fluid pressurising under hard braking.
 */
export const PLAYER_BRAKE_RAMP  = 0.10;

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
 * Prevents an instant snap back to top speed by blending the cap away gradually.
 */
export const OFFROAD_RECOVERY_TIME  = 1.5;

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
 */
export const ROAD_CURVE  = { NONE: 0, EASY: 2, MEDIUM: 4, HARD: 6 } as const;

/**
 * Vertical hill height values, in world units total rise/fall for a section.
 * Compared against CAMERA_HEIGHT (1000), so HIGH (60) is a 6% grade — noticeable
 * at close range but gentle at distance, matching OutRun's rolling hills.
 */
export const ROAD_HILL   = { NONE: 0, LOW: 20, MEDIUM: 40, HIGH: 60 } as const;

/**
 * How hard curves push the player's car outward (centrifugal drift).
 * Formula: playerX -= curve * speedPercent * CENTRIFUGAL * dt
 * At 0.3, a hard curve (6) at full speed drifts the car at ~1.8 road-widths/sec.
 * Steering authority at full speed is ~1.0 road-widths/sec after grip reduction,
 * creating the tight on-the-limit feel of 290 km/h cornering.
 */
export const CENTRIFUGAL    = 0.35;

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

// ── Hit detection — lateral hitbox half-widths (world units) ─────────────────
export const HITBOX_CACTUS    = 450;
export const HITBOX_PALM      = 550;
export const HITBOX_BILLBOARD = 700;
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
export const HIT_GLANCE_SPEED_MULT    = 0.87;
export const HIT_GLANCE_BUMP          = 0.04;
export const HIT_GLANCE_COOLDOWN      = 0.30;

// ── Smack (palm / billboard) ──────────────────────────────────────────────────
export const HIT_SMACK_SPEED_MULT     = 0.52;
export const HIT_SMACK_SPEED_CAP      = 0.55;   // fraction of PLAYER_MAX_SPEED
export const HIT_SMACK_BUMP           = 0.14;
export const HIT_SMACK_COOLDOWN       = 0.85;
export const HIT_SMACK_RECOVERY_BOOST = 1.5;    // accel multiplier post-hit
export const HIT_SMACK_RECOVERY_TIME  = 1.2;    // seconds of boosted recovery

// ── Crunch (house) ────────────────────────────────────────────────────────────
export const HIT_CRUNCH_SPEED_CAP      = 0.08;  // fraction of PLAYER_MAX_SPEED
export const HIT_CRUNCH_GRIND_DECEL    = 7800;  // wu/s² sustained drag
export const HIT_CRUNCH_GRIND_TIME     = 2.0;   // seconds of grind
export const HIT_CRUNCH_BUMP           = 0.22;
export const HIT_CRUNCH_COOLDOWN       = 1.50;
export const HIT_CRUNCH_RECOVERY_BOOST = 2.0;
export const HIT_CRUNCH_RECOVERY_TIME  = 2.0;

// ── Camera shake ──────────────────────────────────────────────────────────────
export const SHAKE_GLANCE_INTENSITY   = 8;      // max screen offset in px
export const SHAKE_GLANCE_DURATION    = 0.15;
export const SHAKE_SMACK_INTENSITY    = 28;
export const SHAKE_SMACK_DURATION     = 0.50;
export const SHAKE_CRUNCH_INTENSITY   = 18;
export const SHAKE_CRUNCH_DURATION    = 2.00;

// ── Speed floor during any collision ─────────────────────────────────────────
/** The car never drops below this fraction of max speed from a hit. Law 2. */
export const HIT_SPEED_FLOOR          = 0.04;   // always keeps 4% — feels alive

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
  RUMBLE_RED:   '#CC0000',
  RUMBLE_WHITE: '#FFFFFF',

  // Sand / shoulder — Coconut Beach palette from the Sega System 16 hardware.
  // Two warm alternating tones create the scrolling banding rhythm.
  SAND_LIGHT:  '#EDE0C8',  // warm pale sand (dominant shoulder colour)
  SAND_DARK:   '#E0CEB0',  // slightly deeper amber-tan (alternating stripe)

  // Centre lane dash colour
  LANE:         '#CCCCCC',
} as const;
