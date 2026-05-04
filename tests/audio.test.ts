/**
 * audio.test.ts
 *
 * Tests AudioManager.playBarney() — the Fisher-Yates shuffle deck that cycles
 * through all four Barney kill phrases without repeating within a cycle or at
 * the boundary between two consecutive cycles.
 *
 * Testing strategy
 * ─────────────────
 * playBarney() uses two browser-only APIs:
 *   • speechSynthesis.cancel() / .speak()
 *   • new SpeechSynthesisUtterance(text)
 *
 * Both are stubbed with vi.stubGlobal() so the full code path runs in Node/Vitest
 * without audio hardware.  AudioManager.init() is NOT called — no AudioContext is
 * created; the deck logic runs independently of Web Audio.
 *
 * Invariants verified
 * ────────────────────
 *   A. Every cycle of 4 hits is a permutation of all 4 phrases (none skipped,
 *      none doubled).
 *
 *   B. The last phrase of one cycle never equals the first phrase of the next
 *      (cross-cycle boundary guard).  Without the guard there is a 1-in-4 chance
 *      of a boundary repeat; the test runs 100 consecutive boundary checks so the
 *      probability of a false-pass without the guard is (1/4)^100 ≈ 0.
 *
 *   C. No two consecutive calls ever return the same phrase (combines A + B).
 *
 *   D. Invariants hold across many independent AudioManager instances and over
 *      hundreds of cycles (stochastic stress coverage).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AudioManager } from '../src/audio';

// ── Browser API stubs ─────────────────────────────────────────────────────────
//
// SpeechSynthesisUtterance is a DOM class; Node doesn't have it.  MockUtterance
// records the spoken text so tests can inspect which phrase was played.

class MockUtterance
{
  pitch  = 1;
  rate   = 1;
  volume = 1;
  constructor(public readonly text: string) {}
}

/** Accumulates every phrase passed to speechSynthesis.speak(). */
const spoken: string[] = [];

beforeAll(() =>
{
  vi.stubGlobal('SpeechSynthesisUtterance', MockUtterance);
  vi.stubGlobal('speechSynthesis', {
    cancel: () => {},
    speak:  (u: MockUtterance) => { spoken.push(u.text); },
  });
});

afterAll(() => { vi.unstubAllGlobals(); });

// ── Helpers ───────────────────────────────────────────────────────────────────

const ALL_PHRASES = new Set([
  'Oh no!',
  'Killing Barney!',
  'Barney will be avenged',
  'One less Barney on the road!',
]);

/**
 * Resets the spoken-phrase buffer, fires playBarney() n times, and returns
 * the captured phrases in call order.
 */
function collect(manager: AudioManager, n: number): string[]
{
  spoken.length = 0;
  for (let i = 0; i < n; i++) manager.playBarney();
  return [...spoken];
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AudioManager.playBarney — shuffle deck', () =>
{
  // ── Invariant A: every cycle is a permutation ────────────────────────────

  it('first cycle of 4 hits contains all 4 phrases exactly once', () =>
  {
    const mgr     = new AudioManager();
    const phrases = collect(mgr, 4);
    expect(phrases).toHaveLength(4);
    expect(new Set(phrases)).toEqual(ALL_PHRASES);
  });

  it('every group of 4 consecutive hits is a permutation of all 4 phrases', () =>
  {
    const mgr     = new AudioManager();
    const phrases = collect(mgr, 40);  // 10 full cycles

    for (let cycle = 0; cycle < 10; cycle++)
    {
      const slice = phrases.slice(cycle * 4, cycle * 4 + 4);
      expect(new Set(slice), `cycle ${cycle} must contain all 4 phrases`).toEqual(ALL_PHRASES);
    }
  });

  // ── Invariant B: cross-cycle boundary guard ──────────────────────────────
  //
  // The guard fires when the freshly-shuffled deck would start with the same
  // phrase that ended the previous cycle.  It swaps that first element with a
  // random other position.  Without it there would be a 1-in-4 chance of a
  // boundary repeat on each cycle transition.

  it('the last phrase of one cycle never equals the first phrase of the next', () =>
  {
    const mgr     = new AudioManager();
    const phrases = collect(mgr, 400);  // 100 cycle boundaries

    for (let cycle = 0; cycle < 99; cycle++)
    {
      const lastOfCycle = phrases[cycle * 4 + 3];
      const firstOfNext = phrases[cycle * 4 + 4];
      expect(lastOfCycle, `cycle ${cycle}→${cycle + 1} boundary`).not.toBe(firstOfNext);
    }
  });

  // ── Invariant C: no adjacent repeat anywhere ─────────────────────────────
  //
  // Combines A (no within-cycle repeat) and B (no cross-cycle boundary repeat)
  // into a single sweep over all 399 adjacent pairs in 400 calls.

  it('never plays the same phrase twice in a row across 400 consecutive hits', () =>
  {
    const mgr     = new AudioManager();
    const phrases = collect(mgr, 400);

    for (let i = 0; i < phrases.length - 1; i++)
      expect(phrases[i], `adjacent repeat at positions ${i} and ${i + 1}`).not.toBe(phrases[i + 1]);
  });

  // ── Invariant D: independence and longevity ───────────────────────────────

  it('three independent manager instances each produce a valid first cycle', () =>
  {
    // Each AudioManager has its own deck state — decks must not share state.
    for (let i = 0; i < 3; i++)
    {
      const phrases = collect(new AudioManager(), 4);
      expect(new Set(phrases), `manager ${i}`).toEqual(ALL_PHRASES);
    }
  });

  it('invariants hold after 20 warm-up cycles (aged deck state)', () =>
  {
    const mgr = new AudioManager();
    collect(mgr, 80);               // discard 20 warm-up cycles
    const phrases = collect(mgr, 40);  // check the next 10

    for (let cycle = 0; cycle < 10; cycle++)
    {
      const slice = phrases.slice(cycle * 4, cycle * 4 + 4);
      expect(new Set(slice), `aged cycle ${cycle}`).toEqual(ALL_PHRASES);
    }
  });
});
