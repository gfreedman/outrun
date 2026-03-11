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
 * Calibrated so the road scrolls at roughly 450 km/h (≈45 segments/sec).
 */
export const PLAYER_MAX_SPEED   = 9000;

// ── Acceleration — three-phase "Alive & Kinetic" curve ───────────────────────

/**
 * Acceleration at low speed (0–15% of max).
 * Tyres are still finding grip so power delivery is limited.
 * A smoothstep ramp blends from ACCEL_LOW up to ACCEL_MID over this band.
 */
export const PLAYER_ACCEL_LOW   = 1400;

/**
 * Peak acceleration during the main thrust band (15–80% of max).
 * Also used as the starting point of the terminal taper (80–100%).
 */
export const PLAYER_ACCEL_MID   = 2800;

// ── Coasting (lift-off deceleration) ─────────────────────────────────────────

/**
 * Deceleration rate when the player lifts off the throttle, in world units/s².
 * Scales with current speed: 50% at rest → 100% at max speed.
 * Gives a natural aerodynamic-drag feel without feeling sticky at low speeds.
 */
export const PLAYER_COAST_RATE  = 1300;

// ── Braking ───────────────────────────────────────────────────────────────────

/**
 * Maximum braking force, in world units/s².
 * Applied at full pedal pressure after the ramp-up period.
 */
export const PLAYER_BRAKE_MAX   = 4800;

/**
 * How long (seconds) the brakes take to develop full force.
 * Models the feel of hydraulic brake fluid pressurising under hard braking.
 */
export const PLAYER_BRAKE_RAMP  = 0.18;

// ── Steering ─────────────────────────────────────────────────────────────────

/**
 * How fast the player can move laterally across the full road width,
 * measured in road-widths per second at maximum speed.
 * 2.0 = the car can cross the entire road in roughly one second at top speed.
 */
export const PLAYER_STEERING    = 2.0;

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
export const OFFROAD_DECEL          = 5500;

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
export const CENTRIFUGAL    = 0.5;

/**
 * How fast the sky background shifts horizontally when on a curve.
 * Accumulated each frame: skyOffset += PARALLAX_SKY * segmentCurve * speedPercent.
 * Ready for future sky texture layers; currently drives the skyOffset accumulator.
 */
export const PARALLAX_SKY   = 0.001;

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

  // Grass verges — saturated arcade greens that alternate in bands
  GRASS_LIGHT:  '#10AA10',
  GRASS_DARK:   '#009A00',

  // Centre lane dash colour
  LANE:         '#CCCCCC',
} as const;
