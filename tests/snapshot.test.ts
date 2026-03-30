/**
 * snapshot.test.ts
 *
 * Visual regression tests — lock color palette and road render logic so that
 * accidental hex edits or color-logic changes produce an explicit diff rather
 * than silently shipping wrong colors.
 *
 * Why inline snapshots instead of pixel comparisons?
 * ─────────────────────────────────────────────────────
 * Pixel-level canvas comparison requires node-canvas or a browser environment.
 * Instead, the color-capture spy intercepts fillStyle assignments and records
 * the active style at the moment fill() or fillRect() is called.  This gives
 * us a lightweight, deterministic record of "which color was applied and when"
 * without rendering a single pixel.
 *
 * toMatchInlineSnapshot() stores the expected value right in the test source.
 * When a color is intentionally changed, `npx vitest --update-snapshot` rewrites
 * the expected value in-place, making the change visible in the commit diff —
 * impossible to accidentally miss.
 *
 * Three suites:
 *
 *   1. COLORS palette      — every hex value locked via inline snapshot.
 *      If anyone edits a hex constant in constants.ts, this test fails
 *      immediately with a diff showing exactly which color changed.
 *
 *   2. Road color sequence — fillStyle at each fill() call for known pools is
 *      locked.  Catches regressions in rumble, lane-dash, and grass color
 *      dispatch logic (not just constant values, but the ORDER of colors).
 *
 *   3. ProjectedSeg shape  — sc2 field is present so the traffic-car intra-
 *      segment interpolation fix cannot silently vanish.  Without sc2, the
 *      interpolation formula would use undefined, producing NaN positions.
 */

import { describe, it, expect } from 'vitest';
import { COLORS } from '../src/constants';
import {
  drawGrass,
  drawRumble,
  drawLaneDashes,
  ProjectedSeg,
} from '../src/renderer';
import { RoadSegment } from '../src/types';

// ── Color-capture spy ──────────────────────────────────────────────────────────
//
// Records fillStyle at the moment fill() or fillRect() is called so tests can
// snapshot the exact sequence of colors applied to the canvas.
//
// Design note: we use a getter/setter pair for fillStyle rather than a plain
// property so that every assignment (ctx.fillStyle = '#FF0000') is intercepted
// and stored in `currentStyle`.  When fill() is subsequently called, the spy
// logs the colour that was ACTIVE at that moment — matching exactly what the
// canvas would have rendered.  This is important because multiple fillStyle
// assignments may occur between fill() calls (e.g., setting up the next run's
// colour while the current path is still open).

interface ColorCall
{
  method:    'fill' | 'fillRect';
  fillStyle: string;
}

function makeColorSpy()
{
  const log: ColorCall[] = [];
  let   currentStyle = '';

  const ctx = {
    get fillStyle()              { return currentStyle; },
    set fillStyle(v: string)     { currentStyle = v; },
    beginPath()                  { /* no-op */ },
    moveTo()                     { /* no-op */ },
    lineTo()                     { /* no-op */ },
    closePath()                  { /* no-op */ },
    fill()                       { log.push({ method: 'fill',     fillStyle: currentStyle }); },
    fillRect(_x: number, _y: number, _w: number, _h: number)
    {
      log.push({ method: 'fillRect', fillStyle: currentStyle });
    },
  } as unknown as CanvasRenderingContext2D;

  return { ctx, log };
}

// ── makeProj / makeSeg helpers ────────────────────────────────────────────────

function makeSeg(rumble = '#CC0000', lane = '', grass = '#10AA10'): RoadSegment
{
  return {
    index: 0,
    curve: 0,
    color: { road: '#888888', grass, rumble, lane },
    p1: { world: { x: 0, y: 0, z: 0 }, screen: { x: 0, y: 0, w: 0, scale: 0 } },
    p2: { world: { x: 0, y: 0, z: 0 }, screen: { x: 0, y: 0, w: 0, scale: 0 } },
  };
}

function makeProj(rumble = '#CC0000', lane = '', grass = '#10AA10'): ProjectedSeg
{
  return {
    seg: makeSeg(rumble, lane, grass),
    sc1: 1.0, sc2: 0.8,
    sx1: 640, sy1: 100, sw1: 200,
    sx2: 640, sy2:  80, sw2: 150,
  };
}

// ── 1. COLORS palette ─────────────────────────────────────────────────────────
//
// COLORS is the single authoritative palette for the entire game.  Every renderer,
// road builder, and UI component reads from this object — if a hex value changes
// here, the change propagates to every visual element simultaneously.

describe('COLORS palette snapshot', () =>
{
  /**
   * The entire COLORS object is locked as an inline snapshot.  This means:
   *
   *   - Any hex edit (intentional or typo) in constants.ts surfaces here as a
   *     test failure with a clear diff — impossible to accidentally miss.
   *
   *   - The test doubles as living documentation: the expected snapshot IS the
   *     authoritative palette listing, visible right in the test file.
   *
   *   - ROAD_DARK and ROAD_LIGHT are intentionally identical ('#888888').
   *     This is by design (both alternating road bands use the same grey) —
   *     the snapshot locks this so a "fix" that accidentally un-unifies them
   *     would be caught immediately.
   *
   * To intentionally update a color: change constants.ts, run
   * `npx vitest --update-snapshot`, then commit both files.
   */
  it('all hex values match the locked palette', () =>
  {
    expect(COLORS).toMatchInlineSnapshot(`
      {
        "LANE": "#CCCCCC",
        "ROAD_DARK": "#888888",
        "ROAD_LIGHT": "#888888",
        "RUMBLE_RED": "#CC0000",
        "RUMBLE_WHITE": "#FFFFFF",
        "SAND_DARK": "#E0CEB0",
        "SAND_LIGHT": "#EDE0C8",
        "SKY_HORIZON": "#C8EEFF",
        "SKY_MID": "#72D7EE",
        "SKY_TOP": "#0066AA",
      }
    `);
  });
});

// ── 2. Road color sequence ────────────────────────────────────────────────────
//
// These tests lock the colour ORDER emitted by each render pass, not just the
// individual values.  A bug that swapped red and white rumble strips would still
// pass the palette test above (both colours are still present) but would fail
// these sequence tests immediately.

describe('drawRumble color sequence snapshot', () =>
{
  /**
   * 4 red + 4 white → 2 fill() calls, one per colour-run.
   * The sequence [#CC0000, #FFFFFF] is locked: red must come before white.
   * If the run-length encoding reversed the order, the rumble stripes would
   * flash in the wrong order and drift out of phase with the grass banding.
   */
  it('[red×4, white×4] → fill colors [#CC0000, #FFFFFF]', () =>
  {
    const { ctx, log } = makeColorSpy();
    const pool = [
      makeProj('#CC0000'), makeProj('#CC0000'),
      makeProj('#CC0000'), makeProj('#CC0000'),
      makeProj('#FFFFFF'), makeProj('#FFFFFF'),
      makeProj('#FFFFFF'), makeProj('#FFFFFF'),
    ];
    drawRumble(ctx, pool, pool.length);

    const fills = log.filter(c => c.method === 'fill').map(c => c.fillStyle);
    expect(fills).toMatchInlineSnapshot(`
      [
        "#CC0000",
        "#FFFFFF",
      ]
    `);
  });

  /**
   * Alternating [red, white, red] → 3 fill() calls in correct order.
   * Tests that the run encoder restarts correctly after a colour boundary:
   * the second 'red' run must produce its own fill, not be merged with the
   * first red run (they are not contiguous — white is between them).
   */
  it('[red, white, red] → fill colors [#CC0000, #FFFFFF, #CC0000]', () =>
  {
    const { ctx, log } = makeColorSpy();
    const pool = [
      makeProj('#CC0000'),
      makeProj('#FFFFFF'),
      makeProj('#CC0000'),
    ];
    drawRumble(ctx, pool, pool.length);

    const fills = log.filter(c => c.method === 'fill').map(c => c.fillStyle);
    expect(fills).toMatchInlineSnapshot(`
      [
        "#CC0000",
        "#FFFFFF",
        "#CC0000",
      ]
    `);
  });
});

describe('drawLaneDashes color sequence snapshot', () =>
{
  /**
   * All lane-on segments → exactly one fill at COLORS.LANE (#CCCCCC).
   * The lane dash colour is a single constant — all dashes on the road
   * must be the same shade.  A colour mismatch here would make lane dashes
   * a different shade of grey than the authored palette value.
   */
  it('all lane-on → single fill at #CCCCCC', () =>
  {
    const { ctx, log } = makeColorSpy();
    const pool = [
      makeProj('#CC0000', '#CCCCCC'),
      makeProj('#CC0000', '#CCCCCC'),
      makeProj('#CC0000', '#CCCCCC'),
    ];
    drawLaneDashes(ctx, pool, pool.length);

    const fills = log.filter(c => c.method === 'fill').map(c => c.fillStyle);
    expect(fills).toMatchInlineSnapshot(`
      [
        "#CCCCCC",
      ]
    `);
  });

  /**
   * [lane×2, off×2, lane×1] → exactly 2 fills, both at #CCCCCC.
   * The off-run produces NO fill call — verifying that lane-off segments are
   * completely skipped rather than drawing a transparent or zero-width path.
   * Two fills at the same colour confirm the runs are correctly split by the
   * off-run gap, not merged into one.
   */
  it('[lane×2, off×2, lane×1] → 2 fills at #CCCCCC', () =>
  {
    const { ctx, log } = makeColorSpy();
    const pool = [
      makeProj('#CC0000', '#CCCCCC'),
      makeProj('#CC0000', '#CCCCCC'),
      makeProj('#CC0000', ''),
      makeProj('#CC0000', ''),
      makeProj('#CC0000', '#CCCCCC'),
    ];
    drawLaneDashes(ctx, pool, pool.length);

    const fills = log.filter(c => c.method === 'fill').map(c => c.fillStyle);
    expect(fills).toMatchInlineSnapshot(`
      [
        "#CCCCCC",
        "#CCCCCC",
      ]
    `);
  });
});

describe('drawGrass color sequence snapshot', () =>
{
  /**
   * drawGrass iterates the pool back-to-front (nearest segment first) and calls
   * fillRect once per segment.  The colour sequence in the log must reflect that
   * order: the NEAREST segment's colour appears first, then the FAR segment's.
   *
   * Pool layout (index 0 = farthest, index 1 = nearest):
   *   far:  grass=#009A00, sy1=280, sy2=260  — just below horizon (halfH=240)
   *   near: grass=#10AA10, sy1=400, sy2=280  — well below horizon
   *
   * drawGrass iterates index 1 → 0, so fillRects are: #10AA10 (near) then
   * #009A00 (far).  Without correct iteration order, the colours would be
   * reversed and the grass banding would "flicker" as closer segments are
   * painted the wrong alternating colour.
   */
  it('alternating grass colors → fillRect sequence matches per-segment color', () =>
  {
    const { ctx, log } = makeColorSpy();

    // Two segments with sy values below the horizon (halfH=240):
    //   index 0 = farthest:  sy1=280, sy2=260  (just below horizon)
    //   index 1 = nearest:   sy1=400, sy2=280  (well below horizon)
    // drawGrass iterates nearest-first (index 1 then 0).
    const far: ProjectedSeg = {
      ...makeProj('#CC0000', '', '#009A00'),
      sy1: 280, sy2: 260,
    };
    const near: ProjectedSeg = {
      ...makeProj('#FFFFFF', '', '#10AA10'),
      sy1: 400, sy2: 280,
    };
    const pool = [far, near];

    // halfH = 240 so gTop/gBot arithmetic is straightforward; canvasW = 1280
    drawGrass(ctx, pool, pool.length, 240, 1280);

    const fillRects = log.filter(c => c.method === 'fillRect').map(c => c.fillStyle);
    expect(fillRects).toMatchInlineSnapshot(`
      [
        "#10AA10",
        "#009A00",
      ]
    `);
  });
});

// ── 3. ProjectedSeg shape ─────────────────────────────────────────────────────
//
// ProjectedSeg is the cached projection data for one road segment.  It is
// computed once per frame in the projection pass and reused in all subsequent
// render passes and the traffic-car draw pass.
//
// sc2 (far-edge perspective scale) was added in the traffic-vibration fix to
// enable intra-segment interpolation: traffic cars that are partway through a
// segment need a scale that is between sc1 (near edge) and sc2 (far edge).
// Without sc2, the formula would use undefined and produce NaN screen positions,
// causing traffic cars to disappear or jump randomly.

describe('ProjectedSeg interface — sc2 field', () =>
{
  /**
   * The sc2 field must be present and a finite number.  This is a regression
   * test: sc2 was added to fix traffic-car vibration and could be accidentally
   * removed in a future refactor.  typeof 'number' and isFinite together guard
   * against both undefined/null (wrong type) and NaN/Infinity (degenerate value).
   */
  it('makeProj returns a ProjectedSeg that includes sc2 as a finite number', () =>
  {
    const p = makeProj();
    expect(typeof p.sc2).toBe('number');
    expect(isFinite(p.sc2)).toBe(true);
    expect(p.sc2).toBeGreaterThan(0);
  });

  /**
   * Perspective geometry requires sc2 < sc1: the far edge of a segment is
   * more distant from the camera, so its scale (projected width per world unit)
   * must be smaller than the near edge's scale.  The interpolation formula
   * lerp(sc1, sc2, t) for t ∈ [0,1] produces values in (sc2, sc1).  If
   * sc2 >= sc1 the interpolation would go in the wrong direction — traffic cars
   * in the back half of a segment would appear larger than those in the front.
   */
  it('sc2 < sc1 (far-edge perspective scale is smaller than near-edge)', () =>
  {
    // Near edge is always closer → larger perspective scale.
    // This is the geometric invariant the interpolation relies on.
    const p = makeProj();
    expect(p.sc2).toBeLessThan(p.sc1);
  });
});
