/**
 * collision.test.ts
 *
 * Tests the roadside collision and near-miss detection system.
 *
 * Architecture overview
 * ──────────────────────
 * The OutRun collision model is purely 1-dimensional: the lateral distance
 * between the player's world X and each sprite's world X is compared against
 * the sprite's family-specific hitbox radius.  There is no depth component —
 * a sprite is "hit" as soon as the player passes its segment number (within a
 * COLLISION_WINDOW of [-1, 0, +1, +2] segments).
 *
 * Three contracts are tested:
 *
 *   1. Family config integrity — FAMILY_CONFIG drives all three properties
 *      (CollisionClass, hitboxRadius, blockRadius) from one authoritative table.
 *      getBlockingRadius reflects that table; the invariant blockRadius < hitboxRadius
 *      ensures the solid wall activates while the player is already inside the
 *      detection zone.
 *
 *   2. checkSegmentCollision — per-segment detection:
 *      on-road immunity, same-side filtering, ghost skipping, severity ranking
 *      when multiple sprites overlap, near-miss band detection.
 *
 *   3. checkCollisions — COLLISION_WINDOW scan:
 *      hits found on every offset in the window, NOT found outside the window.
 *
 * Test value rationale:
 *   OFF_ROAD_RIGHT = 1.2 normalised — above COLLISION_MIN_OFFSET (1.0) so
 *   collision detection is active, but well below 2.0 (world boundary).
 *   All sprite worldX values are expressed as multiples of the hitbox radius
 *   so tests remain valid if the radius constants are tuned.
 */

import { describe, it, expect } from 'vitest';
import {
  checkSegmentCollision,
  checkCollisions,
  getBlockingRadius,
  CollisionClass,
} from '../src/collision';
import {
  ROAD_WIDTH,
  COLLISION_MIN_OFFSET,
  NEAR_MISS_RATIO,
  HITBOX_CACTUS, HITBOX_PALM, HITBOX_BILLBOARD, HITBOX_HOUSE,
  BLOCK_SMACK, BLOCK_HOUSE,
  COLLISION_WINDOW,
  SEGMENT_LENGTH,
} from '../src/constants';
import type { RoadSegment, SpriteInstance, SpriteFamily } from '../src/types';

// ── Minimal test-object builders ──────────────────────────────────────────────

/**
 * Builds a bare RoadSegment with no sprites (or an optional sprite list).
 * Only the fields used by checkSegmentCollision are populated — all other
 * geometry fields are zeroed so tests remain readable without noise.
 */
function makeSeg(index: number, sprites?: SpriteInstance[]): RoadSegment
{
  return {
    index,
    p1: { world: { x: 0, y: 0, z: index * SEGMENT_LENGTH }, screen: { x: 0, y: 0, w: 0, scale: 0 } },
    p2: { world: { x: 0, y: 0, z: (index + 1) * SEGMENT_LENGTH }, screen: { x: 0, y: 0, w: 0, scale: 0 } },
    curve: 0,
    color: { road: '#888', grass: '#0a0', rumble: '#c00', lane: '#ccc' },
    sprites,
  };
}

/**
 * Builds a SpriteInstance on the right side of the road (positive worldX).
 * The id is synthesised as `family_0` — collision detection uses the family,
 * not the id, so any non-empty string works.
 */
function makeSprite(family: SpriteFamily, worldX: number): SpriteInstance
{
  return { id: `${family}_0`, family, worldX };
}

// Player is 1.2 road-widths to the right — off-road, within collision range.
// Using a normalised value slightly above COLLISION_MIN_OFFSET (1.0) means
// collision detection is active but the player is not in the far void (> 2.0).
const OFF_ROAD_RIGHT = 1.2;                          // normalised, > COLLISION_MIN_OFFSET
const PLAYER_WORLD_X = OFF_ROAD_RIGHT * ROAD_WIDTH;  // world units

// ── getBlockingRadius ─────────────────────────────────────────────────────────
//
// getBlockingRadius returns the "solid wall" radius for a sprite family.
// When the player's lateral distance to a sprite falls below blockRadius, the
// player cannot move further into the sprite (lateral momentum is cancelled).
// Ghost families (shrub, sign) have blockRadius = 0 — they are completely
// passable, which is why they are called Ghosts.

describe('getBlockingRadius', () =>
{
  /**
   * Palm and billboard are Smack-class obstacles that also have a solid wall
   * radius (BLOCK_SMACK).  The wall is narrower than the hitbox so the player
   * is already inside the detection zone before the wall activates, giving
   * the collision code a frame to resolve the hit before hard-stopping movement.
   */
  it('returns BLOCK_SMACK for palm', () =>
    expect(getBlockingRadius('palm')).toBe(BLOCK_SMACK));

  it('returns BLOCK_SMACK for billboard', () =>
    expect(getBlockingRadius('billboard')).toBe(BLOCK_SMACK));

  /**
   * House is a Crunch-class obstacle with a wider solid wall (BLOCK_HOUSE > BLOCK_SMACK).
   * A wider wall reflects the house's larger footprint — the player cannot
   * drive through the side of a building as easily as past a palm tree.
   */
  it('returns BLOCK_HOUSE for house', () =>
    expect(getBlockingRadius('house')).toBe(BLOCK_HOUSE));

  /**
   * Cactus is a Glance-class obstacle — it damages and nudges but has no
   * solid wall (blockRadius = 0).  The player can drive through a cactus patch
   * without being physically stopped, which feels more natural for vegetation.
   */
  it('returns 0 for cactus (glance — no solid wall)', () =>
    expect(getBlockingRadius('cactus')).toBe(0));

  /**
   * Shrub is a Ghost-class sprite: completely decorative, no collision at all.
   * blockRadius = 0 means the player passes straight through it with no effect.
   */
  it('returns 0 for shrub (ghost)', () =>
    expect(getBlockingRadius('shrub')).toBe(0));

  /**
   * Sign is also Ghost-class: roadside signage is decorative only.
   */
  it('returns 0 for sign (ghost)', () =>
    expect(getBlockingRadius('sign')).toBe(0));

  /**
   * The blockRadius < hitboxRadius invariant is load-bearing for the collision
   * resolution loop.  If blockRadius >= hitboxRadius, the wall would activate
   * at exactly the hitbox boundary — the player would be stopped before any
   * collision class is detected, making the hit class completely unenforceable.
   *
   * This test iterates over every "solid" family and checks the relationship,
   * so a designer who increases blockRadius past hitboxRadius for any family
   * gets an immediate test failure rather than a subtle runtime bug.
   */
  it('block radius < hitbox radius for every solid family', () =>
  {
    const solidFamilies: SpriteFamily[] = ['palm', 'billboard', 'cookie', 'barney', 'big', 'house'];
    const hitboxes: Record<string, number> = {
      palm: HITBOX_PALM, billboard: HITBOX_BILLBOARD,
      cookie: HITBOX_PALM, barney: HITBOX_PALM, big: HITBOX_PALM,
      house: HITBOX_HOUSE,
    };
    for (const f of solidFamilies)
    {
      expect(getBlockingRadius(f)).toBeLessThan(hitboxes[f]);
    }
  });
});

// ── checkSegmentCollision ─────────────────────────────────────────────────────
//
// checkSegmentCollision scans a single RoadSegment's sprite list.
// It returns { hit: StaticHitDescriptor | null, nearMiss: boolean | null }.
// The key design decisions under test:
//   - On-road players are completely immune (no collision triggers at all).
//   - Opposite-side sprites are skipped (sign convention: player is right-side,
//     sprite at worldX < 0 is left-side — different side, no collision).
//   - The worst hit wins when multiple sprites overlap the player.
//   - A near-miss band extends from hitboxRadius to hitboxRadius × NEAR_MISS_RATIO.

describe('checkSegmentCollision', () =>
{
  // ── On-road immunity ────────────────────────────────────────────────────────

  /**
   * |playerX| < COLLISION_MIN_OFFSET (1.0) means the player is fully on the
   * road surface.  No collision should fire regardless of what sprites exist on
   * the segment — the road itself provides immunity.
   *
   * playerX = 0.5 is well within the immunity zone.  Even a palm placed
   * directly at the player's world position must not register.
   */
  it('returns null when playerX is fully on-road (< COLLISION_MIN_OFFSET)', () =>
  {
    const seg = makeSeg(0, [makeSprite('palm', 2000)]);
    // playerX = 0.5 — well inside COLLISION_MIN_OFFSET (1.0)
    const { hit, nearMiss } = checkSegmentCollision(0.5, seg);
    expect(hit).toBeNull();
    expect(nearMiss).toBeNull();
  });

  /**
   * The on-road immunity guard is `Math.abs(playerX) < COLLISION_MIN_OFFSET`
   * — STRICTLY less than.  At exactly COLLISION_MIN_OFFSET the collision path
   * runs normally.  This boundary test ensures the guard does not use `<=`,
   * which would grant immunity one unit too wide.
   */
  it('can detect a hit when playerX is exactly at COLLISION_MIN_OFFSET (boundary is not immune)', () =>
  {
    // The guard is `Math.abs(playerX) < COLLISION_MIN_OFFSET` — strictly less than.
    // Exactly at the boundary the collision path runs normally.
    const seg = makeSeg(0, [makeSprite('palm', COLLISION_MIN_OFFSET * ROAD_WIDTH)]);
    const { hit } = checkSegmentCollision(COLLISION_MIN_OFFSET, seg);
    expect(hit?.cls).toBe(CollisionClass.Smack);
  });

  // ── Ghost sprites are always ignored ───────────────────────────────────────

  /**
   * Shrub (Ghost class) placed directly on the player's world position must
   * produce no hit.  Ghost sprites are purely decorative — roadside bushes
   * do not damage the car.  If ghosts caused hits, the roadside scenery would
   * feel like an unfair invisible minefield.
   */
  it('ignores shrub sprites (ghost family)', () =>
  {
    // Sprite placed directly at the player's world position — would be a hit if not ghost.
    const seg = makeSeg(0, [makeSprite('shrub', PLAYER_WORLD_X)]);
    const { hit } = checkSegmentCollision(OFF_ROAD_RIGHT, seg);
    expect(hit).toBeNull();
  });

  /**
   * Sign (Ghost class) must also be ignored.  Road signs are navigational
   * decoration — running through them would be absurd physics.
   */
  it('ignores sign sprites (ghost family)', () =>
  {
    const seg = makeSeg(0, [makeSprite('sign', PLAYER_WORLD_X)]);
    const { hit } = checkSegmentCollision(OFF_ROAD_RIGHT, seg);
    expect(hit).toBeNull();
  });

  // ── Same-side filtering ─────────────────────────────────────────────────────

  /**
   * Sprites on the opposite side of the road from the player must be skipped.
   * The player is off-road RIGHT (positive playerX); a sprite at negative
   * worldX is on the LEFT shoulder.  Without this filter, every left-side
   * obstacle would collide with a right-side player at the same Z — the
   * collision system would fire constantly regardless of lateral position.
   */
  it('does not fire for a sprite on the opposite side of the road', () =>
  {
    // Player is off-road RIGHT; sprite is on the LEFT (negative worldX).
    const seg = makeSeg(0, [makeSprite('palm', -PLAYER_WORLD_X)]);
    const { hit } = checkSegmentCollision(OFF_ROAD_RIGHT, seg);
    expect(hit).toBeNull();
  });

  // ── Collision classes ──────────────────────────────────────────────────────

  /**
   * Cactus at delta = 0.5 × HITBOX_CACTUS (inside the radius) must produce
   * a Glance hit.  Glance is the lightest class: minor speed reduction, short
   * cooldown, small screen shake.
   */
  it('detects glance for cactus within HITBOX_CACTUS', () =>
  {
    // Place cactus just inside the hitbox zone
    const spriteX = PLAYER_WORLD_X + HITBOX_CACTUS * 0.5;
    const seg = makeSeg(0, [makeSprite('cactus', spriteX)]);
    const { hit } = checkSegmentCollision(OFF_ROAD_RIGHT, seg);
    expect(hit?.cls).toBe(CollisionClass.Glance);
  });

  /**
   * Palm within HITBOX_PALM must produce a Smack — the "medium" collision
   * class.  Smack represents a solid tree impact: significant speed reduction,
   * lateral bounce, recovery boost window.
   */
  it('detects smack for palm within HITBOX_PALM', () =>
  {
    const spriteX = PLAYER_WORLD_X + HITBOX_PALM * 0.5;
    const seg = makeSeg(0, [makeSprite('palm', spriteX)]);
    const { hit } = checkSegmentCollision(OFF_ROAD_RIGHT, seg);
    expect(hit?.cls).toBe(CollisionClass.Smack);
  });

  /**
   * Billboard uses HITBOX_BILLBOARD which is wider than HITBOX_PALM.
   * A sprite placed at distance (HITBOX_PALM + HITBOX_BILLBOARD) / 2 is:
   *   - Inside HITBOX_BILLBOARD → should be a Smack
   *   - Outside HITBOX_PALM    → would NOT be a Smack if using palm's radius
   * This verifies the family-to-hitbox lookup is used, not a hardcoded value.
   */
  it('detects smack for billboard using HITBOX_BILLBOARD (wider than palm)', () =>
  {
    // Billboard hitbox (700) > palm hitbox (550).  Place sprite at a distance that
    // would miss a palm but hit a billboard.
    const spriteX = PLAYER_WORLD_X + (HITBOX_PALM + HITBOX_BILLBOARD) / 2;
    const seg = makeSeg(0, [makeSprite('billboard', spriteX)]);
    const { hit } = checkSegmentCollision(OFF_ROAD_RIGHT, seg);
    expect(hit?.cls).toBe(CollisionClass.Smack);
  });

  /**
   * House within HITBOX_HOUSE must produce a Crunch — the most severe class.
   * Crunch triggers the long grind phase, heavy speed penalty, and most
   * intense screen shake.  Using the wrong class here would make houses
   * feel identical to palm trees.
   */
  it('detects crunch for house within HITBOX_HOUSE', () =>
  {
    const spriteX = PLAYER_WORLD_X + HITBOX_HOUSE * 0.5;
    const seg = makeSeg(0, [makeSprite('house', spriteX)]);
    const { hit } = checkSegmentCollision(OFF_ROAD_RIGHT, seg);
    expect(hit?.cls).toBe(CollisionClass.Crunch);
  });

  // ── bumpDir ────────────────────────────────────────────────────────────────

  /**
   * bumpDir = +1 when the sprite is to the RIGHT of the player (sprite worldX
   * > player worldX).  The collision response uses bumpDir to determine which
   * direction to launch the lateral slide: -bumpDir gives the rebound direction.
   * Wrong bumpDir would push the player into the obstacle rather than away.
   */
  it('bumpDir is +1 when sprite is to the right of player', () =>
  {
    // Sprite further right than player → bump pushes player left
    const spriteX = PLAYER_WORLD_X + 100;
    const seg = makeSeg(0, [makeSprite('palm', spriteX)]);
    const { hit } = checkSegmentCollision(OFF_ROAD_RIGHT, seg);
    expect(hit?.bumpDir).toBe(+1);
  });

  /**
   * bumpDir = -1 when the sprite is to the LEFT of the player (both still on
   * the same side of the road — both positive worldX).  This tests that bumpDir
   * reflects the relative position, not just the absolute sign of worldX.
   */
  it('bumpDir is -1 when sprite is to the left of player (still same side)', () =>
  {
    // Sprite slightly left of player (but both positive = same side)
    const spriteX = PLAYER_WORLD_X - 100;
    const seg = makeSeg(0, [makeSprite('palm', spriteX)]);
    const { hit } = checkSegmentCollision(OFF_ROAD_RIGHT, seg);
    expect(hit?.bumpDir).toBe(-1);
  });

  // ── Near-miss band ─────────────────────────────────────────────────────────

  /**
   * The near-miss band extends from hitboxRadius to hitboxRadius × NEAR_MISS_RATIO.
   * A sprite in this band produces nearMiss = true and hit = null.
   *
   * delta = HITBOX_PALM × 1.2 places the sprite at 660 wu from the player.
   * That is:
   *   > HITBOX_PALM (550) → outside the hit zone (no collision)
   *   < HITBOX_PALM × NEAR_MISS_RATIO (550 × 1.5 = 825) → inside near-miss zone
   *
   * Near misses trigger the score multiplier and audio cue without damage —
   * essential for the OutRun feel of "threading through traffic".
   */
  it('returns near-miss when delta is between hitboxRadius and hitboxRadius × NEAR_MISS_RATIO', () =>
  {
    // delta must be > HITBOX_PALM (550) and < HITBOX_PALM * NEAR_MISS_RATIO (825)
    const delta   = HITBOX_PALM * 1.2;                 // 660 — inside the near-miss zone
    const spriteX = PLAYER_WORLD_X + delta;
    const seg = makeSeg(0, [makeSprite('palm', spriteX)]);
    const { hit, nearMiss } = checkSegmentCollision(OFF_ROAD_RIGHT, seg);
    expect(hit).toBeNull();
    expect(nearMiss).not.toBeNull();
  });

  /**
   * Beyond NEAR_MISS_RATIO × hitboxRadius the sprite is simply not close enough
   * to register anything.  Both hit and nearMiss must be null — the sprite is
   * invisible to the collision system at this distance.
   */
  it('returns null (no near-miss) when sprite is beyond NEAR_MISS_RATIO × hitboxRadius', () =>
  {
    const delta   = HITBOX_PALM * NEAR_MISS_RATIO + 50; // outside even the near-miss zone
    const spriteX = PLAYER_WORLD_X + delta;
    const seg = makeSeg(0, [makeSprite('palm', spriteX)]);
    const { hit, nearMiss } = checkSegmentCollision(OFF_ROAD_RIGHT, seg);
    expect(hit).toBeNull();
    expect(nearMiss).toBeNull();
  });

  // ── Severity ranking (worst hit wins) ─────────────────────────────────────

  /**
   * When multiple sprites overlap the player on the same segment, the worst
   * CollisionClass wins.  Crunch > Smack > Glance > Ghost (ordered by numeric
   * enum value).
   *
   * A cactus (Glance) and a house (Crunch) at the same position: Crunch must
   * be returned.  Without severity ranking, the result would depend on array
   * order — the first matching sprite would win, producing non-deterministic
   * collision class selection.
   */
  it('returns the worst hit when multiple sprites overlap the player', () =>
  {
    // Both a cactus (glance) and a house (crunch) directly at the player.
    const seg = makeSeg(0, [
      makeSprite('cactus', PLAYER_WORLD_X),
      makeSprite('house',  PLAYER_WORLD_X),
    ]);
    const { hit } = checkSegmentCollision(OFF_ROAD_RIGHT, seg);
    // Crunch > glance — house must win
    expect(hit?.cls).toBe(CollisionClass.Crunch);
  });

  /**
   * A near-miss must be suppressed when a full hit exists on the same segment.
   * The near-miss would be a false positive in this case — the player didn't
   * "just miss" anything; they hit something.  Reporting both would trigger
   * both the score-bonus AND the damage penalty simultaneously, which is
   * logically inconsistent.
   */
  it('near-miss is suppressed when a full hit is found on the same segment', () =>
  {
    // Palm at exact player position (full hit) + another palm in near-miss zone
    const seg = makeSeg(0, [
      makeSprite('palm', PLAYER_WORLD_X),
      makeSprite('palm', PLAYER_WORLD_X + HITBOX_PALM * 1.2),
    ]);
    const { hit, nearMiss } = checkSegmentCollision(OFF_ROAD_RIGHT, seg);
    expect(hit?.cls).toBe(CollisionClass.Smack);
    expect(nearMiss).toBeNull();
  });
});

// ── checkCollisions — COLLISION_WINDOW scan ───────────────────────────────────
//
// checkCollisions loops over COLLISION_WINDOW offsets relative to the player's
// current segment, calling checkSegmentCollision for each.  The window is
// [-1, 0, +1, +2] — one behind and two ahead — to account for the player
// spanning segment boundaries at high speed.

describe('checkCollisions', () =>
{
  /**
   * Build a minimal segment array large enough for the window scan.
   * COLLISION_WINDOW = [-1, 0, 1, 2] so we need at least playerSegIdx + 2 entries.
   * spritesAt maps segment index → sprite list; all other segments are empty.
   */
  function makeSegArray(count: number, spritesAt: Map<number, SpriteInstance[]>): RoadSegment[]
  {
    return Array.from({ length: count }, (_, i) =>
      makeSeg(i, spritesAt.get(i)),
    );
  }

  /**
   * An empty track (no sprites anywhere) must produce null for both hit and
   * nearMiss.  This is the trivial no-op case that ensures the function doesn't
   * generate false positives from uninitialized state.
   */
  it('returns null when no sprites exist anywhere', () =>
  {
    const segs   = makeSegArray(20, new Map());
    const result = checkCollisions(OFF_ROAD_RIGHT, segs, segs.length, 5);
    expect(result.hit).toBeNull();
    expect(result.nearMiss).toBeNull();
  });

  /**
   * Each offset in COLLISION_WINDOW = [-1, 0, +1, +2] must be scanned.
   * This parametric test places a single palm at each offset independently
   * and verifies a hit is detected.  If any offset were skipped, the player
   * could clip through sprites on that segment with no collision.
   *
   * The loop generates one test case per offset — if COLLISION_WINDOW is
   * changed in constants.ts, the test set automatically adapts.
   */
  const windowOffsets = COLLISION_WINDOW as readonly number[];

  for (const offset of windowOffsets)
  {
    it(`detects hit on segment at playerSeg + ${offset} (inside COLLISION_WINDOW)`, () =>
    {
      const playerSeg = 10;
      const targetSeg = playerSeg + offset;
      const sprites   = new Map([[targetSeg, [makeSprite('palm', PLAYER_WORLD_X)]]]);
      const segs      = makeSegArray(20, sprites);
      const { hit }   = checkCollisions(OFF_ROAD_RIGHT, segs, segs.length, playerSeg);
      expect(hit?.cls).toBe(CollisionClass.Smack);
    });
  }

  /**
   * Segments at playerSeg + 3 (one beyond the +2 window edge) must NOT be
   * scanned.  Extending the window accidentally would cause the player to be
   * hit by sprites they have not yet reached — "pre-hit" would feel completely
   * wrong and uncontrollable.
   */
  it('does NOT detect a hit on a segment outside the window (playerSeg + 3)', () =>
  {
    const playerSeg = 5;
    const outsideSeg = playerSeg + 3;   // COLLISION_WINDOW goes up to +2
    const sprites   = new Map([[outsideSeg, [makeSprite('palm', PLAYER_WORLD_X)]]]);
    const segs      = makeSegArray(15, sprites);
    const { hit }   = checkCollisions(OFF_ROAD_RIGHT, segs, segs.length, playerSeg);
    expect(hit).toBeNull();
  });

  /**
   * When hits exist on multiple window offsets, the worst class across the
   * entire window must be returned — not the first one found.  A cactus on
   * offset 0 (Glance) and a house on offset +1 (Crunch): Crunch must win.
   * Without cross-window severity ranking, the hit class would depend on
   * which offset happens to be checked first.
   */
  it('returns the worst hit across the entire window', () =>
  {
    // Glance on offset 0, crunch on offset +1 — crunch must win.
    const playerSeg = 5;
    const sprites   = new Map([
      [playerSeg,     [makeSprite('cactus', PLAYER_WORLD_X)]],
      [playerSeg + 1, [makeSprite('house',  PLAYER_WORLD_X)]],
    ]);
    const segs    = makeSegArray(15, sprites);
    const { hit } = checkCollisions(OFF_ROAD_RIGHT, segs, segs.length, playerSeg);
    expect(hit?.cls).toBe(CollisionClass.Crunch);
  });
});
