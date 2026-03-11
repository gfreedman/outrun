/**
 * input.ts
 *
 * Tracks which keyboard keys are currently held down.
 *
 * How it works:
 *   - On keydown: add the key name to a Set.
 *   - On keyup:   remove it from the Set.
 *   - Each frame, game.ts calls isDown() to check the current state.
 *
 * Using a Set means we don't miss simultaneous key presses (e.g. gas + steer).
 */

/** The four arrow keys the game cares about — used to suppress page scrolling. */
const GAME_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

export class InputManager
{
  /** Set of key names that are currently pressed, e.g. 'ArrowUp'. */
  private keys: Set<string> = new Set();

  /**
   * Stored references to the listener functions so destroy() can remove them.
   * Arrow functions passed directly to addEventListener cannot be removed later
   * because each call to `() => {}` creates a NEW function object — so you must
   * keep a reference to the exact same function you added.
   */
  private readonly onKeyDown: (e: KeyboardEvent) => void;
  private readonly onKeyUp:   (e: KeyboardEvent) => void;

  /**
   * Registers global keyboard listeners on the browser window.
   * Call destroy() to remove them if you tear down the game.
   */
  constructor()
  {
    this.onKeyDown = (e: KeyboardEvent) =>
    {
      // Prevent arrow keys from scrolling the browser window while playing
      if (GAME_KEYS.has(e.key)) e.preventDefault();
      this.keys.add(e.key);
    };

    this.onKeyUp = (e: KeyboardEvent) =>
    {
      this.keys.delete(e.key);
    };

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup',   this.onKeyUp);
  }

  /**
   * Removes the keyboard listeners and clears all held-key state.
   * Call this when tearing down the game to prevent memory leaks.
   */
  destroy(): void
  {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup',   this.onKeyUp);
    this.keys.clear();
  }

  /**
   * Returns true if the given key is currently held down.
   *
   * @param key - The key name to test, e.g. 'ArrowUp', 'ArrowLeft'.
   * @returns true while the key is held; false otherwise.
   */
  isDown(key: string): boolean
  {
    return this.keys.has(key);
  }
}
