# Outrun

A browser-based pseudo-3D racing game modelled on the 1986 Sega arcade original.
No game engine. No 3D library. Just TypeScript, an HTML5 Canvas, and a lot of math.

**[Play it →](https://gfreedman.github.io/outrun/)**

---

## Controls

| Key | Action |
|-----|--------|
| `↑` | Accelerate |
| `↓` | Brake |
| `←` `→` | Steer |

Drive fast. Fight the centrifugal force on corners. Don't run out of time.

---

## Run it locally

```bash
npm install
npm run dev        # esbuild watch mode
npx serve .        # static server at localhost:3000
```

```bash
npm run build      # minified production build
npm test           # unit tests (Vitest)
```

Node 18+. No runtime dependencies.

---

## How the road works

There's no 3D engine here. The road is an array of flat segments. Each frame, every
visible segment gets projected to screen space through a perspective formula and drawn
as a filled trapezoid:

```
CAMERA_DEPTH = 1 / tan(FOV / 2)    // ≈ 0.839 at the 100° arcade field of view

scale   = CAMERA_DEPTH / relativeZ
screenX = halfW − worldX × scale × halfW
screenY = halfH + CAMERA_HEIGHT × scale × halfH
```

`CAMERA_DEPTH` is just the pinhole camera model. The 100° horizontal field of view is
deliberately wider than a typical game camera — it's what produces the dramatic perspective
crush that makes the road feel fast.

### Two passes, not one

The naive approach — draw each trapezoid from far to near — can't handle hills.
You can't skip segments hidden behind a hill crest until you know where the crest is,
and you don't know that until you've projected the geometry.

The fix is two passes:

**Pass 1 (near → far):** project every segment and track a `maxy` ceiling that starts
at the horizon. Any segment whose near edge rises above `maxy` is behind a hill — mark
it skipped, tighten the ceiling. `maxy` only ever moves toward the top of the screen.

**Pass 2 (far → near):** draw only the segments that survived pass 1. Painter's algorithm
works cleanly here because the hidden geometry is already gone.

The result: blind crests work. The road disappears behind the hill, then reappears as the
car clears the top.

### How curves are drawn

The curve effect is a quadratic horizontal shift that grows with distance. Two accumulators
produce it:

```
dx     = -baseSegment.curve × basePercent   // sub-segment correction
curveX = 0

for each segment outward:
    screenX  += curveX × scale × halfW      // offset grows with distance
    curveX   += dx
    dx       += segment.curve               // dx grows each step → quadratic result
```

This is the same technique the original arcade hardware used via raster scroll registers —
each scanline shifted by a different amount. The software version is a direct translation
of that trick.

Roadside sprites are anchored to road centre (`sx1`) and offset by their world-X position,
so they follow the curve automatically with no extra projection logic.

---

## How the car drives

The physics model isn't a simulation. It's tuned to feel like OutRun, which means it
has to be fast and readable on a keyboard at 290 km/h.

### Throttle

Acceleration runs through three bands:

| Band | Speed range | Behaviour |
|------|-------------|-----------|
| Launch | 0–15% | Smoothstep ramp from a lower value up to peak — the car takes a breath before delivering full power |
| Power band | 15–80% | Flat peak acceleration |
| Taper | 80–100% | Linear falloff to zero at max speed — drag and power falloff in one pass |

The launch band exists because a flat linear curve makes the car feel identical at 30 km/h
and 250 km/h. The three-phase curve gives it a distinctive feel at each stage of the speed range.

### Steering inertia

Steering works through a velocity accumulator, not a position input:

```
steerVelocity ramps toward steerAuthority when a direction is held  (~100 ms to full)
steerVelocity decays exponentially when the key is released           (~150 ms to zero)

playerX += steerVelocity × effectiveGrip × dt
```

The car carries momentum through a corner. Releasing the key doesn't snap it straight —
it drifts and settles. At high speed, `steerAuthority` drops to 70% of its maximum, so
a hard corner at 290 km/h needs a wider, earlier input than one at 150.

### Grip

```
gripFactor = 1 − speedRatio² × 0.35
```

At 50% speed: 91% grip. At 100% speed: 65%.

The curve is quadratic, not linear. That choice keeps the car planted through the middle of
the speed range and only introduces float as you push toward the top end. You're not wrestling
with the car at 150 km/h — you start wrestling at 240.

Trail-braking (holding brake and steer together) gives a 25% grip bonus. Most players
won't find it by accident.

### Centrifugal force

```
playerX −= segmentCurve × speedRatio × CENTRIFUGAL × dt
```

The constant `CENTRIFUGAL = 0.22` was tuned so that hard corners at full speed are
challenging but don't require lifting. Too high and hard corners become walls. Too low
and the game feels flat. At 0.22 the car fights you without stopping you, which is where
the tension lives.

When centrifugal force exceeds 65% of available grip, `slideVelocity` starts accumulating —
the rear steps out. Do nothing and it grows. Apply opposite lock (counter-steer) and a
faster decay constant takes over. Catching a slide before it compounds is one of the most
satisfying moments in the game.

### Off-road

Grass applies a drag rate higher than peak acceleration — the car will always slow down,
you cannot power out of it. Vertical jitter starts immediately so the danger registers
before the speed loss does.

Returning to the road lifts the speed cap over 600 ms. The penalty is the decel event
itself, not a lingering tax. A player who brushes the verge and recovers quickly should
feel like they got away with it.

---

## Traffic

Six car types, each a distinct challenge:

| Car | Personality | What to expect |
|-----|-------------|----------------|
| Car | Standard | Mid-speed, random weave, fills the road |
| Barney | Evader | Flees to the outer lane opposite your approach when you close in |
| GottaGo | Speedster | Fastest car on the road; changes lanes on short notice |
| Yoshi | EdgeHugger | 80% outer-lane preference — predictable, easy to route around |
| Banana | Wanderer | Sine-wave wobble keyed to world position — never quite where you expect |
| Mega | RoadHog | Slow, heavy, centre-biased; on Hard difficulty it barely moves |

All cars live in a fixed pool and are recycled in-place when they fall behind the player.
Zero allocation at runtime.

### Speed-as-armour

Most arcade racers apply a flat speed penalty on collision. That rewards slowing down near
traffic, which works against the whole point of an OutRun game.

The model here inverts that:

```
playerMass  = 0.5 + speedRatio        // 0.5 at rest → 1.5 at full speed
penaltyFrac = BASE_CAP × carMassMult / playerMass
newSpeed    = oldSpeed × (1 − penaltyFrac)
```

Going fast makes you heavier. A heavier player loses a smaller fraction of speed. Threading
a gap at 290 km/h is safer than creeping through at 150. Hitting a Mega (massMult = 2.0) is
twice as costly as grazing a GottaGo (massMult = 0.7) — the light cars fly sideways, the
heavy one absorbs your speed.

---

## Code layout

```
constants.ts    — every tuning value; start here when the feel is wrong
types.ts        — shared interfaces and enums; no logic
road.ts         — track builder (addStraight / addCurve / addHill / addSCurves)
road-data.ts    — pre-generated segment array; build artifact, do not edit by hand
renderer.ts     — five-pass canvas renderer; owns projPool
physics.ts      — pure physics functions; no DOM, no audio; fully unit-tested
collision.ts    — roadside obstacle hit detection
traffic.ts      — car pool, AI update loop, player/traffic collision
audio.ts        — Web Audio engine; procedural synthesis, no audio files
game.ts         — owns everything; the only file with side effects
```

`physics.ts` is the part of the architecture worth explaining. Every physics function is
pure: `advancePhysics(state, input, dt, cfg) → { state, screechRatio }`. No mutation,
no globals. `game.ts` captures a state snapshot, passes it through, and writes the result
back. The consequence: the entire physics model — throttle, steering, grip, centrifugal,
drift, off-road, all collision paths — runs in unit tests against known inputs. A physics
regression shows up as a test failure before anyone has to play-test it.

`road-data.ts` is generated at build time by `scripts/generate-road.ts`. Placing ~3000
sprites on the track takes up to 200 ms — doing it at `npm run build` instead of at
page load eliminates a synchronous stutter on startup. The file is checked in so `git diff`
shows exactly what changed when the course layout is modified.

All frame-rate-dependent decay in `physics.ts` uses `Math.exp(-k × dt)` rather than
`1 − k × dt`. The exponential form is stable at variable frame rates; the approximation
compounds errors when `dt` spikes.

---

## Credits

- Rendering technique: Jake Gordon's [JavaScript Racer](https://codeincomplete.com/articles/javascript-racer/)
- Road geometry and colour palette: [Lou's Pseudo 3D Page](http://www.extentofthejam.com/pseudo/)
- Original game: OutRun © 1986 Sega
