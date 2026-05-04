/**
 * renderer-screens.ts
 *
 * ScreenRenderer — full-canvas overlays for non-gameplay phases.
 *
 * Covers five screens, each a distinct rendering path:
 *   renderPreloader  — black fill + "LOADING…" + orange progress bar.
 *   renderCountdown  — large centred 3-2-1-GO! text, drawn over the live road.
 *   renderGoal       — finish screen: confetti, score breakdown rows with
 *                      auto-scaling font when label+value overflow the row width.
 *   renderTimeUp     — red/white flashing "TIME UP" banner + final score.
 *   renderConfetti   — deterministic particle system (no mutable per-particle
 *                      state — all values derived from particle index via integer
 *                      hashing), particle count scaled to screen size.
 *
 * All methods are stateless given their parameters — ScreenRenderer holds only
 * a reference to the shared CanvasRenderingContext2D.
 */

import { Button } from './ui';

// ── ScreenRenderer ────────────────────────────────────────────────────────────

export class ScreenRenderer
{
  constructor(private readonly ctx: CanvasRenderingContext2D) {}

  // ── Preloader screen ───────────────────────────────────────────────────────

  /**
   * Draws the loading screen shown while sprite sheets are downloading.
   * Replaces the canvas with a black fill, "LOADING…" text, and an orange
   * progress bar.  On error, shows the error message in red instead.
   *
   * @param w        - Canvas width.
   * @param h        - Canvas height.
   * @param progress - Fraction [0, 1] of assets loaded so far.
   * @param error    - If defined, an error message replaces the progress bar.
   */
  public renderPreloader(w: number, h: number, progress: number, error?: string): void
  {
    const { ctx } = this;
    ctx.save();
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h / 2;

    if (error)
    {
      ctx.fillStyle = '#FF2200';
      ctx.font      = 'bold 18px Impact, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('FAILED TO LOAD ASSETS', cx, cy - 20);
      ctx.fillStyle = '#FFFFFF';
      ctx.font      = '14px monospace';
      ctx.fillText(error, cx, cy + 10);
    }
    else
    {
      ctx.fillStyle = '#FFFFFF';
      ctx.font      = 'bold 28px Impact, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('LOADING…', cx, cy - 40);

      // Progress bar
      const bw = Math.min(600, w * 0.7);
      const bh = 20;
      const bx = cx - bw / 2;
      const by = cy - 10;
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth   = 2;
      ctx.strokeRect(bx, by, bw, bh);
      ctx.fillStyle = '#FF6600';
      ctx.fillRect(bx + 2, by + 2, Math.round((bw - 4) * Math.min(1, progress)), bh - 4);
    }

    ctx.restore();
  }

  // ── Countdown overlay ──────────────────────────────────────────────────────

  /**
   * Draws the large 3-2-1-GO! countdown text over the road scene.
   * The text is centred horizontally and sits just below the vertical midpoint.
   * "GO!" uses a green fill; numbers use white — both have a thick black outline.
   *
   * @param w     - Canvas width.
   * @param h     - Canvas height.
   * @param value - Current countdown step: 3, 2, 1, or the string 'GO!'.
   */
  public renderCountdown(w: number, h: number, value: number | 'GO!'): void
  {
    const { ctx } = this;
    const text = value === 'GO!' ? 'GO!' : String(value);
    const size = Math.round(h * 0.22);

    ctx.save();
    ctx.font      = `bold ${size}px Impact, sans-serif`;
    ctx.textAlign = 'center';

    // Thick black outline
    ctx.lineWidth   = size * 0.08;
    ctx.strokeStyle = '#000000';
    ctx.lineJoin    = 'round';
    ctx.strokeText(text, w / 2, h * 0.52);

    // Bright fill
    ctx.fillStyle = value === 'GO!' ? '#00FF88' : '#FFFFFF';
    ctx.fillText(text, w / 2, h * 0.52);

    ctx.restore();
  }

  // ── Barney afterburner screen effect ──────────────────────────────────────

  /**
   * Draws the Barney afterburner screen effect — a radial purple/orange glow
   * plus pulsing top/bottom edge bars.  Alpha fades in over the first 0.5 s
   * and pulses at ~6 Hz throughout.
   *
   * Rendered between the road and the HUD so it feels like a lens effect
   * rather than an overlay on top of UI elements.
   *
   * @param w     - Canvas width.
   * @param h     - Canvas height.
   * @param timer - Seconds remaining on the boost (used for fade-in alpha).
   */
  public renderAfterburner(w: number, h: number, timer: number): void
  {
    const { ctx } = this;
    const pulse = Math.floor(Date.now() / 80) % 2 === 0;
    const alpha = Math.min(1, timer / 0.5) * (pulse ? 0.28 : 0.18);

    // Radial glow from centre — purple/orange blast
    const grad = ctx.createRadialGradient(w / 2, h / 2, h * 0.1, w / 2, h / 2, h * 0.8);
    grad.addColorStop(0,   'rgba(255,100,0,0)');
    grad.addColorStop(0.6, 'rgba(255,80,0,0)');
    grad.addColorStop(1.0, `rgba(180,0,255,${alpha})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // Hard edge vignette flash (top + bottom bars)
    ctx.fillStyle = `rgba(255,${pulse ? 120 : 50},0,${alpha * 0.9})`;
    const bar = Math.round(h * 0.035);
    ctx.fillRect(0, 0,     w, bar);
    ctx.fillRect(0, h-bar, w, bar);
  }

  // ── GOAL! screen ───────────────────────────────────────────────────────────

  /**
   * Draws the GOAL! results panel over the frozen road scene.
   *
   * Panel contents:
   *   - "Yay you finished!" or "ooof too bad" banner (font-scaled to fit).
   *   - Score + race time rows; Barney kill + bonus rows when barneyKills > 0.
   *   - PLAY AGAIN and MAIN MENU buttons.
   *   - Confetti animation (rendered last, in front of everything).
   *
   * @param w             - Canvas width.
   * @param h             - Canvas height.
   * @param score         - Final accumulated score.
   * @param elapsedSec    - Total race time in seconds.
   * @param barneyKills   - Number of Barney cars destroyed this race.
   * @param timeRemaining - Seconds left when crossing the finish line.
   * @param btnPlayAgain  - PLAY AGAIN button.
   * @param btnMenu       - MAIN MENU button.
   */
  public renderGoalScreen(
    w: number, h: number,
    score: number, elapsedSec: number,
    barneyKills: number,
    timeRemaining: number,
    btnPlayAgain: Button, btnMenu: Button,
  ): void
  {
    const { ctx } = this;
    ctx.save();

    // Dark overlay over whatever road scene is behind this panel
    ctx.fillStyle = 'rgba(0,0,0,0.72)';
    ctx.fillRect(0, 0, w, h);

    const cx = w / 2;
    const panelW = Math.min(580, Math.round(w * 0.74));
    const panelH = Math.round(h * (barneyKills > 0 ? 0.70 : 0.58));
    const panelX = Math.round(cx - panelW / 2);
    const panelY = Math.round((h - panelH) / 2);

    // Panel body
    ctx.fillStyle   = 'rgba(0,0,20,0.95)';
    ctx.fillRect(panelX, panelY, panelW, panelH);
    ctx.strokeStyle = '#FFD700';
    ctx.lineWidth   = 3;
    ctx.strokeRect(panelX, panelY, panelW, panelH);
    // Inner glow line
    ctx.strokeStyle = 'rgba(255,215,0,0.20)';
    ctx.lineWidth   = 1;
    ctx.strokeRect(panelX + 4, panelY + 4, panelW - 8, panelH - 8);

    // ── "GOAL!" banner ───────────────────────────────────────────────────
    // > 25 s left = comfortable finish; ≤ 25 s = scraped through
    const goalText = timeRemaining > 25 ? 'Yay you finished!' : 'ooof too bad';

    // Scale font down until the text fits within 90% of panel width
    let goalFs = Math.round(h * 0.105);
    ctx.font   = `bold ${goalFs}px Impact, sans-serif`;
    while (ctx.measureText(goalText).width > panelW * 0.90 && goalFs > 20)
    {
      goalFs--;
      ctx.font = `bold ${goalFs}px Impact, sans-serif`;
    }

    const goalY = panelY + Math.round(panelH * 0.26);

    const goalGrad = ctx.createLinearGradient(0, goalY - goalFs, 0, goalY);
    goalGrad.addColorStop(0, '#FFE000');
    goalGrad.addColorStop(1, '#FF8800');

    ctx.font      = `bold ${goalFs}px Impact, sans-serif`;
    ctx.textAlign = 'center';
    ctx.lineJoin  = 'round';
    ctx.lineWidth = goalFs * 0.10;
    ctx.strokeStyle = '#000000';
    ctx.strokeText(goalText, cx, goalY);
    ctx.fillStyle = goalGrad;
    ctx.fillText(goalText, cx, goalY);

    // Subtle yellow glow
    ctx.shadowColor = 'rgba(255,220,0,0.60)';
    ctx.shadowBlur  = Math.round(goalFs * 0.5);
    ctx.fillStyle   = goalGrad;
    ctx.fillText(goalText, cx, goalY);
    ctx.shadowBlur  = 0;
    ctx.shadowColor = 'transparent';

    // ── Score lines ──────────────────────────────────────────────────────
    const rowFs  = Math.round(h * 0.040);
    const rowGap = Math.round(rowFs * 1.55);
    const rowX   = panelX + Math.round(panelW * 0.12);
    const valX   = panelX + panelW - Math.round(panelW * 0.08);
    const row1Y  = goalY + Math.round(panelH * 0.15);

    const mins   = Math.floor(elapsedSec / 60);
    const secs   = (elapsedSec % 60).toFixed(1).padStart(4, '0');
    const timeStr = `${mins}' ${secs}"`;

    const barneyBonus = barneyKills * 5_000;
    const rows: Array<{ label: string; value: string; color: string }> = [
      { label: 'SCORE',               value: String(score).padStart(8, '0'),       color: '#FFD700' },
      { label: 'RACE TIME',           value: timeStr,                               color: '#AAFFAA' },
      ...(barneyKills > 0 ? [
        { label: 'BARNEYS KILLED',    value: String(barneyKills),                   color: '#FF66FF' },
        { label: 'BARNEY KILL BONUS', value: `+${String(barneyBonus).padStart(6,'0')}`, color: '#FF44FF' },
      ] : []),
    ];

    rows.forEach(({ label, value, color }, i) =>
    {
      const y        = row1Y + i * rowGap;
      const availW   = valX - rowX;
      const minGap   = rowFs * 0.8;

      // Measure at full size, then scale down only if label+gap+value overflows.
      ctx.font = `bold ${rowFs}px Impact, sans-serif`;
      const lw = ctx.measureText(label).width;
      const vw = ctx.measureText(value).width;
      const fs = (lw + minGap + vw > availW)
        ? Math.floor(rowFs * availW / (lw + minGap + vw))
        : rowFs;

      ctx.font      = `bold ${fs}px Impact, sans-serif`;
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(255,255,255,0.50)';
      ctx.fillText(label, rowX, y);
      ctx.textAlign = 'right';
      ctx.fillStyle = color;
      ctx.fillText(value, valX, y);
    });

    // Divider
    const divY = row1Y + rows.length * rowGap + Math.round(rowGap * 0.2);
    ctx.strokeStyle = 'rgba(255,215,0,0.25)';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(rowX, divY);
    ctx.lineTo(valX, divY);
    ctx.stroke();

    // ── Buttons ──────────────────────────────────────────────────────────
    const btnFs   = Math.round(h * 0.038);
    const btnPad  = Math.round(btnFs * 0.55);
    const btnY    = divY + rowGap * 0.7;
    const btnGap  = Math.round(panelW * 0.06);
    const btnW    = Math.round((panelW - Math.round(panelW * 0.24) - btnGap) / 2);
    const btnH    = btnFs + btnPad * 2;
    const btn1X   = panelX + Math.round(panelW * 0.12);
    const btn2X   = btn1X + btnW + btnGap;

    const drawBtn = (
      btn: Button, bx: number, label: string,
      hoverFill: string, idleFill: string,
      borderCol: string,
    ): void =>
    {
      const hov = btn.hovered;
      // Register hit area with generous padding so clicks land reliably
      btn.setRect(bx, btnY, btnW, btnH, 6);

      // Shadow / depth on hover
      if (hov)
      {
        ctx.shadowColor = borderCol;
        ctx.shadowBlur  = 18;
      }

      ctx.fillStyle = hov ? hoverFill : idleFill;
      ctx.fillRect(bx, btnY, btnW, btnH);

      ctx.shadowBlur  = 0;
      ctx.shadowColor = 'transparent';

      // Border — thicker + brighter on hover
      ctx.strokeStyle = hov ? '#FFFFFF' : borderCol;
      ctx.lineWidth   = hov ? 3 : 2;
      ctx.strokeRect(bx, btnY, btnW, btnH);

      // Label
      ctx.font      = `bold ${btnFs}px Impact, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = hov ? '#FFFFFF' : 'rgba(255,255,255,0.80)';
      ctx.fillText(label, bx + btnW / 2, btnY + btnPad + btnFs * 0.82);
    };

    drawBtn(btnPlayAgain, btn1X, 'PLAY AGAIN',
      'rgba(0,210,80,0.95)',  'rgba(0,70,25,0.85)',  '#00DD55');
    drawBtn(btnMenu,      btn2X, 'MAIN MENU',
      'rgba(80,100,255,0.95)', 'rgba(15,15,90,0.85)', '#4466FF');

    // Confetti rains in front of everything
    const confettiT = (Date.now() % 60_000) / 1000;
    this.renderConfetti(w, h, confettiT);

    ctx.restore();
  }

  // ── TIME UP screen ─────────────────────────────────────────────────────────

  /**
   * Draws the TIME UP overlay shown when the countdown reaches zero.
   *
   * Features a flashing red/white "TIME UP" banner, the player's final score,
   * and a CONTINUE button that returns to the main menu.
   *
   * @param w           - Canvas width.
   * @param h           - Canvas height.
   * @param score       - Final accumulated score.
   * @param btnContinue - The CONTINUE → main menu button.
   */
  public renderTimeUpScreen(w: number, h: number, score: number, btnContinue: Button): void
  {
    const { ctx } = this;
    ctx.save();

    ctx.fillStyle = 'rgba(0,0,0,0.72)';
    ctx.fillRect(0, 0, w, h);

    const cx = w / 2;

    // ── "TIME UP" banner ─────────────────────────────────────────────────
    const tuFs  = Math.round(h * 0.115);
    const tuY   = Math.round(h * 0.40);
    const flash = Math.floor(Date.now() / 400) % 2 === 0;

    ctx.font      = `bold ${tuFs}px Impact, sans-serif`;
    ctx.textAlign = 'center';
    ctx.lineJoin  = 'round';
    ctx.lineWidth = tuFs * 0.10;
    ctx.strokeStyle = '#000000';
    ctx.strokeText('TIME UP', cx, tuY);
    ctx.fillStyle = flash ? '#FF2200' : '#FFFFFF';
    ctx.fillText('TIME UP', cx, tuY);

    // ── Score ─────────────────────────────────────────────────────────────
    const scoreFs  = Math.round(h * 0.042);
    const scoreY   = tuY + Math.round(tuFs * 0.65);
    const scoreStr = String(score).padStart(8, '0');

    ctx.font      = `bold ${Math.round(h * 0.026)}px Impact, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillText('FINAL SCORE', cx, scoreY);

    ctx.font      = `bold ${scoreFs}px Impact, monospace`;
    ctx.fillStyle = '#000000';
    ctx.fillText(scoreStr, cx + 2, scoreY + scoreFs + 2);
    ctx.fillStyle = '#FFD700';
    ctx.fillText(scoreStr, cx, scoreY + scoreFs);

    // ── Continue button ───────────────────────────────────────────────────
    const btnFs  = Math.round(h * 0.038);
    const btnPad = Math.round(btnFs * 0.55);
    const label  = 'CONTINUE';
    const btnW   = Math.round(w * 0.28);
    const btnH   = btnFs + btnPad * 2;
    const btnX   = Math.round(cx - btnW / 2);
    const btnY   = scoreY + scoreFs + Math.round(h * 0.06);
    const hov    = btnContinue.hovered;

    btnContinue.setRect(btnX, btnY, btnW, btnH, 6);

    if (hov) { ctx.shadowColor = '#FF2200'; ctx.shadowBlur = 18; }
    ctx.fillStyle = hov ? 'rgba(220,20,0,0.95)' : 'rgba(80,0,0,0.85)';
    ctx.fillRect(btnX, btnY, btnW, btnH);
    ctx.shadowBlur  = 0;
    ctx.shadowColor = 'transparent';

    ctx.strokeStyle = hov ? '#FFFFFF' : '#FF2200';
    ctx.lineWidth   = hov ? 3 : 2;
    ctx.strokeRect(btnX, btnY, btnW, btnH);
    ctx.font      = `bold ${btnFs}px Impact, sans-serif`;
    ctx.fillStyle = hov ? '#FFFFFF' : 'rgba(255,255,255,0.80)';
    ctx.textAlign = 'center';
    ctx.fillText(label, cx, btnY + btnPad + btnFs * 0.82);

    ctx.restore();
  }

  // ── Confetti (finish celebration) ─────────────────────────────────────────

  /**
   * Draws coloured confetti ribbons falling from above the canvas.
   *
   * Count scales with screen size so low-end mobile phones don't run hot.
   * Each ribbon is deterministic — position, size, colour, and rotation rate
   * are all derived from the particle index using integer hash constants, so
   * no mutable per-particle state is needed.  The ribbons wrap vertically so
   * the effect continues indefinitely without restarting.
   *
   * @param w - Canvas width.
   * @param h - Canvas height.
   * @param t - Elapsed time in seconds since the animation began (from caller).
   */
  public renderConfetti(w: number, h: number, t: number): void
  {
    const { ctx } = this;
    const PIECE_COLORS = [
      '#FF2200', '#FF8800', '#FFD700', '#AAFF00',
      '#00FF88', '#00CCFF', '#FF66FF', '#FFFFFF', '#FF44AA',
    ];
    // Scale particle count with the smaller screen dimension so large 4K displays
    // get a full shower while small phones stay within a comfortable draw budget.
    const COUNT = Math.round(Math.min(w, h) / 4);

    ctx.save();
    for (let i = 0; i < COUNT; i++)
    {
      // Deterministic pseudo-random per particle — no mutable state needed
      const a = (i * 1_234_567 + 891_011) >>> 0;
      const b = (i * 9_876_543 + 131_415) >>> 0;
      const c = (i * 2_468_101 + 171_819) >>> 0;

      const xFrac     = (a % 1000) / 1000;
      const fallRate  = 110 + (b % 220);           // 110–329 px/s
      const sz        = 5 + (c % 9);               // 5–13 px
      const colorIdx  = a % PIECE_COLORS.length;
      const rotRate   = 1.5 + (b % 5);             // rad/s
      const wobbleAmp = (c % 80) / 1000;           // 0–0.08 of w
      const wobbleOff = (a % 628) / 100;           // 0–2π phase
      const delay     = (b % 120) / 100 * 1.8;     // staggered start 0–1.8 s

      const elapsed = Math.max(0, t - delay);
      if (elapsed <= 0) continue;

      const x = xFrac * w + Math.sin(elapsed * 2.2 + wobbleOff) * wobbleAmp * w;
      const y = -sz * 3 + elapsed * fallRate;

      // Wrap vertically so confetti rains forever while screen is visible
      const wy = ((y % (h + sz * 6)) + (h + sz * 6)) % (h + sz * 6) - sz * 3;

      const alpha = Math.min(1, elapsed * 2.5) * 0.92;

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(Math.round(x), Math.round(wy));
      ctx.rotate(elapsed * rotRate);
      ctx.fillStyle = PIECE_COLORS[colorIdx];
      ctx.fillRect(-sz / 2, -sz / 4, sz, sz / 2);   // flat ribbon = confetti shape
      ctx.restore();
    }
    ctx.restore();
  }

}
