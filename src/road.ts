import { RoadSegment, ProjectedPoint, SegmentColor } from './types';
import { SEGMENT_LENGTH, COLORS, ROAD_LENGTH, ROAD_CURVE, ROAD_HILL } from './constants';

// ── easing helpers ────────────────────────────────────────────────────────────

function easeIn(a: number, b: number, percent: number): number {
  return a + (b - a) * Math.pow(percent, 2);
}
function easeOut(a: number, b: number, percent: number): number {
  return a + (b - a) * (1 - Math.pow(1 - percent, 2));
}
function easeInOut(a: number, b: number, percent: number): number {
  return a + (b - a) * ((-Math.cos(percent * Math.PI) / 2) + 0.5);
}

// ── projected point factory ───────────────────────────────────────────────────

function makeProjectedPoint(worldZ: number, worldY: number = 0): ProjectedPoint {
  return {
    world:  { x: 0, y: worldY, z: worldZ },
    screen: { x: 0, y: 0, w: 0, scale: 0 },
  };
}

// Grass/rumble: groups of 8 → ~3.75 transitions/sec at max speed.
// Lane dashes: groups of 4 → double frequency, matching OutRun centre-line look.
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

// ── Road ──────────────────────────────────────────────────────────────────────

export class Road {
  segments: RoadSegment[] = [];
  private lastY = 0;

  constructor() {
    this.resetRoad();
  }

  get count(): number {
    return this.segments.length;
  }

  // ── core builder ─────────────────────────────────────────────────────────

  private addSegment(curve: number, y: number): void {
    const i = this.segments.length;
    const seg: RoadSegment = {
      index: i,
      p1: makeProjectedPoint(i * SEGMENT_LENGTH, this.lastY),
      p2: makeProjectedPoint((i + 1) * SEGMENT_LENGTH, y),
      curve,
      color: makeColor(i),
    };
    this.lastY = y;
    this.segments.push(seg);
  }

  // Adds a road section with eased entry, constant hold, and eased exit.
  // curve and hill are the TARGET values during the hold phase.
  private addRoad(
    enter: number, hold: number, leave: number,
    curve: number, hill: number,
  ): void {
    const startY = this.lastY;
    const endY   = startY + hill; // hill is total world-unit height change (NOT per-segment)

    for (let n = 0; n < enter; n++) {
      this.addSegment(
        easeIn(0, curve, n / enter),
        easeInOut(startY, endY, n / (enter + hold + leave)),
      );
    }
    for (let n = 0; n < hold; n++) {
      this.addSegment(
        curve,
        easeInOut(startY, endY, (enter + n) / (enter + hold + leave)),
      );
    }
    for (let n = 0; n < leave; n++) {
      this.addSegment(
        easeIn(curve, 0, n / leave),
        easeInOut(startY, endY, (enter + hold + n) / (enter + hold + leave)),
      );
    }
  }

  // ── convenience methods ───────────────────────────────────────────────────

  private addStraight(length: number = ROAD_LENGTH.MEDIUM): void {
    this.addRoad(1, length, 1, ROAD_CURVE.NONE, ROAD_HILL.NONE);
  }

  private addCurve(
    length: number = ROAD_LENGTH.MEDIUM,
    curve: number  = ROAD_CURVE.MEDIUM,
    hill: number   = ROAD_HILL.NONE,
  ): void {
    this.addRoad(length, length, length, curve, hill);
  }

  private addHill(
    length: number = ROAD_LENGTH.MEDIUM,
    hill: number   = ROAD_HILL.MEDIUM,
  ): void {
    this.addRoad(length, length, length, ROAD_CURVE.NONE, hill);
  }

  private addSCurves(): void {
    this.addRoad(ROAD_LENGTH.MEDIUM, ROAD_LENGTH.MEDIUM, ROAD_LENGTH.MEDIUM,
      -ROAD_CURVE.EASY, ROAD_HILL.NONE);
    this.addRoad(ROAD_LENGTH.MEDIUM, ROAD_LENGTH.MEDIUM, ROAD_LENGTH.MEDIUM,
       ROAD_CURVE.MEDIUM, ROAD_HILL.NONE);
    this.addRoad(ROAD_LENGTH.MEDIUM, ROAD_LENGTH.MEDIUM, ROAD_LENGTH.MEDIUM,
      -ROAD_CURVE.HARD, ROAD_HILL.NONE);
    this.addRoad(ROAD_LENGTH.MEDIUM, ROAD_LENGTH.MEDIUM, ROAD_LENGTH.MEDIUM,
       ROAD_CURVE.EASY, ROAD_HILL.NONE);
    this.addRoad(ROAD_LENGTH.MEDIUM, ROAD_LENGTH.MEDIUM, ROAD_LENGTH.MEDIUM,
      -ROAD_CURVE.EASY, ROAD_HILL.NONE);
  }

  // ── road layout: Coconut Beach rhythm ────────────────────────────────────

  private resetRoad(): void {
    this.segments = [];
    this.lastY    = 0;

    // 1. Opening straight — build speed
    this.addStraight(ROAD_LENGTH.SHORT);

    // 2. Gentle right curve — introduce turning
    this.addCurve(ROAD_LENGTH.MEDIUM, ROAD_CURVE.EASY);

    // 3. Short straight
    this.addStraight(ROAD_LENGTH.SHORT);

    // 4. Gentle left curve
    this.addCurve(ROAD_LENGTH.MEDIUM, -ROAD_CURVE.EASY);

    // 5. Uphill climb — first "ooh" moment
    this.addHill(ROAD_LENGTH.MEDIUM, ROAD_HILL.MEDIUM);

    // 6. Brief crest straight
    this.addStraight(ROAD_LENGTH.SHORT);

    // 7. Downhill descent
    this.addHill(ROAD_LENGTH.MEDIUM, -ROAD_HILL.MEDIUM);

    // 8. S-curves — the skill test
    this.addSCurves();

    // 9. Long straight with rolling gentle hills — breathing room
    this.addRoad(ROAD_LENGTH.LONG, ROAD_LENGTH.LONG, ROAD_LENGTH.LONG,
      ROAD_CURVE.NONE, ROAD_HILL.LOW);
    this.addRoad(ROAD_LENGTH.LONG, ROAD_LENGTH.LONG, ROAD_LENGTH.LONG,
      ROAD_CURVE.NONE, -ROAD_HILL.LOW);

    // 10. Hard right curve OVER a hill — the real test (can't see exit)
    this.addCurve(ROAD_LENGTH.MEDIUM, ROAD_CURVE.HARD, ROAD_HILL.HIGH);

    // 11. Downhill straight — reward/relief
    this.addHill(ROAD_LENGTH.MEDIUM, -ROAD_HILL.MEDIUM);
    this.addStraight(ROAD_LENGTH.SHORT);

    // 12. Medium left curve
    this.addCurve(ROAD_LENGTH.MEDIUM, -ROAD_CURVE.MEDIUM);

    // 13. Hard right curve
    this.addCurve(ROAD_LENGTH.MEDIUM, ROAD_CURVE.HARD);

    // 14. Hard left curve
    this.addCurve(ROAD_LENGTH.MEDIUM, -ROAD_CURVE.HARD);

    // 15. Long finish straight
    this.addStraight(ROAD_LENGTH.LONG);

    this.placePalmTrees();
  }

  // ── roadside sprite placement ─────────────────────────────────────────────

  private placePalmTrees(): void {
    const ROAD_EDGE = 2200; // world units from center to tree (just outside ROAD_WIDTH=2000)

    for (let i = 0; i < this.segments.length; i++) {
      const seg = this.segments[i];
      const onCurve = Math.abs(seg.curve) > ROAD_CURVE.NONE;

      if (onCurve) {
        // Denser on curves — visual cue; place both sides every 4 segments
        if (i % 4 === 0) {
          seg.sprites = [
            { id: 'PALM', worldX: -ROAD_EDGE },
            { id: 'PALM', worldX:  ROAD_EDGE },
          ];
        }
      } else {
        // Sparser on straights, alternating sides every 8 segments
        if (i % 8 === 0) {
          const side = (Math.floor(i / 8) % 2 === 0) ? -ROAD_EDGE : ROAD_EDGE;
          seg.sprites = [{ id: 'PALM', worldX: side }];
        }
      }
    }
  }

  // ── lookup ────────────────────────────────────────────────────────────────

  findSegment(playerZ: number): RoadSegment {
    const n = this.count;
    const idx = Math.floor(playerZ / SEGMENT_LENGTH) % n;
    return this.segments[(idx + n) % n];
  }
}
