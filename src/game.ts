import { Road } from './road';
import { Renderer } from './renderer';
import { InputManager } from './input';
import { SpriteLoader } from './sprites';
import {
  PLAYER_MAX_SPEED, PLAYER_ACCEL, PLAYER_DECEL, PLAYER_BRAKE_DECEL,
  PLAYER_STEERING,
  SEGMENT_COUNT, SEGMENT_LENGTH, DRAW_DISTANCE,
  ROAD_WIDTH,
} from './constants';

export class Game {
  private road: Road;
  private renderer: Renderer;
  private input: InputManager;

  private playerZ = 0;
  private playerX = 0;  // normalized: -1 = left road edge, 0 = center, +1 = right edge
  private speed   = 0;
  private steerDir = 0; // -1 / 0 / +1

  private lastTimestamp = 0;
  private rafId = 0;

  // logical canvas size (set by main.ts)
  w = 0;
  h = 0;

  constructor(canvas: HTMLCanvasElement) {
    const carSprites  = new SpriteLoader('sprites/player_car_sprites_1x.png');
    const roadSprites = new SpriteLoader('sprites/sprite_sheet_transparent.png');
    this.road     = new Road();
    this.renderer = new Renderer(canvas, carSprites, roadSprites);
    this.input    = new InputManager();
  }

  start(): void {
    this.lastTimestamp = performance.now();
    this.rafId = requestAnimationFrame(this.loop);
  }

  stop(): void {
    cancelAnimationFrame(this.rafId);
  }

  private loop = (timestamp: number): void => {
    const dt = Math.min((timestamp - this.lastTimestamp) / 1000, 0.05);
    this.lastTimestamp = timestamp;
    this.update(dt);
    this.draw();
    this.rafId = requestAnimationFrame(this.loop);
  };

  private update(dt: number): void {
    const { input } = this;
    const trackLength = SEGMENT_COUNT * SEGMENT_LENGTH;
    const speedRatio  = this.speed / PLAYER_MAX_SPEED;

    // ── throttle / brake ──
    if (input.isDown('ArrowUp')) {
      this.speed += PLAYER_ACCEL * dt;
    } else if (input.isDown('ArrowDown')) {
      this.speed -= PLAYER_BRAKE_DECEL * dt;
    } else {
      this.speed -= PLAYER_DECEL * dt;
    }
    this.speed = Math.max(0, Math.min(this.speed, PLAYER_MAX_SPEED));

    // ── steering: faster at speed, zero when stopped ──
    if (input.isDown('ArrowLeft'))  this.playerX -= PLAYER_STEERING * speedRatio * dt;
    if (input.isDown('ArrowRight')) this.playerX += PLAYER_STEERING * speedRatio * dt;
    this.playerX = Math.max(-1, Math.min(1, this.playerX));

    // steerDir drives car sprite frame selection
    this.steerDir = input.isDown('ArrowLeft') ? -1 : input.isDown('ArrowRight') ? 1 : 0;

    // ── advance position ──
    this.playerZ = ((this.playerZ + this.speed * dt) % trackLength + trackLength) % trackLength;
  }

  private draw(): void {
    const { renderer, road, w, h } = this;
    renderer.render(
      road.segments,
      this.playerZ,
      this.playerX,
      DRAW_DISTANCE,
      w, h,
      this.speed,
      this.steerDir,
    );
  }
}
