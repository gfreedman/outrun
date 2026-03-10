import { RoadSegment, ProjectedPoint, SegmentColor } from './types';
import { SEGMENT_COUNT, SEGMENT_LENGTH, COLORS, ROAD_WIDTH } from './constants';

function makeProjectedPoint(worldZ: number): ProjectedPoint {
  return {
    world:  { x: 0, y: 0, z: worldZ },
    screen: { x: 0, y: 0, w: 0, scale: 0 },
  };
}

// Grass/rumble bands: groups of 8 segments → ~3.75 transitions/sec at max speed (no flicker).
// Lane dashes: groups of 4 → shorter dashes at double frequency, matching OutRun's centre-line look.
function makeColor(i: number): SegmentColor {
  const band = Math.floor(i / 8) % 2 === 0;
  const dash = Math.floor(i / 4) % 2 === 0;
  return {
    road:   band ? COLORS.ROAD_LIGHT  : COLORS.ROAD_DARK,
    grass:  band ? COLORS.GRASS_LIGHT : COLORS.GRASS_DARK,
    rumble: band ? COLORS.RUMBLE_RED  : COLORS.RUMBLE_WHITE,
    lane:   dash ? COLORS.LANE        : '',
  };
}

export class Road {
  segments: RoadSegment[] = [];

  constructor() {
    this.buildStraight(SEGMENT_COUNT);
  }

  private buildStraight(count: number): void {
    for (let i = 0; i < count; i++) {
      const seg: RoadSegment = {
        index: i,
        p1: makeProjectedPoint(i * SEGMENT_LENGTH),
        p2: makeProjectedPoint((i + 1) * SEGMENT_LENGTH),
        curve: 0,
        color: makeColor(i),
      };

      this.segments.push(seg);
    }
  }

  findSegment(playerZ: number): RoadSegment {
    const idx = Math.floor(playerZ / SEGMENT_LENGTH) % SEGMENT_COUNT;
    return this.segments[(idx + SEGMENT_COUNT) % SEGMENT_COUNT];
  }
}
