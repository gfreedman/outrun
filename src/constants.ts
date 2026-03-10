export const CAMERA_HEIGHT    = 1000;   // world units
export const ROAD_WIDTH       = 2000;   // world units (half-width)
export const SEGMENT_LENGTH   = 200;    // world units per segment
export const DRAW_DISTANCE    = 100;    // segments rendered per frame (must be < SEGMENT_COUNT)
export const SEGMENT_COUNT    = 200;    // total segments in looping road
export const FOV_DEG          = 100;    // field of view in degrees
export const CAMERA_DEPTH     = 1 / Math.tan((FOV_DEG / 2) * Math.PI / 180);

// Speed values calibrated so road scrolling feels like ~290 km/h at max.
// At MAX_SPEED the player advances ~30 segments/sec (SEGMENT_LENGTH=200).
export const PLAYER_MAX_SPEED   = 6000;  // world units per second
export const PLAYER_ACCEL       = 8000;  // ~0.75s to reach max — snappy
export const PLAYER_DECEL       = 2000;  // coasting decel
export const PLAYER_BRAKE_DECEL = 12000; // hard brake

// Lateral movement: how fast the player crosses the full road width (2×ROAD_WIDTH)
// at top speed. 2.0 = can cross full road in ~1 second at max speed.
export const PLAYER_STEERING    = 2.0;  // road-widths per second at max speed

// Color palette — authentic OutRun / Jake Gordon reference values
export const COLORS = {
  // Sky
  SKY_TOP:      '#0066AA',  // deep blue at zenith
  SKY_MID:      '#72D7EE',  // vibrant caribbean blue
  SKY_HORIZON:  '#C8EEFF',  // pale near horizon

  // Road — subtle alternation; visual rhythm comes from rumble + grass
  ROAD_LIGHT:   '#6B6B6B',
  ROAD_DARK:    '#696969',

  // Rumble strips — iconic OutRun red/white
  RUMBLE_RED:   '#CC0000',
  RUMBLE_WHITE: '#FFFFFF',

  // Grass — saturated arcade greens
  GRASS_LIGHT:  '#10AA10',
  GRASS_DARK:   '#009A00',

  // Lane dashes
  LANE:         '#CCCCCC',
} as const;
