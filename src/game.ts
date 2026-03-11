/**
 * game.ts
 *
 * The main game loop and player physics simulation.
 *
 * Every animation frame this class:
 *   1. Reads player input (arrow keys).
 *   2. Runs physics: throttle, braking, coasting, steering, centrifugal force,
 *      off-road friction.
 *   3. Advances the player's position along the track.
 *   4. Hands everything to the Renderer to draw.
 *
 * ── Coordinate system ──────────────────────────────────────────────────────
 *
 * playerZ (depth):
 *   Increases as the player moves forward.  Wraps modulo trackLength so the
 *   road loops seamlessly.  Unit: world units.
 *
 * playerX (lateral):
 *   0 = road centre.  ±1 = road edges.  ±2 = hard wall (clamped).
 *   |playerX| > 1 means the car is on the grass (off-road).
 *   Normalised so the physics values are independent of road width.
 *
 * ── Physics model overview ─────────────────────────────────────────────────
 *
 * Throttle — three-phase "Alive & Kinetic" curve:
 *   0–15%  speed: smoothstep ramp LOW→MID (tyres finding grip on launch).
 *   15–80% speed: flat-out MID thrust (peak power band).
 *   80–100%speed: MID tapers linearly to 0 (fighting aerodynamic drag).
 *
 * Braking — hydraulic ramp:
 *   Brake force builds quadratically over BRAKE_RAMP seconds, simulating
 *   hydraulic fluid pressurising under a hard pedal press.
 *
 * Coasting — speed-scaled drag:
 *   Deceleration scales from 50% of COAST_RATE at rest to 100% at top speed,
 *   giving a natural aerodynamic-drag feel without being sticky at low speeds.
 *
 * Steering — grip/understeer model:
 *   Lateral authority tapers quadratically with speed (gripFactor), so the car
 *   feels planted and precise at low speed but dangerously loose at 290 km/h.
 *
 * Centrifugal force:
 *   On a curve, the car is pushed outward proportional to curve intensity ×
 *   speed².  The player must actively counter-steer to stay on the road.
 *
 * Off-road:
 *   Grass applies heavy deceleration (greater than ACCEL_MID so the player
 *   can never accelerate on grass).  On return to asphalt, the speed cap
 *   recovers gradually over OFFROAD_RECOVERY_TIME seconds.
 */

import { Road }         from './road';
import { Renderer }     from './renderer';
import { InputManager } from './input';
import { SpriteLoader } from './sprites';
import
{
  PLAYER_MAX_SPEED,
  PLAYER_ACCEL_LOW, PLAYER_ACCEL_MID,
  PLAYER_COAST_RATE,
  PLAYER_BRAKE_MAX, PLAYER_BRAKE_RAMP,
  PLAYER_STEERING,
  OFFROAD_MAX_RATIO, OFFROAD_DECEL, OFFROAD_RECOVERY_TIME,
  SEGMENT_LENGTH, DRAW_DISTANCE,
  CENTRIFUGAL,
  DRIFT_ONSET, DRIFT_RATE, DRIFT_DECAY, DRIFT_CATCH,
} from './constants';

export class Game
{
  private road:     Road;
  private renderer: Renderer;
  private input:    InputManager;

  /** Player depth position in world units.  Advances each frame at current speed. */
  private playerZ = 0;

  /**
   * Player lateral position, normalised.
   * 0 = centre, ±1 = road edges, |playerX| > 1 = off-road, clamped at ±2.
   */
  private playerX = 0;

  /** Current speed in world units per second. */
  private speed = 0;

  /**
   * Continuous steering value ramped from -1 (full left) to +1 (full right).
   * Springs back to 0 when the key is released.  Fed to the renderer for
   * frame selection on the car sprite.
   */
  private steerAngle = 0;

  /**
   * How long the brake key has been held this press, in seconds.
   * Drives the quadratic ramp-up of braking force.
   */
  private brakeHeld = 0;

  /** True when the player is on grass (|playerX| > 1). */
  private offRoad = false;

  /**
   * Recovery progress after returning to asphalt, in [0, 1].
   * 0 = just returned (speed cap still near OFFROAD_MAX).
   * 1 = fully recovered (no cap).
   */
  private offRoadRecovery = 1;

  /**
   * Lateral slide velocity in road-widths per second.
   * Positive = sliding right, negative = sliding left.
   * Builds when centrifugal force overwhelms grip; caught with counter-steer.
   */
  private slideVelocity = 0;

  /**
   * Vertical horizon pixel offset used to simulate bumpy terrain on grass.
   * Set to a small random value each frame while off-road; 0 on asphalt.
   */
  private jitterY = 0;

  /** Timestamp of the previous frame in milliseconds, used to compute dt. */
  private lastTimestamp = 0;

  /** requestAnimationFrame handle, stored so we can cancel the loop on stop(). */
  private rafId = 0;

  /** Canvas logical width in CSS pixels.  Set by main.ts on resize. */
  w = 0;

  /** Canvas logical height in CSS pixels.  Set by main.ts on resize. */
  h = 0;

  /**
   * Creates the Road, Renderer, and InputManager, then loads sprite sheets.
   *
   * @param canvas - The HTML canvas element to render into.
   */
  constructor(canvas: HTMLCanvasElement)
  {
    const carSprites  = new SpriteLoader('sprites/player_car_sprites_1x.png');
    const roadSprites = new SpriteLoader('sprites/sprite_sheet_transparent.png');
    this.road     = new Road();
    this.renderer = new Renderer(canvas, carSprites, roadSprites);
    this.input    = new InputManager();
  }

  /** Kicks off the requestAnimationFrame loop. */
  start(): void
  {
    this.lastTimestamp = performance.now();
    this.rafId = requestAnimationFrame(this.loop);
  }

  /** Cancels the animation loop (call if you need to pause or teardown). */
  stop(): void
  {
    cancelAnimationFrame(this.rafId);
  }

  // ── Main loop ─────────────────────────────────────────────────────────────

  /**
   * Called by requestAnimationFrame on every display refresh.
   * Computes dt (time since last frame), runs update(), then draw().
   * dt is capped at 50 ms to prevent huge jumps if the tab loses focus.
   */
  private loop = (timestamp: number): void =>
  {
    const dt = Math.min((timestamp - this.lastTimestamp) / 1000, 0.05);
    this.lastTimestamp = timestamp;
    this.update(dt);
    this.draw();
    this.rafId = requestAnimationFrame(this.loop);
  };

  // ── Physics update ────────────────────────────────────────────────────────

  /**
   * Advances all game state by one time step dt (seconds).
   *
   * @param dt - Time elapsed since the previous frame, in seconds.
   */
  private update(dt: number): void
  {
    const { input } = this;
    const trackLength = this.road.count * SEGMENT_LENGTH;
    const speedRatio  = this.speed / PLAYER_MAX_SPEED;

    // ── Throttle / brake — "Alive & Kinetic" three-phase physics ──────────

    if (input.isDown('ArrowUp'))
    {
      // Phase 1 (0–15%): smoothstep ramp LOW→MID — tyres finding grip
      // Phase 2 (15–80%): flat-out MID thrust
      // Phase 3 (80–100%): MID tapers linearly to 0 — fighting aero drag
      let accel: number;

      if (speedRatio < 0.15)
      {
        // Smoothstep: S-shaped curve that starts and ends at zero slope.
        // t goes 0→1 across the 0–15% speed band.
        const t = speedRatio / 0.15;
        const smooth = t * t * (3 - 2 * t);
        accel = PLAYER_ACCEL_LOW + (PLAYER_ACCEL_MID - PLAYER_ACCEL_LOW) * smooth;
      }
      else if (speedRatio < 0.80)
      {
        accel = PLAYER_ACCEL_MID;
      }
      else
      {
        // Linear taper from MID down to 0 over the 80–100% speed band
        accel = PLAYER_ACCEL_MID * (1 - speedRatio) / 0.20;
      }

      this.speed    += accel * dt;
      this.brakeHeld = 0;
    }
    else if (input.isDown('ArrowDown'))
    {
      // Brake builds quadratically over BRAKE_RAMP seconds.
      // Simulates hydraulic brake fluid pressurising under a hard press.
      this.brakeHeld = Math.min(this.brakeHeld + dt, PLAYER_BRAKE_RAMP);
      const t        = this.brakeHeld / PLAYER_BRAKE_RAMP;
      this.speed    -= PLAYER_BRAKE_MAX * t * t * dt;
    }
    else
    {
      // Coast: drag scales from 50% of COAST_RATE at rest to 100% at max speed.
      // Gives natural aerodynamic feel — slow speeds coast gently, high speeds shed speed faster.
      const coastRate = PLAYER_COAST_RATE * (0.5 + 0.5 * speedRatio);
      this.speed     -= coastRate * dt;
      // Brake ramp decays when the pedal is released
      this.brakeHeld  = Math.max(0, this.brakeHeld - dt * 4);
    }

    this.speed = Math.max(0, Math.min(this.speed, PLAYER_MAX_SPEED));

    // ── Steering — grip / understeer model ────────────────────────────────
    //
    // steerRatio: ensures the player can always steer, even at near-zero speed.
    //   Floored at 0.3 so grass friction can't trap the player permanently.
    //
    // gripFactor: lateral authority drops quadratically with speed.
    //   At rest: full authority (gripFactor ≈ 1).
    //   At max speed: 50% authority (gripFactor = 0.5).
    //   Combined with centrifugal force this makes high-speed cornering feel
    //   like you're right on the limit.

    const steerRatio = Math.max(0.3, speedRatio);
    const gripFactor = Math.max(0.68, 1 - speedRatio * speedRatio * 0.5);

    if (input.isDown('ArrowLeft'))  this.playerX -= PLAYER_STEERING * steerRatio * gripFactor * dt;
    if (input.isDown('ArrowRight')) this.playerX += PLAYER_STEERING * steerRatio * gripFactor * dt;

    // Hard wall at ±2 — can't go further off-road than one road-width off the edge
    this.playerX = Math.max(-2, Math.min(2, this.playerX));

    // ── Centrifugal force ─────────────────────────────────────────────────
    //
    // On a curve, the car is pushed OUTWARD (away from centre of the bend).
    // Positive curve = right bend → car pushed rightward → playerX increases.
    // The minus sign here is correct: it converts road-space convention
    // (positive curve = bend to the right) into screen-space push (rightward = +X).
    // The faster you go, the stronger the push.  At full speed on a HARD curve:
    //   push = 6 * 1.0 * 0.3 = 1.8 road-widths/sec — must counter-steer actively.

    const playerSegment = this.road.findSegment(this.playerZ);
    const speedPercent  = this.speed / PLAYER_MAX_SPEED;
    this.playerX -= playerSegment.curve * speedPercent * CENTRIFUGAL * dt;

    // ── Drift / oversteer ──────────────────────────────────────────────────
    //
    // When centrifugal force exceeds available grip at speed, the rear steps
    // out and lateral slide velocity (slideVelocity) begins to build.
    // The car keeps sliding in that direction until:
    //   (a) the player counter-steers (opposite key to slide direction), or
    //   (b) natural tyre self-alignment bleeds it away over time.
    //
    // slideVelocity > 0 = sliding rightward (curve pushed left too hard).
    // slideVelocity < 0 = sliding leftward.

    if (speedRatio > 0.5 && Math.abs(playerSegment.curve) > 0)
    {
      // Force centrifugal is applying this frame (road-widths/sec²)
      const centForce    = Math.abs(playerSegment.curve * speedPercent * CENTRIFUGAL);
      // Grip available to resist lateral force (tapers with speed)
      const availGrip    = PLAYER_STEERING * gripFactor;
      // If centrifugal exceeds the onset fraction of grip, slide builds
      if (centForce > availGrip * DRIFT_ONSET)
      {
        const excess   = centForce - availGrip * DRIFT_ONSET;
        // Centrifugal does playerX -= curve, so positive curve pushes LEFT (-1 direction).
        // Slide must reinforce the same direction, not fight it.
        const slideDir = playerSegment.curve > 0 ? -1 : 1;
        this.slideVelocity += slideDir * excess * DRIFT_RATE * dt;
      }
    }

    // Apply slide to position
    this.playerX += this.slideVelocity * dt;

    // Decay: counter-steer catches the slide much faster than natural decay
    const counterSteering =
      (this.slideVelocity >  0.02 && input.isDown('ArrowLeft')) ||
      (this.slideVelocity < -0.02 && input.isDown('ArrowRight'));
    const decayRate = counterSteering ? DRIFT_CATCH : DRIFT_DECAY;
    this.slideVelocity *= Math.max(0, 1 - decayRate * dt);

    // Hard cap: whisper of slide only — 0.15 road-widths/sec maximum
    this.slideVelocity = Math.max(-0.15, Math.min(0.15, this.slideVelocity));

    // ── steerAngle: visual-only, drives car sprite frame selection ─────────
    //
    // Ramps toward ±1 while a direction key is held, springs back to 0 on release.
    // STEER_RATE = 3.0 means it reaches full lock in ~0.33 seconds.

    const STEER_RATE = 3.0;
    if (input.isDown('ArrowLeft'))        this.steerAngle -= STEER_RATE * dt;
    else if (input.isDown('ArrowRight'))  this.steerAngle += STEER_RATE * dt;
    else                                  this.steerAngle *= Math.max(0, 1 - STEER_RATE * dt * 4);
    this.steerAngle = Math.max(-1, Math.min(1, this.steerAngle));

    // ── Off-road friction ──────────────────────────────────────────────────
    //
    // |playerX| > 1 means the car has crossed the road edge onto the grass.
    // OFFROAD_DECEL (3500) > PLAYER_ACCEL_MID (1550) so the car can NEVER
    // accelerate on grass — it always decelerates toward zero.
    //
    // On return to asphalt, the speed cap recovers over OFFROAD_RECOVERY_TIME
    // seconds to prevent an instant snap back to top speed.

    this.offRoad = Math.abs(this.playerX) > 1;

    if (this.offRoad)
    {
      this.speed           -= OFFROAD_DECEL * dt;
      this.offRoadRecovery  = 0;
      // Random horizon jitter simulates rough grass terrain
      this.jitterY = (Math.random() - 0.5) * 8;
    }
    else
    {
      // Gradually restore full speed cap after returning to asphalt
      this.offRoadRecovery = Math.min(1, this.offRoadRecovery + dt / OFFROAD_RECOVERY_TIME);
      if (this.offRoadRecovery < 1)
      {
        // Blend the cap from OFFROAD_MAX up to PLAYER_MAX_SPEED over recovery time
        const recoveryMax = PLAYER_MAX_SPEED * (OFFROAD_MAX_RATIO + (1 - OFFROAD_MAX_RATIO) * this.offRoadRecovery);
        this.speed = Math.min(this.speed, recoveryMax);
      }
      this.jitterY = 0;
    }

    this.speed = Math.max(0, Math.min(this.speed, PLAYER_MAX_SPEED));

    // ── Advance position ───────────────────────────────────────────────────
    // Modulo wrap keeps playerZ inside [0, trackLength) so the road loops.
    this.playerZ = ((this.playerZ + this.speed * dt) % trackLength + trackLength) % trackLength;
  }

  // ── Draw ──────────────────────────────────────────────────────────────────

  /**
   * Passes the current game state to the Renderer for a complete frame draw.
   */
  private draw(): void
  {
    const { renderer, road, w, h } = this;

    // During a slide, the car body counter-steers into the drift —
    // slide right → car points left (negative steer).  Scale factor 0.5
    // keeps it subtle: full 1.5 wu/s slide = 0.75 extra steer angle.
    const driftVisual    = -this.slideVelocity * 0.15;
    const renderSteer    = Math.max(-1, Math.min(1, this.steerAngle + driftVisual));

    renderer.render(
      road.segments,
      road.count,
      this.playerZ,
      this.playerX,
      DRAW_DISTANCE,
      w, h,
      this.speed,
      renderSteer,
      this.jitterY,
    );
  }
}
