/**
 * ui.ts
 *
 * Button — generic canvas UI hit-area tracker.
 *
 * Flow per frame:
 *   1. Renderer draws the element, then calls button.setRect() with its bounds.
 *   2. Game tick calls button.tick() with current mouse state.
 *   3. Game reads .hovered / .clicked to drive logic and cursor.
 *   4. Renderer reads .hovered to apply hover styling (glow, highlight).
 *
 * Because tick() recomputes hover from the live mouse position every frame,
 * hover clears immediately on mouse-out — no stale state.
 */

export class Button
{
  private _rect: { x: number; y: number; w: number; h: number } | null = null;
  private _hovered = false;
  private _clicked = false;

  /**
   * Update hover and click for this frame.
   *
   * mx / my    — current mouse position (for hover detection)
   * cx / cy    — snapshotted position from the last mousedown event
   *              (never overwritten by mousemove)
   * mouseClick — true when a pending click exists this frame
   *
   * Returns true if this button was clicked this frame.
   */
  tick(mx: number, my: number, cx: number, cy: number, mouseClick: boolean): boolean
  {
    const r = this._rect;
    const inside = (x: number, y: number) =>
      r !== null
      && x >= r.x && x <= r.x + r.w
      && y >= r.y && y <= r.y + r.h;

    this._hovered = inside(mx, my);
    this._clicked = mouseClick && inside(cx, cy);
    return this._clicked;
  }

  /**
   * Register the element's drawn bounds.
   * `pad` (default 5) px is added on all sides for a comfortable hit target.
   * Call from the renderer after drawing, every frame.
   */
  setRect(x: number, y: number, w: number, h: number, pad = 5): void
  {
    this._rect = { x: x - pad, y: y - pad, w: w + pad * 2, h: h + pad * 2 };
  }

  /** Remove the rect — button is unresponsive until the next setRect call. */
  clearRect(): void { this._rect = null; }

  get hovered(): boolean { return this._hovered; }
  get clicked(): boolean { return this._clicked; }
}

/** Convenience: true if any of the supplied buttons is currently hovered. */
export function anyHovered(...btns: Button[]): boolean
{
  return btns.some(b => b.hovered);
}
