import { Button } from './ui';
import { DISPLAY_MAX_KMH, PLAYER_MAX_SPEED } from './constants';

// ── Module-level constants ─────────────────────────────────────────────────────

/**
 * 7-segment bitmask for each digit 0–9.
 *
 * A classic 7-segment display has seven rectangular segments labelled a–g:
 *    aaa
 *   f   b
 *   f   b
 *    ggg
 *   e   c
 *   e   c
 *    ddd
 *
 * Each entry below stores which segments should be LIT for that digit.
 * The bit positions are: bit0=a, bit1=b, bit2=c, bit3=d, bit4=e, bit5=f, bit6=g.
 * Example: '8' lights all 7 segments → 0x7F = 0111 1111.
 */
const SEG_DIGIT = [
  0x3F,  // 0: a b c d e f   (all except middle)
  0x06,  // 1: b c
  0x5B,  // 2: a b d e g
  0x4F,  // 3: a b c d g
  0x66,  // 4: b c f g
  0x6D,  // 5: a c d f g
  0x7D,  // 6: a c d e f g
  0x07,  // 7: a b c
  0x7F,  // 8: a b c d e f g  (all)
  0x6F,  // 9: a b c d f g
] as const;

/** Total number of rectangular segments in the speed bar. */
const BAR_SEGS = 20;

/**
 * Speed bar colour zones — warm OutRun dashboard palette:
 *   Orange zone (~80%): low to mid revs
 *   Yellow zone (~20%): high revs, tach climbing toward redline
 *   Red cap  (last 1): redline — matches the speed digit colour
 */
const BAR_WARM_END    = Math.round(BAR_SEGS * 0.80);  // = 16  (orange → yellow)
const BAR_LAST        = BAR_SEGS - 1;                  // = 19  (red redline cap)
const BAR_COLOR_LOW   = '#FF6600';            // orange           (low–mid revs, warm dashboard feel)
const BAR_COLOR_HIGH  = '#FFCC00';            // yellow           (high revs, tach climbing)
const BAR_COLOR_RED   = '#FF2200';            // red              (redline cap — matches speed digits)
const BAR_COLOR_UNLIT = 'rgba(80,80,80,0.5)'; // 50% transparent — background shows through

// ── HudLayout ─────────────────────────────────────────────────────────────────

/**
 * All pixel positions and font strings needed to draw the HUD.
 * Computed once per canvas size and cached — recomputed only on resize.
 * Avoids recalculating layout values every single frame.
 */
interface HudLayout
{
  /** Left edge of the entire HUD cluster (pixels from canvas left). */
  padX:      number;

  // ── 7-segment speed digits ──────────────────────────────────────────────
  /** Height of each digit cell in pixels. */
  digitH:    number;
  /** Width of each digit cell in pixels. */
  digitW:    number;
  /** Segment line thickness in pixels. */
  digitT:    number;
  /** Horizontal gap between adjacent digit cells. */
  digitGap:  number;
  /** Top Y of the digit row. */
  digitY:    number;

  // ── "km/h" label (yellow, to the right of the digits) ──────────────────
  /** Left X of the "km/h" text. */
  kphX:      number;
  /** Baseline Y of the "km/h" text. */
  kphY:      number;
  /** CSS font string for the km/h label. */
  kphFont:   string;

  // ── Single-row speed bar (below the digits) ────────────────────────────
  /** Left X of the bar. */
  barX:      number;
  /** Top Y of the bar. */
  barY:      number;
  /** Height of each segment rectangle. */
  barH:      number;
  /** Width of each segment rectangle. */
  barSegW:   number;
  /** Total stride per segment (barSegW + inter-segment gap). */
  barStride: number;
}

// ── Helper: fillSegment ───────────────────────────────────────────────────────

/**
 * Draws one rectangular 7-segment LED bar at the given position.
 * Module-level to avoid allocating a fresh closure object on each
 * drawSegDigit() call (~360 closures/sec at 60 fps, 6 calls/frame) (L8).
 *
 * @param ctx      - Canvas 2D rendering context.
 * @param mask     - Bitmask for the current digit (from SEG_DIGIT).
 * @param bit      - Which bit in mask this segment tests.
 * @param colorOn  - CSS colour for a lit segment.
 * @param colorOff - CSS colour for an unlit segment ('' = invisible).
 * @param rx, ry, rw, rh - Destination rectangle.
 */
function fillSegment(
  ctx:      CanvasRenderingContext2D,
  mask:     number,
  bit:      number,
  colorOn:  string,
  colorOff: string,
  rx: number, ry: number, rw: number, rh: number,
): void
{
  const color = (mask >> bit) & 1 ? colorOn : colorOff;
  if (!color || rw <= 0 || rh <= 0) return;
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(rx), Math.round(ry), Math.round(rw), Math.round(rh));
}

// ── Helper: drawSegDigit ──────────────────────────────────────────────────────

/**
 * Draws one 7-segment LED digit using filled rectangles.
 *
 * Each of the seven segments is a thin rectangle.  The SEG_DIGIT bitmask
 * (defined above) tells us which segments to light up for the given digit.
 * Active segments get colorOn; inactive ones get colorOff.
 * Setting colorOff to a very dark colour reproduces the classic "unlit LED"
 * look where you can faintly see the segment grid even when it is off.
 *
 * Segment layout inside the cell (width dw, height dh, thickness t):
 *
 *   |←—— dw ——→|
 *     t  a  t
 *    f        b     ← vertical segments span (dh/2 - t - gap) pixels
 *     t  g  t
 *    e        c     ← same height as b/f
 *     t  d  t
 *
 * @param ctx      - Canvas 2D rendering context.
 * @param digit    - Integer 0–9 to display.
 * @param x        - Left edge of the digit cell in pixels.
 * @param y        - Top edge of the digit cell in pixels.
 * @param dw       - Width of the digit cell in pixels.
 * @param dh       - Height of the digit cell in pixels.
 * @param t        - Segment thickness in pixels.
 * @param colorOn  - CSS colour string for lit (active) segments.
 * @param colorOff - CSS colour string for dark (inactive) segments.
 */
function drawSegDigit(
  ctx:      CanvasRenderingContext2D,
  digit:    number,
  x:        number, y: number,
  dw:       number, dh: number,
  t:        number,
  colorOn:  string,
  colorOff: string,
): void
{
  const mask = SEG_DIGIT[digit] ?? SEG_DIGIT[0];
  const g    = 1;      // hard 1-px tip gap — proportional gaps eat the segments at small sizes
  const hw   = dh / 2; // midpoint between top and bottom

  // fillSegment is module-level to avoid per-call closure allocation (L8).
  fillSegment(ctx, mask, 0, colorOn, colorOff, x + t + g,  y,              dw - 2*t - 2*g, t);           // a — top horizontal
  fillSegment(ctx, mask, 1, colorOn, colorOff, x + dw - t, y + t + g,      t,               hw - t - 2*g); // b — top-right
  fillSegment(ctx, mask, 2, colorOn, colorOff, x + dw - t, y + hw + g,     t,               hw - t - 2*g); // c — bot-right
  fillSegment(ctx, mask, 3, colorOn, colorOff, x + t + g,  y + dh - t,     dw - 2*t - 2*g, t);           // d — bottom horizontal
  fillSegment(ctx, mask, 4, colorOn, colorOff, x,           y + hw + g,     t,               hw - t - 2*g); // e — bot-left
  fillSegment(ctx, mask, 5, colorOn, colorOff, x,           y + t + g,      t,               hw - t - 2*g); // f — top-left
  fillSegment(ctx, mask, 6, colorOn, colorOff, x + t + g,  y + hw - t / 2, dw - 2*t - 2*g, t);           // g — middle horizontal
}

// ── HudRenderer ───────────────────────────────────────────────────────────────

export class HudRenderer
{
  /** Cached layout; null until first render. */
  private hudLayout: HudLayout | null = null;

  /** Canvas width when hudLayout was last computed. */
  private hudW = 0;

  /** Canvas height when hudLayout was last computed. */
  private hudH = 0;

  constructor(private readonly ctx: CanvasRenderingContext2D) {}

  // ── HUD layout helper ─────────────────────────────────────────────────────

  /**
   * Computes all pixel positions and font strings for the HUD.
   * Called only when the canvas dimensions change — not every frame.
   * All values are derived from w and h so the HUD scales with the window.
   *
   * Layout is built upward from the bottom of the canvas:
   *   1. Speed bar — thin row, padY from the bottom.
   *   2. 7-segment digit row — immediately above the bar.
   *   3. "km/h" label — to the right of the digit block.
   *
   * @param w - Canvas width in pixels.
   * @param h - Canvas height in pixels.
   * @returns A HudLayout with every pre-computed value for renderHUD.
   */
  private computeHudLayout(w: number, h: number): HudLayout
  {
    const padX     = Math.round(w * 0.025);
    const padY     = Math.round(h * 0.028);

    // 7-segment digit sizing.
    // Height: 10% of canvas height so the digits are clearly legible.
    // Width:  65% of height — classic 7-segment displays are taller than wide.
    // Thickness: ~14% of height gives chunky, readable segments.
    // Gap between cells: small fixed proportion of width.
    const digitH   = Math.round(h * 0.075);              // −25% from previous 0.10
    const digitW   = Math.round(digitH * 0.55);          // slightly skinnier (was 0.65)
    const digitT   = Math.max(2, Math.round(digitH * 0.14));
    const digitGap = Math.max(2, Math.round(digitW * 0.14));

    // Speed bar — 30% skinnier segments than before (w*0.013 → w*0.0091).
    const barH      = Math.max(8, Math.round(h * 0.032));
    const barGap    = Math.max(4, Math.round(h * 0.010));
    const barSegGap = 2;
    const barSegW   = Math.max(6, Math.round(w * 0.0091));

    // Build positions upward from bottom edge
    const barBotY   = h - padY;
    const barY      = barBotY - barH;
    const digitBotY = barY - barGap;
    const digitY    = digitBotY - digitH;

    // "km/h" label: right of the 3-digit block, baseline at digit bottom
    const numBlockW = 3 * digitW + 2 * digitGap;
    const kphSize   = Math.max(10, Math.round(digitH * 0.38));
    const kphX      = padX + numBlockW + Math.max(3, Math.round(digitGap * 1.4));
    const kphY      = digitY + digitH;  // baseline aligned to bottom of digits

    return {
      padX, digitH, digitW, digitT, digitGap, digitY,
      kphX, kphY,
      kphFont: `bold ${kphSize}px Impact, 'Arial Black', sans-serif`,
      barX: padX, barY, barH,
      barSegW,
      barStride: barSegW + barSegGap,
    };
  }

  // ── HUD ───────────────────────────────────────────────────────────────────

  /**
   * Draws the OutRun-style HUD: 7-segment speed readout + single speed bar.
   *
   * Layout (bottom-left, transparent — no background panel):
   *   - Three fixed digit cells (hundreds / tens / ones), right-aligned.
   *     Leading zeros are left blank so "5" appears as "  5", not "005".
   *     Active segments are bright red; inactive segments are near-black.
   *   - "km/h" label in yellow, to the right of the digit block.
   *   - Single row of rectangular speed bar segments below the digits:
   *       cyan  (~60% of bar) → green (~35%) → pink cap (~5%).
   *     Only the segments up to current speed are lit; the rest are dark.
   *
   * Note: ctx.save/restore is NOT called here — the outer render() call
   * already wraps the entire frame in a single save/restore pair.
   *
   * @param w     - Canvas width in pixels.
   * @param h     - Canvas height in pixels.
   * @param speed - Current speed in world units per second.
   */
  public renderHUD(
    w: number, h: number, speed: number,
    raceTimer       = 0, distanceKm    = 0,
    raceLengthKm    = 0, timeRemaining = 0,
    score           = 0, barneyBoost   = 0, btnQuit?: Button,
  ): void
  {
    const { ctx } = this;

    // Recompute layout only when canvas size has changed (resize events)
    if (w !== this.hudW || h !== this.hudH)
    {
      this.hudLayout = this.computeHudLayout(w, h);
      this.hudW = w;
      this.hudH = h;
    }
    const L = this.hudLayout!;

    const kmh      = Math.min(999, Math.max(0, Math.round(speed * (DISPLAY_MAX_KMH / PLAYER_MAX_SPEED))));
    const hundreds = Math.floor(kmh / 100);
    const tens     = Math.floor((kmh % 100) / 10);
    const ones     = kmh % 10;

    const ON  = '#FF2200';
    const SHD = '#000000';
    const OFF = '';
    const showHundreds = hundreds > 0;
    const showTens     = showHundreds || tens > 0;
    const so = 3;

    // Pass 1 — shadow
    if (showHundreds)
      drawSegDigit(ctx, hundreds, L.padX + so,                              L.digitY + so, L.digitW, L.digitH, L.digitT, SHD, OFF);
    if (showTens)
      drawSegDigit(ctx, tens,     L.padX + (L.digitW + L.digitGap) + so,   L.digitY + so, L.digitW, L.digitH, L.digitT, SHD, OFF);
    drawSegDigit(ctx, ones,       L.padX + 2*(L.digitW + L.digitGap) + so, L.digitY + so, L.digitW, L.digitH, L.digitT, SHD, OFF);

    // Pass 2 — red digits
    if (showHundreds)
      drawSegDigit(ctx, hundreds, L.padX,                            L.digitY, L.digitW, L.digitH, L.digitT, ON, OFF);
    if (showTens)
      drawSegDigit(ctx, tens,     L.padX + (L.digitW + L.digitGap), L.digitY, L.digitW, L.digitH, L.digitT, ON, OFF);
    drawSegDigit(ctx, ones,       L.padX + 2*(L.digitW + L.digitGap), L.digitY, L.digitW, L.digitH, L.digitT, ON, OFF);

    ctx.font         = L.kphFont;
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle    = '#000000';
    ctx.fillText('km/h', L.kphX + so, L.kphY + so);
    ctx.fillStyle    = '#FFD700';
    ctx.fillText('km/h', L.kphX, L.kphY);

    // Speed bar
    const filled   = Math.round((speed / PLAYER_MAX_SPEED) * BAR_SEGS);
    let lastColor  = '';
    for (let i = 0; i < BAR_SEGS; i++)
    {
      let color: string;
      if (i >= filled)           color = BAR_COLOR_UNLIT;
      else if (i === BAR_LAST)    color = BAR_COLOR_RED;
      else if (i < BAR_WARM_END)  color = BAR_COLOR_LOW;
      else                        color = BAR_COLOR_HIGH;
      if (color !== lastColor) { ctx.fillStyle = color; lastColor = color; }
      ctx.fillRect(L.barX + i * L.barStride, L.barY, L.barSegW, L.barH);
    }

    // ── Race HUD — three-panel top bar (OutRun 1986 layout) ────────────────
    if (raceTimer > 0 || distanceKm > 0 || timeRemaining > 0)
    {
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // TOP BAR  —  [ TIME ] 66   [ SCORE ] 4617050   [ LAP ] 0'07"26
      //
      // CRITICAL: all positions are FIXED multiples of w/h — never derived
      // from measureText() on a changing value.  measureText() is only used
      // for badge labels ("TIME", "SCORE", "LAP") which never change.
      // Numbers are RIGHT-ALIGNED to a fixed pixel anchor so their width
      // variation never shifts surrounding elements.
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

      const barH    = Math.round(h * 0.108);
      const barMidY = Math.round(barH * 0.52);

      // Dark strip — pure black, no navy tint
      ctx.fillStyle = 'rgba(0,0,0,0.88)';
      ctx.fillRect(0, 0, w, barH);
      // Gold bottom edge
      ctx.fillStyle = 'rgba(200,165,0,0.70)';
      ctx.fillRect(0, barH - 2, w, 2);

      const badgeH  = Math.round(barH * 0.56);
      const badgeFs = Math.round(badgeH * 0.58);
      const numFs   = Math.round(barH * 0.72);
      const badgeY  = Math.round(barMidY - badgeH / 2);
      const numY    = Math.round(barMidY + numFs * 0.37);

      // ── Fixed section anchors (NEVER derived from value text width) ─────
      //   S1 = TIME  : badge left at w*0.028, number right-edge at w*0.280
      //   S2 = SCORE : badge left at w*0.355, number right-edge at w*0.645
      //   S3 = LAP   : badge left at w*0.698, number right-edge at w*0.972
      const S1_BX = Math.round(w * 0.028);
      const S1_NR = Math.round(w * 0.280);
      const S2_BX = Math.round(w * 0.355);
      const S2_NR = Math.round(w * 0.645);
      const S3_BX = Math.round(w * 0.698);
      const S3_NR = Math.round(w * 0.972);

      // ── Helper: badge (left-aligned, fixed bx) — returns badge right X ─
      const drawBadge = (
        label: string, bx: number,
        bgColor: string, hilite: string,
      ): number =>
      {
        ctx.font = `bold ${badgeFs}px Impact, sans-serif`;
        const tw = ctx.measureText(label).width;   // label text never changes → stable
        const bw = Math.round(tw + badgeH * 0.60);
        ctx.fillStyle = bgColor;
        ctx.fillRect(bx, badgeY, bw, badgeH);
        ctx.fillStyle = hilite;
        ctx.fillRect(bx, badgeY, bw, Math.max(2, Math.round(badgeH * 0.12)));
        ctx.strokeStyle = 'rgba(255,255,255,0.65)';
        ctx.lineWidth   = 1.5;
        ctx.strokeRect(bx + 0.75, badgeY + 0.75, bw - 1.5, badgeH - 1.5);
        ctx.textAlign = 'center';
        ctx.fillStyle = '#FFFFFF';
        ctx.fillText(label, bx + bw / 2, badgeY + badgeH * 0.77);
        return bx + bw;
      };

      // ── Helper: number RIGHT-aligned to fixed rx anchor ─────────────────
      // RIGHT-align is the key: text grows leftward, so the right edge (rx)
      // never moves regardless of how many digits the value has.
      const drawNum = (value: string, rx: number, color: string, fs = numFs): void =>
      {
        ctx.font      = `bold ${fs}px Impact, monospace`;
        ctx.textAlign = 'right';
        ctx.fillStyle = 'rgba(0,0,0,0.85)';
        ctx.fillText(value, rx + 3, numY + 3);
        ctx.fillStyle = color;
        ctx.fillText(value, rx, numY);
      };

      // ── 1. TIME  (left, S1) ─────────────────────────────────────────────
      const lowTime   = timeRemaining <= 10;
      const flashOn   = lowTime && Math.floor(Date.now() / 350) % 2 === 0;
      const timeColor = lowTime ? (flashOn ? '#FF2200' : '#FFFFFF') : '#FFE000';
      const timeStr   = String(Math.ceil(timeRemaining));

      drawBadge('TIME', S1_BX, '#AA3300', '#EE5500');
      drawNum(timeStr, S1_NR, timeColor);

      // ── 2. SCORE  (centre, S2) ──────────────────────────────────────────
      drawBadge('SCORE', S2_BX, '#995500', '#CC7700');
      drawNum(String(score).padStart(7, '0'), S2_NR, '#FFE000');

      // ── 3. LAP  (right, S3) ─────────────────────────────────────────────
      const lapNumFs = Math.round(numFs * 0.70);
      const lm  = Math.floor(raceTimer / 60);
      const ls  = Math.floor(raceTimer % 60);
      const lcs = Math.floor((raceTimer % 1) * 100);
      const lapStr = `${lm}'${String(ls).padStart(2,'0')}"${String(lcs).padStart(2,'0')}`;

      drawBadge('LAP', S3_BX, '#884400', '#BB6600');
      drawNum(lapStr, S3_NR, '#FFE000', lapNumFs);

      // ── Stage progress bar  (bottom-right corner) ───────────────────────
      if (raceLengthKm > 0)
      {
        const progress = Math.min(1, distanceKm / raceLengthKm);
        const stBarW   = Math.round(w * 0.160);
        const stBarH   = Math.max(6, Math.round(h * 0.011));
        const stBarX   = w - stBarW - Math.round(w * 0.014);
        const stBarY   = h - Math.round(h * 0.020) - stBarH;

        // "STAGE 1" label above the bar
        const stFs = Math.max(10, Math.round(h * 0.022));
        ctx.font      = `bold ${stFs}px Impact, sans-serif`;
        ctx.textAlign = 'right';
        ctx.fillStyle = '#000000';
        ctx.fillText('STAGE 1', stBarX + stBarW + 1, stBarY - 3 + 1);
        ctx.fillStyle = '#FFE000';
        ctx.fillText('STAGE 1', stBarX + stBarW, stBarY - 3);

        // Track
        ctx.fillStyle = 'rgba(0,0,0,0.65)';
        ctx.fillRect(stBarX, stBarY, stBarW, stBarH);
        // Fill — green near finish, orange otherwise
        ctx.fillStyle = progress > 0.85 ? '#00FF88' : '#FF9900';
        ctx.fillRect(stBarX, stBarY, Math.round(stBarW * progress), stBarH);
        // Checkerboard finish marker (4 squares, 2-tone)
        const cw = Math.round(stBarH * 0.85);
        for (let ci = 0; ci < 4; ci++)
        {
          ctx.fillStyle = (ci === 0 || ci === 3) ? '#FFFFFF' : '#222222';
          ctx.fillRect(
            stBarX + stBarW - cw,
            stBarY + (ci < 2 ? 0 : stBarH / 2),
            cw / 2, stBarH / 2,
          );
          ctx.fillStyle = (ci === 0 || ci === 3) ? '#222222' : '#FFFFFF';
          ctx.fillRect(
            stBarX + stBarW - cw / 2,
            stBarY + (ci < 2 ? 0 : stBarH / 2),
            cw / 2, stBarH / 2,
          );
        }
        // Border
        ctx.strokeStyle = 'rgba(255,255,255,0.45)';
        ctx.lineWidth   = 1;
        ctx.strokeRect(stBarX, stBarY, stBarW, stBarH);
      }

      // ── QUIT  (minimal — far left of bar, doesn't disrupt TIME layout) ──
      // Drawn LAST so it overlaps the bar bg but sits below badge elements.
      const qfs  = Math.max(9, Math.round(h * 0.022));
      const qpad = Math.round(h * 0.008);
      const qStr = '✕';
      ctx.font      = `bold ${qfs}px Impact, sans-serif`;
      ctx.textAlign = 'left';
      const qbw = qfs + qpad * 2;
      const qbh = qfs + qpad * 2;
      const qbx = 6;
      const qby = Math.round(barMidY - qbh / 2);
      btnQuit?.setRect(qbx, qby, qbw, qbh, 0);
      ctx.fillStyle   = btnQuit?.hovered ? 'rgba(220,30,0,0.92)' : 'rgba(90,10,10,0.80)';
      ctx.fillRect(qbx, qby, qbw, qbh);
      ctx.strokeStyle = btnQuit?.hovered ? '#FF8844' : '#883322';
      ctx.lineWidth   = 1;
      ctx.strokeRect(qbx, qby, qbw, qbh);
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText(qStr, qbx + qpad, qby + qpad + qfs * 0.82);
    }

    // ── Barney afterburner indicator ──────────────────────────────────────
    if (barneyBoost > 0)
    {
      const flash  = Math.floor(Date.now() / 120) % 2 === 0;
      const abFs   = Math.round(h * 0.048);
      const abY    = Math.round(h * 0.58);
      ctx.font      = `bold ${abFs}px Impact, sans-serif`;
      ctx.textAlign = 'center';
      ctx.lineWidth  = abFs * 0.12;
      ctx.lineJoin   = 'round';
      ctx.strokeStyle = '#000000';
      ctx.strokeText('🔥 AFTERBURNER! 🔥', w / 2, abY);
      ctx.fillStyle  = flash ? '#FF6600' : '#FFEE00';
      ctx.fillText('🔥 AFTERBURNER! 🔥', w / 2, abY);
    }
  }
}
