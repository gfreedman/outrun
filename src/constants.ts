export const CAMERA_HEIGHT    = 1000;   // world units
export const ROAD_WIDTH       = 2000;   // world units (half-width)
export const SEGMENT_LENGTH   = 200;    // world units per segment
export const DRAW_DISTANCE    = 100;    // segments rendered per frame (must be < SEGMENT_COUNT)
export const SEGMENT_COUNT    = 200;    // total segments in looping road
export const FOV_DEG          = 100;    // field of view in degrees
export const CAMERA_DEPTH     = 1 / Math.tan((FOV_DEG / 2) * Math.PI / 180);

// Speed values calibrated so road scrolling feels like ~290 km/h at max.
// At MAX_SPEED the player advances ~30 segments/sec (SEGMENT_LENGTH=200).
export const PLAYER_MAX_SPEED    = 6000;  // world units per second at 293 km/h

// ── Acceleration — three-phase "Alive & Kinetic" curve ──────────────────────
// Phase 1 (0–15% speed): launch weight — smoothstep from LOW→MID, like tyres
//   finding grip. Matches OutRun's half-rate at low speed from Cannonball source.
// Phase 2 (15–80% speed): main thrust band — flat-out power delivery (~2.6s).
// Phase 3 (80–100% speed): terminal taper — ACCEL_MID ramps linearly to 0 at
//   max, simulating the car fighting aerodynamic drag. (~1.5s, asymptotic feel).
// Total 0→max: ~5.3s (original arcade: ~5.5s). ✓
export const PLAYER_ACCEL_LOW   = 850;   // u/s, phase 1 launch floor
export const PLAYER_ACCEL_MID   = 1550;  // u/s, phase 2 peak (and phase 3 start)

// ── Coast (lift-off) ─────────────────────────────────────────────────────────
// Speed-proportional: at max the wind fights back at full COAST_RATE;
// below 20% speed a floor prevents the car feeling "sticky" at low speed.
// Matches OutRun's ~60 km/h/s deceleration at high speed.
export const PLAYER_COAST_RATE  = 1300;  // u/s at max speed, scales with speedRatio

// ── Braking — progressive ease-in² buildup ──────────────────────────────────
// First press feels like squeezing through resistance; full bite after RAMP secs.
// 293→0 in ~1.4s at full developed force (original arcade: ~1.2s). ✓
export const PLAYER_BRAKE_MAX   = 4800;  // u/s at fully-developed brake force
export const PLAYER_BRAKE_RAMP  = 0.18;  // s to ramp from first press to full force

// Lateral movement: how fast the player crosses the full road width (2×ROAD_WIDTH)
// at top speed. 2.0 = can cross full road in ~1 second at max speed.
export const PLAYER_STEERING    = 2.0;  // road-widths per second at max speed

// ── Off-road friction ────────────────────────────────────────────────────────
// Triggered when |playerX| > 1 (outside the ±1 normalised road edge).
// Speed is hard-capped at OFFROAD_MAX_RATIO × MAX and extra friction drags it
// there quickly. On return to asphalt, the cap lifts over RECOVERY_TIME seconds.
export const OFFROAD_MAX_RATIO     = 0.30;   // 30% of max speed on grass
export const OFFROAD_DECEL         = 3500;   // u/s² extra friction on grass
export const OFFROAD_RECOVERY_TIME = 1.5;    // seconds to recover full speed

// Color palette — authentic OutRun / Jake Gordon reference values
export const COLORS = {
  // Sky
  SKY_TOP:      '#0066AA',  // deep blue at zenith
  SKY_MID:      '#72D7EE',  // vibrant caribbean blue
  SKY_HORIZON:  '#C8EEFF',  // pale near horizon

  // Road — single uniform gray. No alternation; all rhythm from grass+rumble bands.
  ROAD_LIGHT:   '#888888',
  ROAD_DARK:    '#888888',

  // Rumble strips — iconic OutRun red/white
  RUMBLE_RED:   '#CC0000',
  RUMBLE_WHITE: '#FFFFFF',

  // Grass — saturated arcade greens
  GRASS_LIGHT:  '#10AA10',
  GRASS_DARK:   '#009A00',

  // Lane dashes
  LANE:         '#CCCCCC',
} as const;
