/**
 * renderer.test.ts
 *
 * Tests for the module-level rendering functions extracted from renderer.ts.
 *
 * These tests protect the critical invariants of the batched polygon rendering
 * strategy introduced to eliminate hairline seams between adjacent road segments:
 *
 *   1. Road surface (Pass B): one beginPath/fill for ALL visible segments.
 *   2. Rumble strips (Passes C+D): one fill per contiguous same-colour run.
 *   3. Lane dashes (Pass E): one fill per lane-on run, zero for lane-off.
 *   4. Edge marks (Pass F): one fill per lane-on run, with 4 closePaths.
 *   5. addTrap winding: all trapezoids in a batched path wind clockwise.
 *
 * The tests use a minimal recording spy for CanvasRenderingContext2D — no
 * external libraries, no browser.  The spy records every draw call so tests
 * can count beginPath, fill, closePath, moveTo, and lineTo invocations.
 */

import { describe, it, expect } from 'vitest';
import
{
  buildColorRuns,
  drawRoadSurface,
  drawRumble,
  drawLaneDashes,
  drawEdgeMarks,
  addTrap,
  ProjectedSeg,
} from '../src/renderer';
import { RoadSegment } from '../src/types';

// ── Canvas recording spy ────────────────────────────────────────────────────

/**
 * One recorded canvas method call, with its name and numeric/string arguments.
 * We only record the calls that the rendering functions use — path operations
 * and fill.  Any unrecorded call would throw "is not a function".
 */
interface Call
{
  method: string;
  args:   (number | string)[];
}

/**
 * Creates a minimal spy for CanvasRenderingContext2D.
 *
 * Every draw method pushes a Call record.  The returned `count(method)` helper
 * counts how many times a given method was called — useful for concise assertions
 * like `expect(count('fill')).toBe(2)`.
 *
 * Only the subset of ctx methods used by the extracted render-pass functions
 * is implemented.  Calling anything else throws immediately, which surfaces
 * accidental usage quickly.
 */
function makeMockCtx()
{
  const calls: Call[] = [];

  const ctx = {
    calls,
    fillStyle: '' as string,

    beginPath() { calls.push({ method: 'beginPath', args: [] }); },
    moveTo(x: number, y: number) { calls.push({ method: 'moveTo', args: [x, y] }); },
    lineTo(x: number, y: number) { calls.push({ method: 'lineTo', args: [x, y] }); },
    closePath() { calls.push({ method: 'closePath', args: [] }); },
    fill() { calls.push({ method: 'fill', args: [] }); },
    fillRect(x: number, y: number, w: number, h: number)
    {
      calls.push({ method: 'fillRect', args: [x, y, w, h] });
    },
  } as unknown as CanvasRenderingContext2D & { calls: Call[] };

  /** Count how many times `method` was called. */
  const count = (method: string) =>
    calls.filter(c => c.method === method).length;

  return { ctx, calls, count };
}

// ── Test data helpers ───────────────────────────────────────────────────────

/**
 * Builds a minimal RoadSegment sufficient for render-pass testing.
 * Fields not needed by the pass under test are given zero/empty defaults.
 */
function makeSeg(opts: {
  rumble?: string;
  lane?:   string;
  grass?:  string;
} = {}): RoadSegment
{
  return {
    index:  0,
    curve:  0,
    color:
    {
      road:   '#888888',
      grass:  opts.grass  ?? '#10AA10',
      rumble: opts.rumble ?? '#CC0000',
      lane:   opts.lane   ?? '',
    },
    p1: { world: { x: 0, y: 0, z: 0 }, screen: { x: 0, y: 0, w: 0, scale: 0 } },
    p2: { world: { x: 0, y: 0, z: 0 }, screen: { x: 0, y: 0, w: 0, scale: 0 } },
  };
}

/**
 * Builds a minimal ProjectedSeg for testing.
 *
 * Default geometry: flat, uphill layout (sy1=100 > sy2=80), centred on x=640,
 * half-widths sw1=200 near, sw2=150 far.  All numbers are round integers so
 * Math.round() inside the drawing functions is a no-op — easier to reason about.
 */
function makeProj(opts: {
  sy1?:        number;
  sy2?:        number;
  sx1?:        number;
  sw1?:        number;
  sx2?:        number;
  sw2?:        number;
  sc1?:        number;
  rumble?:     string;
  lane?:       string;
  grass?:      string;
} = {}): ProjectedSeg
{
  return {
    seg: makeSeg({ rumble: opts.rumble, lane: opts.lane, grass: opts.grass }),
    sc1: opts.sc1 ?? 1,
    sc2: 0.8,          // far-edge scale; smaller than sc1 (perspective)
    sx1: opts.sx1 ?? 640,
    sy1: opts.sy1 ?? 100,
    sw1: opts.sw1 ?? 200,
    sx2: opts.sx2 ?? 640,
    sy2: opts.sy2 ?? 80,
    sw2: opts.sw2 ?? 150,
  };
}

// ── buildColorRuns ──────────────────────────────────────────────────────────

describe('buildColorRuns', () =>
{
  /**
   * An empty pool has no segments → no runs.
   */
  it('empty pool → []', () =>
  {
    const runs = buildColorRuns([], 0, seg => seg.color.rumble);
    expect(runs).toEqual([]);
  });

  /**
   * A single segment produces exactly one run covering [0, 0].
   */
  it('single segment → one run', () =>
  {
    const pool = [makeProj({ rumble: 'red' })];
    const runs = buildColorRuns(pool, 1, seg => seg.color.rumble);
    expect(runs).toHaveLength(1);
    expect(runs[0].color).toBe('red');
    expect(runs[0].startIdx).toBe(0);
    expect(runs[0].endIdx).toBe(0);
  });

  /**
   * Three red + two white → [{red,0,2},{white,3,4}].
   * Verifies that run boundaries are detected correctly.
   */
  it('three red + two white → 2 runs with correct boundaries', () =>
  {
    const pool = [
      makeProj({ rumble: 'red' }),
      makeProj({ rumble: 'red' }),
      makeProj({ rumble: 'red' }),
      makeProj({ rumble: 'white' }),
      makeProj({ rumble: 'white' }),
    ];
    const runs = buildColorRuns(pool, 5, seg => seg.color.rumble);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toEqual({ color: 'red',   startIdx: 0, endIdx: 2 });
    expect(runs[1]).toEqual({ color: 'white', startIdx: 3, endIdx: 4 });
  });

  /**
   * Strictly alternating [r,w,r,w] produces 4 separate runs of length 1 each.
   * This is the "worst case" for the old per-segment draw approach but behaves
   * correctly with buildColorRuns.
   */
  it('alternating r/w/r/w → 4 runs', () =>
  {
    const pool = [
      makeProj({ rumble: 'r' }),
      makeProj({ rumble: 'w' }),
      makeProj({ rumble: 'r' }),
      makeProj({ rumble: 'w' }),
    ];
    const runs = buildColorRuns(pool, 4, seg => seg.color.rumble);
    expect(runs).toHaveLength(4);
    expect(runs.map(r => r.color)).toEqual(['r', 'w', 'r', 'w']);
    runs.forEach((r, i) =>
    {
      expect(r.startIdx).toBe(i);
      expect(r.endIdx).toBe(i);
    });
  });
});

// ── drawRoadSurface (Pass B) ────────────────────────────────────────────────

describe('drawRoadSurface — road surface polygon', () =>
{
  /**
   * With 0 segments the function must still call beginPath and fill once
   * (an empty path), but issue no moveTo or lineTo.
   */
  it('0 segments → beginPath + fill called once, no moveTo/lineTo', () =>
  {
    const { ctx, count } = makeMockCtx();
    drawRoadSurface(ctx, [], 0);
    expect(count('beginPath')).toBe(1);
    expect(count('fill')).toBe(1);
    expect(count('moveTo')).toBe(0);
    expect(count('lineTo')).toBe(0);
  });

  /**
   * With 1 segment the polygon has:
   *   moveTo  → far-left of farthest (=only) segment
   *   lineTo  → near-left of segment 0  (1 call — left edge descent)
   *   lineTo  → near-right of segment 0 (1 call — bottom pivot)
   *   lineTo  → far-right  of segment 0 (1 call — right edge ascent)
   *   closePath
   * Total path points: 1 moveTo + 3 lineTos = 4 points.
   * Formula: 2*N + 2 = 2*1 + 2 = 4.
   */
  it('1 segment → 1 moveTo, 3 lineTos, 1 closePath, 1 fill', () =>
  {
    const { ctx, count } = makeMockCtx();
    const pool = [makeProj()];
    drawRoadSurface(ctx, pool, 1);
    expect(count('beginPath')).toBe(1);
    expect(count('fill')).toBe(1);
    expect(count('moveTo')).toBe(1);
    // N=1: left edge (1 lineTo for near-left) + bottom pivot (1) + right edge (1 far-right)
    expect(count('lineTo')).toBe(3);
    expect(count('closePath')).toBe(1);
  });

  /**
   * N segments: the polygon traces 2*N + 2 total points.
   *   - 1 moveTo  at far-left of farthest segment
   *   - N lineTos down the left edge (near-left of each segment, farthest→nearest)
   *   - 1 lineTo  pivot to near-right of nearest segment
   *   - N lineTos up the right edge (far-right of each segment, nearest→farthest)
   *   Total lineTos: N + 1 + N = 2N + 1.  Plus 1 moveTo = 2N + 2 points.
   */
  it('N segments → 1 beginPath, 1 fill, 1 moveTo, 2N+1 lineTos, 1 closePath', () =>
  {
    for (const N of [2, 3, 5, 10])
    {
      const { ctx, count } = makeMockCtx();
      const pool = Array.from({ length: N }, () => makeProj());
      drawRoadSurface(ctx, pool, N);
      expect(count('beginPath')).toBe(1);
      expect(count('fill')).toBe(1);
      expect(count('moveTo')).toBe(1);
      expect(count('lineTo')).toBe(2 * N + 1);
      expect(count('closePath')).toBe(1);
    }
  });

  /**
   * The polygon is always closed (closePath is called exactly once).
   */
  it('polygon is closed — closePath called exactly once', () =>
  {
    const { ctx, count } = makeMockCtx();
    drawRoadSurface(ctx, [makeProj(), makeProj(), makeProj()], 3);
    expect(count('closePath')).toBe(1);
  });
});

// ── drawRumble (Passes C + D) ───────────────────────────────────────────────

describe('drawRumble — rumble strips per colour-run', () =>
{
  /**
   * A single uniform-colour pool → exactly 1 fill call.
   * (Both sides are drawn in the same path.)
   */
  it('single colour run → exactly 1 fill', () =>
  {
    const { ctx, count } = makeMockCtx();
    const pool = [
      makeProj({ rumble: 'red' }),
      makeProj({ rumble: 'red' }),
    ];
    drawRumble(ctx, pool, 2);
    expect(count('fill')).toBe(1);
  });

  /**
   * [red×3, white×2] → 2 fill calls (one per colour-run).
   */
  it('[red×3, white×2] → 2 fill calls', () =>
  {
    const { ctx, count } = makeMockCtx();
    const pool = [
      makeProj({ rumble: 'red' }),
      makeProj({ rumble: 'red' }),
      makeProj({ rumble: 'red' }),
      makeProj({ rumble: 'white' }),
      makeProj({ rumble: 'white' }),
    ];
    drawRumble(ctx, pool, 5);
    expect(count('fill')).toBe(2);
  });

  /**
   * [red, white, red] → 3 fill calls.
   * Verifies runs are split correctly when colour alternates.
   */
  it('[red, white, red] → 3 fill calls', () =>
  {
    const { ctx, count } = makeMockCtx();
    const pool = [
      makeProj({ rumble: 'red' }),
      makeProj({ rumble: 'white' }),
      makeProj({ rumble: 'red' }),
    ];
    drawRumble(ctx, pool, 3);
    expect(count('fill')).toBe(3);
  });

  /**
   * Each run draws LEFT side and RIGHT side as sub-shapes in the SAME path.
   * Each side is one closed polygon → 2 closePaths per run.
   * With a single 1-segment run → 2 closePaths total.
   */
  it('each run draws 2 closePaths (one per side)', () =>
  {
    const { ctx, count } = makeMockCtx();
    const pool = [makeProj({ rumble: 'red' })];
    drawRumble(ctx, pool, 1);
    expect(count('closePath')).toBe(2);
  });

  /**
   * Extension: [red×2, white×1] → 3 runs × 2 closePaths = 6 total.
   * (Two colour runs for red, one for white.)  Wait — [red×2, white×1] is
   * only 2 runs.  2 runs × 2 sides = 4 closePaths.
   */
  it('[red×2, white×1] → 4 closePaths (2 runs × 2 sides)', () =>
  {
    const { ctx, count } = makeMockCtx();
    const pool = [
      makeProj({ rumble: 'red' }),
      makeProj({ rumble: 'red' }),
      makeProj({ rumble: 'white' }),
    ];
    drawRumble(ctx, pool, 3);
    expect(count('fill')).toBe(2);
    expect(count('closePath')).toBe(4);
  });
});

// ── drawLaneDashes (Pass E) ─────────────────────────────────────────────────

describe('drawLaneDashes — lane dashes per lane-on run', () =>
{
  /**
   * All lane=false → 0 fill calls.
   * Lane-off runs are completely skipped.
   */
  it('all lane=false → 0 fills', () =>
  {
    const { ctx, count } = makeMockCtx();
    const pool = [
      makeProj({ lane: '' }),
      makeProj({ lane: '' }),
    ];
    drawLaneDashes(ctx, pool, 2);
    expect(count('fill')).toBe(0);
    expect(count('beginPath')).toBe(0);
  });

  /**
   * All lane=true (same colour) → 1 fill call (one run, both sides batched).
   */
  it('all lane=true → 1 fill', () =>
  {
    const { ctx, count } = makeMockCtx();
    const pool = [
      makeProj({ lane: '#CCCCCC' }),
      makeProj({ lane: '#CCCCCC' }),
      makeProj({ lane: '#CCCCCC' }),
    ];
    drawLaneDashes(ctx, pool, 3);
    expect(count('fill')).toBe(1);
  });

  /**
   * [true×2, false×2, true×1] → 2 fill calls (two separate lane-on runs).
   */
  it('[lane×2, off×2, lane×1] → 2 fills', () =>
  {
    const { ctx, count } = makeMockCtx();
    const pool = [
      makeProj({ lane: '#CCCCCC' }),
      makeProj({ lane: '#CCCCCC' }),
      makeProj({ lane: '' }),
      makeProj({ lane: '' }),
      makeProj({ lane: '#CCCCCC' }),
    ];
    drawLaneDashes(ctx, pool, 5);
    expect(count('fill')).toBe(2);
  });

  /**
   * Lane-on run has 2 closePaths (left side + right side per run).
   */
  it('lane-on run → 2 closePaths (one per side)', () =>
  {
    const { ctx, count } = makeMockCtx();
    const pool = [makeProj({ lane: '#CCCCCC' })];
    drawLaneDashes(ctx, pool, 1);
    expect(count('closePath')).toBe(2);
  });
});

// ── drawEdgeMarks (Pass F) ──────────────────────────────────────────────────

describe('drawEdgeMarks — edge track marks per lane-on run', () =>
{
  /**
   * All lane=false → 0 fills.
   */
  it('all lane=false → 0 fills', () =>
  {
    const { ctx, count } = makeMockCtx();
    const pool = [makeProj({ lane: '' }), makeProj({ lane: '' })];
    drawEdgeMarks(ctx, pool, 2);
    expect(count('fill')).toBe(0);
  });

  /**
   * A single lane-on run → 1 fill.
   * All 4 stripes are batched in a single beginPath/fill.
   */
  it('all lane=true → 1 fill', () =>
  {
    const { ctx, count } = makeMockCtx();
    const pool = [makeProj({ lane: '#CCCCCC' }), makeProj({ lane: '#CCCCCC' })];
    drawEdgeMarks(ctx, pool, 2);
    expect(count('fill')).toBe(1);
  });

  /**
   * A lane-on run with N segments draws exactly 4 closePaths:
   * left-outer, left-inner, right-outer, right-inner.
   * All 4 stripes are in the same path — 1 fill, 4 closePaths.
   */
  it('lane-on run → 1 fill with exactly 4 closePaths (4 stripes)', () =>
  {
    const { ctx, count } = makeMockCtx();
    const pool = [
      makeProj({ lane: '#CCCCCC' }),
      makeProj({ lane: '#CCCCCC' }),
    ];
    drawEdgeMarks(ctx, pool, 2);
    expect(count('fill')).toBe(1);
    expect(count('closePath')).toBe(4);
  });

  /**
   * Two separate lane-on runs → 2 fills, 8 closePaths total.
   */
  it('[lane×2, off×1, lane×2] → 2 fills, 8 closePaths', () =>
  {
    const { ctx, count } = makeMockCtx();
    const pool = [
      makeProj({ lane: '#CCCCCC' }),
      makeProj({ lane: '#CCCCCC' }),
      makeProj({ lane: '' }),
      makeProj({ lane: '#CCCCCC' }),
      makeProj({ lane: '#CCCCCC' }),
    ];
    drawEdgeMarks(ctx, pool, 5);
    expect(count('fill')).toBe(2);
    expect(count('closePath')).toBe(8);
  });
});

// ── addTrap winding ─────────────────────────────────────────────────────────

describe('addTrap — trapezoid winding direction', () =>
{
  /**
   * Uphill (y1 > y2): near edge is below far edge.
   * Clockwise on screen (Y-axis points down): BL→BR→TR→TL.
   *
   * With x1=640, y1=100, w1=200, x2=640, y2=80, w2=150:
   *   BL = (640-200, 100) = (440, 100)   ← moveTo
   *   BR = (640+200, 100) = (840, 100)   ← lineTo
   *   TR = (640+150, 79)  = (790, 79)    ← lineTo  (ry2-1=79)
   *   TL = (640-150, 79)  = (490, 79)    ← lineTo
   */
  it('uphill (y1>y2): moveTo bottom-left first, then BR, TR, TL', () =>
  {
    const { ctx, calls, count } = makeMockCtx();
    ctx.beginPath();
    addTrap(ctx, 640, 100, 200, 640, 80, 150);

    const moveTos = calls.filter(c => c.method === 'moveTo');
    const lineTos = calls.filter(c => c.method === 'lineTo');

    expect(moveTos).toHaveLength(1);
    // BL: x1 - w1 = 440, y1 = 100
    expect(moveTos[0].args).toEqual([440, 100]);

    expect(lineTos).toHaveLength(3);
    // BR: x1 + w1 = 840, y1 = 100
    expect(lineTos[0].args).toEqual([840, 100]);
    // TR: x2 + w2 = 790, ry2-1 = 79
    expect(lineTos[1].args).toEqual([790, 79]);
    // TL: x2 - w2 = 490, ry2-1 = 79
    expect(lineTos[2].args).toEqual([490, 79]);
    expect(count('lineTo')).toBe(3);
    expect(count('closePath')).toBe(1);
  });

  /**
   * Downhill (y1 < y2): near edge is above far edge.
   * Must also be CW on screen: TL→BL→BR→TR.
   *
   * With x1=640, y1=80, w1=150, x2=640, y2=100, w2=200:
   *   TL = (640-150, 80) = (490, 80)     ← moveTo
   *   BL = (640-200, 101) = (440, 101)   ← lineTo  (ry2+1=101)
   *   BR = (640+200, 101) = (840, 101)   ← lineTo
   *   TR = (640+150, 80)  = (790, 80)    ← lineTo
   */
  it('downhill (y1<y2): moveTo top-left first, then BL, BR, TR', () =>
  {
    const { ctx, calls, count } = makeMockCtx();
    ctx.beginPath();
    addTrap(ctx, 640, 80, 150, 640, 100, 200);

    const moveTos = calls.filter(c => c.method === 'moveTo');
    const lineTos = calls.filter(c => c.method === 'lineTo');

    expect(moveTos).toHaveLength(1);
    // TL: x1 - w1 = 490, y1 = 80
    expect(moveTos[0].args).toEqual([490, 80]);

    expect(lineTos).toHaveLength(3);
    // BL: x2 - w2 = 440, ry2+1 = 101
    expect(lineTos[0].args).toEqual([440, 101]);
    // BR: x2 + w2 = 840, ry2+1 = 101
    expect(lineTos[1].args).toEqual([840, 101]);
    // TR: x1 + w1 = 790, y1 = 80
    expect(lineTos[2].args).toEqual([790, 80]);

    expect(count('lineTo')).toBe(3);
    expect(count('closePath')).toBe(1);
  });

  /**
   * Both uphill and downhill produce exactly 4 path points (1 moveTo + 3 lineTos)
   * and 1 closePath.
   */
  it('both uphill and downhill produce 3 lineTos + 1 closePath', () =>
  {
    // Uphill
    {
      const { ctx, count } = makeMockCtx();
      ctx.beginPath();
      addTrap(ctx, 640, 100, 200, 640, 80, 150);    // y1 > y2 — uphill
      expect(count('moveTo')).toBe(1);
      expect(count('lineTo')).toBe(3);
      expect(count('closePath')).toBe(1);
    }
    // Downhill
    {
      const { ctx, count } = makeMockCtx();
      ctx.beginPath();
      addTrap(ctx, 640, 80, 150, 640, 100, 200);    // y1 < y2 — downhill
      expect(count('moveTo')).toBe(1);
      expect(count('lineTo')).toBe(3);
      expect(count('closePath')).toBe(1);
    }
  });

  /**
   * Flat segment (y1 === y2): treated as uphill (ry1 >= ry2), so winding
   * is BL→BR→TR→TL with the 1px far-edge extension going upward (ry2-1).
   */
  it('flat (y1 === y2): treated as uphill, moveTo bottom-left', () =>
  {
    const { ctx, calls } = makeMockCtx();
    ctx.beginPath();
    addTrap(ctx, 640, 100, 200, 640, 100, 150);    // y1 === y2

    const moveTos = calls.filter(c => c.method === 'moveTo');
    // BL: x1 - w1 = 440, y1 = 100
    expect(moveTos[0].args).toEqual([440, 100]);
  });
});
