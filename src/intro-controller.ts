/**
 * intro-controller.ts
 *
 * Self-contained state machine for the INTRO phase (title screen + menus).
 *
 * Extracted from game.ts to isolate all menu UI state — keyboard nav, button
 * hover/click, sub-menu open/close, settings persistence — from the physics
 * and race logic that lives in Game.
 *
 * Separation contract:
 *   • IntroController owns: menu item focus, sub-menu open state, difficulty
 *     picker selection, sound toggle, pulse clock, hero image, all menu
 *     buttons, GameSettings load/save.
 *   • Game owns: mouse event listeners (shared with in-game phases), mouse
 *     state, canvas, renderer, audio, road, physics — everything that matters
 *     outside the INTRO phase.
 *
 * The one cross-boundary call is `onStartRace()`, a callback injected at
 * construction time.  When the user confirms START, IntroController calls it;
 * Game's `beginRace()` reads `this.intro.settings` for mode/sound preferences.
 */

import { InputManager }         from './input';
import { Renderer }             from './renderer';
import { GameMode, GameSettings } from './types';
import { Button, anyHovered }   from './ui';

// ── Settings persistence ───────────────────────────────────────────────────────

const STORAGE_KEY = 'outrun_settings';

/**
 * Reads persisted GameSettings from localStorage.
 * Falls back to { mode: MEDIUM, soundEnabled: true } on any parse error.
 */
export function loadSettings(): GameSettings
{
  try
  {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw)
    {
      const s    = JSON.parse(raw) as Partial<GameSettings>;
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
 * Writes GameSettings to localStorage.
 * Silently ignores quota / private-browsing errors.
 */
export function saveSettings(s: GameSettings): void
{
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); }
  catch { /* quota / private-mode */ }
}

// ── IntroController ───────────────────────────────────────────────────────────

/**
 * Manages all INTRO phase state and input.
 *
 * Lifecycle: construct once at game startup; call tick() every frame while
 * phase === INTRO.  When the user confirms START, the `onStartRace` callback
 * fires — Game reads `this.intro.settings` then transitions to COUNTDOWN.
 */
export class IntroController
{
  // ── Persisted user preferences ───────────────────────────────────────────

  /** Current difficulty + sound preferences. Read by Game.beginRace(). */
  readonly settings: GameSettings;

  // ── Menu navigation state ────────────────────────────────────────────────

  /** Currently focused main-menu item (keyboard nav). */
  private menuItem:    'start' | 'mode' | 'settings' = 'start';
  /** Which sub-menu overlay is open, or null for the main menu. */
  private menuSubMenu: 'mode' | 'settings' | null = null;
  /** Currently highlighted difficulty in the mode picker. */
  private menuSubMode: GameMode;
  /** Monotonic clock driving the 2 Hz blink on selected menu text. */
  private pulseClock = 0;

  // ── Hero image ───────────────────────────────────────────────────────────

  /** Loaded asynchronously; null until the image resolves. */
  private heroImage: HTMLImageElement | null = null;

  // ── Buttons ──────────────────────────────────────────────────────────────

  // Main menu
  readonly btnMode     = new Button();
  readonly btnSettings = new Button();
  readonly btnStart    = new Button();

  // Mode sub-menu cards
  readonly btnEasy   = new Button();
  readonly btnMedium = new Button();
  readonly btnHard   = new Button();

  // Settings panel
  readonly btnClose  = new Button();
  readonly btnSound  = new Button();
  readonly btnGithub = new Button();

  // ── Wiring ───────────────────────────────────────────────────────────────

  private readonly canvas:       HTMLCanvasElement;
  private readonly onStartRace:  () => void;

  /**
   * @param canvas          - Canvas element; used only for cursor style changes.
   * @param onStartRace     - Called when the user confirms START.
   * @param initialSettings - Optional override; defaults to localStorage then defaults.
   * @param isMobile        - Whether to show touch hint instead of keyboard hint.
   */
  constructor(
    canvas:           HTMLCanvasElement,
    onStartRace:      () => void,
    initialSettings?: GameSettings,
    readonly isMobile: boolean = false,
  )
  {
    this.canvas      = canvas;
    this.onStartRace = onStartRace;
    this.settings    = initialSettings ?? loadSettings();
    this.menuSubMode = this.settings.mode;

    // Load the hero image independently of the sprite preloader.
    // A load failure is non-fatal — the renderer falls back to gradient.
    const img = new Image();
    img.onload  = () => { this.heroImage = img; };
    img.onerror = () => { /* graceful fallback — heroImage stays null */ };
    img.src = 'sprites/source_for_sprites/hero.jpg';
  }

  /**
   * Processes one INTRO frame: advances input, updates menu state, renders.
   *
   * @param dt       - Frame delta-time in seconds.
   * @param input    - Keyboard/touch input manager.
   * @param renderer - Renderer instance (for renderIntro).
   * @param w        - Canvas width in pixels.
   * @param h        - Canvas height in pixels.
   * @param mouseX   - Current mouse X in canvas pixels.
   * @param mouseY   - Current mouse Y in canvas pixels.
   * @param clickX   - Mouse X at last click (snapshot, not overwritten by move).
   * @param clickY   - Mouse Y at last click.
   * @param mouseClick - True if a new left-click arrived this frame.
   * @returns true if `mouseClick` was consumed — caller should clear it.
   */
  tick(
    dt:         number,
    input:      InputManager,
    renderer:   Renderer,
    w:          number,
    h:          number,
    mouseX:     number,
    mouseY:     number,
    clickX:     number,
    clickY:     number,
    mouseClick: boolean,
  ): boolean
  {
    this.pulseClock += dt;

    const MODES = [GameMode.EASY, GameMode.MEDIUM, GameMode.HARD] as const;
    let consumed = false;

    if (this.menuSubMenu === 'mode')
    {
      const idx = MODES.indexOf(this.menuSubMode);

      if (input.wasPressed('ArrowUp')   || input.wasPressed('ArrowLeft'))
        this.menuSubMode = MODES[Math.max(0, idx - 1)];
      if (input.wasPressed('ArrowDown') || input.wasPressed('ArrowRight'))
        this.menuSubMode = MODES[Math.min(MODES.length - 1, idx + 1)];

      if (input.wasPressed('Enter'))
      {
        this.settings.mode = this.menuSubMode;
        this.menuSubMenu   = null;
        saveSettings(this.settings);
      }
      if (input.wasPressed('Escape')) this.menuSubMenu = null;

      const modeButtons = [this.btnEasy, this.btnMedium, this.btnHard] as const;
      modeButtons.forEach(btn => btn.tick(mouseX, mouseY, clickX, clickY, mouseClick));
      modeButtons.forEach((btn, i) => { if (btn.hovered) this.menuSubMode = MODES[i]; });

      if (mouseClick)
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
        consumed = true;
      }

      this.canvas.style.cursor = anyHovered(...modeButtons) ? 'pointer' : 'default';
    }
    else if (this.menuSubMenu === 'settings')
    {
      this.btnClose .tick(mouseX, mouseY, clickX, clickY, mouseClick);
      this.btnSound .tick(mouseX, mouseY, clickX, clickY, mouseClick);
      this.btnGithub.tick(mouseX, mouseY, clickX, clickY, mouseClick);

      this.canvas.style.cursor =
        anyHovered(this.btnClose, this.btnSound, this.btnGithub) ? 'pointer' : 'default';

      if (input.wasPressed('Enter') || input.wasPressed(' ') || this.btnSound.clicked)
      {
        this.settings.soundEnabled = !this.settings.soundEnabled;
        saveSettings(this.settings);
      }

      if (this.btnGithub.clicked)
        window.open('https://github.com/gfreedman/outrun', '_blank', 'noopener');

      // Close on X, Escape, or click outside the panel rect
      const px = Math.round(w * 0.18), py = Math.round(h * 0.16);
      const pw = Math.round(w * 0.64), ph = Math.round(h * 0.62);
      const inPanel = mouseX >= px && mouseX <= px + pw
                   && mouseY >= py && mouseY <= py + ph;
      if (input.wasPressed('Escape') || this.btnClose.clicked || (mouseClick && !inPanel))
        this.menuSubMenu = null;

      consumed = true;
    }
    else
    {
      // ── Main menu ───────────────────────────────────────────────────────
      const items: Array<'mode' | 'settings' | 'start'> = ['mode', 'settings', 'start'];
      const idx = items.indexOf(this.menuItem);

      if (input.wasPressed('ArrowUp'))   this.menuItem = items[Math.max(0, idx - 1)];
      if (input.wasPressed('ArrowDown')) this.menuItem = items[Math.min(items.length - 1, idx + 1)];

      this.btnMode    .tick(mouseX, mouseY, clickX, clickY, mouseClick);
      this.btnSettings.tick(mouseX, mouseY, clickX, clickY, mouseClick);
      this.btnStart   .tick(mouseX, mouseY, clickX, clickY, mouseClick);

      this.canvas.style.cursor =
        anyHovered(this.btnMode, this.btnSettings, this.btnStart) ? 'pointer' : 'default';

      const clickItem: typeof this.menuItem | null =
        this.btnMode.clicked     ? 'mode'     :
        this.btnSettings.clicked ? 'settings' :
        this.btnStart.clicked    ? 'start'     :
        null;

      if (input.wasPressed('Enter') || input.wasPressed(' ') || (mouseClick && clickItem !== null))
      {
        if (clickItem !== null) this.menuItem = clickItem;
        consumed = true;
        if      (this.menuItem === 'mode')     { this.menuSubMenu = 'mode'; this.menuSubMode = this.settings.mode; }
        else if (this.menuItem === 'settings') { this.menuSubMenu = 'settings'; }
        else                                   { this.onStartRace(); }
      }
      else
      {
        consumed = mouseClick;
      }
    }

    renderer.renderIntro(
      w, h,
      this.menuItem,
      this.menuSubMenu === 'mode' ? this.menuSubMode : this.settings.mode,
      this.settings.soundEnabled,
      this.menuSubMenu,
      Math.floor(this.pulseClock * 2) % 2 === 0,
      this.heroImage,
      {
        mode: this.btnMode, settings: this.btnSettings, start: this.btnStart,
        easy: this.btnEasy, medium:   this.btnMedium,   hard:  this.btnHard,
        close: this.btnClose, sound:  this.btnSound,    github: this.btnGithub,
      },
    );

    return consumed;
  }
}
