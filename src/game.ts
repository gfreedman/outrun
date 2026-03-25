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
import {
  advancePhysics, applyCollisionResponse,
  PhysicsState, InputSnapshot, PhysicsConfig,
} from './physics';
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
  RACE_TIME_LIMIT,
  SCORE_BASE_PER_SEC, SCORE_SPEED_PER_SEC, SCORE_CRASH_PENALTY,
  SCORE_FINISH_BASE, SCORE_TIME_BONUS_PER_SEC,
  TIMEUP_DECEL,
  TIME_PENALTY_HIT,
  BARNEY_BOOST_MULTIPLIER, BARNEY_BOOST_DURATION, BARNEY_KILL_BONUS,
  FINISHING_DURATION, FINISHING_DECEL,
} from './constants';

/** localStorage key used to persist GameSettings between sessions. */
const STORAGE_KEY = 'outrun_settings';

/**
 * Reads persisted GameSettings from localStorage.
 * Falls back to { mode: MEDIUM, soundEnabled: true } if nothing is stored
 * or the stored value is malformed.
 */
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

/**
 * Writes GameSettings to localStorage so they survive page reloads.
 * Silently ignores quota / private-browsing errors.
 */
function saveSettings(s: GameSettings): void
{
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); }
  catch { /* quota / private-mode */ }
}

/**
 * Top-level game controller.
 *
 * Owns the state machine (GamePhase), all physics state, the Renderer,
 * InputManager, AudioManager, and the rAF loop.  The HTML page creates one
 * Game instance and calls start() / resize() — everything else is internal.
 *
 * State machine summary:
 *   PRELOADING → INTRO → COUNTDOWN → PLAYING ─┬→ FINISHING → GOAL
 *                                               └→ TIMEUP
 *   GOAL / TIMEUP → INTRO (via exitToMenu or user input)
 */
export class Game
{
  /** The HTML canvas element the game renders into. */
  private canvas:   HTMLCanvasElement;
  /** Stateless renderer -- receives all state as params to render(). */
  private renderer: Renderer;
  /** Keyboard/touch input polling manager. */
  private input:    InputManager;
  /** Web Audio API manager for engine, screech, crash, and music. */
  private audio:    AudioManager;

  // ── State machine ──────────────────────────────────────────────────────────

  /** Current top-level state (PRELOADING, INTRO, COUNTDOWN, PLAYING, etc.). */
  private phase:    GamePhase = GamePhase.PRELOADING;
  /** Persisted user preferences (difficulty mode, sound toggle). */
  private settings: GameSettings;

  // ── Preloader state ────────────────────────────────────────────────────────

  private preloader:  Preloader | null = null;
  private loadError:  string = '';
  private heroImage:  HTMLImageElement | null = null;

  // ── Road + traffic (initialised on game start, not construction) ───────────

  private road:        Road;
  private trafficCars: TrafficCar[] = [];

  // ── Player physics ─────────────────────────────────────────────────────────

  /** World depth position (increases as the player drives forward). */
  private playerZ          = 0;
  /** Normalised lateral position (-1..+1 = road; beyond = off-road). */
  private playerX          = 0;
  /** Forward speed in world units per second. */
  private speed            = 0;
  /** Visual steer angle (-1..+1) for sprite frame selection only. */
  private steerAngle       = 0;
  /** Accumulated brake hold time (seconds); ramps brake force quadratically. */
  private brakeHeld        = 0;
  /** True when |playerX| > 1 (car is on the grass verge). */
  private offRoad          = false;
  /** Recovery blend factor (0 = just left grass, 1 = fully recovered). */
  private offRoadRecovery  = 1;
  /** Lateral slide velocity from drift/oversteer (road-widths/sec). */
  private slideVelocity    = 0;
  /** Vertical pixel jitter from off-road terrain or camera shake. */
  private jitterY          = 0;

  // ── Effective top speed (varies by mode) ──────────────────────────────────

  private effectiveMaxSpeed = PLAYER_MAX_SPEED;

  // ── Collision state ────────────────────────────────────────────────────────

  /** Seconds remaining before the next collision can register. */
  private hitCooldown      = 0;
  /** Seconds remaining of sustained grind drag (house crunch only). */
  private grindTimer       = 0;
  /** Seconds remaining of boosted acceleration recovery after a hit. */
  private hitRecoveryTimer = 0;
  /** Acceleration multiplier during the recovery window (1.0 = normal). */
  private hitRecoveryBoost = 1.0;
  /** Seconds remaining of camera shake effect. */
  private shakeTimer       = 0;
  /** Maximum pixel offset of the current camera shake. */
  private shakeIntensity   = 0;

  // ── Race timers + scoring ─────────────────────────────────────────────────

  /** Total elapsed race time in seconds (counts up from 0). */
  private raceTimer         = 0;
  /** Cumulative world units driven (never wraps -- used for finish detection). */
  private distanceTravelled = 0;
  /** Exact world-unit position where the finish line triggers. */
  private finishLineWU      = 0;
  /** Countdown timer: seconds remaining before TIME UP. */
  private timeRemaining     = 0;
  /** Accumulated score (base rate + speed bonus - crash penalties). */
  private score             = 0;
  /** Seconds left to show the "COCONUT BEACH" stage announcement. */
  private stageNameTimer    = 0;
  /** True once the car has fully stopped after a TIME UP. */
  private timeUpDecelDone   = false;
  /** Seconds left of Barney afterburner speed boost. */
  private barneyBoostTimer  = 0;
  /** Number of Barney cars destroyed this race (bonus at finish). */
  private barneyKillCount   = 0;

  // ── Finishing cinematic ────────────────────────────────────────────────────

  /** Seconds elapsed since crossing the finish line. */
  private finishingTimer       = 0;
  /** True once the sideways slide has been triggered during finishing. */
  private finishingSlid        = false;
  /** World units rolled since FINISHING began -- hard-capped to stop near the gate. */
  private finishingTravelledWU = 0;

  // ── Countdown state ────────────────────────────────────────────────────────

  /** Current countdown step: 3, 2, 1, or 'GO!'. */
  private countdownValue: number | 'GO!' = 3;
  /** Seconds elapsed since the countdown began. */
  private countdownTimer  = 0;

  // ── Intro / menu state ─────────────────────────────────────────────────────

  /** Currently focused main-menu item (keyboard nav). */
  private menuItem:     'start' | 'mode' | 'settings' = 'start';
  /** Which sub-menu overlay is open, or null for the main menu. */
  private menuSubMenu:  'mode' | 'settings' | null = null;
  /** Currently highlighted difficulty in the mode picker. */
  private menuSubMode:  GameMode = GameMode.MEDIUM;
  /** Current state of the sound toggle in the settings panel. */
  private menuSubSound  = true;
  /** Monotonic clock (seconds) driving the 2 Hz blink on menu text. */
  private pulseClock    = 0;

  // ── Mouse state ────────────────────────────────────────────────────────────

  /** Current mouse X in canvas pixels (updated on mousemove). */
  private mouseX     = -1;
  /** Current mouse Y in canvas pixels (updated on mousemove). */
  private mouseY     = -1;
  /** Snapshot of mouseX at click time -- never overwritten by onMouseMove. */
  private clickX     = -1;
  /** Snapshot of mouseY at click time -- never overwritten by onMouseMove. */
  private clickY     = -1;
  /** True for one frame after a left-click; consumed by tick methods. */
  private mouseClick = false;

  /**
   * Converts viewport mouse coordinates to canvas-pixel coordinates.
   * Uses getBoundingClientRect + CSS-to-canvas scale factor so the
   * mapping remains correct when the canvas is letterboxed or resized.
   */
  private onMouseMove = (e: MouseEvent): void =>
  {
    const r      = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width  / r.width;
    const scaleY = this.canvas.height / r.height;
    this.mouseX  = (e.clientX - r.left) * scaleX;
    this.mouseY  = (e.clientY - r.top)  * scaleY;
  };

  /**
   * Handles left-click: records canvas-pixel click position and sets the
   * mouseClick flag.  Only button 0 (left) is processed; right-click ignored.
   */
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
  private btnQuit      = new Button();

  // End screens (TIME UP + GOAL)
  private btnEndContinue  = new Button();   // TIME UP → back to menu
  private btnEndPlayAgain = new Button();   // GOAL → play again
  private btnEndMenu      = new Button();   // GOAL → main menu

  // ── Audio state ────────────────────────────────────────────────────────────

  private wasOffRoad   = false;

  // ── Loop ───────────────────────────────────────────────────────────────────

  /** Timestamp (ms) of the previous requestAnimationFrame callback. */
  private lastTimestamp = 0;
  /** Current requestAnimationFrame handle; 0 when the loop is stopped. */
  private rafId         = 0;

  /** Current canvas width in CSS pixels (set by resize()). */
  w = 0;
  /** Current canvas height in CSS pixels (set by resize()). */
  h = 0;

  /**
   * Creates a Game instance bound to the given canvas.
   *
   * Instantiates the Renderer, InputManager, and AudioManager, loads all
   * sprite sheets and audio assets via a Preloader, then waits in the
   * PRELOADING phase until every asset resolves before advancing to INTRO.
   *
   * @param canvas           - The HTML canvas element to render into.
   * @param initialSettings  - Optional settings override (e.g. from tests).
   *                           Falls back to localStorage, then defaults.
   */
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

  /**
   * Starts the requestAnimationFrame loop.
   * Safe to call multiple times — ignored if the loop is already running.
   */
  start(): void
  {
    if (this.rafId !== 0) return;
    this.lastTimestamp = performance.now();
    this.rafId = requestAnimationFrame(this.loop);
  }

  /**
   * Cancels the requestAnimationFrame loop.
   * The game state is preserved; call start() to resume.
   */
  stop(): void
  {
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  /**
   * Updates the logical canvas resolution.
   * Called by main.ts on every window resize and fullscreen change.
   *
   * @param w - New canvas width in CSS pixels.
   * @param h - New canvas height in CSS pixels.
   */
  resize(w: number, h: number): void { this.w = w; this.h = h; }

  /**
   * Stops the loop and removes all event listeners.
   * Call when the game is being torn down (e.g. SPA navigation).
   */
  destroy(): void
  {
    this.stop();
    this.input.destroy();
    this.canvas.removeEventListener('mousemove', this.onMouseMove);
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
  }

  // ── Main loop ──────────────────────────────────────────────────────────────

  /**
   * The requestAnimationFrame callback.  Computes a capped delta-time,
   * dispatches to the active phase tick function, then re-schedules itself.
   *
   * dt is capped at MAX_FRAME_DT (1/30 s) so a tab wake-up after a long
   * background pause never causes a giant physics jump.
   */
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
      case GamePhase.FINISHING:  this.tickFinishing(dt);    break;
      case GamePhase.GOAL:       this.tickGoal();           break;
      case GamePhase.TIMEUP:     this.tickTimeUp(dt);       break;
    }

    this.rafId = requestAnimationFrame(this.loop);
  };

  // ── Phase: PRELOADING ──────────────────────────────────────────────────────

  /**
   * Renders the loading progress bar each frame while assets download.
   * No physics or input are processed during this phase.
   */
  private tickPreload(): void
  {
    const progress = this.preloader?.progress ?? 0;
    this.renderer.renderPreloader(this.w, this.h, progress, this.loadError || undefined);
  }

  // ── Phase: INTRO ───────────────────────────────────────────────────────────

  /**
   * Processes input and renders the title/menu screen each frame.
   *
   * Handles three sub-states based on menuSubMenu:
   *   null       → main menu: arrow-key focus + Enter/click on START/MODE/SETTINGS.
   *   'mode'     → difficulty picker: up/down selects; Enter or click confirms.
   *   'settings' → options panel: Enter/click toggles sound; Escape/click-out closes.
   *
   * Button hit-areas are registered by the renderer; this method calls btn.tick()
   * immediately after to compute hover/click state for this frame.
   *
   * @param dt - Frame delta-time (used only to advance pulseClock).
   */
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


  /**
   * Initialises all race state and transitions to COUNTDOWN.
   * Called when the player confirms START from the intro menu, or hits PLAY AGAIN.
   *
   * Responsibilities:
   *   - Selects the correct road data (EASY = default, MEDIUM/HARD = hard course).
   *   - Applies mode-specific hill/curve scaling and injects the finish celebration.
   *   - Resets all physics, collision, scoring, and timer fields.
   *   - Starts music and requests fullscreen (first interaction allowed by browsers).
   */
  private beginRace(): void
  {
    // EASY uses the base Nürburgring course; MEDIUM and HARD use the hard course layout
    // (MEDIUM applies 75% curve / 80% hill scaling so it sits halfway between modes)
    const roadData = this.settings.mode === GameMode.EASY ? ROAD_DATA : ROAD_DATA_HARD;
    this.road = Road.fromData(roadData, this.settings.mode);
    this.road.injectFinishCelebration();

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
    this.raceTimer         = 0;
    this.distanceTravelled = 0;
    // Finish fires exactly as the car crosses the start/finish gate on its return lap.
    // Gate is at segment START_GATE_SEGMENT; add one extra segment so the car is
    // visually past it before FINISHING triggers.
    this.finishLineWU = (this.road.count + Road.START_GATE_SEGMENT + 1) * SEGMENT_LENGTH;
    this.timeRemaining     = RACE_TIME_LIMIT[this.settings.mode];
    this.score             = 0;
    this.stageNameTimer    = 3.5;
    this.timeUpDecelDone   = false;
    this.barneyBoostTimer  = 0;
    this.barneyKillCount   = 0;
    this.finishingTimer       = 0;
    this.finishingSlid        = false;
    this.finishingTravelledWU = 0;

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

  /**
   * Returns to the INTRO phase.
   * Silences all audio, clears engine/screech, stops music, and exits
   * fullscreen if it was active.  Safe to call from any in-game phase.
   */
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

  /**
   * Advances the 3-2-1-GO! countdown sequence.
   *
   * The road scene is rendered but the car is stationary (update() is not called).
   * A tone is played on each transition.  After "GO!" has shown for 0.7 s the
   * phase advances to PLAYING.
   *
   * @param dt - Frame delta-time in seconds.
   */
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

  /**
   * The main gameplay tick — called every frame during the race.
   *
   * Per-frame order:
   *   1. Advance race/countdown timers; accumulate score at current speed.
   *   2. Tick music and run full physics update().
   *   3. Render the road scene (drawRace).
   *   4. Process QUIT button.
   *   5. Check finish-line crossing → FINISHING.
   *   6. Check time expiry → TIMEUP.
   *
   * @param dt - Frame delta-time in seconds.
   */
  private tickPlaying(dt: number): void
  {
    this.raceTimer        += dt;
    this.timeRemaining     = Math.max(0, this.timeRemaining - dt);
    this.stageNameTimer    = Math.max(0, this.stageNameTimer - dt);
    this.barneyBoostTimer  = Math.max(0, this.barneyBoostTimer - dt);

    // Score: base rate + speed bonus (pts/sec)
    const speedRatio = this.speed / this.effectiveMaxSpeed;
    this.score += Math.round((SCORE_BASE_PER_SEC + SCORE_SPEED_PER_SEC * speedRatio) * dt);

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

    // ── Finish detection (checked BEFORE time-up so a simultaneous
    //    crossing-as-clock-hits-zero gives FINISHING, not TIME UP) ──────
    const cfg = RACE_CONFIG[this.settings.mode];
    if (this.distanceTravelled >= this.finishLineWU)
    {
      // Bank the score now (once); the cinematic runs then GOAL screen shows it
      this.score += SCORE_FINISH_BASE
        + Math.round(this.timeRemaining * SCORE_TIME_BONUS_PER_SEC)
        + this.barneyKillCount * BARNEY_KILL_BONUS;
      this.phase                = GamePhase.FINISHING;
      this.finishingTimer       = 0;
      this.finishingSlid        = false;
      this.finishingTravelledWU = 0;
      // Kick a sideways skid — car slides in the direction it was already
      // drifting (or away from centre if stopped), then decays to a halt.
      {
        const dir = this.slideVelocity !== 0
          ? Math.sign(this.slideVelocity)
          : (this.playerX >= 0 ? 1 : -1);
        this.slideVelocity = dir * 0.65;
      }
      this.audio.updateScreech(0);
      this.audio.playBeep(880, 0.8);
      return;
    }

    // ── Time up ───────────────────────────────────────────────────────────
    if (this.timeRemaining <= 0)
    {
      this.phase = GamePhase.TIMEUP;
    }
  }

  // ── Phase: FINISHING ───────────────────────────────────────────────────────
  // Player input is gone.  Car decelerates hard while a sideways slide kicks in
  // immediately — car crosses the finish gate and skids to a stop just past it.
  // Confetti rains throughout.  After FINISHING_DURATION → GOAL screen.

  /**
   * Plays the post-finish cinematic: hard deceleration, sideways skid, and
   * confetti rain.  The car rolls at most 12 segments past the gate so it
   * stops inside the billboard celebration zone.
   *
   * No player input is accepted during this phase.
   * After FINISHING_DURATION seconds the phase advances to GOAL.
   *
   * @param dt - Frame delta-time in seconds.
   */
  private tickFinishing(dt: number): void
  {
    this.finishingTimer += dt;

    // ── Hard deceleration — stops from max speed in under 1 second ────────
    this.speed = Math.max(0, this.speed - FINISHING_DECEL * dt);

    // ── Sideways finish skid ──────────────────────────────────────────────
    // slideVelocity was kicked at transition; it decays over ~1.5 s.
    // steerAngle mirrors the slide direction (countersteering look).
    // playerX is clamped so the car never leaves the road surface.
    this.playerX      += this.slideVelocity * dt;
    this.playerX       = Math.max(-0.92, Math.min(0.92, this.playerX));
    this.slideVelocity *= Math.exp(-1.8 * dt);
    this.steerAngle    = -this.slideVelocity * 0.5;

    // ── Advance road — hard stop inside the billboard celebration zone ────
    // The car is still fast enough to blow through hundreds of segments, so
    // we cap the total roll-out to 12 segments past the gate.  Once the
    // budget is spent, playerZ freezes and the car appears stopped inside
    // the billboard cluster.
    const trackLength   = this.road.count * SEGMENT_LENGTH;
    const FINISH_BUDGET = 12 * SEGMENT_LENGTH;              // 2 400 WU
    const stepWU        = this.speed * dt;
    const allowed       = Math.max(0, FINISH_BUDGET - this.finishingTravelledWU);
    const actualStep    = Math.min(stepWU, allowed);
    this.finishingTravelledWU += actualStep;
    this.playerZ = ((this.playerZ + actualStep) % trackLength + trackLength) % trackLength;

    // ── Audio ─────────────────────────────────────────────────────────────
    this.audio.updateEngine(this.speed / this.effectiveMaxSpeed);
    this.audio.updateScreech(0);
    this.audio.tickMusic();

    // ── Render ────────────────────────────────────────────────────────────
    const { renderer, road, w, h } = this;
    const cfg         = RACE_CONFIG[this.settings.mode];
    const driftVisual = -this.slideVelocity * 0.12;
    const renderSteer = Math.max(-1, Math.min(1, this.steerAngle + driftVisual));

    renderer.render(
      road.segments, road.count,
      this.playerZ, this.playerX,
      DRAW_DISTANCE, w, h,
      this.speed, renderSteer, 0,
      [],          // traffic hidden during cinematic
      this.raceTimer,
      this.distanceTravelled / WU_PER_KM,
      cfg.raceLengthKm,
      this.timeRemaining,
      this.score,
      0, 0,
      undefined,   // no quit button
    );

    renderer.renderConfetti(w, h, this.finishingTimer);

    if (this.finishingTimer >= FINISHING_DURATION)
      this.phase = GamePhase.GOAL;
  }

  // ── Phase: GOAL ────────────────────────────────────────────────────────────

  /**
   * Renders the GOAL results screen each frame and handles dismissal input.
   * The road scene stays rendered in the background (car is frozen at the gate).
   * Enter / PLAY AGAIN → beginRace(); Escape / MAIN MENU → exitToMenu().
   */
  private tickGoal(): void
  {
    this.drawRace();
    this.renderer.renderGoalScreen(
      this.w, this.h, this.score, this.raceTimer, this.barneyKillCount,
      this.timeRemaining,
      this.btnEndPlayAgain, this.btnEndMenu,
    );

    this.btnEndPlayAgain.tick(this.mouseX, this.mouseY, this.clickX, this.clickY, this.mouseClick);
    this.btnEndMenu     .tick(this.mouseX, this.mouseY, this.clickX, this.clickY, this.mouseClick);
    this.canvas.style.cursor = anyHovered(this.btnEndPlayAgain, this.btnEndMenu) ? 'pointer' : 'default';

    if (this.mouseClick)
    {
      this.mouseClick = false;
      if (this.btnEndPlayAgain.clicked) { this.beginRace(); return; }
      if (this.btnEndMenu.clicked)      { this.exitToMenu(); return; }
    }
    if (this.input.wasPressed('Enter'))  { this.beginRace(); return; }
    if (this.input.wasPressed('Escape')) { this.exitToMenu(); return; }
  }

  // ── Phase: TIMEUP ──────────────────────────────────────────────────────────

  /**
   * Decelerates the car to a stop after the countdown reaches zero, then
   * shows the TIME UP overlay until the player presses CONTINUE.
   * Engine audio fades with speed.  Enter / Escape / CONTINUE → exitToMenu().
   *
   * @param dt - Frame delta-time in seconds.
   */
  private tickTimeUp(dt: number): void
  {
    // Decelerate to a stop; fade engine with speed
    if (!this.timeUpDecelDone)
    {
      this.speed = Math.max(0, this.speed - TIMEUP_DECEL * dt);
      if (this.speed === 0) this.timeUpDecelDone = true;
    }
    this.audio.updateEngine(this.speed / this.effectiveMaxSpeed);
    this.audio.updateScreech(0);

    this.audio.tickMusic();
    this.drawRace();
    this.renderer.renderTimeUpScreen(this.w, this.h, this.score, this.btnEndContinue);

    this.btnEndContinue.tick(this.mouseX, this.mouseY, this.clickX, this.clickY, this.mouseClick);
    this.canvas.style.cursor = this.btnEndContinue.hovered ? 'pointer' : 'default';

    if (this.mouseClick)
    {
      this.mouseClick = false;
      if (this.btnEndContinue.clicked) { this.exitToMenu(); return; }
    }
    if (this.input.wasPressed('Enter') || this.input.wasPressed('Escape'))
    {
      this.exitToMenu();
    }
  }

  // ── Physics update (PLAYING only) ─────────────────────────────────────────

  /**
   * Advances all player physics by one time step.  Called only in PLAYING phase.
   *
   * Processing order (order matters — later steps read values set by earlier ones):
   *   1. Throttle / brake / coast → raw speed.
   *   2. Barney afterburner → override speed cap.
   *   3. Steering input → playerX.
   *   4. Centrifugal force → playerX drift.
   *   5. Drift / oversteer → slideVelocity accumulates and decays.
   *   6. Visual steer angle (sprite frame only, not physics).
   *   7. Off-road detection → speed cap + terrain jitter.
   *   8. Collision detection and response.
   *   9. Advance playerZ, distanceTravelled.
   *  10. Update traffic positions.
   *  11. Update engine audio.
   *
   * @param dt - Frame delta-time in seconds (already capped at MAX_FRAME_DT).
   */

  /** Reads all 17 physics fields from `this` into a PhysicsState snapshot. */
  private capturePhysicsState(): PhysicsState
  {
    return {
      speed:             this.speed,
      playerX:           this.playerX,
      playerZ:           this.playerZ,
      steerAngle:        this.steerAngle,
      brakeHeld:         this.brakeHeld,
      offRoad:           this.offRoad,
      offRoadRecovery:   this.offRoadRecovery,
      slideVelocity:     this.slideVelocity,
      jitterY:           this.jitterY,
      hitCooldown:       this.hitCooldown,
      grindTimer:        this.grindTimer,
      hitRecoveryTimer:  this.hitRecoveryTimer,
      hitRecoveryBoost:  this.hitRecoveryBoost,
      shakeTimer:        this.shakeTimer,
      shakeIntensity:    this.shakeIntensity,
      barneyBoostTimer:  this.barneyBoostTimer,
      distanceTravelled: this.distanceTravelled,
    };
  }

  /** Writes all 17 physics fields from a PhysicsState back to `this`. */
  private applyPhysicsState(s: PhysicsState): void
  {
    this.speed             = s.speed;
    this.playerX           = s.playerX;
    this.playerZ           = s.playerZ;
    this.steerAngle        = s.steerAngle;
    this.brakeHeld         = s.brakeHeld;
    this.offRoad           = s.offRoad;
    this.offRoadRecovery   = s.offRoadRecovery;
    this.slideVelocity     = s.slideVelocity;
    this.jitterY           = s.jitterY;
    this.hitCooldown       = s.hitCooldown;
    this.grindTimer        = s.grindTimer;
    this.hitRecoveryTimer  = s.hitRecoveryTimer;
    this.hitRecoveryBoost  = s.hitRecoveryBoost;
    this.shakeTimer        = s.shakeTimer;
    this.shakeIntensity    = s.shakeIntensity;
    this.barneyBoostTimer  = s.barneyBoostTimer;
    this.distanceTravelled = s.distanceTravelled;
  }

  private update(dt: number): void
  {
    const playerSegment = this.road.findSegment(this.playerZ);
    const input: InputSnapshot = {
      throttle:   this.input.isDown('ArrowUp'),
      brake:      this.input.isDown('ArrowDown') || this.input.isDown(' '),
      steerLeft:  this.input.isDown('ArrowLeft'),
      steerRight: this.input.isDown('ArrowRight'),
    };
    const cfg: PhysicsConfig = {
      maxSpeed:        this.effectiveMaxSpeed,
      accelMultiplier: RACE_CONFIG[this.settings.mode].accelMultiplier,
      trackLength:     this.road.count * SEGMENT_LENGTH,
      segmentCurve:    playerSegment.curve,
    };

    const prevOffRoad = this.offRoad;
    const physIn      = this.capturePhysicsState();
    const { state: physOut, screechRatio } = advancePhysics(physIn, input, dt, cfg);
    this.applyPhysicsState(physOut);

    // ── Audio feedback (non-pure, stays in game.ts) ─────────────────────

    this.audio.updateScreech(screechRatio);

    if (this.offRoad && !prevOffRoad) this.audio.startRumble();
    if (!this.offRoad && prevOffRoad) this.audio.stopRumble();
    this.wasOffRoad = this.offRoad;

    // ── Collision ──────────────────────────────────────────────────────────

    this.updateCollisions(dt);

    // ── Traffic ───────────────────────────────────────────────────────────

    updateTraffic(this.trafficCars, this.playerZ, this.road.count, dt);

    // ── Engine audio ──────────────────────────────────────────────────────

    const speedRatio = this.speed / this.effectiveMaxSpeed;
    this.audio.updateEngine(speedRatio);
  }

  // ── Collision ──────────────────────────────────────────────────────────────

  /**
   * Pushes the player away from any solid (Smack/Crunch) objects within the
   * COLLISION_WINDOW segment range.  This is a positional constraint applied
   * every frame (regardless of hitCooldown) so the car cannot phase through
   * a solid object by approaching it from the side.
   *
   * Only fires when the player is already off-road (|playerX| >= COLLISION_MIN_OFFSET).
   * On-road players cannot overlap road-edge objects by definition.
   *
   * @param segIdx - Index of the segment the player is currently on.
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
   * Ticks all collision timers, runs solid-object blocking, then tests for
   * new static-sprite and traffic collisions.
   *
   * Static-sprite collisions (checkCollisions) are tested first.  If a hit
   * is found, traffic collision testing is skipped for this frame — the car
   * can only take one hit class per cooldown window.
   *
   * Traffic collision handling distinguishes two cases:
   *   - Barney hit: triggers afterburner, no penalty.
   *   - Regular hit: speed penalty + lateral flick + time penalty (−1 s).
   *   - Afterburner active: bulldoze through — no penalty, the struck car
   *     gets flung hard.
   *
   * Near-misses apply a cosmetic wobble nudge but no speed or score penalty.
   *
   * @param dt - Frame delta-time in seconds.
   */
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
        const boosting    = this.barneyBoostTimer > 0;
        const preHitRatio = this.speed / this.effectiveMaxSpeed;

        if (boosting)
        {
          // ── Afterburner: bulldoze through — no speed penalty, no lateral bump ──
          // Short cooldown (0.15 s) prevents re-detecting the SAME car this frame;
          // fast enough to chain into the next car immediately after.
          // Struck car launches harder (proportional to boost speed).
          this.shakeTimer     = SHAKE_TRAFFIC_DURATION * 0.4;
          this.shakeIntensity = SHAKE_TRAFFIC_INTENSITY * 0.5;
          this.hitCooldown    = 0.15;
          trafficHit.hitCar.hitVelX   = trafficHit.bumpDir * 9000;   // flung hard
          trafficHit.hitCar.spinAngle = 0;
          this.audio.playCrashCar();
        }
        else
        {
          // ── Normal hit: full speed penalty + lateral flick ──────────────────
          this.speed = Math.min(this.speed, this.effectiveMaxSpeed * TRAFFIC_HIT_SPEED_CAP);
          const bumpSign = -trafficHit.bumpDir;
          const flick    = Math.max(TRAFFIC_HIT_FLICK_BASE, preHitRatio * TRAFFIC_HIT_FLICK_RESTITUTION);
          this.slideVelocity    = bumpSign * Math.min(flick, 0.75);
          this.shakeTimer       = SHAKE_TRAFFIC_DURATION;
          this.shakeIntensity   = SHAKE_TRAFFIC_INTENSITY;
          this.hitCooldown      = TRAFFIC_HIT_COOLDOWN;
          this.hitRecoveryTimer = TRAFFIC_HIT_RECOVERY_TIME;
          this.hitRecoveryBoost = TRAFFIC_HIT_RECOVERY_BOOST;
          if (this.speed > 0)
            this.speed = Math.max(this.speed, this.effectiveMaxSpeed * HIT_SPEED_FLOOR);
          trafficHit.hitCar.hitVelX   = trafficHit.bumpDir * 4500;
          trafficHit.hitCar.spinAngle = 0;
          this.audio.playCrashCar();
        }

        this.playerX = Math.max(-2, Math.min(2, this.playerX));

        if (trafficHit.hitCar.type === TrafficType.Barney)
        {
          // Barney kill: start/chain afterburner + kill tally, no penalty ever
          this.barneyKillCount++;
          this.barneyBoostTimer = BARNEY_BOOST_DURATION;
          this.audio.playBarney();
        }
        else if (!boosting)
        {
          // Regular traffic hit outside afterburner: -1 second time penalty
          this.timeRemaining = Math.max(0, this.timeRemaining - TIME_PENALTY_HIT);
        }
      }
      return;
    }

    const hitResult = applyCollisionResponse(this.capturePhysicsState(), hit, this.effectiveMaxSpeed);
    this.applyPhysicsState(hitResult);

    // Audio stays in game.ts — not part of the pure collision response.
    if (hit.cls !== CollisionClass.Ghost) this.audio.playCrashObject();
  }

  // ── Draw helpers ───────────────────────────────────────────────────────────

  /**
   * Issues a single renderer.render() call with all current game state.
   * The steer angle is augmented by a small drift visual (`-slideVelocity × 0.15`)
   * so the car sprite leans in the direction of an active rear-wheel slide.
   *
   * Used by tickPlaying, tickCountdown, tickGoal, and tickTimeUp — any phase
   * that needs the live road scene behind its overlay.
   */
  private drawRace(): void
  {
    const { renderer, road, w, h } = this;
    const driftVisual = -this.slideVelocity * 0.15;
    const renderSteer = Math.max(-1, Math.min(1, this.steerAngle + driftVisual));
    const cfg         = RACE_CONFIG[this.settings.mode];

    renderer.render(
      road.segments, road.count,
      this.playerZ, this.playerX,
      DRAW_DISTANCE, w, h,
      this.speed, renderSteer, this.jitterY,
      this.trafficCars,
      this.raceTimer,
      this.distanceTravelled / WU_PER_KM,
      this.finishLineWU / WU_PER_KM,   // exact km to gate — matches finish detection
      this.timeRemaining,
      this.score,
      this.stageNameTimer,
      this.barneyBoostTimer,
      this.btnQuit,
    );
  }
}
