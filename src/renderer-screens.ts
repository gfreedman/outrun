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
      const y = row1Y + i * rowGap;
      ctx.font      = `bold ${rowFs}px Impact, sans-serif`;
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
   * Draws 160 coloured confetti ribbons falling from above the canvas.
   *
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
    const COUNT = 160;

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

  // ── Barney & Beagle celebration billboards ─────────────────────────────────

  /**
   * Draws four procedural celebration billboards for the GOAL screen:
   *   Left large:  Barney (purple dino) + "ROAD KILL!" label.
   *   Right large: Beagle (brown dog)   + "GOOD BOY!" label.
   *   Left small:  Second Barney (slightly transparent).
   *   Right small: Second Beagle (slightly transparent).
   *
   * All characters are drawn with canvas arc/ellipse primitives — no images
   * needed.  `drawBoard()` is a local helper that handles the post, shadow,
   * face, border, and labels for any board; the character is passed as a
   * callback so the geometry can be shared.
   *
   * @param w - Canvas width.
   * @param h - Canvas height.
   */
  private renderBillboards(w: number, h: number): void
  {
    const { ctx } = this;

    const drawBoard = (
      bx: number, by: number, bw: number, bh: number,
      bgColor: string, borderColor: string,
      drawCharacter: () => void,
      topLabel: string, botLabel: string,
      labelColor: string, botColor: string,
    ): void =>
    {
      // Post
      ctx.fillStyle = '#666666';
      const postW = Math.max(6, Math.round(bw * 0.09));
      ctx.fillRect(bx + bw * 0.46, by + bh * 0.97, postW, Math.round(h * 0.18));

      // Board shadow
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(bx + 5, by + 5, bw, bh);

      // Board face
      ctx.fillStyle = bgColor;
      ctx.fillRect(bx, by, bw, bh);

      // Top colour band
      ctx.fillStyle = borderColor;
      ctx.fillRect(bx, by, bw, Math.round(bh * 0.17));

      // Border
      ctx.strokeStyle = borderColor;
      ctx.lineWidth   = Math.max(3, Math.round(bw * 0.03));
      ctx.strokeRect(bx, by, bw, bh);

      drawCharacter();

      // Top label
      const topFs = Math.round(bh * 0.13);
      ctx.font      = `bold ${topFs}px Impact, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = labelColor;
      ctx.fillText(topLabel, bx + bw / 2, by + Math.round(bh * 0.135));

      // Bottom label
      const botFs = Math.round(bh * 0.09);
      ctx.font      = `bold ${botFs}px Impact, sans-serif`;
      ctx.fillStyle = botColor;
      ctx.fillText(botLabel, bx + bw / 2, by + Math.round(bh * 0.93));
    };

    // ── LEFT BILLBOARD: Barney ────────────────────────────────────────────
    const lw = Math.round(w * 0.17);
    const lh = Math.round(h * 0.54);
    const lx = Math.round(w * 0.015);
    const ly = Math.round(h * 0.15);

    drawBoard(lx, ly, lw, lh, '#3A0D6E', '#9B30E0',
      () =>
      {
        const cx = lx + lw / 2;
        const cy = ly + lh * 0.60;

        // Tail
        ctx.fillStyle = '#7B2FBE';
        ctx.beginPath();
        ctx.moveTo(cx + lw * 0.22, cy + lh * 0.12);
        ctx.lineTo(cx + lw * 0.45, cy - lh * 0.10);
        ctx.lineTo(cx + lw * 0.38, cy + lh * 0.20);
        ctx.closePath();
        ctx.fill();

        // Body
        ctx.fillStyle = '#7B2FBE';
        ctx.beginPath();
        ctx.ellipse(cx, cy, lw * 0.33, lh * 0.22, 0, 0, Math.PI * 2);
        ctx.fill();

        // Belly
        ctx.fillStyle = '#55CC55';
        ctx.beginPath();
        ctx.ellipse(cx, cy + lh * 0.04, lw * 0.18, lh * 0.14, 0, 0, Math.PI * 2);
        ctx.fill();

        // Head
        ctx.fillStyle = '#7B2FBE';
        ctx.beginPath();
        ctx.ellipse(cx, cy - lh * 0.23, lw * 0.22, lh * 0.17, 0, 0, Math.PI * 2);
        ctx.fill();

        // Eyes
        ctx.fillStyle = '#FFFFFF';
        ctx.beginPath(); ctx.arc(cx - lw * 0.08, cy - lh * 0.25, lw * 0.055, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(cx + lw * 0.08, cy - lh * 0.25, lw * 0.055, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#1A1A1A';
        ctx.beginPath(); ctx.arc(cx - lw * 0.07, cy - lh * 0.245, lw * 0.028, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(cx + lw * 0.09, cy - lh * 0.245, lw * 0.028, 0, Math.PI * 2); ctx.fill();

        // Big grin
        ctx.strokeStyle = '#1A1A1A';
        ctx.lineWidth   = Math.max(2, Math.round(lw * 0.025));
        ctx.beginPath();
        ctx.arc(cx, cy - lh * 0.14, lw * 0.13, 0.15, Math.PI - 0.15);
        ctx.stroke();
      },
      'BARNEY', 'ROAD KILL!', '#FFD700', '#FF6666',
    );

    // ── RIGHT BILLBOARD: Beagle ───────────────────────────────────────────
    const rw = Math.round(w * 0.17);
    const rh = Math.round(h * 0.54);
    const rx = Math.round(w * 0.815);
    const ry = Math.round(h * 0.15);

    drawBoard(rx, ry, rw, rh, '#3A1A00', '#CC6600',
      () =>
      {
        const cx = rx + rw / 2;
        const cy = ry + rh * 0.60;

        // Left ear (floppy, drawn first so head overlaps it)
        ctx.fillStyle = '#8B4513';
        ctx.beginPath();
        ctx.ellipse(cx - rw * 0.22, cy - rh * 0.04, rw * 0.10, rh * 0.18, -0.25, 0, Math.PI * 2);
        ctx.fill();

        // Right ear
        ctx.beginPath();
        ctx.ellipse(cx + rw * 0.22, cy - rh * 0.04, rw * 0.10, rh * 0.18, 0.25, 0, Math.PI * 2);
        ctx.fill();

        // Face (on top)
        ctx.fillStyle = '#D2A060';
        ctx.beginPath();
        ctx.ellipse(cx, cy - rh * 0.10, rw * 0.24, rh * 0.20, 0, 0, Math.PI * 2);
        ctx.fill();

        // White muzzle patch
        ctx.fillStyle = '#F0E0C0';
        ctx.beginPath();
        ctx.ellipse(cx, cy + rh * 0.02, rw * 0.13, rh * 0.09, 0, 0, Math.PI * 2);
        ctx.fill();

        // Eyes (expressive)
        ctx.fillStyle = '#1A1A1A';
        ctx.beginPath(); ctx.arc(cx - rw * 0.09, cy - rh * 0.14, rw * 0.04, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(cx + rw * 0.09, cy - rh * 0.14, rw * 0.04, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#FFFFFF';
        ctx.beginPath(); ctx.arc(cx - rw * 0.08, cy - rh * 0.15, rw * 0.015, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(cx + rw * 0.10, cy - rh * 0.15, rw * 0.015, 0, Math.PI * 2); ctx.fill();

        // Nose
        ctx.fillStyle = '#1A1A1A';
        ctx.beginPath();
        ctx.ellipse(cx, cy - rh * 0.02, rw * 0.06, rh * 0.035, 0, 0, Math.PI * 2);
        ctx.fill();

        // Happy panting mouth
        ctx.strokeStyle = '#1A1A1A';
        ctx.lineWidth   = Math.max(2, Math.round(rw * 0.025));
        ctx.beginPath();
        ctx.arc(cx, cy + rh * 0.02, rw * 0.09, 0.2, Math.PI - 0.2);
        ctx.stroke();

        // Tongue
        ctx.fillStyle = '#FF6688';
        ctx.beginPath();
        ctx.ellipse(cx, cy + rh * 0.08, rw * 0.06, rh * 0.055, 0, 0, Math.PI * 2);
        ctx.fill();

        // Body
        ctx.fillStyle = '#C09040';
        ctx.beginPath();
        ctx.ellipse(cx, cy + rh * 0.22, rw * 0.26, rh * 0.13, 0, 0, Math.PI * 2);
        ctx.fill();
      },
      'BEAGLE', 'GOOD BOY!', '#FFFFFF', '#FFD700',
    );

    // ── SECOND BARNEY (right cluster, smaller) ────────────────────────────
    const s1w = Math.round(w * 0.11);
    const s1h = Math.round(h * 0.36);
    const s1x = Math.round(w * 0.84);
    const s1y = Math.round(h * 0.55);

    ctx.save();
    ctx.globalAlpha = 0.85;
    drawBoard(s1x, s1y, s1w, s1h, '#3A0D6E', '#9B30E0',
      () =>
      {
        const cx = s1x + s1w / 2;
        const cy = s1y + s1h * 0.60;
        ctx.fillStyle = '#7B2FBE';
        ctx.beginPath(); ctx.ellipse(cx, cy, s1w * 0.30, s1h * 0.20, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#55CC55';
        ctx.beginPath(); ctx.ellipse(cx, cy, s1w * 0.14, s1h * 0.10, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#7B2FBE';
        ctx.beginPath(); ctx.ellipse(cx, cy - s1h * 0.22, s1w * 0.18, s1h * 0.14, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#FFD700';
        const starFs = Math.round(s1h * 0.22);
        ctx.font = `bold ${starFs}px Impact`;
        ctx.textAlign = 'center';
        ctx.fillText('★', cx, cy - s1h * 0.40);
      },
      'BARNEY', 'GOT WRECKED', '#FFD700', '#FF6666',
    );
    ctx.restore();

    // ── SECOND BEAGLE (left cluster, smaller) ────────────────────────────
    const s2w = Math.round(w * 0.11);
    const s2h = Math.round(h * 0.36);
    const s2x = Math.round(w * 0.05);
    const s2y = Math.round(h * 0.55);

    ctx.save();
    ctx.globalAlpha = 0.85;
    drawBoard(s2x, s2y, s2w, s2h, '#3A1A00', '#CC6600',
      () =>
      {
        const cx = s2x + s2w / 2;
        const cy = s2y + s2h * 0.58;
        ctx.fillStyle = '#8B4513';
        ctx.beginPath(); ctx.ellipse(cx - s2w * 0.18, cy, s2w * 0.09, s2h * 0.16, -0.25, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.ellipse(cx + s2w * 0.18, cy, s2w * 0.09, s2h * 0.16,  0.25, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#D2A060';
        ctx.beginPath(); ctx.ellipse(cx, cy - s2h * 0.06, s2w * 0.20, s2h * 0.18, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#FFD700';
        const starFs2 = Math.round(s2h * 0.22);
        ctx.font = `bold ${starFs2}px Impact`;
        ctx.textAlign = 'center';
        ctx.fillText('★', cx, cy - s2h * 0.38);
      },
      'BEAGLE', 'CHAMP!', '#FFFFFF', '#FFD700',
    );
    ctx.restore();
  }
}
