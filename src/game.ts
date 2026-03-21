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
import { ROAD_DATA }   from './road-data';
import { Renderer }     from './renderer';
import { InputManager } from './input';
import { SpriteLoader, TRAFFIC_CAR_SPECS } from './sprites';
import { checkCollisions, getBlockingRadius, CollisionClass } from './collision';
import {
  TrafficType,
  TrafficCar,
  initTraffic,
  updateTraffic,
  checkTrafficCollision,
} from './traffic';
import
{
  PLAYER_MAX_SPEED,
  PLAYER_ACCEL_LOW, PLAYER_ACCEL_MID,
  PLAYER_COAST_RATE,
  PLAYER_BRAKE_MAX, PLAYER_BRAKE_RAMP,
  PLAYER_STEERING, PLAYER_STEER_RATE,
  ACCEL_LOW_BAND, ACCEL_HIGH_BAND,
  OFFROAD_MAX_RATIO, OFFROAD_DECEL, OFFROAD_RECOVERY_TIME,
  OFFROAD_CRAWL_RATIO, OFFROAD_JITTER_BLEND, OFFROAD_JITTER_DECAY,
  SEGMENT_LENGTH, DRAW_DISTANCE,
  CENTRIFUGAL,
  DRIFT_ONSET, DRIFT_RATE, DRIFT_DECAY, DRIFT_CATCH,
  HIT_GLANCE_SPEED_MULT, HIT_GLANCE_BUMP, HIT_GLANCE_COOLDOWN,
  HIT_SMACK_SPEED_MULT, HIT_SMACK_SPEED_CAP, HIT_SMACK_BUMP,
  HIT_SMACK_COOLDOWN, HIT_SMACK_RECOVERY_BOOST, HIT_SMACK_RECOVERY_TIME,
  HIT_SMACK_RESTITUTION, HIT_SMACK_FLICK_BASE,
  HIT_CRUNCH_SPEED_CAP, HIT_CRUNCH_GRIND_DECEL, HIT_CRUNCH_GRIND_TIME,
  HIT_CRUNCH_BUMP, HIT_CRUNCH_COOLDOWN,
  HIT_CRUNCH_RECOVERY_BOOST, HIT_CRUNCH_RECOVERY_TIME,
  HIT_CRUNCH_RESTITUTION, HIT_CRUNCH_FLICK_BASE,
  HIT_SPEED_FLOOR,
  SHAKE_GLANCE_INTENSITY, SHAKE_GLANCE_DURATION,
  SHAKE_SMACK_INTENSITY, SHAKE_SMACK_DURATION,
  SHAKE_CRUNCH_INTENSITY, SHAKE_CRUNCH_DURATION,
  NEAR_MISS_WOBBLE,
  COLLISION_MIN_OFFSET, ROAD_WIDTH,
  COLLISION_WINDOW, MAX_FRAME_DT,
  TRAFFIC_HIT_SPEED_CAP,
  TRAFFIC_HIT_FLICK_BASE, TRAFFIC_HIT_FLICK_RESTITUTION,
  TRAFFIC_HIT_COOLDOWN,
  SHAKE_TRAFFIC_DURATION, SHAKE_TRAFFIC_INTENSITY,
  TRAFFIC_HIT_RECOVERY_TIME, TRAFFIC_HIT_RECOVERY_BOOST,
} from './constants';

// COLLISION_WINDOW imported from constants — see that file for the asymmetry explanation (L5).

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

  // ── Collision state ────────────────────────────────────────────────────────

  /** Seconds until the next collision can register. */
  private hitCooldown = 0;

  /** Seconds of sustained house-grind deceleration remaining. */
  private grindTimer = 0;

  /** Post-hit speed-recovery boost remaining, in seconds. */
  private hitRecoveryTimer = 0;

  /** Current accel multiplier for post-hit recovery (1.0 = no boost). */
  private hitRecoveryBoost = 1.0;

  /** Camera shake countdown in seconds. */
  private shakeTimer = 0;

  /** Max screen offset in px for current shake event. */
  private shakeIntensity = 0;

  /** Active traffic cars — updated every frame by updateTraffic(). */
  private trafficCars: TrafficCar[] = [];

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
    this.road     = Road.fromData(ROAD_DATA);
    this.renderer = new Renderer(canvas, {
      car:         new SpriteLoader('sprites/assets/cars/player_car_sprites_1x.png'),
      trafficCars: Object.fromEntries(
        Object.values(TrafficType).map(
          type => [type, new SpriteLoader(TRAFFIC_CAR_SPECS[type].assetPath)],
        ),
      ) as Record<TrafficType, SpriteLoader>,
      road:      new SpriteLoader('sprites/assets/palm_sheet.png'),
      billboard: new SpriteLoader('sprites/assets/billboard_sheet.png'),
      cactus:    new SpriteLoader('sprites/assets/cactus_sheet.png'),
      cookie:    new SpriteLoader('sprites/assets/cookie_sheet.png'),
      barney:    new SpriteLoader('sprites/assets/barney_sheet.png'),
      big:       new SpriteLoader('sprites/assets/big_sheet.png'),
      shrub:     new SpriteLoader('sprites/assets/shrub_sheet.png'),
      sign:      new SpriteLoader('sprites/assets/sign_sheet.png'),
      house:     new SpriteLoader('sprites/assets/house_sheet.png'),
      clouds:    new SpriteLoader('sprites/assets/clouds_1x.png'),
    });
    this.input       = new InputManager();
    this.trafficCars = initTraffic(this.road.count);
  }

  /** Kicks off the requestAnimationFrame loop. */
  start(): void
  {
    // Guard against calling start() twice — a second RAF chain would run the
    // game at double speed and waste a full CPU core on duplicate frames.
    if (this.rafId !== 0) return;
    this.lastTimestamp = performance.now();
    this.rafId = requestAnimationFrame(this.loop);
  }

  /** Cancels the animation loop (call if you need to pause or teardown). */
  stop(): void
  {
    cancelAnimationFrame(this.rafId);
    // Reset to 0 so start() can safely restart the loop later.
    this.rafId = 0;
  }

  /**
   * Updates the canvas logical dimensions atomically.
   * Call this from the window resize handler instead of setting w/h directly,
   * so any future per-resize work (e.g. notifying the renderer) can be added here.
   *
   * @param w - New canvas CSS-pixel width.
   * @param h - New canvas CSS-pixel height.
   */
  resize(w: number, h: number): void
  {
    this.w = w;
    this.h = h;
  }

  /**
   * Fully tears down the game: cancels the RAF loop and removes all window
   * event listeners held by InputManager.  Call this before discarding the
   * Game instance to prevent the keyboard listeners from keeping the entire
   * game object graph alive after a hot-reload or SPA navigation.
   */
  destroy(): void
  {
    this.stop();
    this.input.destroy();
  }

  // ── Main loop ─────────────────────────────────────────────────────────────

  /**
   * Called by requestAnimationFrame on every display refresh.
   * Computes dt (time since last frame), runs update(), then draw().
   * dt is capped at 50 ms to prevent huge jumps if the tab loses focus.
   */
  private loop = (timestamp: number): void =>
  {
    const dt = Math.min((timestamp - this.lastTimestamp) / 1000, MAX_FRAME_DT);
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

      if (speedRatio < ACCEL_LOW_BAND)
      {
        // Smoothstep: S-shaped curve that starts and ends at zero slope.
        // t goes 0→1 across the low-speed band.
        const t = speedRatio / ACCEL_LOW_BAND;
        const smooth = t * t * (3 - 2 * t);
        accel = PLAYER_ACCEL_LOW + (PLAYER_ACCEL_MID - PLAYER_ACCEL_LOW) * smooth;
      }
      else if (speedRatio < ACCEL_HIGH_BAND)
      {
        accel = PLAYER_ACCEL_MID;
      }
      else
      {
        // Linear taper from MID down to 0 over the high-speed band
        accel = PLAYER_ACCEL_MID * (1 - speedRatio) / (1 - ACCEL_HIGH_BAND);
      }

      this.speed    += accel * this.hitRecoveryBoost * dt;
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
    // gripFactor: lateral authority drops quadratically with speed.
    //   At rest: full authority (gripFactor = 1).
    //   At max speed: 50% authority (gripFactor = 0.5).
    //   This is correct understeer behaviour — high-speed cornering requires
    //   earlier commitment and more progressive trail-braking to hold the line.

    const gripFactor = 1 - speedRatio * speedRatio * 0.5;

    // Lateral movement requires forward speed — a stopped car cannot slide sideways.
    if (this.speed > 0)
    {
      if (input.isDown('ArrowLeft'))  this.playerX -= PLAYER_STEERING * gripFactor * dt;
      if (input.isDown('ArrowRight')) this.playerX += PLAYER_STEERING * gripFactor * dt;
    }

    // Hard wall at ±2 — can't go further off-road than one road-width off the edge
    this.playerX = Math.max(-2, Math.min(2, this.playerX));

    // ── Centrifugal force ─────────────────────────────────────────────────
    //
    // On a curve, the car is pushed OUTWARD (away from centre of the bend).
    // Positive curve = right bend → car pushed rightward → playerX increases.
    // The minus sign here is correct: it converts road-space convention
    // (positive curve = bend to the right) into screen-space push (rightward = +X).
    // The faster you go, the stronger the push.  At full speed on a HARD curve:
    //   push = 6 * 1.0 * 0.35 = 2.1 road-widths/sec — must counter-steer actively.

    const playerSegment = this.road.findSegment(this.playerZ);
    this.playerX -= playerSegment.curve * speedRatio * CENTRIFUGAL * dt;

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
      const centForce    = Math.abs(playerSegment.curve * speedRatio * CENTRIFUGAL);
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

    // Decay: counter-steer catches the slide much faster than natural decay.
    // Math.exp gives frame-rate-independent exponential decay (correct physics).
    const counterSteering =
      (this.slideVelocity >  0.02 && input.isDown('ArrowLeft')) ||
      (this.slideVelocity < -0.02 && input.isDown('ArrowRight'));
    // During a hit cooldown, slow the natural decay so the bounce travels further.
    // Counter-steer still catches it — but the player has to actually work for it.
    let decayRate = counterSteering ? DRIFT_CATCH : DRIFT_DECAY;
    if (this.hitCooldown > 0) decayRate = Math.min(decayRate, 2.5);
    this.slideVelocity *= Math.exp(-decayRate * dt);

    // Raise cap during a collision so the full flick can apply.
    const slideCap = this.hitCooldown > 0 ? 0.75 : 0.5;
    this.slideVelocity = Math.max(-slideCap, Math.min(slideCap, this.slideVelocity));

    // ── steerAngle: visual-only, drives car sprite frame selection ─────────
    //
    // Ramps toward ±1 while a direction key is held, springs back to 0 on release.
    // PLAYER_STEER_RATE = 3.0 means it reaches full lock in ~0.33 seconds.
    // Math.exp gives frame-rate-independent spring-back (correct physics).

    if (input.isDown('ArrowLeft'))        this.steerAngle -= PLAYER_STEER_RATE * dt;
    else if (input.isDown('ArrowRight'))  this.steerAngle += PLAYER_STEER_RATE * dt;
    else                                  this.steerAngle *= Math.exp(-PLAYER_STEER_RATE * 4 * dt);
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
      // If the player is pressing throttle off-road, maintain a minimum crawl
      // speed (~15 km/h) so the car isn't completely frozen and the speedometer
      // reads non-zero while steering back to the road.
      if (input.isDown('ArrowUp'))
        this.speed = Math.max(this.speed, PLAYER_MAX_SPEED * OFFROAD_CRAWL_RATIO);
      this.offRoadRecovery  = 0;
      // Smooth terrain jitter: lerp toward a new random target each frame.
      // Blending at rate 8 means ~12% progress per frame at 60 fps —
      // large jumps are dampened over ~6 frames, producing a rolling-wave feel
      // instead of the frame-rate-speed noise the raw random produced.
      const jitterTarget = this.speed > 0 ? (Math.random() - 0.5) * 10 : 0;
      this.jitterY += (jitterTarget - this.jitterY) * (1 - Math.exp(-OFFROAD_JITTER_BLEND * dt));
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
      // Decay smoothly to zero when back on asphalt — avoids an instant snap
      // from whatever the last grass jitter value was.
      this.jitterY *= Math.exp(-OFFROAD_JITTER_DECAY * dt);
    }

    this.speed = Math.max(0, Math.min(this.speed, PLAYER_MAX_SPEED));

    // ── Roadside collision ─────────────────────────────────────────────────
    this.updateCollisions(dt);

    // ── Advance position ───────────────────────────────────────────────────
    // Modulo wrap keeps playerZ inside [0, trackLength) so the road loops.
    this.playerZ = ((this.playerZ + this.speed * dt) % trackLength + trackLength) % trackLength;

    // ── Traffic cars ───────────────────────────────────────────────────────
    updateTraffic(this.trafficCars, this.playerZ, this.road.count, dt);
  }

  // ── Collision ─────────────────────────────────────────────────────────────

  /**
   * Prevents the player from moving laterally through solid objects (smack/crunch).
   * Called every frame regardless of cooldown so objects are always solid walls.
   */
  private blockSolidObjects(segIdx: number): void
  {
    if (Math.abs(this.playerX) < COLLISION_MIN_OFFSET) return;

    for (const offset of COLLISION_WINDOW)
    {
      const idx = ((segIdx + offset) % this.road.count + this.road.count) % this.road.count;
      for (const sprite of this.road.segments[idx].sprites ?? [])
      {
        const radius = getBlockingRadius(sprite.family);
        if (radius === 0) continue;

        const spriteXN = sprite.worldX / ROAD_WIDTH;
        const radN     = radius / ROAD_WIDTH;

        if (sprite.worldX > 0 && this.playerX >= spriteXN - radN)
          this.playerX = spriteXN - radN;
        else if (sprite.worldX < 0 && this.playerX <= spriteXN + radN)
          this.playerX = spriteXN + radN;
      }
    }
  }

  /**
   * Runs collision detection for the current frame and applies physics effects.
   * Called after playerX and speed are settled for the frame.
   */
  private updateCollisions(dt: number): void
  {
    // ── Tick timers ──────────────────────────────────────────────────────
    this.hitCooldown      = Math.max(0, this.hitCooldown      - dt);
    this.grindTimer       = Math.max(0, this.grindTimer       - dt);
    this.hitRecoveryTimer = Math.max(0, this.hitRecoveryTimer - dt);
    this.shakeTimer       = Math.max(0, this.shakeTimer       - dt);

    // Apply grind deceleration (house wall scrape sustained drag)
    if (this.grindTimer > 0) this.speed -= HIT_CRUNCH_GRIND_DECEL * dt;

    // Sustained camera shake overrides the off-road jitter set above
    if (this.shakeTimer > 0)
      this.jitterY = (Math.random() - 0.5) * this.shakeIntensity * 2;

    // Decay post-hit recovery boost when timer expires
    if (this.hitRecoveryTimer <= 0) this.hitRecoveryBoost = 1.0;

    const segIdx = this.road.findSegmentIndex(this.playerZ);

    // ── ALWAYS block solid objects (prevents phasing through palms/houses) ─
    this.blockSolidObjects(segIdx);

    // ── Skip new hit effects during cooldown ─────────────────────────────
    if (this.hitCooldown > 0) return;

    // ── Spatial check ────────────────────────────────────────────────────
    const { hit, nearMiss } = checkCollisions(
      this.playerX,
      this.road.segments,
      this.road.count,
      segIdx,
    );

    if (!hit && nearMiss)
      this.playerX += nearMiss.wobbleDir * NEAR_MISS_WOBBLE;

    // ── Traffic collision (runs whenever not in cooldown, no static hit) ──
    if (!hit)
    {
      const trafficHit = checkTrafficCollision(
        this.playerX,
        this.playerZ,
        this.speed,
        this.trafficCars,
        this.road.count,
      );

      if (trafficHit)
      {
        // Capture ratio BEFORE capping speed — faster approach = bigger flick.
        const preHitRatio   = this.speed / PLAYER_MAX_SPEED;

        // Hard cap — always slam to TRAFFIC_HIT_SPEED_CAP regardless of closing speed.
        this.speed = Math.min(this.speed, PLAYER_MAX_SPEED * TRAFFIC_HIT_SPEED_CAP);

        const bumpSign      = -trafficHit.bumpDir;
        const flick         = Math.max(
          TRAFFIC_HIT_FLICK_BASE,
          preHitRatio * TRAFFIC_HIT_FLICK_RESTITUTION,
        );
        this.slideVelocity  = bumpSign * Math.min(flick, 0.75);

        this.shakeTimer       = SHAKE_TRAFFIC_DURATION;
        this.shakeIntensity   = SHAKE_TRAFFIC_INTENSITY;
        this.hitCooldown      = TRAFFIC_HIT_COOLDOWN;
        this.hitRecoveryTimer = TRAFFIC_HIT_RECOVERY_TIME;
        this.hitRecoveryBoost = TRAFFIC_HIT_RECOVERY_BOOST;

        if (this.speed > 0)
          this.speed = Math.max(this.speed, PLAYER_MAX_SPEED * HIT_SPEED_FLOOR);

        // Kick the traffic car away — same direction as player bounced, but mirrored.
        // bumpDir +1 = car was to the RIGHT → player bounces left, car flies right.
        trafficHit.hitCar.hitVelX   = trafficHit.bumpDir * 4500;
        trafficHit.hitCar.spinAngle = 0;

        this.playerX = Math.max(-2, Math.min(2, this.playerX));
      }
      return;
    }

    // ── Compute angle-based flick ─────────────────────────────────────────
    //
    // The flick is the lateral velocity imparted at impact — how hard the car
    // bounces off the obstacle.  It depends on:
    //   - How fast the player was steering INTO the object (lateral approach)
    //   - How fast they were going overall (forward speed component)
    //
    // bumpDir = +1 if object is RIGHT of player, -1 if LEFT.
    // The flick must push AWAY from the object (opposite to bumpDir).

    const preHitSpeedRatio = this.speed / PLAYER_MAX_SPEED;
    const gripFactor       = 1 - preHitSpeedRatio * preHitSpeedRatio * 0.5;
    const bumpSign         = -hit.bumpDir;

    // Lateral velocity component moving toward the object this frame
    const steerApproach = hit.bumpDir * this.steerAngle * PLAYER_STEERING * gripFactor;
    const slideApproach = hit.bumpDir * this.slideVelocity;
    const approach      = Math.max(0, steerApproach + slideApproach);

    // ── Apply collision effects by class ─────────────────────────────────
    switch (hit.cls)
    {
      case CollisionClass.Glance:
      {
        // Small poke — speed penalty + tiny lateral bump, no dramatic flick
        this.speed   *= HIT_GLANCE_SPEED_MULT;
        this.playerX += bumpSign * HIT_GLANCE_BUMP;
        this.shakeTimer     = SHAKE_GLANCE_DURATION;
        this.shakeIntensity = SHAKE_GLANCE_INTENSITY;
        this.hitCooldown    = HIT_GLANCE_COOLDOWN;
        break;
      }

      case CollisionClass.Smack:
      {
        // Hard whack — speed loss + angle-computed flick off the object.
        // Restitution 0.55: palm/post is fairly springy.
        // Base 0.10: even a dead-straight hit at full speed kicks the car.
        this.speed *= HIT_SMACK_SPEED_MULT;
        this.speed  = Math.min(this.speed, PLAYER_MAX_SPEED * HIT_SMACK_SPEED_CAP);

        const flick         = Math.max(0.08, approach * HIT_SMACK_RESTITUTION + preHitSpeedRatio * HIT_SMACK_FLICK_BASE);
        this.slideVelocity  = bumpSign * Math.min(flick, 0.45);

        this.shakeTimer       = SHAKE_SMACK_DURATION;
        this.shakeIntensity   = SHAKE_SMACK_INTENSITY;
        this.hitCooldown      = HIT_SMACK_COOLDOWN;
        this.hitRecoveryTimer = HIT_SMACK_RECOVERY_TIME;
        this.hitRecoveryBoost = HIT_SMACK_RECOVERY_BOOST;
        break;
      }

      case CollisionClass.Crunch:
      {
        // Building wall — instant crawl + sustained grind + strong flick.
        // Restitution 0.30: concrete absorbs a lot of energy.
        // Base 0.15: heavy base kick even head-on so the car always bounces.
        this.speed = Math.min(this.speed, PLAYER_MAX_SPEED * HIT_CRUNCH_SPEED_CAP);
        this.grindTimer = HIT_CRUNCH_GRIND_TIME;

        const flick        = Math.max(0.14, approach * HIT_CRUNCH_RESTITUTION + preHitSpeedRatio * HIT_CRUNCH_FLICK_BASE);
        this.slideVelocity = bumpSign * Math.min(flick, 0.45);

        this.shakeTimer     = SHAKE_CRUNCH_DURATION;
        this.shakeIntensity = SHAKE_CRUNCH_INTENSITY;
        this.hitCooldown    = HIT_CRUNCH_COOLDOWN;
        this.hitRecoveryTimer = HIT_CRUNCH_RECOVERY_TIME;
        this.hitRecoveryBoost = HIT_CRUNCH_RECOVERY_BOOST;
        break;
      }

      case CollisionClass.Ghost:
        // Ghost sprites never reach here (filtered in checkSegmentCollision),
        // but the case is required for the exhaustiveness sentinel below.
        break;

      default:
      {
        // Exhaustiveness sentinel: if a new CollisionClass member is added but
        // not handled above, TypeScript reports a type error here at compile time.
        const _exhaustive: never = hit.cls;
      }
    }

    // ── Speed floor — car never fully stops from a hit (Law 2) ───────────
    if (this.speed > 0)
      this.speed = Math.max(this.speed, PLAYER_MAX_SPEED * HIT_SPEED_FLOOR);

    // ── Hard wall clamp ───────────────────────────────────────────────────
    this.playerX = Math.max(-2, Math.min(2, this.playerX));
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
      this.trafficCars,
    );
  }
}
