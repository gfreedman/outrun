const GAME_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

export class InputManager {
  private keys: Set<string> = new Set();

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (GAME_KEYS.has(e.key)) e.preventDefault(); // stop page scrolling
      this.keys.add(e.key);
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.key);
    });
  }

  isDown(key: string): boolean {
    return this.keys.has(key);
  }
}
