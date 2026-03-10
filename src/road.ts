import { RoadSegment, ProjectedPoint, SegmentColor } from './types';
import { SEGMENT_COUNT, SEGMENT_LENGTH, COLORS, ROAD_WIDTH } from './constants';

function makeProjectedPoint(worldZ: number): ProjectedPoint {
  return {
    world:  { x: 0, y: 0, z: worldZ },
    screen: { x: 0, y: 0, w: 0, scale: 0 },
  };
}

function makeColor(even: boolean): SegmentColor {
  return even
    ? { road: COLORS.ROAD_LIGHT, grass: COLORS.GRASS_LIGHT, rumble: COLORS.RUMBLE_RED,   lane: COLORS.LANE }
    : { road: COLORS.ROAD_DARK,  grass: COLORS.GRASS_DARK,  rumble: COLORS.RUMBLE_WHITE, lane: '' };
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
        color: makeColor(Math.floor(i / 2) % 2 === 0),
      };

      this.segments.push(seg);
    }
  }

  findSegment(playerZ: number): RoadSegment {
    const idx = Math.floor(playerZ / SEGMENT_LENGTH) % SEGMENT_COUNT;
    return this.segments[(idx + SEGMENT_COUNT) % SEGMENT_COUNT];
  }
}
