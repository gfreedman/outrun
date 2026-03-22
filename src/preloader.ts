/**
 * preloader.ts
 *
 * Tracks the loading progress of all SpriteLoader promises so the game can
 * display an accurate progress bar before the first frame of gameplay.
 *
 * Usage:
 *   const preloader = new Preloader([ { promise: loader.ready, name: 'car' }, … ]);
 *   // Each frame: draw using preloader.progress
 *   // On completion: await preloader.done → { ok, error? }
 */

export interface PreloadResult
{
  ok:     boolean;
  /** File name that failed, if ok === false. */
  error?: string;
}

export interface PreloadEntry
{
  promise: Promise<void>;
  name:    string;
}

export class Preloader
{
  private readonly total:  number;
  private          loaded: number = 0;
  private          failed: string = '';

  /** Resolves when every entry has settled (fulfilled or rejected). */
  readonly done: Promise<PreloadResult>;

  constructor(entries: PreloadEntry[])
  {
    this.total = entries.length;

    this.done = Promise.all(
      entries.map(({ promise, name }) =>
        promise.then(
          () => { this.loaded++; },
          () => { this.loaded++; this.failed = this.failed || name; },
        ),
      ),
    ).then(() =>
      this.failed
        ? { ok: false, error: this.failed }
        : { ok: true },
    );
  }

  /**
   * Loading progress in [0, 1].  Suitable for driving a progress bar each frame
   * without awaiting the done promise.
   */
  get progress(): number
  {
    return this.total > 0 ? this.loaded / this.total : 0;
  }

  get errorMessage(): string { return this.failed; }
}
