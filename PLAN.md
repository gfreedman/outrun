# OutRun — Project Plan & Development History

A browser-based recreation of the 1986 Sega arcade classic, built with TypeScript and the
Canvas 2D API.  No frameworks, no game engine — just math, pixels, and stubbornness.

---

## What It Is

OutRun (1986) is a pseudo-3D sprite-scaling racing game.  The original ran on Sega System 16
hardware at a fixed 60 fps with a purpose-built GPU that could scale and composite sprites in
real time.  This recreation implements the same visual tricks — road projection, parallax sky,
sprite scaling, per-segment color banding — entirely in software on a 2D canvas.

The goal is high fidelity to the 1986 original: the Ferrari Testarossa, the Coconut Beach
setting, the OutRun music aesthetic, the warm System 16 color palette, the traffic cars with
their characteristic types.  Half-measures are unacceptable.

---

## Phase 1 — Foundation (Straight Road, Car, Physics, HUD)

**Goal:** Get something on screen that feels like a racing game.

### What was built
- **Canvas loop** — `requestAnimationFrame` with a delta-time accumulator so the simulation
  runs at a fixed physics rate regardless of display refresh.  Avoids spiral-of-death on
  low-end hardware.
- **Pseudo-3D road projection** — The OutRun road is not rendered with WebGL or a 3D
  transform.  Each road *segment* is a trapezoid drawn with a 2D polygon.  The width of the
  trapezoid at a given screen row encodes perspective depth: wide at the bottom (near), narrow
  at the top (far).  Classic technique first described publicly by Louis Gobin in the DEVELOP
  magazine OutRun clone articles.
- **Segment color banding** — Grass and rumble strips alternate every 8 segments
  (`Math.floor(i/8) % 2`); lane dashes every 4 (`Math.floor(i/4) % 2`).  This is the primary
  source of the road's "moving" feel — color bands scroll toward the player.
- **Car sprite** — Ferrari Testarossa convertible, red, viewed from behind, with driver and
  blonde passenger.  Sprite is scaled by the player's lateral position to lean into curves.
  Seven lean frames (full-left through full-right).
- **Player physics** — Velocity with acceleration/braking, off-road friction (sand/grass),
  steering with a `playerX` normalized −1 to +1.  Camera X follows `playerX * ROAD_WIDTH`.
- **Speed HUD** — OutRun-style 7-segment speed digits (Impact font, red #FF2200) with a
  3-row RPM tachometer bar and pixel grain overlay.  Positioned bottom-left.

### Key constants locked in Phase 1
```
CAMERA_HEIGHT    = 1000
ROAD_WIDTH       = 2000
SEGMENT_LENGTH   = 200
DRAW_DISTANCE    = 150
PLAYER_STEERING  = 2.0   (road-widths / sec)
```

---

## Phase 2 — Curves, Hills, Parallax

**Goal:** The road should curve and undulate like the original.

### Curves
The road curvature is stored per-segment as a signed float.  During projection, two
accumulators track how much the road has drifted laterally at each depth:

```
dx      — delta per step, initialised to −baseSegment.curve × basePercent
curveX  — total accumulated drift
```

The projected X for segment near/far edges:
```
projX1 = (cameraX − curveX) × sc1
projX2 = (cameraX − curveX − dx) × sc2
curveX += dx;  dx += seg.curve
```

The camera offset (`cameraX = playerX × ROAD_WIDTH`) combined with this accumulator produces
the characteristic OutRun look where the road curves away and you can see what's coming.

### Hills
Hill Y values are stored in `p1.world.y` per segment.  The screen Y of a segment is:

```
sy = halfH + (CAMERA_HEIGHT − seg.p1.world.y) × sc × halfH
```

Hills required a `maxy` occlusion pass: segments hidden behind a crest must be skipped or the
road "folds" visibly.  `maxy` initialises to `halfH` (horizon) and is updated to
`min(maxy, sy2)` after each segment is drawn.

An important fix: on downhill segments the camera must track the road Y so the horizon doesn't
"bleed" through the sky.  Camera Y is computed from the base segment's Y value.

Hill amplitudes by difficulty:
- EASY: 1.0× base amplitude
- MEDIUM: 1.8×
- HARD: 2.6×

### Parallax sky
Three-layer gradient sky (deep blue → mid cyan → horizon pale blue) with a cloud layer that
scrolls at a different rate from the road.  The sky accumulator tracks total lateral drift so
clouds don't reset on wrap.

### Coconut Beach conversion
The original OutRun course takes place on Coconut Beach, not a grassy racetrack.  Replaced
green grass with warm sand tones:
- `SAND_DARK  = #E0CEB0`
- `SAND_LIGHT = #EDE0C8`

Road surface is `#888888` for both light and dark bands — the rhythm comes from grass+rumble,
not from the road itself.  This eliminates sub-pixel alpha bleed at segment boundaries that
shows up at high DPI.

---

## Phase 3 — Traffic, Collision, Sprites, Billboards

**Goal:** The road should feel alive.  Other cars.  Things to look at.

### Sprites system
Sprites are extracted from JPEG source art via `build_sprite_sheet.py` and packed into a
single sprite sheet.  The renderer scales each sprite by the perspective scale at its world Z
position:

```
sprH   = worldH × sc × halfH
sprX   = sx + sprite.worldX × sc × halfW
drawY  = Math.round(sy − sprH)
```

Sprite types: palm trees (9 varieties, Sega placement rubric — outside of bends), shrubs,
cacti, buildings (houses), billboards (cookies, Barney boards, big boards), turn signs,
traffic cars.

A dedicated sprite rendering pass runs *after* the road geometry pass so sprites are never
occluded by road polygons.

### Traffic cars
Four traffic car types with distinct personalities and hitbox classes:

| Type       | Color  | Behavior          |
|------------|--------|-------------------|
| Yellow     | Yellow | Slow, wanders     |
| Barney     | Purple | Steady pace       |
| Police     | White  | Fast, aggressive  |
| Sports     | Red    | Very fast         |

Traffic cars are spawned ahead of the player and despawned when they pass behind.  Each car
has a `worldZ` position and a `worldX` lateral offset.

### Collision system
Collision detection compares the player's projected X against each traffic car's projected X.
On collision:
- Speed is reduced by 20%
- Screen shake fires (SHAKE_TRAFFIC_INTENSITY = 20, DURATION = 0.35 s)
- Car flicks sideways based on impact angle

Wall collisions at the road edge use a separate "solid wall" response.

### Billboards
`injectFinishCelebration()` populates the road near the start/finish line with Barney boards —
the purple "CHECKPOINT" signs that appear in the original game.  Placed at specific Z offsets
with measured density so the visual effect is impactful without becoming a carpet.

### Turn signs
Six signs per corner, outside shoulder, scaled to 1.5×, with measured spacing so all six are
visible in the approach window.  These are critical navigation cues for the player.

---

## Phase 4 — Audio, Menu, Modes

**Goal:** Sound and a proper title screen.

### Audio
- **Engine growl** — Oscillator-based synth whose pitch tracks RPM.  Two detuned oscillators
  for body.  Separate "afterburner" layer at redline.
- **Screech** — Continuous squeal when off-road or hard-cornering.
- **OutRun music** — Web Audio API synthesis of the OutRun BGM aesthetic.  Rewritten twice to
  reach the right feel.
- **Finish fanfare** — Cinematic sequence at the finish line.

### Menu system
Title screen with hero image (Ferrari photo background), three main menu items (MODE,
SETTINGS, START), and two sub-menus:

- **Mode picker** — EASY / MEDIUM / HARD difficulty cards with keyboard and mouse nav.
- **Settings panel** — Sound toggle, GitHub link, close button.

Settings persisted to `localStorage` with graceful fallback.

### Difficulty modes
- **EASY** — Gentle curves, low hills, sparse traffic.
- **MEDIUM** — The default OutRun feel.  Moderate curves and hills, normal traffic.
- **HARD** — A dedicated course with sweepers, blind crests, chicanes, and hilly S-curves.

---

## Architecture

### File structure

```
src/
  constants.ts        — All tuning values, color palette, physics constants
  types.ts            — Shared TypeScript interfaces and enums
  main.ts             — Canvas init, DPR scaling, Game construction
  game.ts             — Main game loop, phase state machine, mouse events
  intro-controller.ts — INTRO phase state machine (menus, settings, hero image)
  input.ts            — Keyboard + touch InputManager
  road.ts             — Road class, segment builder, course layout
  road-data.ts        — Pre-generated segment array (build artifact)
  physics.ts          — Pure physics functions (acceleration, braking, friction)
  collision.ts        — Collision detection and response
  traffic.ts          — Traffic car spawning, movement, despawning
  sprites.ts          — Sprite definitions, sprite sheet coords, TRAFFIC_CAR_SPECS
  renderer.ts         — Main Renderer class, two-pass road render, projPool
  renderer-hud.ts     — HUD sub-renderer (speed, tach, time, lap)
  renderer-menu.ts    — Menu/intro sub-renderer (title screen, sub-menus)
  renderer-screens.ts — Goal/countdown/time-up screen overlays
  audio.ts            — Web Audio engine, music, SFX
  preloader.ts        — Sprite sheet + image preloading
  ui.ts               — Button class, anyHovered helper
```

### Rendering pipeline

The renderer uses a two-pass `projPool` architecture to achieve correct back-to-front draw
order without allocating per-frame objects:

**Pass 1 — Project (front to back)**
Walk segments from the camera position forward.  For each visible segment, compute screen
coordinates (`sx1, sy1, sw1, sc1, sx2, sy2, sw2, sc2`) and write them into a pre-allocated
slot in `projPool`.  Apply `maxy` occlusion to skip segments hidden behind hills.

**Pass 2 — Road surface (back to front)**
Iterate `projPool` in reverse.  Draw each road trapezoid with `Math.round(sy)` — the rounding
is critical to eliminate sub-pixel alpha bleed on horizontal edges.

**Pass 3 — Sprites (back to front)**
Iterate `projPool` in reverse.  For each slot, check the segment's sprite list and draw
billboards, plants, and buildings scaled by `sc1`.

**Pass 4 — Traffic cars (back to front)**
Iterate `projPool` in reverse.  For each traffic car whose `segIndex` matches the current
slot, render it.

**Intra-segment interpolation (Pass 4)**
Traffic cars vibrated visibly before this fix.  At 4000 wu/s relative closing speed and
SEGMENT_LENGTH = 200, a car crosses a segment boundary every ~3 frames.  Snapping `drawY` to
`p.sy1` produced a per-frame jump visible as vibration.

Fix: store `sc2` (far-edge perspective scale) in the projPool slot.  Pass 4 interpolates
within the segment using:

```typescript
const t      = (car.worldZ % SEGMENT_LENGTH) / SEGMENT_LENGTH;
const scCar  = p.sc1 + (p.sc2 - p.sc1) * t;
const syCar  = p.sy1 + (p.sy2 - p.sy1) * t;
const sxCar  = p.sx1 + (p.sx2 - p.sx1) * t;
```

### IntroController extraction

`game.ts` grew to 1284 lines after the menu system was added.  The INTRO phase is a
self-contained state machine (keyboard nav, button hover/click, sub-menu open/close, settings
persistence, hero image loading) with no dependency on physics or race logic.

Extracted into `intro-controller.ts` (294 lines).  The separation contract:

- **IntroController owns:** menu item focus, sub-menu state, difficulty picker, sound toggle,
  pulse clock, hero image, all menu buttons, GameSettings load/save.
- **Game owns:** mouse event listeners (shared with in-game phases), mouse state, canvas,
  renderer, audio, road, physics.

The only cross-boundary call is `onStartRace()` — a callback injected at construction time.
`Game.beginRace()` reads `this.intro.settings` for mode/sound preferences.

Mouse coordinates are passed as parameters to `intro.tick()` rather than moving the mouse
state into IntroController, because `tickPlaying`, `tickGoal`, and `tickTimeUp` also use it.

### Physics extraction

Pure physics functions (velocity integration, steering, off-road friction, centrifugal force)
extracted into `physics.ts` for unit testability.  All timer ticks consolidated into a single
`advancePhysics()` state machine to eliminate double-application of deceleration that had
caused a subtle slow-down bug.

---

## Code Review History (L5 Audit)

An L5-level code review identified findings across CRITICAL, HIGH, MEDIUM, and LOW severity.
All findings were actioned:

### Critical fixes
- **C2** Double grind deceleration — `advancePhysics` and `updateCollisions` both applied
  braking; removed the duplicate.
- **C4** Sprite rendering in geometry pass — sprites were drawn during the road polygon pass,
  causing road segments to overdraw sprites.  Moved to a dedicated post-geometry pass.
- **C5** Traffic catch-up / teleport — cars could jump forward when the player slowed sharply.
  Fixed with a maximum relative velocity cap.
- **C6** Finish-line sideways skid — player car slid sideways on crossing finish due to
  uncleared lateral velocity.  Centred car on road at goal transition.
- **C7** Billboard Z-fighting — multiple billboard types could overlap at the same Z.
  Enforced cross-type spacing.
- **C8** Horizon artifact on downhill segments — camera Y not tracking road Y, causing sky to
  show through the road on descents.

### High / Medium fixes
- Per-frame GC pressure from projPool object allocation.  Pool pre-allocated to
  `DRAW_DISTANCE` slots; Pass 1 writes into existing slots rather than pushing new objects.
- `requestAnimationFrame` / input lifecycle ordering — input `wasPressed` consumed flags were
  being cleared before the frame that needed them.
- Dead exports and stale JSDoc throughout.
- `TRAFFIC_CAR_SPECS` consolidated from scattered per-type constants into a single config
  table; `TrafficType` and `CollisionClass` converted to TypeScript enums for exhaustiveness.

---

## Testing Infrastructure

**181 tests across 7 suites** (Vitest, runs in ~730 ms).

| Suite | Tests | What it covers |
|-------|-------|----------------|
| `constants.test.ts` | ~20 | Invariants: ROAD_WIDTH > 0, all colors valid hex, difficulty enums |
| `physics.test.ts` | ~40 | Acceleration, braking, off-road friction, centrifugal, steering |
| `collision.test.ts` | ~30 | Hit detection geometry, wall response, car flick angles |
| `traffic.test.ts` | ~18 | Spawn/despawn logic, TRAFFIC_CAR_SPECS shape |
| `road.test.ts` | ~14 | Segment count, Z continuity, curve/hill bounds |
| `renderer.test.ts` | ~50 | Two-pass projPool, sprite placement, projected coords |
| `snapshot.test.ts` | ~9 | Color palette lock, road draw-call sequence lock, sc2 regression guard |

Snapshot tests (`toMatchInlineSnapshot`) lock the exact hex values of every color and the
exact sequence of `fillStyle` values at each `fill()` / `fillRect()` call.  An accidental hex
edit fails a test rather than silently shipping wrong colors.

A Husky pre-commit hook runs the full suite before every commit.

---

## Current State

### What works
- Full race loop: countdown → racing → goal / time-up → result screen → menu
- Pseudo-3D road with curves, hills, parallax sky, clouds
- Coconut Beach sand aesthetic, accurate System 16 color palette
- Ferrari Testarossa with lean frames, correct perspective scaling
- Traffic cars (4 types) with collision, screen shake, hit classification
- Roadside sprites: 9 palm varieties, shrubs, cacti, buildings, billboards, turn signs
- Three difficulty modes with distinct courses and tuning
- Title screen with hero image, mode picker, settings (sound toggle), GitHub link
- Settings persistence via localStorage
- Web Audio engine: engine growl, off-road screech, OutRun-style BGM, finish fanfare
- 181 passing tests with pre-commit enforcement

### Repository layout
```
/
  src/          TypeScript source (19 files)
  tests/        Vitest test suites (7 files)
  sprites/      Sprite sheet PNG + source art
  dist/         Build output (esbuild, gitignored)
  outrun.code-workspace   VS Code workspace (file nesting configured)
  vitest.config.ts
  esbuild.config.js
  package.json
```

### Build & dev
```bash
npm run build   # one-shot esbuild compile → dist/
npm run dev     # esbuild watch
npx serve .     # static file server for local testing
npm test        # vitest run (all 181 tests)
```

---

## Roadmap

### Phase 5 — Music
Full implementation of Magical Sound Shower and Splash Wave using the Web Audio API.  The
audio module already has the architecture; this is a matter of sequencing the correct chord
progressions and timbres.

### Phase 6 — Branching routes
OutRun's defining mechanic is the fork at the end of each stage: left branch (harder) or right
branch (easier).  This requires:
- Stage boundary detection
- Fork UI overlay (LEFT / RIGHT countdown)
- Multiple course definitions loaded by stage index
- Stage select screen on the title

### Phase 7 — Stage select screen
The original title screen had a map with the five possible route endings.  Players could
choose their starting stage in free-play mode.

### Phase 8 — High score table
Persistent best times per difficulty, initials entry, displayed on the title screen cycling
between the logo and the leaderboard.

### Phase 9 — Mobile / touch
Touch controls for throttle, brake, steer.  The canvas already scales to window size; the
remaining work is a D-pad/button overlay and touch event mapping in `input.ts`.

---

## Design Principles

1. **Fidelity first.** If it doesn't look like the 1986 arcade, it's not done.
2. **No frameworks.** TypeScript + Canvas 2D + the browser.  No game engines, no React, no
   Three.js.  The constraint is the point.
3. **Math over magic.** Every visual effect has an explicit geometric explanation.  No
   "tweak until it looks right" without understanding why.
4. **Tests for logic, eyes for pixels.** Unit tests lock invariants and catch regressions.
   But visual fidelity requires looking at the screen.
5. **No half-measures.** Missing the car, a broken HUD, traffic that vibrates — all
   unacceptable.  Ship it right or don't ship it.
