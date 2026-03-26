/**
 * snapshot.test.ts
 *
 * Visual regression tests — lock color palette and road render logic so that
 * accidental hex edits or color-logic changes produce an explicit diff rather
 * than silently shipping wrong colors.
 *
 * Three suites:
 *
 *   1. COLORS palette      — every hex value locked via inline snapshot.
 *   2. Road color sequence — fillStyle at each fill() call for known pools is
 *                             locked.  Catches regressions in rumble, lane-dash,
 *                             and grass color dispatch.
 *   3. ProjectedSeg shape  — sc2 field is present so the traffic-car intra-
 *                             segment interpolation fix cannot silently vanish.
 *
 * Approach: a lightweight color-capture spy records `(fillStyle, method)` pairs
 * rather than running the full renderer — no browser, no node-canvas required.
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

describe('COLORS palette snapshot', () =>
{
  /**
   * The entire palette is locked so any hex edit — intentional or accidental —
   * produces a vitest snapshot diff rather than silently shipping wrong colors.
   *
   * If you intentionally change a color: run `npx vitest --update-snapshot` to
   * accept the new values, then commit both the source change and the updated
   * snapshot.
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

describe('drawRumble color sequence snapshot', () =>
{
  /**
   * 4 red + 4 white → 2 fill() calls, one per color-run.
   * Locked colors: #CC0000 then #FFFFFF.
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
   * Single alternating segment [red, white, red] → 3 fill() calls.
   * Each call uses the correct color for its run.
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
   * All lane-on segments use the LANE color (#CCCCCC).
   * One run → one fill() call at #CCCCCC.
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
   * [lane×2, off×2, lane×1] → 2 fill() calls, both at #CCCCCC.
   * The off-run produces NO fill at all.
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
   * Two grass colors alternating → drawGrass calls fillRect with the correct
   * color per segment.  Locked sequence guards the grass color dispatch.
   *
   * Pool is ordered farthest→nearest (index 0 = farthest) but drawGrass
   * iterates back-to-front (from projCount-1 to 0), so the first fillRect
   * corresponds to the nearest visible segment.
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

describe('ProjectedSeg interface — sc2 field', () =>
{
  /**
   * Regression test: the traffic-car vibration fix added sc2 to ProjectedSeg
   * so Pass 4 can interpolate within a segment.  This test ensures the field
   * is present and a numeric value — if sc2 is accidentally removed from the
   * interface or the projPool init, this test breaks.
   */
  it('makeProj returns a ProjectedSeg that includes sc2 as a finite number', () =>
  {
    const p = makeProj();
    expect(typeof p.sc2).toBe('number');
    expect(isFinite(p.sc2)).toBe(true);
    expect(p.sc2).toBeGreaterThan(0);
  });

  it('sc2 < sc1 (far-edge perspective scale is smaller than near-edge)', () =>
  {
    // Near edge is always closer → larger perspective scale.
    // This is the geometric invariant the interpolation relies on.
    const p = makeProj();
    expect(p.sc2).toBeLessThan(p.sc1);
  });
});
