export interface WorldPoint {
  x: number;
  y: number;
  z: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
  w: number;
  scale: number;
}

export interface ProjectedPoint {
  world: WorldPoint;
  screen: ScreenPoint;
}

export interface SegmentColor {
  road: string;
  grass: string;
  rumble: string;
  lane: string;
}

export interface SpriteInstance {
  id: string;      // SpriteId value
  worldX: number;  // world-unit offset from road centre (positive = right)
}

export interface RoadSegment {
  index: number;
  p1: ProjectedPoint;
  p2: ProjectedPoint;
  curve: number;
  color: SegmentColor;
  sprites?: SpriteInstance[];
}

export enum GamePhase {
  PLAYING,
}
