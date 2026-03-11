# Outrun

A browser-based pseudo-3D racing game inspired by the 1986 Sega arcade classic.
Built from scratch in TypeScript with an HTML5 Canvas renderer — no game engine, no frameworks.

**[Play it live →](https://gfreedman.github.io/outrun/)**

---

## How to Play

| Key | Action |
|-----|--------|
| `↑` Arrow Up | Accelerate |
| `↓` Arrow Down | Brake |
| `←` Arrow Left | Steer left |
| `→` Arrow Right | Steer right |

Drive fast. Fight the centrifugal force on corners. Stay on the road.

---

## Features

- **Pseudo-3D perspective renderer** — each road segment is projected through a virtual camera and drawn as a trapezoid, no 3D engine required
- **Curved roads and rolling hills** — smooth eased transitions between straights, gentle bends, S-curves, and blind crests
- **Centrifugal force** — curves push the car outward; harder corners at higher speed require active counter-steering
- **Grip/understeer model** — steering authority tapers at speed, so 290 km/h cornering demands real commitment
- **Off-road friction** — grass drags the car down; speed recovers gradually after returning to asphalt
- **Ferrari Testarossa Spider** — 37-frame sprite animation with per-frame pivot correction
- **Roadside palm trees** — perspective-scaled sprites that follow the road's curve
- **Retro HUD** — digital speed readout and three-row LED tachometer

---

## Technical Overview

```
src/
  constants.ts   — Every tuning value in one place (speed, physics, colours, geometry)
  types.ts       — Shared TypeScript interfaces (RoadSegment, ProjectedPoint, etc.)
  road.ts        — Road builder: eased curve/hill sections, palm tree placement
  renderer.ts    — Two-pass canvas renderer: project front-to-back, draw back-to-front
  game.ts        — Game loop, three-phase throttle physics, steering, centrifugal force
  input.ts       — Keyboard state tracker (Set-based, handles simultaneous keys)
  sprites.ts     — Sprite sheet metadata and SpriteLoader helper
  main.ts        — Entry point: canvas resize, game start
```

### Rendering technique

The road is an array of flat segments. Each frame, every visible segment is projected through a perspective formula:

```
scale   = CAMERA_DEPTH / (worldZ - playerZ)
screenX = halfW + worldX * scale * halfW
screenY = halfH + CAMERA_HEIGHT * scale * halfH
```

Curves are rendered using two accumulators (`dx`, `curveX`) that produce a quadratic horizontal offset — the same technique used in the original arcade hardware.

Hill occlusion uses a two-pass approach: project front-to-back tracking a `maxy` ceiling (skipping segments hidden behind hill crests), then render back-to-front for correct painter's-algorithm ordering.

---

## Local Development

```bash
npm install
npm run dev        # esbuild watch mode → dist/script.js
npx serve .        # static file server at http://localhost:3000
```

```bash
npm run build      # minified production build
```

Requires Node 18+. No other dependencies beyond esbuild and TypeScript.

---

## Credits

- Rendering technique based on Jake Gordon's [JavaScript Racer](https://codeincomplete.com/articles/javascript-racer/) articles
- Colour palette and road geometry reference: [Lou's Pseudo 3D Page](http://www.extentofthejam.com/pseudo/)
- Original game: OutRun © 1986 Sega
