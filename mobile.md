# OutRun — Mobile Support Implementation Plan

## 1. Goals & Non-Goals

**Goals:**
- Landscape-only play with a portrait "please rotate" overlay
- Two-zone touch controls: left half = steer (slide ←→), right half = throttle/brake (slide ↑↓)
- White pill-outline affordances drawn on canvas to guide thumb placement
- Mobile-aware hero screen (replace keyboard hint with touch hint)
- iOS Safari safe — no dependency on `fullscreen` API or `screen.orientation.lock()`
- Desktop game completely unchanged in behaviour, controls, and build output

**Non-goals:**
- PWA / add-to-home-screen beyond existing meta tags
- Haptic feedback
- Pointer-lock / gamepad API
- iPad split-screen / Stage Manager multitasking — in these modes the canvas is not full-viewport-width, which breaks the 50% midline zone split and safe-area assumptions. This is a known limitation; the feature targets single-app fullscreen on phones only. iPad split-screen is explicitly out of scope for this implementation.

---

## 2. Mobile Detection

Single constant computed once at startup in `main.ts`:

```
isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
        || ('ontouchstart' in window)
        || (navigator.maxTouchPoints > 1)

isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
     || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
```

Both assigned to module-level `const`s and passed into `new Game(canvas, settings, isMobile)` so every subsystem branches on a single authoritative value.

---

## 3. Orientation Enforcement

**No JS lock for iOS.** `screen.orientation.lock('landscape')` is silently ignored on iOS Safari.

### CSS overlay (all mobile)

Add `#rotate-prompt` div to `index.html`. Show it via CSS media query only — no JS needed:

```css
@media (orientation: portrait) and (hover: none) and (pointer: coarse) {
  #rotate-prompt { display: flex; }
}
```

Overlay: `width: 100dvw; height: 100dvh` — `dvh` avoids iOS address-bar flicker that `100vh` causes. Content: `↻` icon, "Rotate to landscape to play". `z-index: 9999`. Game loop runs underneath; controls are inaccessible in portrait so no pause is needed.

**Mid-race portrait behavior:** If `GamePhase` is `PLAYING` or `COUNTDOWN` when the portrait overlay becomes visible, `game.ts` sets a `pausedForPortrait` flag that suspends `advancePhysics` and the race timer on every `tick()`. When the device returns to landscape and the overlay is hidden, the flag clears and the race resumes. This prevents the race timer from expiring while the phone is tilted and the player cannot steer.

**`pausedForPortrait` mechanism:** The flag is driven by `window.matchMedia('(orientation: portrait)')`. In `main.ts`, register a `change` listener on that `MediaQueryList`; on every change call `game.setPortraitPaused(mql.matches)` — a one-line setter on `Game` that sets/clears `_pausedForPortrait`. This is the same signal the CSS overlay responds to, so the flag and overlay are always in sync.

### Android JS lock (enhancement)

Android Chrome supports the API. After mobile detection:

```
if (isMobile && !isIOS && screen.orientation?.lock) {
  screen.orientation.lock('landscape').catch(() => {});
}
```

---

## 4. Canvas Sizing on Mobile

### Coordinate space contract

All pixel values in this plan are **CSS pixels** unless explicitly noted. On mobile the canvas is sized to `window.innerWidth × window.innerHeight`, making CSS px and canvas logical px 1:1. This invariant is relied upon by touch zone math and tap-to-click coordinate synthesis; it must be maintained on every resize.

### Resize logic (`main.ts`)

When `isMobile === true`, skip the 1280×720 windowed cap — set `maxW = vw; maxH = vh`. The 16:9 letterboxing logic still runs and handles non-16:9 landscape phones. Desktop path unchanged.

### Resize event sources

iOS Safari fires `visualViewport` resize when the address bar animates (but not reliably on `window.resize`). Register both on mobile:

```typescript
window.addEventListener('resize', resize);
if (isMobile && window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => {
    const newW = window.innerWidth, newH = window.innerHeight;
    if (canvas.width !== newW || canvas.height !== newH) resize();
  });
}
```

The `canvas.width !== newW` guard prevents 60 Hz resize calls during iOS scroll-momentum animation (address bar hides/shows at ~60 Hz, which would fire `resize()` and reallocate the canvas backing store on every frame — expensive and visually flickery).

### Orientation change settle

```typescript
window.addEventListener('orientationchange', () => {
  setTimeout(resize, 300);   // 300 ms: pragmatic standard; visualViewport fires again as correction
  TouchInput.reset();        // see Section 5.1 — clears stale zone anchors
});
```

The `visualViewport.resize` guard above provides a second correction pass once dimensions settle.

### `pauseOnResize()` contract

`pauseOnResize()` is a private method on `Game` called at the top of the `resize()` handler (before canvas dimensions are updated). Its contract:

1. If `isMobile === false` — returns immediately (no-op; desktop resize is non-disruptive). `TouchInput` does not exist on desktop so `reset()` is not called.
2. If `isMobile === true` and phase is `PLAYING` or `COUNTDOWN` — sets `this._resizePaused = true` (skips `advancePhysics` for one tick).
3. If `isMobile === true` — calls `TouchInput.reset()` to clear stale zone anchors regardless of phase.
4. `_resizePaused` clears at the end of the next `tick()` that runs after resize completes.

It does **not** alter the race timer, pause the render loop, or change `GamePhase`.

### Mid-race orientation change

If `GamePhase` is `PLAYING` or `COUNTDOWN` when `game.resize(w, h)` is called, set a one-frame skip flag. The next `tick()` call skips `advancePhysics` only (render still runs to avoid a blank frame), then clears the flag. This prevents a dt spike from the 300 ms settle gap reaching the physics integrator.

### Fullscreen guard

Wrap the `fullscreenchange` listener, `document.fullscreenElement` branch, and the `requestFullscreen()` call in `beginRace()` (currently in `game.ts`) with `if (!isMobile)`. iOS Safari has no Fullscreen API; calling it logs a rejected-promise error in DevTools on every race start.

---

## 5. Touch Input Architecture

### 5.1 New file: `src/touch-input.ts`

`InputManager` (`input.ts`) is **not modified**. `TouchInput` is only instantiated when `isMobile === true`.

#### Zone assignment

Zone is determined at `touchstart` and **does not change for the lifetime of that touch identifier**, even if the finger drifts across the midline:

```typescript
const rect = canvas.getBoundingClientRect();
const midX = rect.left + rect.width / 2;
zone = touch.clientX < midX ? 'left' : 'right';
```

#### Multi-touch policy

- Up to 2 simultaneous touches — one per zone.
- Any `touchstart` when both zones are already active is silently ignored.
- `touchend` / `touchcancel` clears that zone slot.
- **Zone-drift design decision:** if a left-zone touch drifts physically into the right half of the screen but a second finger then touches the right half, the second finger correctly claims the right zone (throttle), while the drifted first finger still drives steer — because zone assignment is locked at `touchstart`, not re-evaluated on move. This is intentional and correct: it prevents spurious zone swaps during normal play. The drifted left-zone finger's steer delta is computed from its own `startX`, not from the screen midline, so there is no edge-case in the delta math.

#### `reset()` (static / instance method)

Called on orientation change and on canvas resize to clear all active zone state and `{ id, startX, startY, currentX, currentY, active, cancelled }` records. Prevents ghost zones with stale coordinate anchors after the viewport dimensions change.

#### Per-zone state

```typescript
{ id: number, startX: number, startY: number,
  currentX: number, currentY: number,
  active: boolean, cancelled: boolean }
```

#### Steer (left zone) — CSS pixels

- `deltaX = currentX − startX`
- Deadzone: `|deltaX| < TOUCH_DEADZONE` (10 CSS px) → no steer
- `steerLeft = deltaX < −10`, `steerRight = deltaX > 10`
- Magnitude ratio (exposed for pill highlight): `clamp((|deltaX|−10)/TOUCH_STEER_RANGE, 0, 1)`, `TOUCH_STEER_RANGE = 60`
- `InputSnapshot` steer fields remain **boolean** — full authority once past deadzone

#### Throttle/Brake (right zone) — CSS pixels

- `deltaY = currentY − startY`
- Deadzone: `|deltaY| < 10` → coast
- `throttle = deltaY < −10` (slide up = gas), `brake = deltaY > 10` (slide down = brake)

#### `toInputSnapshot(): InputSnapshot`

Returns `InputSnapshot` with boolean fields. Merged in `game.ts`:

```typescript
const kb    = this.input.snapshot();
const touch = this.touchInput.toInputSnapshot();
const merged = {
  steerLeft:  kb.steerLeft  || touch.steerLeft,
  steerRight: kb.steerRight || touch.steerRight,
  throttle:   kb.throttle   || touch.throttle,
  brake:      kb.brake      || touch.brake,
};
```

Handlers update stored zone state on each event. `toInputSnapshot()` reads stored values at physics-tick time — decouples polling from `touchmove` event delivery rate (which can be 30–60 Hz on older iPhones).

#### Touch event registration

```typescript
['touchstart','touchmove','touchend','touchcancel'].forEach(type =>
  canvas.addEventListener(type, handler, { passive: false })
);
```

`e.preventDefault()` in every handler to block scroll, rubber-band, pull-to-refresh, and browser swipe gestures.

### 5.2 Tap-to-click synthesis (all interactive phases)

`game.ts` feeds `mouseX, mouseY, clickX, clickY, mouseClick` to every `Button.tick()` call in every phase: `INTRO`, `PLAYING` (quit button), `GOAL`, `TIMEUP`, `FINISHING`. All of these must receive synthesized coordinates from touch taps.

**`COUNTDOWN` phase:** No interactive buttons exist during the countdown timer — the player waits for GO. Tap synthesis is therefore not required for `COUNTDOWN`. Pills are drawn during `COUNTDOWN` to orient the player's thumbs before the race starts, but no taps are consumed there.

**Coordinate transformation (critical):** `Button.tick()` expects canvas logical pixels. Touch events report CSS viewport coordinates. On mobile these are 1:1 (canvas CSS size = canvas logical size), but the transformation must still pass through the `getBoundingClientRect()` path to stay correct if sizing logic ever changes:

```typescript
function touchToCanvas(clientX: number, clientY: number): {x: number, y: number} {
  const r      = canvas.getBoundingClientRect();
  const scaleX = canvas.width  / r.width;
  const scaleY = canvas.height / r.height;
  return { x: (clientX - r.left) * scaleX, y: (clientY - r.top) * scaleY };
}
```

**Tap detection:** On `touchend`, if the touch's `cancelled` flag is false and `|deltaX| < 15 && |deltaY| < 15` CSS px, record `clickX/clickY` via `touchToCanvas()` and set `mouseClick = true` for that frame. The threshold is 15 CSS px (not 10) because tap intention requires more tolerance than the steer deadzone — a quick finger lift naturally drifts up to ~12 px even with no steering intent, and 15 px provides headroom without accidentally consuming deliberate steering gestures as clicks. All `Button.tick()` calls in the current phase consume it.

**`touchcancel`:** Sets `cancelled = true` on that touch identifier. No click is synthesized for a cancelled touch.

---

## 6. Safe-Area Insets (Notch & Home Bar)

On iPhone in landscape: notch is left or right; home-bar swipe zone covers bottom ~21 CSS px. `env(safe-area-inset-*)` cannot be read directly in JavaScript.

**Zero-div technique** — the only reliable method:

```html
<div id="safe-probe" style="position:fixed;pointer-events:none;padding:0;
  padding-left:env(safe-area-inset-left,0px);
  padding-right:env(safe-area-inset-right,0px);
  padding-bottom:env(safe-area-inset-bottom,0px);">
</div>
```

```typescript
function readSafeInsets() {
  const cs = getComputedStyle(document.getElementById('safe-probe')!);
  safeL = parseFloat(cs.paddingLeft)   || 0;
  safeR = parseFloat(cs.paddingRight)  || 0;
  safeB = parseFloat(cs.paddingBottom) || 0;
}
```

Called in `main.ts` after `DOMContentLoaded` and on every `orientationchange` (left/right insets swap on rotate). The same `orientationchange` listener that calls `setTimeout(resize, 300)` also calls `readSafeInsets()` immediately (insets are valid from the new orientation by the time `orientationchange` fires).

**`viewport-fit=cover` required** in `index.html` — without it all insets are 0:

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0,
  maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
```

**Applied to pill positions (canvas px = CSS px on mobile):**

```
leftPillCx  = w * 0.18 + safeL
rightPillCx = w * 0.82 − safeR
pillCy      = h * 0.80 − safeB
```

---

## 7. Touch Visual Affordances

Drawn **last in render pipeline** (after HUD), inside `ctx.save()/ctx.restore()`. Only when `isMobile === true` and phase is `PLAYING`, `COUNTDOWN`, or `FINISHING`.

### Left pill — horizontal (steer)

- Center: `(leftPillCx, pillCy)`
- Size: `pillW = w * 0.22`, `pillH = pillW * 0.45`
- Border-radius: `pillH / 2`
- Stroke: `rgba(255,255,255,0.55)`, lineWidth 2
- Fill: `rgba(255,255,255,0.10)`
- Left-half highlight when steering left: `rgba(255,255,255,0.32)`
- Right-half highlight when steering right: same
- Label: `◀  ▶` centred, font ~`pillH * 0.45`px

### Right pill — vertical (throttle/brake)

- Center: `(rightPillCx, pillCy)`
- Size: `pillW * 0.45` wide × `pillW` tall
- Top-half highlight when throttle: `rgba(255,255,255,0.32)`
- Bottom-half highlight when braking: same
- Labels: `▲` top, `▼` bottom

---

## 8. Hero Screen & Sub-menu Adaptations

### Controls hint panel (`renderIntro` in `renderer-menu.ts`)

`MenuRenderer` constructor gains `isMobile: boolean` (set at construction from `Renderer`, which receives it from `Game`). `renderIntro()` branches on it:

- `isMobile === false`: existing keyboard hint unchanged.
- `isMobile === true`: draw touch hint — left pill icon + `STEER`, right pill icon + `GAS / BRAKE`.

### `isMobile` flow to `IntroController`

`IntroController` constructor receives `isMobile: boolean` and stores it. `game.ts` passes `isMobile` when constructing `IntroController`. `IntroController.tick()` passes it to `renderer.renderIntro()`.

### Sub-menu footer strings (mobile-aware)

`drawModeMenu()` footer: currently `"↑ ↓ or hover · ENTER or click to confirm · ESC to cancel"`.
On mobile replace with: `"Tap to select"`.

`drawSettingsPanel()` footer: currently `"ENTER / CLICK to toggle sound · ESC to close"`.
On mobile replace with: `"Tap to toggle · tap ✕ to close"`.

Both `drawModeMenu()` and `drawSettingsPanel()` already receive context via `MenuRenderer` constructor — the `isMobile` field is available with no signature change to these private methods.

### Tap target sizing (decided now, not deferred)

All interactive buttons must have hit areas ≥ 44×44 CSS px (Apple HIG minimum). At minimum mobile landscape height (~375 CSS px on iPhone SE), the current desktop layout falls below this for small buttons. **Decision:** when `isMobile === true`, clamp every `Button` height to `Math.max(computedH, 44)` and add `padH = Math.max(padH, 10)` horizontal padding, applied inside `MenuRenderer` before draw/hit-test. This is a rendering-only change; `Button` hit-test already uses the drawn rect, so no separate hit-area logic is needed. No desktop path is touched.

---

## 9. iOS Safari Mitigations

| Issue | Mitigation |
|---|---|
| No `screen.orientation.lock()` | CSS overlay; JS lock on Android only |
| `100vh` includes address bar | `100dvh` for HTML overlay; `window.innerHeight` in JS |
| Address-bar resize not on `window.resize` | Also listen `visualViewport.resize` with canvas-size guard |
| `visualViewport.resize` fires at 60 Hz during scroll momentum | Canvas-size equality guard prevents redundant reallocations |
| 300ms tap delay | `touch-action: manipulation` on `canvas` in CSS |
| Scroll / rubber-band / pull-to-refresh | `e.preventDefault()` in all canvas touch handlers (`passive: false`) |
| Double-tap zoom | `touch-action: manipulation` is the real fix; `user-scalable=no` **ignored by iOS 13+** |
| Browser pre-scroll optimization | `touch-action: none` on `<canvas>` in CSS (belt-and-suspenders) |
| `touchcancel` mid-game | Clears zone state; sets `cancelled` flag to suppress click synthesis |
| Safe-area insets (notch, home bar) | Zero-div technique; re-read on `orientationchange` |
| No Fullscreen API | Guard `fullscreenchange`, `document.fullscreenElement`, and `requestFullscreen()` in `beginRace()` with `if (!isMobile)` |
| `touchmove` coalescing at 30–60 Hz | Store-on-event, read-on-tick pattern |
| `canvas.width` backing-store reallocation | Guarded by canvas-size equality check before calling `resize()` |
| Stale touch anchors after orientation change | `TouchInput.reset()` called on every `orientationchange` and resize |

---

## 10. File-by-File Change Summary

| File | Change | Desktop impact |
|---|---|---|
| `index.html` | Add `#rotate-prompt`, `#safe-probe` divs; add `viewport-fit=cover` to meta | None |
| `style.css` | Rotate-prompt styles; `touch-action: none` + `manipulation` on canvas; `dvh` for overlay | None |
| `main.ts` | `isMobile`/`isIOS` detection; mobile resize path; `visualViewport` listener with guard; `orientationchange` settle + `TouchInput.reset()`; Android lock; safe-area reading; pass `isMobile` to `Game` | None |
| `src/touch-input.ts` | **New file** — `TouchInput` class; auto-discovered by esbuild via import, no build config change | N/A |
| `src/input.ts` | **Unchanged** | — |
| `src/game.ts` | Accept `isMobile`; guard `requestFullscreen()` in `beginRace()`; instantiate `TouchInput`; OR snapshots; `pauseOnResize()`; tap synthesis with `touchToCanvas()`; pass `isMobile` to `IntroController` and `Renderer` | None |
| `src/intro-controller.ts` | Accept `isMobile` in constructor; store and pass to `renderer.renderIntro()` | None |
| `src/renderer.ts` | Accept `isMobile` in constructor; pass to `new MenuRenderer(ctx, barneySheet, isMobile)`; draw pills last in pipeline | None |
| `src/renderer-menu.ts` | Accept `isMobile` in constructor; swap hint in `renderIntro()`; swap footer strings in `drawModeMenu()` and `drawSettingsPanel()` | None |
| `src/types.ts` | **Unchanged** | — |
| `src/physics.ts` | **Unchanged** | — |
| `src/constants.ts` | Add `TOUCH_DEADZONE = 10`, `TOUCH_STEER_RANGE = 60` (CSS px) | None |

---

## 11. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Tap synthesis coordinate space mismatch | High | Always use `touchToCanvas()` (BoundingClientRect + scale); never pass raw `clientX/Y` to `Button.tick()` |
| Touch tap scope too narrow (only title screen) | High | Synthesized `mouseClick`/`clickX/clickY` fed to ALL `Button.tick()` calls in ALL phases |
| `requestFullscreen()` promise rejection on iOS | Medium | Guarded with `if (!isMobile)` in `beginRace()` |
| `touchmove` coalescing on older iPhones | High | Store-on-event, read-on-tick pattern |
| `orientationchange` dt spike | Medium | One-frame physics skip |
| Stale zone anchors after rotate | Medium | `TouchInput.reset()` called on every resize/rotate |
| `visualViewport.resize` at 60 Hz scroll momentum | Medium | Canvas-size equality guard |
| Sub-menu keyboard strings shown on mobile | Low | `drawModeMenu` and `drawSettingsPanel` use `isMobile` branch |
| `canvas.width` backing-store blank frame (low-memory iOS) | Low | Resize only fires when dimensions actually change |
| Safe-area probe not yet styled on first read | Low | Read after `DOMContentLoaded` |
| Third simultaneous touch stealing zone | Low | Ignored when both zones active |
| Android `screen.orientation.lock()` unexpected failure | Low | `.catch(() => {})` |
| Iframe / WKWebView embedding | Low | CSS overlay still works; JS lock silently fails |
| Desktop regression | Medium | Manual smoke test (Section 12) |

---

## 12. Testing Plan

### Automated
- `npm run test:run` — all 237 existing tests pass unchanged (physics, renderer, collision, traffic are untouched).

### Manual — Mobile (iOS Safari + Android Chrome)
1. **Portrait overlay** — covers game fully; no game content visible behind it.
2. **Landscape play** — overlay gone; canvas fills viewport edge-to-edge.
3. **Steer deadzone** — rest thumb on left zone; car drives straight.
4. **Steer left/right** — full drag; car responds; pill half highlights correctly.
5. **Throttle/brake** — right zone drag up/down; speed responds; pill highlights.
6. **Simultaneous zones** — both thumbs active; steer + accelerate simultaneously.
7. **Title screen taps** — GAME MODE, START RACE, SETTINGS all respond to tap.
8. **Mode picker taps** — EASY/MEDIUM/HARD bands tappable; sub-menu closes on tap outside.
9. **Settings panel taps** — sound toggle, close button respond to tap.
10. **Quit button** — in-race quit button tappable on mobile.
11. **End-game buttons** — PLAY AGAIN, MAIN MENU respond to tap on GOAL/TIMEUP screens.
12. **Mid-race rotate** — one-frame physics skip; no glitch; controls continue correctly.
13. **Notch clearance** — pills not under iPhone notch (left or right landscape orientation).
14. **Home-bar clearance** — pills not under iOS home-bar swipe zone.
15. **Address-bar resize** — canvas re-fits; no flicker; no redundant resize calls.
16. **`touchcancel`** — simulate phone call; stuck inputs release; no phantom click.
17. **Sub-menu hints** — mode picker and settings show tap-friendly footer strings, not keyboard instructions.

### Manual — Desktop smoke test
1. Keyboard controls (↑↓←→ / Space) work at all game phases.
2. Fullscreen toggle letterboxes and restores correctly.
3. Window resize letterboxes at 16:9.
4. Mouse clicks work on all menu buttons including in-game quit and end-game screens.
5. Hero screen shows **keyboard** hint (not touch hint) — verifies `isMobile === false` path.
6. Mode picker and settings footers show keyboard strings, not tap strings.
7. No TypeScript compiler errors from `isMobile` parameter threading through `Game`, `IntroController`, `Renderer`, `MenuRenderer` constructors.
