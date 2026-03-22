# OutRun Feature Plan — Claude Code Implementation Guide

## Overview

This document specifies all new features to be added to the OutRun TypeScript browser game. It is written as a precise implementation guide for Claude Code and should be followed phase by phase, with each phase buildable and testable independently.

---

## Architecture Changes Required First

Before implementing any feature, expand `GamePhase` in `src/types.ts`:

```ts
export enum GamePhase {
  PRELOADING,   // Asset loading with progress bar
  INTRO,        // Title/menu screen
  COUNTDOWN,    // 3-2-1-GO sequence
  PLAYING,      // Existing race state
  FINISHED,     // Race complete / finish line crossed
  GAME_OVER,    // Time expired or player quit
}
```

Add a `GameMode` enum and `GameSettings` interface to `src/types.ts`:

```ts
export enum GameMode {
  EASY   = 'easy',
  MEDIUM = 'medium',
  HARD   = 'hard',
}

export interface GameSettings {
  mode: GameMode;
  soundEnabled: boolean;
}
```

Add to `src/constants.ts` a `RACE_CONFIG` block per difficulty (see Phase 4 below).

---

## Phase 1 — Preloader

### Goal
Before any game screen appears, load all image assets. Show a progress bar. If any asset fails, show a clear error message.

### Implementation

1. **Create `src/preloader.ts`**

   - Collect every image URL the game needs: the sprite sheets used in `src/sprites.ts`, any background images, and the start/finish gate sprite (new).
   - Use `Promise.all` over an array of `new Image()` loads, tracking `loaded / total` for progress.
   - Return a typed result: `{ ok: true, images: Map<string, HTMLImageElement> }` or `{ ok: false, error: string }`.

2. **Preloader UI (drawn on the game canvas, not DOM)**

   - Black background.
   - Centered white text: `LOADING…` in a retro pixel font (use the same font as the HUD).
   - A horizontal progress bar (e.g., 600 px wide, 20 px tall, centered). Fill color: `#FF6600` (OutRun orange). Border: `#FFFFFF`.
   - On failure: replace bar with red text: `FAILED TO LOAD ASSETS` followed by the specific asset filename that failed.

3. **Wiring**

   - `src/main.ts` must start in `GamePhase.PRELOADING`. Once the preloader resolves successfully, transition to `GamePhase.INTRO`. On failure, stay on the error screen permanently.

---

## Phase 2 — Intro / Menu Screen

### Goal
A styled title screen inspired by the 1986 Sega OutRun cabinet, with three selectable options: **GAME MODE**, **SETTINGS**, and **START**.

### Visual Design

- **Background**: Render a static version of the road (first few segments) to give a sense of depth, or use a solid gradient sky + road strip — keep it lightweight.
- **Title**: `OUT RUN` in large blocky letters, orange/yellow gradient, slight drop shadow. Position: upper-center.
- **Subtitle**: `PRESS START` pulsing (alternating visible/hidden every 500 ms) — shown only when no sub-menu is open.
- **Menu items** (centered, vertically stacked):
  - `GAME MODE`
  - `SETTINGS`
  - `START`
- Keyboard navigation: Up/Down arrows to highlight. Enter or Space to select. The selected item is shown in yellow; others in white.

### Game Mode Sub-menu

Activating **GAME MODE** opens an inline panel showing three options with a `>` cursor:

```
> EASY
  MEDIUM
  HARD
```

Each option shows a short descriptor line beneath it when highlighted:

- **EASY**: `Few cars · Gentle curves · Relaxed pace`
- **MEDIUM**: `Classic OutRun experience`
- **HARD**: `Many cars · Tight turns · Full hills · Max speed`

Press Enter to confirm. Press Escape to return to main menu.

### Settings Sub-menu

Activating **SETTINGS** shows:

```
SOUND       [ON ] / [OFF]
─────────────────────────
ABOUT THIS GAME
  Built in TypeScript + HTML5 Canvas.
  No game engines. Pure pseudo-3D.
  github.com/gfreedman/outrun
```

Toggle sound with Enter/Space when `SOUND` is highlighted. The link text is display-only (not clickable in-game — users can visit the repo in a browser).

### Starting the Game

Selecting **START** transitions to `GamePhase.COUNTDOWN` using the current `GameMode` selection (defaulting to `MEDIUM` on first launch).

---

## Phase 3 — Countdown Sequence

### Goal
Replicate the OutRun pre-race countdown: a large animated number sequence (3 → 2 → 1 → GO!) with a start gate visible ahead on the road.

### Countdown Timer

- Duration: 1 second per number. `GO!` shown for 0.7 seconds, then transition to `GamePhase.PLAYING`.
- Display: Centered on screen, large font (≥ 100px), white with a black outline.
- Accompanying sound: three short beep tones (220 Hz, 330 Hz, 440 Hz) for 3, 2, 1; a longer "GO!" sound at a higher pitch (880 Hz). All generated via Web Audio API if no audio files are available.

### Start Gate Asset

- **Appearance**: A red-and-white striped gantry spanning the full road width, with a soccer-net-style mesh hanging below and a `START` banner. This mimics the iconic OutRun starting gate.
- **Implementation**: Create `sprites/start_gate.png`. This is a new sprite. If no artist is available, draw it procedurally on canvas (red/white alternating vertical stripes on two tall posts, horizontal beam across the top, diagonal hatching for the net).
- **Placement**: Place the start gate sprite on a road segment roughly 8–12 segments ahead of the player's starting position (close enough to be clearly visible, far enough to give the countdown room to animate).
- **Family**: Add `'gate_start'` and `'gate_finish'` to the `SpriteFamily` union type.
- **Behavior**: The gate exists as a non-collidable sprite (CollisionClass.Ghost). The player drives through it at GO!.

---

## Phase 4 — Game Modes & Difficulty

### Constants per Difficulty

Add a `RACE_CONFIG` lookup to `src/constants.ts`:

```ts
export const RACE_CONFIG = {
  [GameMode.EASY]: {
    maxSpeed:        7200,   // ~195 km/h
    trafficCount:    1,
    raceLengthKm:    4,      // ~2 min at moderate pace
    curveIntensity:  'mild', // Only ROAD_CURVE.EASY segments
    hillIntensity:   'mild', // Only ROAD_HILL.LOW segments
    accelMultiplier: 0.75,
  },
  [GameMode.MEDIUM]: {
    maxSpeed:        10800,  // 293 km/h — current default
    trafficCount:    3,
    raceLengthKm:    6,      // ~2.5 min at race pace
    curveIntensity:  'mixed',
    hillIntensity:   'mixed',
    accelMultiplier: 1.0,
  },
  [GameMode.HARD]: {
    maxSpeed:        13200,  // ~360 km/h
    trafficCount:    8,
    raceLengthKm:    10,     // ~2.5–3 min at hard pace
    curveIntensity:  'hard', // Full ROAD_CURVE.HARD + MEDIUM mix
    hillIntensity:   'hard', // Full ROAD_HILL.HIGH + MEDIUM mix
    accelMultiplier: 1.25,
  },
};
```

### Road Generation by Difficulty

In `src/road.ts`, modify the road generation function to accept a `GameMode` parameter.

- **EASY**: Fewer curve segments. Maximum curve magnitude capped at `ROAD_CURVE.EASY`. Hills capped at `ROAD_HILL.LOW`. Longer straight sections between turns.
- **MEDIUM**: Existing `ROAD_DATA` logic unchanged.
- **HARD**: Increase total segment count to cover 10 km. Use `ROAD_CURVE.HARD` freely. Introduce `ROAD_HILL.HIGH` on back-to-back segments. Add unexpected reversals (curve direction switching within 3–5 segments). Increase traffic spawn density using `trafficCount: 8`.

### Race Length

Race distance is defined per mode in `RACE_CONFIG.raceLengthKm`. Convert to world units:

```
raceLength_wu = raceLengthKm × 1000 × (SEGMENT_LENGTH / metersPerSegment)
```

Where `metersPerSegment` is calibrated from the speed constant (1 world unit ≈ 0.0075 m based on `PLAYER_MAX_SPEED` = 10,800 wu/s ≈ 81.4 m/s).

The road must be long enough to contain the full race distance. Add a finish gate segment at exactly the race-length position.

**Proposed race distances:**
| Mode   | Distance | Target duration |
|--------|----------|-----------------|
| Easy   | 4 km     | ~1:45 – 2:15   |
| Medium | 6 km     | ~2:00 – 2:45   |
| Hard   | 10 km    | ~2:30 – 3:15   |

---

## Phase 5 — HUD During Race

### Add to the existing HUD renderer in `src/renderer.ts`:

1. **Timer** — Top-right or top-center. Format: `1:23.4`. Counts up from 0:00.0. Color: white. Font: monospace/retro. Background: semi-transparent black pill.

2. **Distance** — Directly below timer. Shows `X.XX km` covered, updating each frame. Or alternatively show distance remaining: `X.XX km to go`.

3. **Speed** — Already present; keep as-is (or verify it's rendering correctly).

All three HUD elements must be readable at 1280×720 and gracefully scale on smaller canvases.

---

## Phase 6 — Finish Gate & Race End

### Finish Gate

- Identical visually to the start gate but with a `FINISH` banner and checkered flag coloring (black and white squares).
- Placed at the road segment corresponding to the race length distance.
- When the player's `playerZ` position crosses the finish gate segment index, trigger `GamePhase.FINISHED`.

### Finish Sequence

1. Player car slows automatically (engine cuts, coasting deceleration applies).
2. Display a full-screen overlay (semi-transparent dark):
   ```
   ╔══════════════════════╗
   ║     RACE COMPLETE    ║
   ║   Time:  2:14.7      ║
   ║   Distance:  6.0 km  ║
   ╚══════════════════════╝
   [PLAY AGAIN]  [MENU]
   ```
3. Keyboard: Enter = Play Again (same mode), Escape = return to `GamePhase.INTRO`.

### Game Over (Time Limit / Alt Ending)

- If the player has not reached the finish after `raceLengthKm × 1.4` km of travel (i.e., they went very slowly the whole time), show a `GAME OVER` screen with the same structure as the finish screen but without a congratulatory message.

---

## Phase 7 — Sound System

### Architecture

Create `src/audio.ts` with an `AudioManager` class wrapping the Web Audio API. Use `AudioContext` and `GainNode` for volume control. All sounds respect `GameSettings.soundEnabled`.

The audio manager must be initialized on the first user interaction (click or keypress) to satisfy browser autoplay policies.

### Sound Assets

For each sound, first check if a file exists in `sounds/`. If not, synthesize procedurally using Web Audio API oscillators and buffers. Mark each sound with its preferred synthesis fallback:

| Sound | File (if exists) | Synthesis fallback |
|-------|------------------|--------------------|
| Engine idle/low | `sounds/engine_low.mp3` | Sawtooth 80–120 Hz, slight vibrato |
| Engine mid | `sounds/engine_mid.mp3` | Sawtooth 150–220 Hz |
| Engine high | `sounds/engine_high.mp3` | Sawtooth 280–400 Hz |
| Brakes | `sounds/brake.mp3` | White noise burst, fading |
| Tire screech | `sounds/screech.mp3` | Filtered white noise, 0.6–1.2s |
| Car collision | `sounds/crash_car.mp3` | Low thud + crunch envelope |
| Object collision | `sounds/crash_object.mp3` | Higher thud |
| Rumble strip / off-road | `sounds/rumble.mp3` | Periodic low buzz |
| Countdown beep | — | Sine tone (220/330/440/880 Hz) |
| Barney hit | `sounds/barney.mp3` | **Must use audio file** — Barney voice: "Oh no! Not Barney!" |

### Engine Sound Logic

In `src/game.ts` (game loop), call `audioManager.updateEngine(playerSpeed, maxSpeed)` each frame.

- Map `playerSpeed / maxSpeed` (0–1) to three bands:
  - 0.00–0.30 → play `engine_low` loop, pitch-shift with speed ratio
  - 0.30–0.70 → crossfade into `engine_mid` loop
  - 0.70–1.00 → crossfade into `engine_high` loop
- Use `AudioBufferSourceNode.playbackRate` for pitch shifting within each band.

### Trigger Points

| Event | Where in code | Sound |
|-------|--------------|-------|
| Player speed increases | `game.ts` — throttle phase | Engine loop (continuous) |
| Braking input held | `game.ts` — brake phase | `brake` one-shot |
| Drift oversteer onset (`isDrifting`) | `game.ts` | `screech` loop while drifting |
| Collision `Smack` or `Crunch` with traffic | `game.ts` collision handler | `crash_car` |
| Collision with cactus/palm/billboard/house | `game.ts` collision handler | `crash_object` |
| Player goes off-road | `game.ts` — off-road branch | `rumble` loop |
| Player hits Barney car specifically | `game.ts` — Barney collision path | `barney` one-shot |
| Countdown 3, 2, 1, GO | `game.ts` — countdown phase | Beep tones |

### Barney Collision Detection

In `src/game.ts`, the existing collision handler checks all traffic cars. Add a check: if the colliding traffic car's `spriteFamily === 'barney'`, call `audioManager.playBarney()`. This plays the "Oh no! Not Barney!" audio clip and applies `CollisionClass.Smack` physics as normal.

---

## Phase 8 — Integration & Polish

1. **Keyboard input in menus**: Ensure `src/input.ts` exposes menu navigation keys (Up, Down, Enter, Escape) in addition to the existing driving keys. Consider a `consumeKey(key)` API to prevent menu inputs bleeding into driving.

2. **State machine guard**: In `src/game.ts`, gate all physics updates behind `phase === GamePhase.PLAYING`. During `COUNTDOWN`, freeze the player (speed = 0, input ignored) but allow the road renderer to show the scene.

3. **Canvas resolution**: Menu and HUD elements are drawn at the logical canvas resolution (capped at 1280×720 in `main.ts`). All positions should be expressed as fractions of `canvas.width / canvas.height` so they scale correctly.

4. **Performance**: The preloader caches all `HTMLImageElement` objects. Pass the cache into `SpriteLoader` in `src/sprites.ts` so images are not re-fetched.

5. **Persistence** (optional / nice-to-have): Use `localStorage` to remember `GameSettings.soundEnabled` and the last selected `GameMode` between sessions.

---

## File Change Summary

| File | Change |
|------|--------|
| `src/types.ts` | Add `GamePhase` states, `GameMode` enum, `GameSettings` interface, `SpriteFamily` entries |
| `src/constants.ts` | Add `RACE_CONFIG` per difficulty |
| `src/preloader.ts` | **New** — asset loader with progress tracking |
| `src/audio.ts` | **New** — `AudioManager` class, all sound logic |
| `src/road.ts` | Accept `GameMode`, generate difficulty-specific road, place finish gate |
| `src/game.ts` | State machine expansion, countdown logic, finish detection, Barney detection, audio triggers |
| `src/renderer.ts` | Preloader UI, intro screen, countdown overlay, HUD (timer + distance), finish overlay |
| `src/input.ts` | Menu navigation keys, `consumeKey` API |
| `src/sprites.ts` | Register `gate_start` and `gate_finish` sprite families |
| `src/main.ts` | Start in `PRELOADING`, pass settings through |
| `sprites/start_gate.png` | **New** — start gate artwork (or procedural fallback) |
| `sprites/finish_gate.png` | **New** — finish gate artwork (or procedural fallback) |
| `sounds/barney.mp3` | **New** — Barney voice clip |
| `sounds/*.mp3` | **New** — engine, brake, screech, crash, rumble sounds |

---

## Implementation Order for Claude Code

Execute phases in this order to maintain a working build at each step:

1. **Phase 1** — Preloader (no gameplay changes, safe first step)
2. **Phase 2** — Intro/Menu screen (GamePhase expansion, no road changes)
3. **Phase 3** — Countdown sequence (requires start gate sprite)
4. **Phase 4** — Game modes & difficulty (road generation changes)
5. **Phase 5** — HUD additions (timer and distance)
6. **Phase 6** — Finish gate & race end flow
7. **Phase 7** — Sound system (AudioManager + all triggers)
8. **Phase 8** — Integration, polish, localStorage persistence

After each phase: run `npm run build` and verify in browser before proceeding.

---

## Notes & Decisions for Claude Code

- **No external libraries**: Keep the zero-dependency philosophy. Use Web Audio API natively for sound. No game engine, no audio library.
- **Barney voice clip**: This is the one sound that cannot be synthesized. Obtain or create a short audio clip of a Barney-like voice saying "Oh no! Not Barney!" (≤ 2 seconds). Place it at `sounds/barney.mp3`. The preloader must include this file.
- **Gate sprites**: If no PNG assets are provided, implement `drawStartGate(ctx, x, y, width, height)` and `drawFinishGate(ctx, ...)` as canvas drawing functions directly in `renderer.ts`. This avoids blocking on asset creation.
- **Sound synthesis priority**: All engine/brake/screech/crash sounds should be synthesized first (no file dependency). Add file-based sounds only as an enhancement.
- **Test on mobile/touch**: The menu should also support touch input (tap to select, swipe to navigate) if the existing game has any touch support.
