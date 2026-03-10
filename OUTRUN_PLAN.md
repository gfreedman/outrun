# OutRun — HTML5 Canvas Build Plan

## Project Codename: `outrun`

A pseudo-3D arcade racer built with vanilla TypeScript on HTML5 Canvas, inspired by Yu Suzuki's 1986 Out Run. Desktop + mobile. No frameworks, no runtime dependencies. One repo, one HTML file, one bundled JS.

---

## 1. Why This Is Hard (And Why It's Doable)

Out Run isn't a "real" 3D game. It never was. The original used Sega's Super Scaler hardware to scale and position 2D sprites, creating the *illusion* of depth through a technique called **pseudo-3D road rendering**. This is actually *perfect* for HTML5 Canvas — we're working with the same constraints Yu Suzuki had, just on a different chip.

The core insight: the road is rendered as a series of horizontal **segments** (thin trapezoids), projected from world coordinates to screen space using basic trigonometry. Objects (trees, signs, cars) are 2D sprites scaled by their distance from the camera. There is no z-buffer, no polygon mesh, no WebGL required.

**What makes it tractable:**

- The pseudo-3D math is well-documented (Jake Gordon's JavaScript Racer tutorial, Lou's Pseudo 3d Page)
- Your Pong repo already establishes the architectural pattern (TypeScript modules, esbuild, delta-time physics, Web Audio synthesis, canvas rendering, mobile support)
- We're building one level first — no branching paths, no stage transitions
- Sprites can be generated procedurally on offscreen canvases — zero external asset dependencies

**What makes it legitimately challenging:**

- The road renderer is ~10x more complex than Pong's renderer
- Sprite scaling must be pixel-perfect and performant at 60fps
- Mobile touch controls for steering + acceleration is a UX design problem, not just an input mapping
- "Game feel" — the sensation of speed — requires careful tuning of camera height, FOV, draw distance, road width, and segment density
- Traffic AI needs to feel fair but threatening

---

## 2. Architecture

Following your Pong repo's pattern: strict one-directional dependency graph, pure physics, no DOM in game logic.

```
main.ts ──→ Game ──→ InputManager     (keyboard + touch, single-fire wasPressed)
                 ──→ AudioManager     (Web Audio synthesis — engine, skid, music)
                 ──→ Renderer         (all canvas drawing — road, sprites, HUD, sky)
                 ──→ Road             (segment array, curve/hill definitions, sprite placement)
                 ──→ Player           (position, speed, steering, gear, collision state)
                 ──→ TrafficManager   (NPC car spawning, lane logic, speed variation)
                 ──→ SpriteManager    (procedural sprite generation, sprite atlas cache)
                 ──→ PhysicsEngine    (speed, friction, centrifugal force, collision)
```

### Module Breakdown

| File | Responsibility |
|------|----------------|
| `src/types.ts` | All shared types, interfaces, game-phase enum, road segment type |
| `src/constants.ts` | Every tuning value — single source of truth (speeds in px/s, distances in world units, timing in ms) |
| `src/input.ts` | `InputManager` — keyboard + touch with virtual joystick / tilt / button zones |
| `src/audio.ts` | `AudioManager` — Web Audio engine drone, gear shifts, skid, wind, collision, selectable radio tracks |
| `src/sprites.ts` | `SpriteManager` — procedural pixel art generation onto offscreen canvases, cached sprite atlas |
| `src/road.ts` | `Road` — segment array construction, curve/hill parametric builders, roadside sprite placement |
| `src/player.ts` | `Player` — steering, acceleration, braking, speed, off-road friction, crash state, gear simulation |
| `src/traffic.ts` | `TrafficManager` — NPC car pool, lane assignment, speed distribution, respawning |
| `src/physics.ts` | Pure functions: centrifugal curve force, collision AABB, off-road deceleration, speed clamping |
| `src/renderer.ts` | `Renderer` — sky/parallax, road projection, sprite scaling, HUD, effects (heat haze, etc.) |
| `src/game.ts` | `Game` — state machine, RAF loop, DOM overlay management, timer |
| `src/main.ts` | Bootstrap, DPR-aware canvas sizing, orientation handling, resize |

---

## 3. The Road Renderer (The Heart of Everything)

This is the single most important system. Everything else is secondary.

### 3.1 Segment Model

The road is an array of segments. Each segment stores:

```typescript
interface RoadSegment {
  index: number;
  p1: ProjectedPoint;  // near edge center
  p2: ProjectedPoint;  // far edge center
  curve: number;        // horizontal curvature (-1 to +1)
  y: number;           // world-space elevation (for hills)
  clip: number;        // max y for painter's algorithm clipping
  color: SegmentColor; // road, rumble, grass, lane marking colors
  sprites: RoadSprite[];  // trees, signs, rocks
  cars: TrafficCar[];     // NPC cars occupying this segment
}
```

### 3.2 Projection Math

For each visible segment, project world coordinates to screen:

```
screen.x = (world.x - camera.x) * (cameraDepth / z) + halfWidth
screen.y = (world.y - camera.y) * (cameraDepth / z) + halfHeight  
screen.w = roadWidth * (cameraDepth / z)
```

Where `cameraDepth = 1 / Math.tan((fov / 2) * Math.PI / 180)`.

Render front-to-back with a `maxy` clipping variable that decreases as each segment is drawn — this is how hills occlude the road behind them (painter's algorithm, reversed).

### 3.3 Curves

Curves are *not* actual geometry changes. They're a visual trick: accumulate a `dx` offset per segment based on each segment's `curve` value. The further a segment is from the camera, the more the accumulated offset shifts it left or right. This creates the illusion of the road bending.

### 3.4 Hills

Each segment has a `y` elevation. The projection math handles the rest — segments at different heights project to different screen y positions, creating the illusion of cresting and dipping.

### 3.5 Road Construction

Build the segment array procedurally with helper functions:

```typescript
addStraight(numSegments: number)
addCurve(numSegments: number, curvature: number)
addHill(numSegments: number, height: number)
addSCurve()  // convenience: left curve → straight → right curve
```

### 3.6 Rendering Pipeline (per frame)

```
1. Clear canvas
2. Draw sky gradient + parallax background layers (hills, trees, clouds)
3. Find base segment from player position
4. For each segment in draw distance (front to back):
   a. Project p1 and p2 to screen coordinates
   b. Skip if behind camera or clipped by nearer hill
   c. Draw grass quad (full width, segment height)
   d. Draw road quad (trapezoid between p1 and p2)
   e. Draw rumble strips (slightly wider than road)
   f. Draw lane markings
   g. Update maxy for clipping
5. For each segment (back to front — standard painter's order):
   a. Draw roadside sprites (scaled by distance)
   b. Draw traffic cars (scaled by distance)
6. Draw player car sprite (fixed position, bottom-center, steering tilt)
7. Draw HUD (speed, time, radio station)
8. Draw effects (screen edge speed blur, heat haze shimmer)
```

---

## 4. Sprite Strategy: Procedural Generation (No External Assets)

### 4.1 The Question: "Do We Need Sprite Sheets?"

**Short answer: No. We generate everything procedurally on offscreen canvases at init time.**

**Why this approach:**

- **Zero asset dependencies** — the game is fully self-contained in code
- **Consistent with your Pong approach** — no audio files, no image files
- **Matches the original's aesthetic** — Out Run sprites are low-res pixel art (32–64px wide). Drawing them programmatically is completely feasible
- **Eliminates copyright concerns** — we're not borrowing Sega's sprites
- **Scales with DPR** — we can generate at whatever resolution the device needs

### 4.2 How Procedural Sprite Generation Works

At game init, we create offscreen canvases and draw pixel art onto them:

```typescript
function generatePlayerCar(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 80;
  canvas.height = 42;
  const ctx = canvas.getContext('2d')!;
  // Draw a red convertible, pixel by pixel or with fillRect blocks
  // Multiple frames: straight, slight-left, hard-left, slight-right, hard-right
  return canvas;
}
```

These are cached in a `Map<string, HTMLCanvasElement>` and drawn via `drawImage()` with scaling.

### 4.3 Sprite Inventory (MVP — One Level)

**Player car** (5 frames):
- Straight ahead
- Slight left steer
- Hard left steer  
- Slight right steer
- Hard right steer
- *(Style: red convertible with two occupants — homage to the Ferrari Testarossa)*

**Traffic cars** (3–4 types × 1 frame each):
- Sedan (blue)
- Truck (white)  
- Sports car (yellow)
- Van (green)

**Roadside objects** (8–12 types):
- Palm tree (2 variants)
- Rock/boulder
- Billboard/sign
- Cactus
- Bush
- Road sign (speed, curve warning)
- Light post
- Building silhouette

**Parallax background layers** (3 layers):
- Sky gradient (canvas gradient, not a sprite)
- Distant mountains/hills (wide repeating pattern)
- Near treeline/buildings (wide repeating pattern)

### 4.4 Is Procedural Sprite Generation Hard?

**Honestly: medium difficulty.** The sprites are small (32–80px wide), low-color-count pixel art. The technique is:

1. Define a pixel grid as a 2D array of color indices
2. Map indices to hex colors
3. Draw each pixel as a `fillRect(x, y, 1, 1)` on an offscreen canvas
4. Cache the result

The hardest sprite is the player car (needs 5 steering angles and enough detail to read as "a car"). Traffic cars and roadside objects are simpler — trees are basically green triangles on brown rectangles, at the scale we're working at.

**Alternative if procedural art proves too time-consuming:** We can generate basic geometric shapes first (rectangles, triangles) to prove out the renderer, then replace them with detailed pixel art in a polish pass. The rendering code doesn't care what's on the canvas — it just scales and draws it.

### 4.5 Sprite Scaling

Sprites are drawn at screen position with width/height calculated from their z-distance:

```typescript
const scale = cameraDepth / z;
const destW = sprite.width * scale * roadWidth;
const destH = sprite.height * scale * roadWidth;
ctx.drawImage(spriteCanvas, destX, destY, destW, destH);
```

Use `ctx.imageSmoothingEnabled = false` for crisp pixel art scaling.

---

## 5. Mobile Support

### 5.1 Control Scheme Options

Out Run has more inputs than Pong: steer left/right, accelerate, brake. This needs careful mobile UX.

**Recommended approach: Virtual button zones**

```
┌─────────────────────────────────────┐
│                                     │
│           Game Canvas               │
│                                     │
│                                     │
├────────┬───────────────┬────────────┤
│  STEER │               │  STEER     │
│  LEFT  │    BRAKE      │  RIGHT     │
│        │               │            │
├────────┤               ├────────────┤
│        │               │            │
│  LEFT  │  ACCELERATE   │  RIGHT     │
│        │               │            │
└────────┴───────────────┴────────────┘
```

Bottom-left/right zones: steer. Bottom-center split: top half brake, bottom half gas. Semi-transparent HUD overlay shows the zones.

**Alternative: Tilt steering** — `DeviceOrientationEvent` for steering, touch zones for gas/brake. More immersive but less precise. Could offer as an option.

### 5.2 Orientation

Force landscape via CSS `@media (orientation: portrait)` with a rotate-device overlay, similar to how Pong handles aspect ratio. Racing games fundamentally need horizontal space.

### 5.3 iOS Safari Considerations

Your Pong repo already solved the fullscreen workarounds for iOS Safari. Same patterns apply:
- `<meta name="viewport" content="...">` with `viewport-fit=cover`
- `<meta name="apple-mobile-web-app-capable" content="yes">`
- CSS `env(safe-area-inset-*)` for notch avoidance
- Touch event `preventDefault()` to block pull-to-refresh

### 5.4 Performance

Canvas pseudo-3D is CPU-bound (lots of `fillRect` and `drawImage` calls per frame). Mobile mitigation:
- Configurable draw distance (fewer segments on slower devices)
- Configurable resolution scaling (render at 0.5x then CSS upscale)
- Profile and optimize the segment loop — this is the hot path
- Consider `OffscreenCanvas` + worker for background rendering (stretch goal)

---

## 6. Audio (Web Audio Synthesis)

Following the Pong pattern — zero audio files, all synthesized.

### 6.1 Engine Sound

Continuous oscillator(s) whose frequency maps to player speed:
- Base frequency ~80Hz at idle
- Ramp to ~300Hz at max speed
- Layer 2–3 oscillators with slight detuning for richness
- Gain modulation on gear shifts (brief dip then climb)

### 6.2 Sound Effects

| Effect | Synthesis Approach |
|--------|-------------------|
| Gear shift | Quick frequency drop + climb, click transient |
| Skid/drift | Filtered noise burst, duration = slide time |
| Collision | Low thud (sine envelope) + noise crash |
| Off-road | Filtered noise rumble, continuous while off-road |
| Checkpoint | Ascending arpeggio (3 sine tones) |
| Time warning | Rapid beeping oscillator |

### 6.3 Music — The Radio

Out Run's most iconic feature: the radio with selectable tracks. We synthesize simple chiptune-style tracks using Web Audio:

- **Track 1: "Magical Sound Shower" homage** — upbeat, major key, arpeggiated synth
- **Track 2: "Passing Breeze" homage** — mellow, jazzy chord progression  
- **Track 3: "Splash Wave" homage** — driving, energetic bassline

Implementation: sequence of scheduled `OscillatorNode` + `GainNode` events, quantized to a BPM grid. Each track is a data array of `[frequency, duration, type]` tuples.

Radio selection happens on the title screen (just like the original).

---

## 7. Game Systems

### 7.1 State Machine

```
TITLE_SCREEN (radio select)
     │
     └─ player selects track
            │
            ▼
     COUNTDOWN (3-2-1-GO)
            │
            ▼
        PLAYING ←── Escape ──→ PAUSED
            │
            ├─ timer > 0: keep driving
            │
            ├─ reach checkpoint → extend timer
            │
            ├─ crash → CRASHED (brief pause, respawn)
            │
            └─ timer = 0 → GAME_OVER
                              │
                              ▼
                        TITLE_SCREEN
```

### 7.2 Player Physics

```typescript
// Per frame (all values × dt)
if (accelerating) speed += accel;
if (braking)      speed -= brakeDecel;
if (offRoad)      speed *= offRoadFriction;  // e.g., 0.96
speed *= roadFriction;                        // e.g., 0.99
speed = clamp(speed, 0, maxSpeed);

// Steering
if (steering) playerX += steerSpeed * (speed / maxSpeed);  // faster = more responsive
playerX += segment.curve * centrifugalForce * (speed / maxSpeed);  // curves push you

// Clamp to road bounds (or apply off-road penalty)
if (Math.abs(playerX) > 1.0) { /* off-road */ }
```

### 7.3 Traffic AI

NPC cars are simple:
- Each has a lane offset (-0.5, 0, 0.5) and a speed (fraction of player's max)
- They hold their lane and speed — no steering AI needed
- Player must weave around them
- On collision: player decelerates sharply, NPC nudges sideways
- Cars recycle: once far behind the camera, respawn ahead with new lane/speed

### 7.4 Timer and Checkpoints

- Start with ~75 seconds
- Road is divided into stages; crossing a stage boundary adds ~20 seconds
- Timer ticks down in real-time
- At 10 seconds remaining: audio warning, HUD flash
- At 0: game over sequence

### 7.5 Scoring

- Distance traveled
- Time remaining at each checkpoint (bonus points)
- Final score = distance + time bonus

---

## 8. Visual Polish and Game Feel

### 8.1 Parallax Scrolling

3 background layers scroll at different speeds relative to the player's horizontal position and curve offset:
- **Sky** — barely moves (0.05× player steer offset)
- **Mountains** — slow (0.2× offset)  
- **Near trees** — medium (0.5× offset)

Each layer wraps horizontally. Drawn as repeating `drawImage` strips above the road.

### 8.2 Road Color Variation

Alternate segment colors create the classic rumble strip effect:
- Even segments: dark gray road, red/white rumble
- Odd segments: slightly lighter gray, no rumble color
- Grass alternates between two greens

### 8.3 Speed Effects

- **FOV increase** — widen FOV slightly at high speed (subtle zoom-out)
- **Road segment density** — segments render closer together at speed (this happens naturally from the projection math)
- **Screen edge blur** — optional: darken/blur edges at max speed via canvas compositing
- **Heat haze** — subtle sine wave distortion on the horizon line (shift a few rows of pixels)

### 8.4 Crash Animation

On collision with traffic or roadside object:
- Player car sprite swaps to a "tumble" frame (or we rotate the sprite)
- Camera shakes (translate by random offset, decaying)
- Speed drops to zero over ~1 second
- Brief pause, then resume

---

## 9. Level Design (Single Level, MVP)

One continuous road, ~5 minutes of driving at moderate speed:

```
Segment Plan:
  1. Straight intro (gentle start, few objects)
  2. Gentle right curve through palm trees
  3. Long straight with billboards, light traffic
  4. S-curve through rock formations — CHECKPOINT 1
  5. Uphill climb with reduced visibility at crest
  6. Downhill straight, heavy traffic
  7. Sharp left curve — CHECKPOINT 2
  8. Winding section through dense trees
  9. Long high-speed straight, sparse obstacles
  10. Final S-curve to finish — CHECKPOINT 3
```

Theme: **Coastal highway** (the classic Out Run vibe — blue sky, palm trees, ocean implied by the color palette).

Color palette:
- Sky: `#72D2F4` → `#1E90FF` gradient
- Road: `#6B6B6B` / `#696969` alternating
- Rumble: `#CC0000` / `#FFFFFF` alternating
- Grass: `#10AA10` / `#009A00` alternating
- Lane markings: `#FFFFFF`
- Horizon line: soft gradient blend

---

## 10. Project Structure

```
outrun/
├── index.html              Single-page HTML shell
├── style.css               Styles (canvas, overlays, mobile zones, orientation lock)
├── package.json            Build scripts (esbuild + vitest)
├── tsconfig.json           TypeScript config (strict, ES2020, DOM)
├── src/
│   ├── types.ts            Shared types, interfaces, game phases
│   ├── constants.ts        All tuning values (speeds, distances, colors, timing)
│   ├── input.ts            InputManager — keyboard + touch + tilt
│   ├── audio.ts            AudioManager — engine, SFX, radio music synthesis
│   ├── sprites.ts          SpriteManager — procedural sprite generation + cache
│   ├── road.ts             Road — segment array, curves, hills, object placement
│   ├── player.ts           Player — steering, speed, gear, crash state
│   ├── traffic.ts          TrafficManager — NPC car pool, lane logic
│   ├── physics.ts          Pure functions: collision, friction, centrifugal force
│   ├── renderer.ts         Renderer — sky, road projection, sprites, HUD, effects
│   ├── game.ts             Game — state machine, RAF loop, timer, overlays
│   └── main.ts             Bootstrap, canvas sizing, resize, orientation
├── tests/
│   ├── physics.test.ts     Collision, speed, friction
│   ├── road.test.ts        Segment generation, curve/hill math
│   ├── traffic.test.ts     Spawning, lane logic, recycling
│   └── helpers.ts          Factory functions for test segments/cars
└── dist/
    └── script.js           Bundled output (esbuild, ES2020)
```

---

## 11. Build Phases

### Phase 1: Road Renderer (The Foundation)
**Goal:** Render a straight road that scrolls as the player moves forward.

- [ ] Project scaffold (package.json, tsconfig, esbuild, index.html)
- [ ] Canvas setup with DPR scaling and resize handling
- [ ] `types.ts` and `constants.ts`
- [ ] `Road` class: build straight segment array
- [ ] `Renderer`: sky gradient, road segment projection, rumble strips, lane markings
- [ ] `InputManager`: up arrow = accelerate
- [ ] Basic game loop with delta-time
- [ ] Player moves forward through segments

**Milestone: scrolling straight road at 60fps.**

### Phase 2: Curves and Hills
**Goal:** Road bends and undulates convincingly.

- [ ] `Road`: addCurve() and addHill() builders
- [ ] Renderer: accumulate curve offset, handle hill clipping with maxy
- [ ] Parallax background (3 layers, horizontal scroll with curve)
- [ ] Centrifugal force pushes player on curves
- [ ] Full steering input (left/right keys)

**Milestone: S-curves and hills feel like driving.**

### Phase 3: Sprites and Scenery
**Goal:** Trees, signs, and roadside objects populate the world.

- [ ] `SpriteManager`: procedural generation of palm trees, rocks, signs, bushes
- [ ] Road: place sprites along segments with offset
- [ ] Renderer: scale and draw sprites per segment (back-to-front painter's order)
- [ ] Sprite clipping (don't draw sprites behind hills)
- [ ] Player car sprite (5 steering frames, procedurally drawn)

**Milestone: world feels inhabited — palm trees, signs whipping past.**

### Phase 4: Traffic
**Goal:** NPC cars to dodge.

- [ ] `TrafficManager`: car pool, spawn ahead, recycle behind
- [ ] Procedural traffic car sprites (3–4 types)
- [ ] Renderer: draw traffic cars scaled by distance
- [ ] `PhysicsEngine`: player↔traffic AABB collision
- [ ] Collision response: speed penalty, camera shake, brief stun

**Milestone: weaving through traffic at speed.**

### Phase 5: Game Loop and Timer
**Goal:** Playable game with start, checkpoints, and game over.

- [ ] State machine (title → countdown → playing → game over)
- [ ] Timer with checkpoint extensions
- [ ] HUD: speedometer, timer, score
- [ ] Title screen with radio station select (visual only at first)
- [ ] Game over screen with score
- [ ] HTML overlays with glassmorphic CSS (matching Pong's aesthetic)

**Milestone: complete game loop — play, score, replay.**

### Phase 6: Audio
**Goal:** Engine sound, SFX, and radio music.

- [ ] `AudioManager`: engine oscillators mapped to speed
- [ ] Gear shift sound
- [ ] Collision, skid, off-road sounds
- [ ] Checkpoint chime, timer warning
- [ ] 1–3 synthesized chiptune radio tracks
- [ ] Radio selection on title screen

**Milestone: game has sonic identity.**

### Phase 7: Mobile
**Goal:** Fully playable on phones and tablets.

- [ ] Touch input zones (steer left/right, gas, brake)
- [ ] Semi-transparent HUD overlay for touch zones
- [ ] Landscape orientation lock + rotate-device prompt
- [ ] iOS Safari fullscreen workarounds
- [ ] Performance scaling (adjustable draw distance and resolution)
- [ ] Touch-friendly UI (larger buttons, no hover states)

**Milestone: playable on iPhone/Android in landscape.**

### Phase 8: Polish
**Goal:** Game feel, visual effects, tuning.

- [ ] Heat haze shimmer on horizon
- [ ] Speed-edge darkening/blur
- [ ] Crash animation (sprite rotation, camera shake)
- [ ] Paddle (car) breathing/idle animation
- [ ] Off-road rumble visual (screen shake)
- [ ] Particle dust when off-road
- [ ] Fine-tune all constants (speed curve, curve force, friction)
- [ ] Difficulty tuning (traffic density, timer generosity)
- [ ] GitHub Actions deployment (gh-pages)

**Milestone: polished, shippable game.**

---

## 12. Key Technical Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| Road renderer math is wrong → looks flat/broken | HIGH | Follow Jake Gordon's tutorial line-by-line for v1, refactor into TS modules after it works |
| Procedural sprites look bad at scale | MEDIUM | Start with geometric placeholders (colored rectangles), replace with pixel art iteratively. The renderer doesn't care what's on the canvas |
| Mobile performance kills 60fps | MEDIUM | Configurable draw distance + resolution. Profile early, optimize the segment loop. Offscreen canvas as escape hatch |
| Touch controls feel bad | MEDIUM | Prototype multiple schemes (zones, tilt, virtual joystick) early. User-test on real devices |
| Web Audio engine sound is annoying | LOW | Careful gain/frequency mapping. Provide volume control. Test extensively |
| Synthesized music sounds terrible | LOW | Keep it simple (monophonic chiptune). If it's bad, make it optional or cut it |

---

## 13. Questions — All Resolved

All design decisions have been locked in. See Section 16 for the final decision table.

---

## 14. Reference Materials

These are the essential resources for implementation:

- **Jake Gordon's JavaScript Racer** — [github.com/jakesgordon/javascript-racer](https://github.com/jakesgordon/javascript-racer) — The gold standard pseudo-3D road tutorial in JS. Four progressive versions (straight → curves → hills → final). Our primary technical reference.
- **Lou's Pseudo 3d Page** — [extentofthejam.com/pseudo](http://www.extentofthejam.com/pseudo/) — Deep technical breakdown of pseudo-3D road math, sprite scaling, curve equations. The theoretical foundation.
- **Pseudo-3d Racer by ssusnic** — [github.com/ssusnic/Pseudo-3d-Racer](https://github.com/ssusnic/Pseudo-3d-Racer) — Another complete OutRun-style tutorial with video walkthroughs.
- **Your Pong repo** — [github.com/gfreedman/pong](https://github.com/gfreedman/pong) — Architectural patterns, esbuild config, mobile support, Web Audio synthesis, game feel techniques.

---

## 15. Estimated Effort

| Phase | Complexity | Estimated Time (Claude Code sessions) |
|-------|-----------|--------------------------------------|
| Phase 1: Road renderer | High | 2–3 sessions |
| Phase 2: Curves + hills | High | 2 sessions |
| Phase 3: Sprites + scenery | Medium | 2 sessions |
| Phase 4: Traffic | Medium | 1–2 sessions |
| Phase 5: Game loop + HUD | Medium | 1–2 sessions |
| Phase 6: Audio | Medium | 2 sessions |
| Phase 7: Mobile | Medium | 1–2 sessions |
| Phase 8: Polish | Variable | 2–3 sessions |
| **Total** | | **~13–19 sessions** |

This is a bigger project than Pong — roughly 3–4× the code and complexity. But the architecture is proven, the math is documented, and the phased approach means you have a playable (if minimal) game after Phase 5 and can polish from there.

---

---

## 16. Final Decisions (Locked)

| Decision | Choice |
|----------|--------|
| **Repo name** | `outrun` |
| **Theme/setting** | Coastal highway — palm trees, blue sky, ocean palette |
| **Sprite art style** | 16-bit Genesis era (~64px wide, detailed pixel art) |
| **Mobile controls** | Virtual button zones (steer L/R, gas, brake) |
| **Build priority** | 1) Road feel + speed sensation → 2) Polish & game feel → 3) Mobile → 4) Audio/music |
| **Difficulty vibe** | Generous — Out Run wants you to enjoy the drive |
| **Deployment** | GitHub Pages via GitHub Actions |
| **External assets** | Zero — all sprites procedural, all audio synthesized |

### Adjusted Phase Order

Based on priority ranking, the build order shifts slightly:

1. **Phase 1–3** (Road renderer → Curves/Hills → Sprites) — *the core feel*
2. **Phase 4** (Traffic) — *the gameplay challenge*
3. **Phase 5** (Game loop + HUD) — *playable game*
4. **Phase 8** (Polish) — *game feel effects, tuning*
5. **Phase 7** (Mobile) — *touch controls, orientation, performance*
6. **Phase 6** (Audio) — *engine sound, SFX, radio music last*

This means we ship a great-feeling desktop game first, then add mobile and audio as layers on top.

---

*"I wanted people to enjoy driving. I didn't want the car to explode. I wanted them to feel the wind and the speed and the music." — Yu Suzuki, on designing Out Run*

Let's build it.
