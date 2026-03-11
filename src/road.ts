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

  // ── road layout: graded difficulty test track ────────────────────────────
  // Designed to showcase all curve/hill combinations and stress-test the
  // grip/understeer mechanic. ~550 segments ≈ 18s at max speed.

  private resetRoad(): void {
    this.segments = [];
    this.lastY    = 0;

    // Shorthand so the layout reads clearly
    const r = (enter: number, hold: number, leave: number, curve: number, hill: number) =>
      this.addRoad(enter, hold, leave, curve, hill);

    const CE = ROAD_CURVE.EASY;   // 2
    const CM = ROAD_CURVE.MEDIUM; // 4
    const CH = ROAD_CURVE.HARD;   // 6
    const HL = ROAD_HILL.LOW;     // 20
    const HM = ROAD_HILL.MEDIUM;  // 40

    // ── 1. Opening straight ────────────────────────────────────────────────
    r(1, 20, 1, 0, 0);                     // 22 segs — build speed

    // ── 2. Easy intro chicane (right → left) ──────────────────────────────
    r(10, 15, 10, CE, 0);                  // 35 easy right
    r(10, 15, 10, -CE, 0);                 // 35 easy left
    r(1, 12, 1, 0, 0);                     // 14 straight

    // ── 3. Medium corners ─────────────────────────────────────────────────
    r(10, 15, 10, CM, 0);                  // 35 medium right
    r(1, 10, 1, 0, 0);                     // 12 straight
    r(10, 15, 10, -CM, 0);                 // 35 medium left
    r(1, 12, 1, 0, 0);                     // 14 straight

    // ── 4. Hill + curve combo ─────────────────────────────────────────────
    r(10, 15, 10, 0, HM);                  // 35 uphill
    r(10, 15, 10, CE, -HM);                // 35 downhill right — crest blind exit
    r(1, 10, 1, 0, 0);                     // 12 straight

    // ── 5. Hard corners — grip test ───────────────────────────────────────
    r(10, 15, 10, CH, 0);                  // 35 hard right
    r(10, 15, 10, -CH, 0);                 // 35 hard left chicane
    r(1, 10, 1, 0, 0);                     // 12 straight breathing room
    r(10, 15, 10, CH, HL);                 // 35 hard right over low hill
    r(10, 15, 10, 0, -HM);                 // 35 downhill relief
    r(1, 12, 1, 0, 0);                     // 14 straight

    // ── 6. S-curve section ────────────────────────────────────────────────
    r(10, 15, 10, -CE, 0);                 // 35 easy left
    r(10, 15, 10, CM, 0);                  // 35 medium right
    r(10, 15, 10, -CH, 0);                 // 35 hard left
    r(10, 15, 10, CE, 0);                  // 35 easy right
    r(1, 10, 1, 0, 0);                     // 12 straight

    // ── 7. Long finish straight ───────────────────────────────────────────
    r(1, 50, 1, 0, 0);                     // 52 segs — relief & prep for lap

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
