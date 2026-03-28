# Tests — End-to-End Flow

## How to run

```bash
npm test          # watch mode — re-runs on every file save
npm run test:run  # single pass, exits with a pass/fail code
```

Tests run automatically before every commit via a Husky pre-commit hook.
**A failing test blocks the commit.** Fix the test, then commit.

---

## What framework is used

**[Vitest](https://vitest.dev/)** — a fast, Jest-compatible test runner built on Vite.
No browser required. Tests run in Node.js with TypeScript support out of the box.

Config: `vitest.config.ts` (nested under `tsconfig.json` in the VS Code explorer).

---

## What happens when you run `npm run test:run`

```
1.  Vitest discovers every *.test.ts file in the tests/ directory.
2.  Each file is TypeScript-compiled on the fly by Vite's transform pipeline.
3.  The tests import from src/ — the same source files the game uses.
4.  No browser, no canvas, no DOM.  Any canvas calls go through a lightweight
    spy object that records method calls instead of drawing pixels.
5.  Results are printed.  All 237 tests must pass or the exit code is non-zero.
```

---

## The seven test suites

### 1. `constants.test.ts` — Physics invariants and color band geometry
**What it guards:** Every value in `src/constants.ts` that the game physics
*depends on being true*.

If a designer tweaks a number in constants.ts and accidentally breaks a
relationship (e.g. makes grass deceleration weaker than the car's peak
acceleration — meaning you can floor it on grass), these tests catch it
before it ships.

Key contracts:
- `OFFROAD_DECEL > PLAYER_ACCEL_MID` — you cannot accelerate on grass
- `DRIFT_CATCH > DRIFT_DECAY` — counter-steering is mechanically rewarded
- `ROAD_CURVE.NONE < EASY < MEDIUM < HARD` — curve presets are strictly ordered
- Road marking fraction constants (`RUMBLE_INNER_FRAC`, `LANE_OUTER_FRAC`, etc.)
  are in valid range and correctly oriented

---

### 2. `physics.test.ts` — Player physics state machine
**What it guards:** The pure physics functions extracted from `game.ts` into
`src/physics.ts`.

Three groups:

**`advancePhysics`** — the per-frame tick: throttle, braking, coasting, steering
inertia (`steerVelocity` accumulator), trail-braking grip bonus, centrifugal drift,
off-road friction, grind deceleration, high-speed rumble, playerZ advance.
Also covers steering attenuation: pre-saturating `steerVelocity` to 100 then
running one frame verifies the authority clamp (`PLAYER_STEERING × max(0.70,
1 − speedRatio × 0.30)`) is lower at full speed than at low speed, and never
below `PLAYER_STEERING × STEER_AUTHORITY_MIN`.

**`applyCollisionResponse`** — what happens when you hit a static sprite:
- `Ghost` — no effect (shrubs, signs)
- `Glance` — small speed cut, brief shake (cactus scratch)
- `Smack` — hard speed cap, recovery boost, longer shake (palm, billboard)
- `Crunch` — worst speed cap, grind timer, longest shake (house, wall)

**`applyTrafficHitResponse`** — what happens when you hit a live traffic car:
- Speed-as-armour: high-speed player retains a larger *fraction* of speed
- Car mass: heavy car (massMult=2.0) penalises more than light (massMult=0.7)
- Lateral flick strictly decreases at high speed (flickScale only, no restitution)
- Boosting branch: no speed penalty, `slideVelocity` zeroed, short cooldown
- Immutability: input state is never mutated

Cross-cutting invariants: `playerX` is always clamped to `[-1, 1]`; speed never
falls below `HIT_SPEED_FLOOR`.

---

### 3. `collision.test.ts` — Roadside obstacle collision detection
**What it guards:** `src/collision.ts` — the system that decides whether the
player hit a roadside sprite and how hard.

Three groups:

**`getBlockingRadius`** — every sprite family returns the correct blocking radius
(solid families return `BLOCK_SMACK`/`BLOCK_HOUSE`; ghost families return 0).
Critical invariant: `blockRadius < hitboxRadius` for every solid family, so the
wall activates *inside* the hit zone.

**`checkSegmentCollision`** — per-segment hit detection:
- On-road immunity: no collision when `playerX < COLLISION_MIN_OFFSET`
- Same-side filtering: sprite on opposite side is ignored
- Ghost immunity: shrubs and signs never collide
- Correct collision class per family: Glance (cactus), Smack (palm, billboard),
  Crunch (house)
- `bumpDir` is +1 when sprite is to the right, −1 when left
- Near-miss band: returns `nearMiss` when just outside the hitbox radius
- Severity ranking: worst hit wins when multiple sprites overlap

**`checkCollisions`** — the `COLLISION_WINDOW = [-1, 0, 1, 2]` scan that checks
four segments around the player's current segment. Tests verify each offset fires,
and that offset +3 (outside the window) does NOT fire.

---

### 4. `traffic.test.ts` — Traffic car pool, movement, and collision
**What it guards:** `src/traffic.ts` — AI car spawning, per-frame movement, and
player/traffic collision detection.

Groups:

**Pool integrity** — `initTraffic` produces exactly `TRAFFIC_COUNT` cars, all
with valid speeds, worldZ within bounds, recognised `TrafficType` values, and
all required personality fields (`massMult`, `hitboxX`, `behavior`).

**Per-type profiles** — each `TrafficType` has the expected `TrafficBehavior`,
correct relative mass (Mega > GottaGo) and hitbox (Mega > Barney), speed ordering
(GottaGo fastest), and intensity-scaling (higher intensity → higher speed floor).

**Barney EVADER AI** — flees to the far outer lane when the player is within
`BARNEY_EVADE_SEGS` segments and `BARNEY_EVADE_RANGE` lateral units; does not
evade when out of depth range or out of lateral range.

**Mega ROAD_HOG AI** — lane choices are biased toward the centre (>50% over
200 random trials).

**Banana WANDERER AI** — `worldX` matches `targetX + BANANA_WOBBLE_AMP` at the
sine peak (verifies amplitude and keying to worldZ, not time).

**Update — Z advancement** — each car's `worldZ` advances by `speed × dt` per
frame. Test pins cars to known speed and position to verify exact arithmetic.

**Update — recycle horizon** — when a car falls too far behind the player it is
recycled. Tests verify recycled cars always spawn at `DRAW_DISTANCE ± 5` segments
ahead — never mid-road. This is the regression test for the original bug where
recycled cars could teleport to random positions.

**`checkTrafficCollision`** — depth window + per-car `hitboxX` lateral overlap:
- Returns `null` when no cars are in range
- Fires on a direct hit (same lane, within depth window)
- Does NOT fire for an adjacent lane (gap > 2 × `car.hitboxX`)
- `bumpDir` is correct (+1 = car to right, −1 = car to left)
- `closingSpeed` ≈ `playerSpeed − carSpeed`
- Returns `null` when the car is behind the player

**`TRAFFIC_CAR_SPECS`** — every `TrafficType` has a spec entry; all specs have
positive dimensions and a `.png` asset path; all `worldH` values are below
`CAMERA_HEIGHT` (a car taller than the camera would project above the horizon).

---

### 5. `road.test.ts` — Track construction and segment lookup
**What it guards:** `src/road.ts` — the class that builds and stores every segment
of the track.

The road is built *once* in `beforeAll` (expensive — ~600 segments), shared
across all tests.

Key contracts:
- Segment count is in the expected range (~900–1400 for the current layout)
- `findSegment(0)` returns index 0
- `findSegment(trackLength)` wraps seamlessly back to index 0
- All segment indices are sequential from 0
- `p1.world.z === index × SEGMENT_LENGTH` exactly
- `p2.world.z − p1.world.z === SEGMENT_LENGTH` exactly
- No segment curve exceeds `ROAD_CURVE.HARD`
- Hill Y values stay within ±500 world units (safe relative to `CAMERA_HEIGHT`)
- Every segment has non-empty color strings for road, grass, and rumble

---

### 6. `renderer.test.ts` — Batched polygon rendering passes
**What it guards:** The module-level rendering functions exported from
`src/renderer.ts`.

These tests protect the **batched polygon** strategy that eliminated hairline
seams between adjacent road segments. The key insight: instead of one
`beginPath/fill` per segment (which leaves 1px gaps between adjacent trapezoids
due to sub-pixel rounding), adjacent same-color segments are joined into a single
polygon path with one `fill`.

Tests use a **canvas recording spy** — a plain JavaScript object that implements
the canvas 2D API methods (beginPath, moveTo, lineTo, closePath, fill, fillRect)
but records every call to an array instead of drawing pixels. No browser needed.

**`buildColorRuns`** — the run-length encoder that groups consecutive same-color
segments. Tests verify: empty pool → `[]`; single segment → one run; alternating
colors → separate runs; correct `startIdx`/`endIdx` boundaries.

**`drawRoadSurface` (Pass B)** — one `beginPath/fill` for ALL visible segments.
The polygon traces the left edge down (far→near), pivots at near-right, then
traces the right edge back up (near→far). Point count formula: `1 moveTo +
2N+1 lineTos + 1 closePath` for N segments.

**`drawRumble` (Passes C+D)** — one `fill` per contiguous same-color run,
2 `closePaths` per run (left side + right side). Tests verify fill count and
closePath count for various color sequences.

**`drawLaneDashes` (Pass E)** — one `fill` per lane-on run; lane-off runs produce
zero draw calls. Tests verify 0 fills for all-off pools, correct fill count for
mixed pools.

**`drawEdgeMarks` (Pass F)** — 4 stripes per run (left-outer, left-inner,
right-outer, right-inner) all batched into 1 `fill` with exactly 4 `closePaths`.

**`addTrap` winding** — every trapezoid must wind **clockwise** on screen (Y-axis
points down). Tests verify the exact `moveTo`/`lineTo` sequence for uphill
(`y1 > y2`), downhill (`y1 < y2`), and flat (`y1 === y2`) segments.

---

### 7. `snapshot.test.ts` — Color palette and draw-call sequence locks
**What it guards:** `src/constants.ts` (color palette) and the color-dispatch
logic in the drawing functions.

These tests use `toMatchInlineSnapshot()` — the expected value is written
**directly in the test file**. If you change a hex value in `constants.ts`, the
snapshot fails with a diff showing the old and new value. You must explicitly
run `npx vitest --update-snapshot` to accept the change, then commit both the
source change and the updated snapshot.

**COLORS palette** — every hex string in `COLORS` is locked. An accidental
`#10AA10` → `#10ab10` typo fails here rather than shipping wrong grass color.

**drawRumble color sequence** — the exact sequence of `fillStyle` values at each
`fill()` call is locked. Guards the color-dispatch logic that decides whether a
segment gets red or white rumble.

**drawLaneDashes color sequence** — same idea for lane dash color dispatch.

**drawGrass fillRect sequence** — per-segment grass color dispatch is locked.
Uses realistic below-horizon geometry (`sy1=400` / `sy2=280`) because the guard
`gBot <= gTop` skips segments above the horizon.

**`ProjectedSeg.sc2` field** — regression guard for the traffic car vibration
fix. `sc2` (far-edge perspective scale) was added to `ProjectedSeg` so Pass 4
can interpolate within a segment instead of snapping to the segment boundary.
If `sc2` is accidentally removed from the interface, this test breaks.

---

## How the canvas spy works

Every test file that exercises rendering functions creates a fake canvas context:

```typescript
const ctx = {
  get fillStyle()          { return currentStyle; },
  set fillStyle(v: string) { currentStyle = v; },
  beginPath()              { log.push({ method: 'beginPath', ... }); },
  moveTo(x, y)             { log.push({ method: 'moveTo', args: [x, y] }); },
  // ...etc
} as unknown as CanvasRenderingContext2D;
```

The functions under test call `ctx.fillStyle = '#CC0000'` and `ctx.fill()` as
normal. The spy records those calls. Tests then assert on the log:

```typescript
const fills = log.filter(c => c.method === 'fill').map(c => c.fillStyle);
expect(fills).toEqual(['#CC0000', '#FFFFFF']);
```

This approach tests the *behavior* (what colors were applied, in what order,
how many times) without requiring a real browser or pixel comparison.

---

## Pre-commit hook

`.husky/pre-commit` runs `npm run test:run` automatically before every
`git commit`. If any test fails, the commit is blocked.

To bypass in an emergency (not recommended):
```bash
git commit --no-verify -m "message"
```

To update snapshot values after an intentional color change:
```bash
npx vitest --update-snapshot
git add tests/snapshot.test.ts
git commit -m "update: intentional color change ..."
```
