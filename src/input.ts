/**
 * input.ts
 *
 * Tracks which keyboard keys are currently held down, and which were just
 * pressed this tick (for menu navigation).
 *
 * isDown()    — true while a key is held (driving: throttle, steer, brake).
 * wasPressed() — true once on the frame a key is first pressed; cleared after
 *                reading.  Use this for menu Up/Down/Enter/Escape so a held
 *                key fires only once, not at 60 fps.
 */

/** Keys that suppress browser page-scroll. */
const GAME_KEYS = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Enter', 'Escape', ' ',
]);

export class InputManager
{
  /** Set of key names that are currently held down. */
  private keys:        Set<string> = new Set();

  /** Keys pressed since the last wasPressed() call for each key. */
  private justPressed: Set<string> = new Set();

  private readonly onKeyDown: (e: KeyboardEvent) => void;
  private readonly onKeyUp:   (e: KeyboardEvent) => void;

  constructor()
  {
    this.onKeyDown = (e: KeyboardEvent) =>
    {
      if (GAME_KEYS.has(e.key)) e.preventDefault();
      // Only register a fresh press — not the auto-repeat events from held keys.
      if (!this.keys.has(e.key)) this.justPressed.add(e.key);
      this.keys.add(e.key);
    };

    this.onKeyUp = (e: KeyboardEvent) =>
    {
      this.keys.delete(e.key);
    };

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup',   this.onKeyUp);
  }

  /** Removes listeners and clears state. */
  destroy(): void
  {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup',   this.onKeyUp);
    this.keys.clear();
    this.justPressed.clear();
  }

  /** Returns true while the given key is held (driving input). */
  isDown(key: string): boolean { return this.keys.has(key); }

  /**
   * Returns true if the key was newly pressed since the last call for that key.
   * Consuming the press clears it so the next call returns false unless the
   * key was released and pressed again.
   */
  wasPressed(key: string): boolean
  {
    if (this.justPressed.has(key))
    {
      this.justPressed.delete(key);
      return true;
    }
    return false;
  }
}
