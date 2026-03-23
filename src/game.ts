/**
 * game.ts
 *
 * Main game loop and state machine.
 *
 * GamePhase drives every frame:
 *   PRELOADING → shows progress bar while sprites load.
 *   INTRO      → title screen with GAME MODE / SETTINGS / START menu.
 *   COUNTDOWN  → 3-2-1-GO sequence; road visible but player frozen.
 *   PLAYING    → full physics race; timer and distance accumulate.
 *   FINISHED   → race-complete overlay; Enter restarts, Escape goes to menu.
 */

import { Road }         from './road';
import { ROAD_DATA, ROAD_DATA_HARD } from './road-data';
import { Renderer }     from './renderer';
import { InputManager } from './input';
import { AudioManager } from './audio';
import { Preloader }    from './preloader';
import { SpriteLoader, TRAFFIC_CAR_SPECS } from './sprites';
import { checkCollisions, getBlockingRadius, CollisionClass } from './collision';
import {
  TrafficType,
  TrafficCar,
  initTraffic,
  updateTraffic,
  checkTrafficCollision,
} from './traffic';
import { GamePhase, GameMode, GameSettings } from './types';
import { Button, anyHovered }               from './ui';
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
  RACE_CONFIG, WU_PER_KM,
} from './constants';

const STORAGE_KEY = 'outrun_settings';

function loadSettings(): GameSettings
{
  try
  {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw)
    {
      const s = JSON.parse(raw) as Partial<GameSettings>;
      const mode = Object.values(GameMode).includes(s.mode as GameMode)
        ? s.mode as GameMode
        : GameMode.MEDIUM;
      return { mode, soundEnabled: s.soundEnabled !== false };
    }
  }
  catch { /* ignore parse errors */ }
  return { mode: GameMode.MEDIUM, soundEnabled: true };
}

function saveSettings(s: GameSettings): void
{
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); }
  catch { /* quota / private-mode */ }
}

export class Game
{
  private canvas:   HTMLCanvasElement;
  private renderer: Renderer;
  private input:    InputManager;
  private audio:    AudioManager;

  // ── State machine ──────────────────────────────────────────────────────────

  private phase:    GamePhase = GamePhase.PRELOADING;
  private settings: GameSettings;

  // ── Preloader state ────────────────────────────────────────────────────────

  private preloader:  Preloader | null = null;
  private loadError:  string = '';
  private heroImage:  HTMLImageElement | null = null;

  // ── Road + traffic (initialised on game start, not construction) ───────────

  private road:        Road;
  private trafficCars: TrafficCar[] = [];

  // ── Player physics ─────────────────────────────────────────────────────────

  private playerZ          = 0;
  private playerX          = 0;
  private speed            = 0;
  private steerAngle       = 0;
  private brakeHeld        = 0;
  private offRoad          = false;
  private offRoadRecovery  = 1;
  private slideVelocity    = 0;
  private jitterY          = 0;

  // ── Effective top speed (varies by mode) ──────────────────────────────────

  private effectiveMaxSpeed = PLAYER_MAX_SPEED;

  // ── Collision state ────────────────────────────────────────────────────────

  private hitCooldown      = 0;
  private grindTimer       = 0;
  private hitRecoveryTimer = 0;
  private hitRecoveryBoost = 1.0;
  private shakeTimer       = 0;
  private shakeIntensity   = 0;

  // ── Race timers ────────────────────────────────────────────────────────────

  private raceTimer         = 0;
  private distanceTravelled = 0;   // cumulative world units (not looped)

  // ── Countdown state ────────────────────────────────────────────────────────

  private countdownValue: number | 'GO!' = 3;
  private countdownTimer  = 0;

  // ── Intro / menu state ─────────────────────────────────────────────────────

  private menuItem:     'start' | 'mode' | 'settings' = 'start';
  private menuSubMenu:  'mode' | 'settings' | null = null;
  private menuSubMode:  GameMode = GameMode.MEDIUM;
  private menuSubSound  = true;
  private pulseClock    = 0;

  // ── Mouse state ────────────────────────────────────────────────────────────

  private mouseX     = -1;
  private mouseY     = -1;
  private clickX     = -1;   // snapshot of mouseX at click time — never overwritten by onMouseMove
  private clickY     = -1;
  private mouseClick = false;

  private onMouseMove = (e: MouseEvent): void =>
  {
    const r      = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width  / r.width;
    const scaleY = this.canvas.height / r.height;
    this.mouseX  = (e.clientX - r.left) * scaleX;
    this.mouseY  = (e.clientY - r.top)  * scaleY;
  };

  private onMouseDown = (e: MouseEvent): void =>
  {
    if (e.button !== 0) return;
    const r      = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width  / r.width;
    const scaleY = this.canvas.height / r.height;
    this.mouseX  = (e.clientX - r.left) * scaleX;
    this.mouseY  = (e.clientY - r.top)  * scaleY;
    this.clickX  = this.mouseX;
    this.clickY  = this.mouseY;
    this.mouseClick = true;
  };

  // ── UI Buttons ─────────────────────────────────────────────────────────────
  // Each button's rect is registered by the renderer each frame, then tick()
  // is called in the game tick to compute fresh hover/click state.

  // Main menu
  private btnMode     = new Button();
  private btnSettings = new Button();
  private btnStart    = new Button();

  // Mode submenu cards
  private btnEasy   = new Button();
  private btnMedium = new Button();
  private btnHard   = new Button();

  // Settings panel
  private btnClose  = new Button();
  private btnSound  = new Button();
  private btnGithub = new Button();

  // In-game
  private btnQuit   = new Button();

  // ── Audio state ────────────────────────────────────────────────────────────

  private wasOffRoad   = false;

  // ── Loop ───────────────────────────────────────────────────────────────────

  private lastTimestamp = 0;
  private rafId         = 0;

  w = 0;
  h = 0;

  constructor(canvas: HTMLCanvasElement, initialSettings?: GameSettings)
  {
    this.canvas   = canvas;
    this.settings = initialSettings ?? loadSettings();
    this.menuSubMode  = this.settings.mode;
    this.menuSubSound = this.settings.soundEnabled;

    // Road is built once at construction time (MEDIUM default).
    // It is rebuilt with the chosen mode when the player hits START.
    this.road = Road.fromData(ROAD_DATA, GameMode.MEDIUM);

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
    });

    this.input = new InputManager();
    this.audio = new AudioManager();
    this.canvas.addEventListener('mousemove', this.onMouseMove);
    this.canvas.addEventListener('mousedown', this.onMouseDown);

    // Preload all sprite sheet assets.  The browser serves subsequent
    // SpriteLoader loads from cache, so there is no double-download.
    const allUrls = [
      'sprites/assets/cars/player_car_sprites_1x.png',
      'sprites/assets/palm_sheet.png',
      'sprites/assets/billboard_sheet.png',
      'sprites/assets/cactus_sheet.png',
      'sprites/assets/cookie_sheet.png',
      'sprites/assets/barney_sheet.png',
      'sprites/assets/big_sheet.png',
      'sprites/assets/shrub_sheet.png',
      'sprites/assets/sign_sheet.png',
      'sprites/assets/house_sheet.png',
      ...Object.values(TrafficType).map(t => TRAFFIC_CAR_SPECS[t].assetPath),
    ];

    const entries = allUrls.map(url =>
    {
      const img = new Image();
      const promise = new Promise<void>((resolve, reject) =>
      {
        img.onload  = () => resolve();
        img.onerror = () => reject();
      });
      img.src = url;
      return { promise, name: url.split('/').pop() ?? url };
    });

    // Load hero image separately — its resolution determines the intro layout,
    // but a load failure is non-fatal (we fall back to the gradient background).
    const heroImg = new Image();
    const heroPromise = new Promise<void>(resolve =>
    {
      heroImg.onload  = () => { this.heroImage = heroImg; resolve(); };
      heroImg.onerror = () => resolve();   // graceful fallback
    });
    heroImg.src = 'sprites/source_for_sprites/hero.jpg';
    entries.push({ promise: heroPromise, name: 'hero' });

    this.preloader = new Preloader(entries);
    this.preloader.done.then(result =>
    {
      if (!result.ok) { this.loadError = result.error ?? 'unknown'; return; }
      this.phase = GamePhase.INTRO;
    });
  }

  start(): void
  {
    if (this.rafId !== 0) return;
    this.lastTimestamp = performance.now();
    this.rafId = requestAnimationFrame(this.loop);
  }

  stop(): void
  {
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  resize(w: number, h: number): void { this.w = w; this.h = h; }

  destroy(): void
  {
    this.stop();
    this.input.destroy();
    this.canvas.removeEventListener('mousemove', this.onMouseMove);
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
  }

  // ── Main loop ──────────────────────────────────────────────────────────────

  private loop = (timestamp: number): void =>
  {
    const dt = Math.min((timestamp - this.lastTimestamp) / 1000, MAX_FRAME_DT);
    this.lastTimestamp = timestamp;

    switch (this.phase)
    {
      case GamePhase.PRELOADING: this.tickPreload();        break;
      case GamePhase.INTRO:      this.tickIntro(dt);        break;
      case GamePhase.COUNTDOWN:  this.tickCountdown(dt);    break;
      case GamePhase.PLAYING:    this.tickPlaying(dt);      break;
      case GamePhase.FINISHED:   this.tickFinished();       break;
    }

    this.rafId = requestAnimationFrame(this.loop);
  };

  // ── Phase: PRELOADING ──────────────────────────────────────────────────────

  private tickPreload(): void
  {
    const progress = this.preloader?.progress ?? 0;
    this.renderer.renderPreloader(this.w, this.h, progress, this.loadError || undefined);
  }

  // ── Phase: INTRO ───────────────────────────────────────────────────────────

  private tickIntro(dt: number): void
  {
    this.pulseClock += dt;

    const { input } = this;
    const MODES = [GameMode.EASY, GameMode.MEDIUM, GameMode.HARD] as const;

    if (this.menuSubMenu === 'mode')
    {
      const idx = MODES.indexOf(this.menuSubMode);

      // ── Keyboard navigation (bands are vertical — up/down primary) ─────
      if (input.wasPressed('ArrowUp')   || input.wasPressed('ArrowLeft'))
        this.menuSubMode = MODES[Math.max(0, idx - 1)];
      if (input.wasPressed('ArrowDown') || input.wasPressed('ArrowRight'))
        this.menuSubMode = MODES[Math.min(MODES.length - 1, idx + 1)];

      if (input.wasPressed('Enter'))  { this.settings.mode = this.menuSubMode; this.menuSubMenu = null; saveSettings(this.settings); }
      if (input.wasPressed('Escape')) { this.menuSubMenu = null; }

      // ── Buttons ─────────────────────────────────────────────────────────
      const modeButtons = [this.btnEasy, this.btnMedium, this.btnHard] as const;
      modeButtons.forEach((btn, i) => btn.tick(this.mouseX, this.mouseY, this.clickX, this.clickY, this.mouseClick));

      modeButtons.forEach((btn, i) => { if (btn.hovered) this.menuSubMode = MODES[i]; });

      if (this.mouseClick)
      {
        modeButtons.forEach((btn, i) =>
        {
          if (btn.clicked)
          {
            this.menuSubMode   = MODES[i];
            this.settings.mode = this.menuSubMode;
            this.menuSubMenu   = null;
            saveSettings(this.settings);
          }
        });
        this.mouseClick = false;
      }

      this.canvas.style.cursor = anyHovered(...modeButtons) ? 'pointer' : 'default';
    }
    else if (this.menuSubMenu === 'settings')
    {
      // Rects registered by drawSettingsPanel each frame; tick() reads them.
      this.btnClose .tick(this.mouseX, this.mouseY, this.clickX, this.clickY, this.mouseClick);
      this.btnSound .tick(this.mouseX, this.mouseY, this.clickX, this.clickY, this.mouseClick);
      this.btnGithub.tick(this.mouseX, this.mouseY, this.clickX, this.clickY, this.mouseClick);

      this.canvas.style.cursor = anyHovered(this.btnClose, this.btnSound, this.btnGithub) ? 'pointer' : 'default';

      if (input.wasPressed('Enter') || input.wasPressed(' ') || this.btnSound.clicked)
      {
        this.settings.soundEnabled = !this.settings.soundEnabled;
        this.menuSubSound = this.settings.soundEnabled;
        saveSettings(this.settings);
      }

      if (this.btnGithub.clicked)
        window.open('https://github.com/gfreedman/outrun', '_blank', 'noopener');

      // Close on X click, Escape, or click outside panel
      const { w, h } = this;
      const px = Math.round(w * 0.18), py = Math.round(h * 0.16);
      const pw = Math.round(w * 0.64), ph = Math.round(h * 0.62);
      const inPanel = this.mouseX >= px && this.mouseX <= px + pw
                   && this.mouseY >= py && this.mouseY <= py + ph;
      if (input.wasPressed('Escape') || this.btnClose.clicked || (this.mouseClick && !inPanel))
        this.menuSubMenu = null;

      this.mouseClick = false;
    }
    else
    {
      const items: Array<'mode' | 'settings' | 'start'> = ['mode', 'settings', 'start'];
      const idx = items.indexOf(this.menuItem);

      // ── Keyboard nav ────────────────────────────────────────────────────
      if (input.wasPressed('ArrowUp'))   this.menuItem = items[Math.max(0, idx - 1)];
      if (input.wasPressed('ArrowDown')) this.menuItem = items[Math.min(items.length - 1, idx + 1)];

      // ── Buttons — rects registered by renderer each frame ────────────────
      this.btnMode    .tick(this.mouseX, this.mouseY, this.clickX, this.clickY, this.mouseClick);
      this.btnSettings.tick(this.mouseX, this.mouseY, this.clickX, this.clickY, this.mouseClick);
      this.btnStart   .tick(this.mouseX, this.mouseY, this.clickX, this.clickY, this.mouseClick);

      this.canvas.style.cursor = anyHovered(this.btnMode, this.btnSettings, this.btnStart) ? 'pointer' : 'default';

      const clickItem: typeof this.menuItem | null =
        this.btnMode.clicked     ? 'mode'     :
        this.btnSettings.clicked ? 'settings' :
        this.btnStart.clicked    ? 'start'     :
        null;

      if (input.wasPressed('Enter') || input.wasPressed(' ') || (this.mouseClick && clickItem !== null))
      {
        if (clickItem !== null) this.menuItem = clickItem;
        this.mouseClick = false;
        if (this.menuItem === 'mode')          { this.menuSubMenu = 'mode'; this.menuSubMode = this.settings.mode; }
        else if (this.menuItem === 'settings') { this.menuSubMenu = 'settings'; }
        else                                   { this.beginRace(); }
      }
      else
      {
        this.mouseClick = false;
      }
    }

    this.renderer.renderIntro(
      this.w, this.h,
      this.menuItem,
      this.menuSubMenu === 'mode' ? this.menuSubMode : this.settings.mode,
      this.settings.soundEnabled,
      this.menuSubMenu,
      Math.floor(this.pulseClock * 2) % 2 === 0,
      this.heroImage,
      {
        mode: this.btnMode, settings: this.btnSettings, start: this.btnStart,
        easy: this.btnEasy, medium: this.btnMedium,     hard:  this.btnHard,
        close: this.btnClose, sound: this.btnSound,     github: this.btnGithub,
      },
    );
  }


  private beginRace(): void
  {
    // Build road for chosen mode — HARD uses its own course layout
    const roadData = this.settings.mode === GameMode.HARD ? ROAD_DATA_HARD : ROAD_DATA;
    this.road = Road.fromData(roadData, this.settings.mode);

    const cfg = RACE_CONFIG[this.settings.mode];
    this.effectiveMaxSpeed = PLAYER_MAX_SPEED * cfg.maxSpeedRatio;
    this.trafficCars = initTraffic(this.road.count, cfg.trafficCount);

    // Reset physics
    this.playerZ = 0;
    this.playerX = 0;
    this.speed   = 0;
    this.steerAngle    = 0;
    this.brakeHeld     = 0;
    this.offRoad       = false;
    this.offRoadRecovery = 1;
    this.slideVelocity = 0;
    this.jitterY       = 0;
    this.hitCooldown   = 0;
    this.grindTimer    = 0;
    this.hitRecoveryTimer = 0;
    this.hitRecoveryBoost = 1.0;
    this.shakeTimer    = 0;
    this.shakeIntensity = 0;
    this.raceTimer     = 0;
    this.distanceTravelled = 0;

    // Countdown
    this.countdownValue = 3;
    this.countdownTimer = 0;
    this.phase = GamePhase.COUNTDOWN;

    // Init audio on first user interaction
    this.audio.init();
    this.audio.setEnabled(this.settings.soundEnabled);
    this.audio.startMusic();

    // Go fullscreen on the document root, NOT the canvas element.
    // Requesting fullscreen on the canvas itself causes browsers to apply a UA
    // stylesheet override (width:100%; height:100%) to the fullscreen element,
    // which corrupts getBoundingClientRect() and breaks mouse coordinate mapping.
    // Fullscreening the document root avoids this — our resize() handles sizing.
    if (document.fullscreenEnabled && !document.fullscreenElement)
      document.documentElement.requestFullscreen().catch(() => { /* permission denied — stay windowed */ });
  }

  /** Return to INTRO and exit fullscreen if active. */
  private exitToMenu(): void
  {
    this.audio.silenceEngine();
    this.audio.updateScreech(0);
    this.audio.stopRumble();
    this.audio.stopMusic();
    this.phase = GamePhase.INTRO;
    if (document.fullscreenElement)
      document.exitFullscreen().catch(() => {});
  }

  // ── Phase: COUNTDOWN ──────────────────────────────────────────────────────

  private tickCountdown(dt: number): void
  {
    this.countdownTimer += dt;

    const prev = this.countdownValue;

    if (this.countdownTimer < 1.0)      this.countdownValue = 3;
    else if (this.countdownTimer < 2.0) this.countdownValue = 2;
    else if (this.countdownTimer < 3.0) this.countdownValue = 1;
    else if (this.countdownTimer < 3.7) this.countdownValue = 'GO!';
    else
    {
      this.phase = GamePhase.PLAYING;
      return;
    }

    // Beep on each new number
    if (this.countdownValue !== prev)
    {
      if      (this.countdownValue === 3)    this.audio.playBeep(220, 0.18);
      else if (this.countdownValue === 2)    this.audio.playBeep(330, 0.18);
      else if (this.countdownValue === 1)    this.audio.playBeep(440, 0.18);
      else if (this.countdownValue === 'GO!') this.audio.playBeep(880, 0.40);
    }

    this.audio.tickMusic();

    // Draw road scene + countdown overlay
    this.drawRace();
    this.renderer.renderCountdown(this.w, this.h, this.countdownValue);
  }

  // ── Phase: PLAYING ─────────────────────────────────────────────────────────

  private tickPlaying(dt: number): void
  {
    this.raceTimer += dt;
    this.audio.tickMusic();
    this.update(dt);
    this.drawRace();

    // ── Quit button hover + click ─────────────────────────────────────────
    this.btnQuit.tick(this.mouseX, this.mouseY, this.clickX, this.clickY, this.mouseClick);
    this.canvas.style.cursor = this.btnQuit.hovered ? 'pointer' : 'default';
    if (this.mouseClick)
    {
      this.mouseClick = false;
      if (this.btnQuit.clicked) this.exitToMenu();
    }

    // Finish detection: race length in world units
    const cfg = RACE_CONFIG[this.settings.mode];
    const raceWU = cfg.raceLengthKm * WU_PER_KM;
    if (this.distanceTravelled >= raceWU)
    {
      this.phase = GamePhase.FINISHED;
      this.speed = 0;
    }
  }

  // ── Phase: FINISHED ────────────────────────────────────────────────────────

  private tickFinished(): void
  {
    // Draw the road scene underneath the overlay
    this.drawRace();

    const cfg       = RACE_CONFIG[this.settings.mode];
    const distKm    = this.distanceTravelled / WU_PER_KM;
    this.renderer.renderFinish(this.w, this.h, this.raceTimer, Math.min(distKm, cfg.raceLengthKm));

    const { input } = this;
    if (input.wasPressed('Enter'))   { this.beginRace(); }
    if (input.wasPressed('Escape'))  { this.exitToMenu(); }

    if (this.mouseClick) this.mouseClick = false;
  }

  // ── Physics update (PLAYING only) ─────────────────────────────────────────

  private update(dt: number): void
  {
    const { input } = this;
    const trackLength = this.road.count * SEGMENT_LENGTH;
    const maxSpeed    = this.effectiveMaxSpeed;
    const speedRatio  = this.speed / maxSpeed;
    const cfg         = RACE_CONFIG[this.settings.mode];

    // ── Throttle / brake ───────────────────────────────────────────────────

    if (input.isDown('ArrowUp'))
    {
      let accel: number;
      if (speedRatio < ACCEL_LOW_BAND)
      {
        const t      = speedRatio / ACCEL_LOW_BAND;
        const smooth = t * t * (3 - 2 * t);
        accel = PLAYER_ACCEL_LOW + (PLAYER_ACCEL_MID - PLAYER_ACCEL_LOW) * smooth;
      }
      else if (speedRatio < ACCEL_HIGH_BAND)
      {
        accel = PLAYER_ACCEL_MID;
      }
      else
      {
        accel = PLAYER_ACCEL_MID * (1 - speedRatio) / (1 - ACCEL_HIGH_BAND);
      }

      this.speed     += accel * cfg.accelMultiplier * this.hitRecoveryBoost * dt;
      this.brakeHeld  = 0;
    }
    else if (input.isDown('ArrowDown'))
    {
      this.brakeHeld = Math.min(this.brakeHeld + dt, PLAYER_BRAKE_RAMP);
      const t        = this.brakeHeld / PLAYER_BRAKE_RAMP;
      this.speed    -= PLAYER_BRAKE_MAX * t * t * dt;
    }
    else
    {
      const coastRate = PLAYER_COAST_RATE * (0.5 + 0.5 * speedRatio);
      this.speed     -= coastRate * dt;
      this.brakeHeld  = Math.max(0, this.brakeHeld - dt * 4);
    }

    this.speed = Math.max(0, Math.min(this.speed, maxSpeed));

    // ── Steering ───────────────────────────────────────────────────────────

    const gripFactor = 1 - speedRatio * speedRatio * 0.5;
    if (this.speed > 0)
    {
      if (input.isDown('ArrowLeft'))  this.playerX -= PLAYER_STEERING * gripFactor * dt;
      if (input.isDown('ArrowRight')) this.playerX += PLAYER_STEERING * gripFactor * dt;
    }
    this.playerX = Math.max(-2, Math.min(2, this.playerX));

    // ── Centrifugal force ──────────────────────────────────────────────────

    const playerSegment = this.road.findSegment(this.playerZ);
    this.playerX -= playerSegment.curve * speedRatio * CENTRIFUGAL * dt;

    // ── Drift ──────────────────────────────────────────────────────────────

    if (speedRatio > 0.5 && Math.abs(playerSegment.curve) > 0)
    {
      const centForce = Math.abs(playerSegment.curve * speedRatio * CENTRIFUGAL);
      const availGrip = PLAYER_STEERING * gripFactor;
      if (centForce > availGrip * DRIFT_ONSET)
      {
        const excess   = centForce - availGrip * DRIFT_ONSET;
        const slideDir = playerSegment.curve > 0 ? -1 : 1;
        this.slideVelocity += slideDir * excess * DRIFT_RATE * dt;
      }
    }
    this.playerX += this.slideVelocity * dt;

    const counterSteering =
      (this.slideVelocity >  0.02 && input.isDown('ArrowLeft')) ||
      (this.slideVelocity < -0.02 && input.isDown('ArrowRight'));
    let decayRate = counterSteering ? DRIFT_CATCH : DRIFT_DECAY;
    if (this.hitCooldown > 0) decayRate = Math.min(decayRate, 2.5);
    this.slideVelocity *= Math.exp(-decayRate * dt);

    // Continuous screech: feed grip ratio every frame; AudioManager fades in/out
    if (speedRatio > 0.4 && Math.abs(playerSegment.curve) > 0)
    {
      const centForce  = Math.abs(playerSegment.curve * speedRatio * CENTRIFUGAL);
      const availGrip  = PLAYER_STEERING * gripFactor;
      this.audio.updateScreech(centForce / availGrip);
    }
    else
    {
      this.audio.updateScreech(0);
    }

    const slideCap = this.hitCooldown > 0 ? 0.75 : 0.5;
    this.slideVelocity = Math.max(-slideCap, Math.min(slideCap, this.slideVelocity));

    // ── Steer angle (visual) ───────────────────────────────────────────────

    if (input.isDown('ArrowLeft'))        this.steerAngle -= PLAYER_STEER_RATE * dt;
    else if (input.isDown('ArrowRight'))  this.steerAngle += PLAYER_STEER_RATE * dt;
    else                                  this.steerAngle *= Math.exp(-PLAYER_STEER_RATE * 4 * dt);
    this.steerAngle = Math.max(-1, Math.min(1, this.steerAngle));

    // ── Off-road ───────────────────────────────────────────────────────────

    this.offRoad = Math.abs(this.playerX) > 1;

    if (this.offRoad)
    {
      this.speed          -= OFFROAD_DECEL * dt;
      if (input.isDown('ArrowUp'))
        this.speed = Math.max(this.speed, maxSpeed * OFFROAD_CRAWL_RATIO);
      this.offRoadRecovery = 0;
      const jitterTarget   = this.speed > 0 ? (Math.random() - 0.5) * 10 : 0;
      this.jitterY += (jitterTarget - this.jitterY) * (1 - Math.exp(-OFFROAD_JITTER_BLEND * dt));

      if (!this.wasOffRoad) this.audio.startRumble();
    }
    else
    {
      this.offRoadRecovery = Math.min(1, this.offRoadRecovery + dt / OFFROAD_RECOVERY_TIME);
      if (this.offRoadRecovery < 1)
      {
        const recoveryMax = maxSpeed * (OFFROAD_MAX_RATIO + (1 - OFFROAD_MAX_RATIO) * this.offRoadRecovery);
        this.speed = Math.min(this.speed, recoveryMax);
      }
      this.jitterY *= Math.exp(-OFFROAD_JITTER_DECAY * dt);

      if (this.wasOffRoad) this.audio.stopRumble();
    }
    this.wasOffRoad = this.offRoad;

    this.speed = Math.max(0, Math.min(this.speed, maxSpeed));

    // ── Collision ──────────────────────────────────────────────────────────

    this.updateCollisions(dt);

    // ── Advance ───────────────────────────────────────────────────────────

    const stepWU      = this.speed * dt;
    this.playerZ      = ((this.playerZ + stepWU) % trackLength + trackLength) % trackLength;
    this.distanceTravelled += stepWU;

    // ── Traffic ───────────────────────────────────────────────────────────

    updateTraffic(this.trafficCars, this.playerZ, this.road.count, dt);

    // ── Engine audio ──────────────────────────────────────────────────────

    this.audio.updateEngine(speedRatio);
  }

  // ── Collision ──────────────────────────────────────────────────────────────

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

  private updateCollisions(dt: number): void
  {
    this.hitCooldown      = Math.max(0, this.hitCooldown      - dt);
    this.grindTimer       = Math.max(0, this.grindTimer       - dt);
    this.hitRecoveryTimer = Math.max(0, this.hitRecoveryTimer - dt);
    this.shakeTimer       = Math.max(0, this.shakeTimer       - dt);

    if (this.grindTimer > 0) this.speed -= HIT_CRUNCH_GRIND_DECEL * dt;

    if (this.shakeTimer > 0)
      this.jitterY = (Math.random() - 0.5) * this.shakeIntensity * 2;

    if (this.hitRecoveryTimer <= 0) this.hitRecoveryBoost = 1.0;

    const segIdx = this.road.findSegmentIndex(this.playerZ);
    this.blockSolidObjects(segIdx);

    if (this.hitCooldown > 0) return;

    const { hit, nearMiss } = checkCollisions(
      this.playerX,
      this.road.segments,
      this.road.count,
      segIdx,
    );

    if (!hit && nearMiss)
      this.playerX += nearMiss.wobbleDir * NEAR_MISS_WOBBLE;

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
        const preHitRatio = this.speed / this.effectiveMaxSpeed;
        this.speed = Math.min(this.speed, this.effectiveMaxSpeed * TRAFFIC_HIT_SPEED_CAP);
        const bumpSign = -trafficHit.bumpDir;
        const flick    = Math.max(TRAFFIC_HIT_FLICK_BASE, preHitRatio * TRAFFIC_HIT_FLICK_RESTITUTION);
        this.slideVelocity  = bumpSign * Math.min(flick, 0.75);
        this.shakeTimer       = SHAKE_TRAFFIC_DURATION;
        this.shakeIntensity   = SHAKE_TRAFFIC_INTENSITY;
        this.hitCooldown      = TRAFFIC_HIT_COOLDOWN;
        this.hitRecoveryTimer = TRAFFIC_HIT_RECOVERY_TIME;
        this.hitRecoveryBoost = TRAFFIC_HIT_RECOVERY_BOOST;
        if (this.speed > 0)
          this.speed = Math.max(this.speed, this.effectiveMaxSpeed * HIT_SPEED_FLOOR);
        trafficHit.hitCar.hitVelX   = trafficHit.bumpDir * 4500;
        trafficHit.hitCar.spinAngle = 0;
        this.playerX = Math.max(-2, Math.min(2, this.playerX));
        this.audio.playCrashCar();

        if (trafficHit.hitCar.type === TrafficType.Barney)
          this.audio.playBarney();
      }
      return;
    }

    const preHitSpeedRatio = this.speed / this.effectiveMaxSpeed;
    const gripFactor       = 1 - preHitSpeedRatio * preHitSpeedRatio * 0.5;
    const bumpSign         = -hit.bumpDir;
    const steerApproach = hit.bumpDir * this.steerAngle * PLAYER_STEERING * gripFactor;
    const slideApproach = hit.bumpDir * this.slideVelocity;
    const approach      = Math.max(0, steerApproach + slideApproach);

    switch (hit.cls)
    {
      case CollisionClass.Glance:
      {
        this.speed   *= HIT_GLANCE_SPEED_MULT;
        this.playerX += bumpSign * HIT_GLANCE_BUMP;
        this.shakeTimer     = SHAKE_GLANCE_DURATION;
        this.shakeIntensity = SHAKE_GLANCE_INTENSITY;
        this.hitCooldown    = HIT_GLANCE_COOLDOWN;
        this.audio.playCrashObject();
        break;
      }
      case CollisionClass.Smack:
      {
        this.speed *= HIT_SMACK_SPEED_MULT;
        this.speed  = Math.min(this.speed, this.effectiveMaxSpeed * HIT_SMACK_SPEED_CAP);
        const flick         = Math.max(0.08, approach * HIT_SMACK_RESTITUTION + preHitSpeedRatio * HIT_SMACK_FLICK_BASE);
        this.slideVelocity  = bumpSign * Math.min(flick, 0.45);
        this.shakeTimer       = SHAKE_SMACK_DURATION;
        this.shakeIntensity   = SHAKE_SMACK_INTENSITY;
        this.hitCooldown      = HIT_SMACK_COOLDOWN;
        this.hitRecoveryTimer = HIT_SMACK_RECOVERY_TIME;
        this.hitRecoveryBoost = HIT_SMACK_RECOVERY_BOOST;
        this.audio.playCrashObject();
        break;
      }
      case CollisionClass.Crunch:
      {
        this.speed = Math.min(this.speed, this.effectiveMaxSpeed * HIT_CRUNCH_SPEED_CAP);
        this.grindTimer = HIT_CRUNCH_GRIND_TIME;
        const flick        = Math.max(0.14, approach * HIT_CRUNCH_RESTITUTION + preHitSpeedRatio * HIT_CRUNCH_FLICK_BASE);
        this.slideVelocity = bumpSign * Math.min(flick, 0.45);
        this.shakeTimer     = SHAKE_CRUNCH_DURATION;
        this.shakeIntensity = SHAKE_CRUNCH_INTENSITY;
        this.hitCooldown    = HIT_CRUNCH_COOLDOWN;
        this.hitRecoveryTimer = HIT_CRUNCH_RECOVERY_TIME;
        this.hitRecoveryBoost = HIT_CRUNCH_RECOVERY_BOOST;
        this.audio.playCrashObject();
        break;
      }
      case CollisionClass.Ghost:
        break;
      default:
      {
        const _exhaustive: never = hit.cls;
      }
    }

    if (this.speed > 0)
      this.speed = Math.max(this.speed, this.effectiveMaxSpeed * HIT_SPEED_FLOOR);
    this.playerX = Math.max(-2, Math.min(2, this.playerX));
  }

  // ── Draw helpers ───────────────────────────────────────────────────────────

  private drawRace(): void
  {
    const { renderer, road, w, h } = this;
    const driftVisual = -this.slideVelocity * 0.15;
    const renderSteer = Math.max(-1, Math.min(1, this.steerAngle + driftVisual));

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
      this.raceTimer,
      this.distanceTravelled / WU_PER_KM,
      this.btnQuit,
    );
  }
}
