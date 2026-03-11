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
   * Registers global keyboard listeners on the browser window.
   * Called once at game startup; listeners persist for the lifetime of the page.
   */
  constructor()
  {
    window.addEventListener('keydown', (e) =>
    {
      // Prevent arrow keys from scrolling the browser window while playing
      if (GAME_KEYS.has(e.key)) e.preventDefault();
      this.keys.add(e.key);
    });

    window.addEventListener('keyup', (e) =>
    {
      this.keys.delete(e.key);
    });
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
