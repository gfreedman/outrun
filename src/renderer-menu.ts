import { Button }                         from './ui';
import { SpriteLoader, BARNEY_RECTS }     from './sprites';

// ── MenuRenderer ──────────────────────────────────────────────────────────────

export class MenuRenderer
{
  constructor(
    private readonly ctx:         CanvasRenderingContext2D,
    private readonly barneySheet: SpriteLoader | null = null,
  ) {}

  // ── Intro / menu screen ────────────────────────────────────────────────────

  /**
   * Draws the title / main-menu screen.
   *
   * If a hero image is available it fills the background (letterboxed); otherwise
   * a sky gradient + road strip + "OUT RUN" title is generated.  All interactive
   * elements — menu buttons, sub-menu overlays — are drawn on top.
   *
   * Sub-menu routing:
   *   subMenu === 'mode'     → drawModeMenu overlay
   *   subMenu === 'settings' → drawSettingsPanel overlay
   *   subMenu === null       → main three-button row (GAME MODE / START / SETTINGS)
   *
   * Button hit-areas are registered HERE each frame (via btn.setRect) so that
   * game.ts can call btn.tick() immediately afterwards with the current mouse pos.
   *
   * @param w            - Canvas width.
   * @param h            - Canvas height.
   * @param selectedItem - Currently focused main-menu item (keyboard nav).
   * @param selectedMode - Currently active difficulty string.
   * @param soundEnabled - Whether sound is on (shown in settings panel).
   * @param subMenu      - Which sub-menu overlay is open, or null for main menu.
   * @param pulse        - Alternating bool (2 Hz) for blinking "press start" effects.
   * @param heroImage    - Pre-loaded hero JPEG, or null to use procedural background.
   * @param btns         - All interactive Button objects used on this screen.
   */
  public renderIntro(
    w: number, h: number,
    selectedItem:  'start' | 'mode' | 'settings',
    selectedMode:  string,
    soundEnabled:  boolean,
    subMenu:       'mode' | 'settings' | null,
    pulse:         boolean,
    heroImage:     HTMLImageElement | null = null,
    btns?: {
      mode: Button; settings: Button; start: Button;          // main menu
      easy: Button; medium: Button; hard: Button;             // mode submenu
      close: Button; sound: Button; github: Button;           // settings panel
    },
  ): void
  {
    const { ctx } = this;
    ctx.save();

    // ── Background ──────────────────────────────────────────────────────────
    if (heroImage && heroImage.complete && heroImage.naturalWidth > 0)
    {
      const iw = heroImage.naturalWidth;
      const ih = heroImage.naturalHeight;
      // Contain: fit the entire image inside the canvas, letterbox with black
      const scale = Math.min(w / iw, h / ih);
      const dw    = Math.round(iw * scale);
      const dh    = Math.round(ih * scale);
      const dx    = Math.round((w - dw) / 2);   // center horizontally
      const dy    = Math.round((h - dh) / 2);   // center vertically
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(heroImage, dx, dy, dw, dh);
    }
    else
    {
      // Fallback: sky gradient
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0,    '#0066AA');
      grad.addColorStop(0.6,  '#72D7EE');
      grad.addColorStop(1,    '#C8EEFF');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      // Road strip at bottom
      ctx.fillStyle = '#888888';
      ctx.fillRect(0, h * 0.70, w, h * 0.30);
      ctx.fillStyle = '#CC0000';
      ctx.fillRect(0, h * 0.70, w, 6);

      // Title (only when no hero image)
      const titleGrad = ctx.createLinearGradient(0, h * 0.06, 0, h * 0.22);
      titleGrad.addColorStop(0, '#FFE000');
      titleGrad.addColorStop(1, '#FF6600');
      ctx.font      = `bold ${Math.round(h * 0.16)}px Impact, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = '#000000';
      ctx.fillText('OUT RUN', w / 2 + 5, h * 0.22 + 5);
      ctx.fillStyle = titleGrad;
      ctx.fillText('OUT RUN', w / 2, h * 0.22);
    }

    // ── Hero image bounds — all menus are constrained to this region ─────────
    let imgX = 0, imgW = w, imgY = 0, imgH = h;
    if (heroImage && heroImage.complete && heroImage.naturalWidth > 0)
    {
      const scale = Math.min(w / heroImage.naturalWidth, h / heroImage.naturalHeight);
      imgW = Math.round(heroImage.naturalWidth  * scale);
      imgH = Math.round(heroImage.naturalHeight * scale);
      imgX = Math.round((w - imgW) / 2);
      imgY = Math.round((h - imgH) / 2);
    }

    // ── Barney billboard on the beach (right side of hero image) ─────────────
    // BARNEY_METAL_TILLETIRE = metal-frame billboard (left sprite in sheet).
    // Beach ground level is at ~56% of image height (pixel-sampled);
    // foreground cars occupy y > 58%, so we stay safely above them.
    if (heroImage && heroImage.complete && heroImage.naturalWidth > 0 && this.barneySheet)
    {
      const rect = BARNEY_RECTS.BARNEY_METAL_TILLETIRE;
      if (rect)
      {
        const bdH = Math.round(imgH * 0.20);
        const bdW = Math.round(bdH * rect.w / rect.h);
        const cx  = Math.round(imgX + imgW * 0.84);
        const top = Math.round(imgY + imgH * 0.56) - bdH;
        this.barneySheet.draw(ctx, rect, cx - Math.round(bdW / 2), top, bdW, bdH);
      }
    }

    // ── Sub-menus ────────────────────────────────────────────────────────────
    if (subMenu === 'mode')
    {
      this.drawModeMenu(w, h, imgX, imgW, selectedMode, btns);
    }
    else if (subMenu === 'settings')
    {
      this.drawSettingsPanel(w, h, soundEnabled, btns);
    }
    else
    {
      // ── Main menu — all three buttons share one horizontal row ────────────
      // START RACE stays centered; GAME MODE sits left, SETTINGS sits right.
      const startFs = Math.round(imgW * 0.060);
      const sideFs  = Math.round(imgW * 0.045);
      const baseY   = Math.round(h * 0.978);   // shared baseline — START RACE anchor

      ctx.lineJoin = 'round';

      // ── Pre-measure all three labels so we can size the background rect ──
      ctx.font = `bold ${startFs}px Impact, sans-serif`;
      const smStart = ctx.measureText('START RACE');
      const sAsc    = smStart.actualBoundingBoxAscent  ?? startFs * 0.78;
      const sDesc   = smStart.actualBoundingBoxDescent ?? startFs * 0.14;

      ctx.font = `bold ${sideFs}px Impact, sans-serif`;
      const smMode = ctx.measureText('GAME MODE');
      const smSet  = ctx.measureText('SETTINGS');

      // Side buttons are vertically centred with START RACE by aligning ascenders
      const sideAsc  = smMode.actualBoundingBoxAscent ?? sideFs * 0.78;
      const sideDesc = smMode.actualBoundingBoxDescent ?? sideFs * 0.14;
      // Offset side baselines so their cap-height lines up with START RACE cap-height
      const sideY    = baseY - sAsc + sideAsc;

      // Centre X positions — all relative to hero image bounds
      const startCx = Math.round(imgX + imgW * 0.50);
      const modeCx  = Math.round(imgX + imgW * 0.22);
      const setCx   = Math.round(imgX + imgW * 0.78);

      // ── Black semi-transparent bar behind all three buttons ───────────────
      const padV = Math.round(h * 0.022);
      const rectTop = baseY - sAsc - padV;
      const rectBot = baseY + sDesc + padV;
      ctx.fillStyle = 'rgba(0,0,0,0.30)';
      ctx.fillRect(imgX, rectTop, imgW, rectBot - rectTop);

      // ── Controls hint — OutRun 1986 arcade style, below title ───────────────
      {
        const hintCx  = imgX + imgW / 2;
        const keyFs   = Math.round(h * 0.026);
        const keyPad  = Math.round(keyFs * 0.32);
        const keyH    = keyFs + keyPad * 2;
        const arrowKW = Math.round(keyH * 1.15);
        const spaceKW = Math.round(keyH * 2.80);
        const actFs   = Math.round(h * 0.026);
        const keyGap  = Math.round(arrowKW * 0.18);   // gap between ← and →
        const textGap = Math.round(actFs * 0.55);      // gap between key and action text
        const divGap  = Math.round(actFs * 1.40);      // gap between STEER and SPACE

        // Pre-measure action text for exact centering
        ctx.font = `bold ${actFs}px Impact, sans-serif`;
        const steerW = Math.round(ctx.measureText('STEER').width);
        const gasW   = Math.round(ctx.measureText('GAS').width);
        const brakeW = Math.round(ctx.measureText('BRAKE').width);

        const totalContentW = arrowKW + keyGap + arrowKW + textGap + steerW
                            + divGap + arrowKW + textGap + gasW
                            + divGap + spaceKW + textGap + brakeW;
        const panPadH = Math.round(keyH * 0.55);
        const panH    = keyH + panPadH * 2;
        const panW    = totalContentW + Math.round(keyH * 2.0);   // generous side padding
        const panX    = Math.round(hintCx - panW / 2);
        const panY    = imgY + Math.round(imgH * 0.23) + 50;
        const radius  = Math.round(panH * 0.30);

        // Rounded-corner dark panel
        ctx.beginPath();
        ctx.roundRect(panX, panY, panW, panH, radius);
        ctx.fillStyle = 'rgba(0,0,0,0.42)';
        ctx.fill();

        // Draw content left-to-right starting from centered origin
        let cx2 = panX + Math.round((panW - totalContentW) / 2);
        const keyCy = panY + panPadH + Math.round(keyH / 2);

        const drawKeyCap = (label: string, kw: number): void =>
        {
          ctx.font = `bold ${keyFs}px Impact, monospace`;
          const kx = Math.round(cx2);
          const ky = Math.round(keyCy - keyH / 2);
          ctx.fillStyle = '#000000';
          ctx.fillRect(kx + 2, ky + 3, kw, keyH);
          const kg = ctx.createLinearGradient(kx, ky, kx, ky + keyH);
          kg.addColorStop(0,   '#FFEC50');
          kg.addColorStop(0.5, '#FFD700');
          kg.addColorStop(1,   '#BB8800');
          ctx.fillStyle = kg;
          ctx.fillRect(kx, ky, kw, keyH);
          ctx.strokeStyle = '#775500';
          ctx.lineWidth   = 1;
          ctx.strokeRect(kx, ky, kw, keyH);
          ctx.fillStyle = '#000000';
          ctx.textAlign = 'center';
          ctx.fillText(label, kx + kw / 2, ky + keyPad + keyFs * 0.82);
          cx2 += kw;
        };

        const drawAction = (label: string, color: string, tw: number): void =>
        {
          cx2 += textGap;
          ctx.font        = `bold ${actFs}px Impact, sans-serif`;
          ctx.textAlign   = 'left';
          ctx.lineWidth   = Math.round(actFs * 0.15);
          ctx.strokeStyle = '#000000';
          ctx.lineJoin    = 'round';
          const ty = keyCy + actFs * 0.38;
          ctx.strokeText(label, cx2, ty);
          ctx.fillStyle = color;
          ctx.fillText(label, cx2, ty);
          cx2 += tw;
        };

        // [←] [→] STEER
        drawKeyCap('←', arrowKW);
        cx2 += keyGap;
        drawKeyCap('→', arrowKW);
        drawAction('STEER', '#FFFFFF', steerW);

        // divider
        cx2 += Math.round(divGap / 2);
        ctx.fillStyle = 'rgba(255,170,0,0.50)';
        ctx.fillRect(Math.round(cx2), Math.round(keyCy - keyH * 0.50), 2, Math.round(keyH));
        cx2 += 2 + Math.round(divGap / 2);

        // [↑] GAS
        drawKeyCap('↑', arrowKW);
        drawAction('GAS', '#00FF88', gasW);

        // divider
        cx2 += Math.round(divGap / 2);
        ctx.fillStyle = 'rgba(255,170,0,0.50)';
        ctx.fillRect(Math.round(cx2), Math.round(keyCy - keyH * 0.50), 2, Math.round(keyH));
        cx2 += 2 + Math.round(divGap / 2);

        // [SPACE] BRAKE
        drawKeyCap('SPACE', spaceKW);
        drawAction('BRAKE', '#FF4422', brakeW);
      }

      // ── Helper: draw a centred label with outline + optional glow ─────────
      const drawLabel = (
        label: string, cx: number, by: number,
        fontSize: number, color: string, btn?: Button,
      ): void =>
      {
        ctx.font = `bold ${fontSize}px Impact, sans-serif`;
        const m    = ctx.measureText(label);
        const lx   = Math.round(cx - m.width / 2);
        const asc  = m.actualBoundingBoxAscent  ?? fontSize * 0.78;
        const desc = m.actualBoundingBoxDescent ?? fontSize * 0.14;
        btn?.setRect(lx, by - asc, m.width, asc + desc);

        ctx.shadowColor = btn?.hovered ? 'rgba(255,160,0,0.9)' : 'transparent';
        ctx.shadowBlur  = btn?.hovered ? Math.round(fontSize * 0.65) : 0;

        ctx.textAlign   = 'left';
        ctx.lineWidth   = Math.round(fontSize * 0.18);
        ctx.strokeStyle = 'rgba(0,0,0,0.95)';
        ctx.strokeText(label, lx, by);
        ctx.fillStyle   = color;
        ctx.fillText(label, lx, by);

        ctx.shadowBlur  = 0;
        ctx.shadowColor = 'transparent';
      };

      drawLabel('GAME MODE',  modeCx,  sideY,  sideFs,  '#FFFFFF', btns?.mode);
      drawLabel('START RACE', startCx, baseY,  startFs, '#00EE44', btns?.start);
      drawLabel('SETTINGS',   setCx,   sideY,  sideFs,  '#FFFFFF', btns?.settings);
    }

    ctx.restore();
  }

  /**
   * Draws the difficulty-selection overlay (three full-width horizontal bands).
   *
   * Each band shows the mode name, a one-line description (when selected), and
   * a coloured left chevron.  The layout uses fixed proportions of h so it
   * scales correctly at any canvas height.
   *
   * IMPORTANT: band geometry (bandH, bandTop) MUST match `modeCardAt()` in
   * game.ts — they share the same layout contract.
   *
   * @param w            - Canvas width.
   * @param h            - Canvas height.
   * @param imgX         - Left edge of the hero image (menu constrained to this).
   * @param imgW         - Width of the hero image.
   * @param selectedMode - Currently highlighted mode key.
   * @param btns         - Easy / Medium / Hard Button objects.
   */
  private drawModeMenu(w: number, h: number, imgX: number, imgW: number, selectedMode: string, btns?: { easy: Button; medium: Button; hard: Button }): void
  {
    const { ctx } = this;

    const MODES = [
      { key: 'easy',   label: 'EASY',   accent: '#00DD44', stars: 1,
        desc: 'Few cars  ·  gentle curves  ·  relaxed pace'      },
      { key: 'medium', label: 'MEDIUM', accent: '#FFB800', stars: 2,
        desc: 'Classic OutRun experience'                         },
      { key: 'hard',   label: 'HARD',   accent: '#FF2200', stars: 3,
        desc: 'Dense traffic  ·  sharp turns  ·  max speed'      },
    ];

    // ── Layout: three equal full-width bands, vertically centred ─────────────
    // MUST match modeCardAt() in game.ts exactly.
    const bandH   = Math.round(h * 0.18);
    const totalH  = bandH * 3;
    const bandTop = Math.round((h - totalH) / 2);

    // Dark scrim over entire canvas — hero image dims to silhouette
    ctx.fillStyle = 'rgba(0,0,0,0.80)';
    ctx.fillRect(0, 0, w, h);

    // Thin title above bands — centred within hero image
    ctx.font      = `bold ${Math.round(h * 0.040)}px Impact, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText('SELECT DIFFICULTY', imgX + imgW / 2, bandTop - Math.round(h * 0.04));

    MODES.forEach(({ key, label, accent, stars, desc }, i) =>
    {
      const btn = btns?.[key as 'easy' | 'medium' | 'hard'];
      const sel = selectedMode === key;
      const by  = bandTop + i * bandH;
      const mid = by + bandH / 2;

      // Hit area constrained to hero image width
      btn?.setRect(imgX, by, imgW, bandH, 0);

      // Band background — highlight on hover
      ctx.fillStyle = btn?.hovered ? 'rgba(255,255,255,0.12)' : sel ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0)';
      ctx.fillRect(imgX, by, imgW, bandH);

      // Left chevron stripe (selected only)
      if (sel)
      {
        ctx.fillStyle = accent;
        ctx.fillRect(imgX, by, 8, bandH);
      }

      // Separator line between bands — constrained to hero image width
      if (i > 0)
      {
        ctx.strokeStyle = 'rgba(255,255,255,0.10)';
        ctx.lineWidth   = 1;
        ctx.beginPath();
        ctx.moveTo(imgX, by);
        ctx.lineTo(imgX + imgW, by);
        ctx.stroke();
      }

      // Mode label — left-aligned within hero image
      const labelX  = Math.round(imgX + imgW * 0.08);
      const fontSize = Math.round(h * 0.090);
      ctx.font      = `bold ${fontSize}px Impact, sans-serif`;
      ctx.textAlign = 'left';
      ctx.fillStyle = sel ? accent : '#444444';
      ctx.fillText(label, labelX, mid + fontSize * 0.35);

      // Description — right of label, dimmed
      if (sel)
      {
        ctx.font      = `${Math.round(h * 0.026)}px monospace`;
        ctx.fillStyle = 'rgba(255,255,255,0.88)';
        ctx.textAlign = 'left';
        ctx.fillText(desc, labelX + Math.round(imgW * 0.28), mid + fontSize * 0.35);
      }
    });

    // Nav hint below bands — centred within hero image
    ctx.font      = `${Math.round(h * 0.024)}px monospace`;
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.textAlign = 'center';
    ctx.fillText(
      '↑ ↓ or hover  ·  ENTER or click to confirm  ·  ESC to cancel',
      imgX + imgW / 2,
      bandTop + totalH + Math.round(h * 0.05),
    );
  }

  /**
   * Draws the OPTIONS panel (a centered modal over the hero image).
   *
   * Contains:
   *   - Title bar with orange background + CLOSE button (top-right).
   *   - SOUND toggle pill (◀ ON ▶ / ◀ OFF ▶).
   *   - ABOUT section with a clickable GitHub link.
   *
   * @param w            - Canvas width.
   * @param h            - Canvas height.
   * @param soundEnabled - Current sound toggle state (drives pill display).
   * @param btns         - Close / Sound / Github Button objects.
   */
  private drawSettingsPanel(w: number, h: number, soundEnabled: boolean, btns?: { close: Button; sound: Button; github: Button }): void
  {
    const { ctx } = this;

    // ── Panel geometry ────────────────────────────────────────────────────
    const px = Math.round(w * 0.18);
    const py = Math.round(h * 0.16);
    const pw = Math.round(w * 0.64);
    const ph = Math.round(h * 0.62);
    const pad = Math.round(pw * 0.06);

    // Background + border
    ctx.fillStyle = 'rgba(0,0,8,0.88)';
    ctx.fillRect(px, py, pw, ph);
    ctx.strokeStyle = '#FF6600';
    ctx.lineWidth   = 3;
    ctx.strokeRect(px, py, pw, ph);
    // Inner highlight line
    ctx.strokeStyle = 'rgba(255,102,0,0.20)';
    ctx.lineWidth   = 1;
    ctx.strokeRect(px + 4, py + 4, pw - 8, ph - 8);

    // ── Title bar ─────────────────────────────────────────────────────────
    const titleH = Math.round(h * 0.072);
    ctx.fillStyle = '#FF6600';
    ctx.fillRect(px, py, pw, titleH);

    const titleFs = Math.round(h * 0.048);
    ctx.font      = `bold ${titleFs}px Impact, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#000000';
    ctx.fillText('OPTIONS', px + pw / 2 + 2, py + titleH * 0.72 + 2);
    ctx.fillStyle = '#FFE000';
    ctx.fillText('OPTIONS', px + pw / 2, py + titleH * 0.72);

    // ── Close button — top-right of title bar ─────────────────────────────
    const closeSize = Math.round(titleH * 0.72);
    const closeX    = px + pw - closeSize - Math.round(titleH * 0.18);
    const closeY    = py + Math.round(titleH * 0.14);
    btns?.close.setRect(closeX, closeY, closeSize, closeSize, 0);
    ctx.fillStyle   = btns?.close.hovered ? 'rgba(0,0,0,0.55)' : 'rgba(255,80,0,0.55)';
    ctx.fillRect(closeX, closeY, closeSize, closeSize);
    ctx.font        = `bold ${Math.round(closeSize * 0.75)}px Impact, sans-serif`;
    ctx.textAlign   = 'center';
    ctx.fillStyle   = '#FFFFFF';
    ctx.fillText('✕', closeX + closeSize / 2, closeY + closeSize * 0.78);

    // ── Section: SOUND toggle — top margin matches left/right pad ─────────
    const rowY   = py + titleH + pad;
    const labelFs = Math.round(h * 0.040);

    ctx.font      = `bold ${labelFs}px Impact, sans-serif`;
    ctx.textAlign = 'left';
    ctx.fillStyle = '#CCCCCC';
    ctx.fillText('SOUND', px + pad, rowY);

    // Toggle pill  ◀ ON ▶  /  ◀ OFF ▶
    const pillFs = Math.round(h * 0.032);
    const pillTxt = soundEnabled ? '◀  ON  ▶' : '◀  OFF  ▶';
    ctx.font      = `bold ${pillFs}px Impact, monospace`;
    const pillW   = ctx.measureText(pillTxt).width + 24;
    const pillH   = pillFs + 14;
    const pillX   = px + pw - pad - pillW;
    const pillY   = rowY - labelFs * 0.82;
    btns?.sound.setRect(pillX, pillY, pillW, pillH, 0);
    ctx.fillStyle = soundEnabled ? '#003322' : '#220000';
    ctx.fillRect(pillX, pillY, pillW, pillH);
    ctx.strokeStyle = soundEnabled ? '#00CC66' : '#882200';
    ctx.lineWidth   = 2;
    ctx.strokeRect(pillX, pillY, pillW, pillH);
    ctx.fillStyle = soundEnabled ? '#00FF88' : '#FF4400';
    ctx.textAlign = 'center';
    ctx.fillText(pillTxt, pillX + pillW / 2, pillY + pillFs * 0.88 + 7);

    // Divider
    const divY = rowY + Math.round(h * 0.034);
    ctx.strokeStyle = 'rgba(255,102,0,0.30)';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(px + pad, divY);
    ctx.lineTo(px + pw - pad, divY);
    ctx.stroke();

    // ── Section: ABOUT ────────────────────────────────────────────────────
    const aboutY  = divY + Math.round(h * 0.038);
    const aboutFs = Math.round(h * 0.028);
    const lineGap = Math.round(aboutFs * 1.55);

    ctx.font      = `bold ${aboutFs}px monospace`;
    ctx.textAlign = 'left';
    ctx.fillStyle = '#FF6600';
    ctx.fillText('ABOUT', px + pad, aboutY);

    const aboutLines = [
      { text: 'Built in TypeScript + HTML5 Canvas.', link: false },
      { text: 'No game engines. Pure pseudo-3D.',    link: false },
      { text: '⇒  github.com/gfreedman/outrun',      link: true  },
    ];
    ctx.font = `${aboutFs}px monospace`;
    aboutLines.forEach(({ text, link }, i) =>
    {
      const ty = aboutY + lineGap + i * lineGap;
      const asc = aboutFs * 0.78;
      if (link)
      {
        const tw = ctx.measureText(text).width;
        btns?.github.setRect(px + pad, ty - asc, tw, asc + aboutFs * 0.14);
        ctx.fillStyle = btns?.github.hovered ? '#99DDFF' : '#66BBFF';
        ctx.fillText(text, px + pad, ty);
        ctx.fillRect(px + pad, ty + 3, tw, 1);
      }
      else
      {
        ctx.fillStyle = '#888899';
        ctx.fillText(text, px + pad, ty);
      }
    });

    // ── Footer hint ───────────────────────────────────────────────────────
    ctx.font      = `${Math.round(h * 0.022)}px monospace`;
    ctx.fillStyle = 'rgba(255,255,255,0.20)';
    ctx.textAlign = 'center';
    ctx.fillText('ENTER / CLICK to toggle sound  ·  ESC to close', px + pw / 2, py + ph - 14);
  }

  // ── Stage name announcement ────────────────────────────────────────────────

  /**
   * Draws the "STAGE ONE - 1 / COCONUT BEACH" announcement that appears at
   * race start.  The text fades in over 0.3 s, holds, then fades out over
   * the last 0.7 s.  Positioned in the upper third of the sky band so it
   * sits comfortably above the horizon and below the race HUD bar.
   *
   * @param w     - Canvas width.
   * @param h     - Canvas height.
   * @param timer - Seconds remaining (counts down from 3.5 toward 0).
   */
  public renderStageAnnouncement(w: number, h: number, timer: number): void
  {
    // timer counts DOWN from 3.5 → 0
    // Fade in 0–0.3 s, hold until 0.7 s remain, then fade out
    const totalTime    = 3.5;
    const fadeInTime   = 0.30;
    const fadeOutStart = 0.70;

    let alpha: number;
    if (timer > totalTime - fadeInTime)
      alpha = (totalTime - timer) / fadeInTime;   // 0 → 1
    else if (timer > fadeOutStart)
      alpha = 1;
    else
      alpha = timer / fadeOutStart;               // 1 → 0
    alpha = Math.max(0, Math.min(1, alpha));
    if (alpha <= 0) return;

    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = alpha;

    // ── Position: mid-sky area, centred horizontally ─────────────────────
    // The HUD bar is ~10.8 % of h.  The horizon is at h/2.
    // Sky area = 10.8 % → 50 %.  We target the upper third of that band.
    const topBarH = Math.round(h * 0.108);
    const skyH    = h / 2 - topBarH;
    const cx      = w / 2;
    const cy      = Math.round(topBarH + skyH * 0.36);   // ~26 % down from top

    const line1Fs = Math.round(h * 0.052);   // "STAGE ONE - 1"
    const line2Fs = Math.round(h * 0.080);   // "COCONUT BEACH"
    const lineGap = Math.round(line1Fs * 0.45);

    ctx.textAlign = 'center';
    ctx.lineJoin  = 'round';

    // ── Line 1: "STAGE ONE - 1" ───────────────────────────────────────────
    ctx.font        = `bold ${line1Fs}px Impact, sans-serif`;
    ctx.lineWidth   = Math.round(line1Fs * 0.16);
    ctx.strokeStyle = '#000000';
    ctx.strokeText('STAGE ONE - 1', cx, cy);
    ctx.fillStyle   = '#FFFFFF';
    ctx.fillText('STAGE ONE - 1', cx, cy);

    // ── Line 2: "COCONUT BEACH" — yellow/orange gradient ─────────────────
    const line2Y   = cy + line1Fs + lineGap;
    const nameGrad = ctx.createLinearGradient(0, line2Y - line2Fs, 0, line2Y);
    nameGrad.addColorStop(0, '#FFE000');
    nameGrad.addColorStop(1, '#FF8800');

    ctx.font        = `bold ${line2Fs}px Impact, sans-serif`;
    ctx.lineWidth   = Math.round(line2Fs * 0.14);
    ctx.strokeStyle = '#000000';
    ctx.strokeText('COCONUT BEACH', cx, line2Y);
    ctx.fillStyle   = nameGrad;
    ctx.fillText('COCONUT BEACH', cx, line2Y);

    ctx.restore();
  }
}
