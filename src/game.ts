import { Road } from './road';
import { Renderer } from './renderer';
import { InputManager } from './input';
import { SpriteLoader } from './sprites';
import {
  PLAYER_MAX_SPEED,
  PLAYER_ACCEL_LOW, PLAYER_ACCEL_MID,
  PLAYER_COAST_RATE,
  PLAYER_BRAKE_MAX, PLAYER_BRAKE_RAMP,
  PLAYER_STEERING,
  OFFROAD_MAX_RATIO, OFFROAD_DECEL, OFFROAD_RECOVERY_TIME,
  SEGMENT_LENGTH, DRAW_DISTANCE,
  ROAD_WIDTH,
  CENTRIFUGAL,
} from './constants';

export class Game {
  private road: Road;
  private renderer: Renderer;
  private input: InputManager;

  private playerZ = 0;
  private playerX = 0;  // normalized: -1 = left road edge, 0 = center, +1 = right edge
  private speed   = 0;
  private steerAngle       = 0;   // continuous -1…+1
  private brakeHeld        = 0;   // seconds brake held (ramp buildup)
  private offRoad          = false;
  private offRoadRecovery  = 1;   // 0 = just returned to asphalt, 1 = fully recovered
  private jitterY          = 0;   // horizon pixel offset for bumpy terrain feel

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
    const trackLength = this.road.count * SEGMENT_LENGTH;
    const speedRatio  = this.speed / PLAYER_MAX_SPEED;

    // ── throttle / brake — "Alive & Kinetic" three-phase physics ──
    if (input.isDown('ArrowUp')) {
      // Phase 1 (0–15%): smoothstep launch weight LOW→MID (tyres finding grip)
      // Phase 2 (15–80%): flat-out MID thrust
      // Phase 3 (80–100%): MID tapers linearly to 0 (fighting aero drag)
      let accel: number;
      if (speedRatio < 0.15) {
        const t = speedRatio / 0.15;
        const smooth = t * t * (3 - 2 * t);
        accel = PLAYER_ACCEL_LOW + (PLAYER_ACCEL_MID - PLAYER_ACCEL_LOW) * smooth;
      } else if (speedRatio < 0.80) {
        accel = PLAYER_ACCEL_MID;
      } else {
        accel = PLAYER_ACCEL_MID * (1 - speedRatio) / 0.20;
      }
      this.speed     += accel * dt;
      this.brakeHeld  = 0;
    } else if (input.isDown('ArrowDown')) {
      // Progressive ease-in² buildup over BRAKE_RAMP seconds
      this.brakeHeld  = Math.min(this.brakeHeld + dt, PLAYER_BRAKE_RAMP);
      const t         = this.brakeHeld / PLAYER_BRAKE_RAMP;
      this.speed     -= PLAYER_BRAKE_MAX * t * t * dt;
    } else {
      // Coast: linearly scales from 50% COAST_RATE at rest to 100% at max speed.
      // Gives ~2.4s stop from 100 km/h while preserving ~4.6s stop from max.
      const coastRate = PLAYER_COAST_RATE * (0.5 + 0.5 * speedRatio);
      this.speed     -= coastRate * dt;
      this.brakeHeld  = Math.max(0, this.brakeHeld - dt * 4);
    }
    this.speed = Math.max(0, Math.min(this.speed, PLAYER_MAX_SPEED));

    // ── steering: faster at speed, minimum floor so player can always escape grass ──
    // playerX > 1 or < -1 means off-road; allow up to ±2 before hard wall
    // Floor of 0.3 ensures steering works even when off-road friction kills speed.
    const steerRatio = Math.max(0.3, speedRatio);
    // Grip/understeer: steering authority tapers at speed (tyres lose lateral grip).
    // At rest: full authority. At max speed: 50% (quadratic roll-off).
    // Combined with centrifugal force this creates the "on the edge" feel at 290 km/h.
    const gripFactor = Math.max(0.5, 1 - speedRatio * speedRatio * 0.5);
    if (input.isDown('ArrowLeft'))  this.playerX -= PLAYER_STEERING * steerRatio * gripFactor * dt;
    if (input.isDown('ArrowRight')) this.playerX += PLAYER_STEERING * steerRatio * gripFactor * dt;
    this.playerX = Math.max(-2, Math.min(2, this.playerX));

    // ── centrifugal force: curves push the player sideways ──
    const playerSegment = this.road.findSegment(this.playerZ);
    const speedPercent  = this.speed / PLAYER_MAX_SPEED;
    this.playerX -= playerSegment.curve * speedPercent * CENTRIFUGAL * dt;

    // steerAngle: ramp toward ±1 while key held, spring back when released
    const STEER_RATE = 3.0; // full sweep in ~0.33s
    if (input.isDown('ArrowLeft'))       this.steerAngle -= STEER_RATE * dt;
    else if (input.isDown('ArrowRight')) this.steerAngle += STEER_RATE * dt;
    else                                 this.steerAngle *= Math.max(0, 1 - STEER_RATE * dt * 4);
    this.steerAngle = Math.max(-1, Math.min(1, this.steerAngle));

    // ── off-road friction ──
    this.offRoad = Math.abs(this.playerX) > 1;
    if (this.offRoad) {
      // Grass drag decelerates from whatever speed was carried in.
      // No instant snap — high-speed entry travels further before slowing.
      // OFFROAD_DECEL (3500) > PLAYER_ACCEL_MID (1550) so the car can never
      // accelerate on grass; no explicit cap needed.
      this.speed -= OFFROAD_DECEL * dt;
      this.offRoadRecovery = 0;
      // Bumpy horizon jitter — random per-frame oscillation simulates rough terrain
      this.jitterY = (Math.random() - 0.5) * 8;
    } else {
      // Gradually restore full speed cap after returning to asphalt
      this.offRoadRecovery = Math.min(1, this.offRoadRecovery + dt / OFFROAD_RECOVERY_TIME);
      if (this.offRoadRecovery < 1) {
        const recoveryMax = PLAYER_MAX_SPEED * (OFFROAD_MAX_RATIO + (1 - OFFROAD_MAX_RATIO) * this.offRoadRecovery);
        this.speed = Math.min(this.speed, recoveryMax);
      }
      this.jitterY = 0;
    }
    this.speed = Math.max(0, Math.min(this.speed, PLAYER_MAX_SPEED));

    // ── advance position ──
    this.playerZ = ((this.playerZ + this.speed * dt) % trackLength + trackLength) % trackLength;
  }

  private draw(): void {
    const { renderer, road, w, h } = this;
    renderer.render(
      road.segments,
      road.count,
      this.playerZ,
      this.playerX,
      DRAW_DISTANCE,
      w, h,
      this.speed,
      this.steerAngle,
      this.jitterY,
    );
  }
}
