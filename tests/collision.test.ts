/**
 * collision.test.ts
 *
 * Tests the roadside collision and near-miss detection system.
 *
 * Three contracts:
 *
 *   1. Family config integrity — FAMILY_CONFIG drives all three properties
 *      (class, hitbox, block radius) from one place; verify the values are
 *      logically consistent and getBlockingRadius reflects the table.
 *
 *   2. checkSegmentCollision — per-segment hit/near-miss detection:
 *      on-road immunity, same-side filtering, ghost skipping, severity
 *      ranking when multiple sprites are present, near-miss band.
 *
 *   3. checkCollisions — COLLISION_WINDOW scan: verifies hits are found
 *      on all four offsets and NOT found on out-of-window segments.
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

/** Bare RoadSegment with no sprites. */
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

/** Sprite on the right side of the road at the given world X. */
function makeSprite(family: SpriteFamily, worldX: number): SpriteInstance
{
  return { id: `${family}_0`, family, worldX };
}

// Convenient normalised player position just past the road edge (off-road right)
const OFF_ROAD_RIGHT = 1.2;                          // normalised, > COLLISION_MIN_OFFSET
const PLAYER_WORLD_X = OFF_ROAD_RIGHT * ROAD_WIDTH;  // world units

// ── getBlockingRadius ─────────────────────────────────────────────────────────

describe('getBlockingRadius', () =>
{
  it('returns BLOCK_SMACK for palm', () =>
    expect(getBlockingRadius('palm')).toBe(BLOCK_SMACK));

  it('returns BLOCK_SMACK for billboard', () =>
    expect(getBlockingRadius('billboard')).toBe(BLOCK_SMACK));

  it('returns BLOCK_HOUSE for house', () =>
    expect(getBlockingRadius('house')).toBe(BLOCK_HOUSE));

  it('returns 0 for cactus (glance — no solid wall)', () =>
    expect(getBlockingRadius('cactus')).toBe(0));

  it('returns 0 for shrub (ghost)', () =>
    expect(getBlockingRadius('shrub')).toBe(0));

  it('returns 0 for sign (ghost)', () =>
    expect(getBlockingRadius('sign')).toBe(0));

  /**
   * blockRadius must always be strictly less than hitboxRadius so the player
   * is inside the detection zone when the solid wall activates.
   * If blockRadius >= hitboxRadius the "delta < hitboxRadius" check in
   * checkSegmentCollision fires at exactly the wall boundary and the wall
   * feels transparent.
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

describe('checkSegmentCollision', () =>
{
  // ── On-road immunity ────────────────────────────────────────────────────────

  it('returns null when playerX is fully on-road (< COLLISION_MIN_OFFSET)', () =>
  {
    const seg = makeSeg(0, [makeSprite('palm', 2000)]);
    // playerX = 0.5 — well inside COLLISION_MIN_OFFSET (1.0)
    const { hit, nearMiss } = checkSegmentCollision(0.5, seg);
    expect(hit).toBeNull();
    expect(nearMiss).toBeNull();
  });

  it('can detect a hit when playerX is exactly at COLLISION_MIN_OFFSET (boundary is not immune)', () =>
  {
    // The guard is `Math.abs(playerX) < COLLISION_MIN_OFFSET` — strictly less than.
    // Exactly at the boundary the collision path runs normally.
    const seg = makeSeg(0, [makeSprite('palm', COLLISION_MIN_OFFSET * ROAD_WIDTH)]);
    const { hit } = checkSegmentCollision(COLLISION_MIN_OFFSET, seg);
    expect(hit?.cls).toBe(CollisionClass.Smack);
  });

  // ── Ghost sprites are always ignored ───────────────────────────────────────

  it('ignores shrub sprites (ghost family)', () =>
  {
    // Sprite placed directly at the player's world position — would be a hit if not ghost.
    const seg = makeSeg(0, [makeSprite('shrub', PLAYER_WORLD_X)]);
    const { hit } = checkSegmentCollision(OFF_ROAD_RIGHT, seg);
    expect(hit).toBeNull();
  });

  it('ignores sign sprites (ghost family)', () =>
  {
    const seg = makeSeg(0, [makeSprite('sign', PLAYER_WORLD_X)]);
    const { hit } = checkSegmentCollision(OFF_ROAD_RIGHT, seg);
    expect(hit).toBeNull();
  });

  // ── Same-side filtering ─────────────────────────────────────────────────────

  it('does not fire for a sprite on the opposite side of the road', () =>
  {
    // Player is off-road RIGHT; sprite is on the LEFT (negative worldX).
    const seg = makeSeg(0, [makeSprite('palm', -PLAYER_WORLD_X)]);
    const { hit } = checkSegmentCollision(OFF_ROAD_RIGHT, seg);
    expect(hit).toBeNull();
  });

  // ── Collision classes ──────────────────────────────────────────────────────

  it('detects glance for cactus within HITBOX_CACTUS', () =>
  {
    // Place cactus just inside the hitbox zone
    const spriteX = PLAYER_WORLD_X + HITBOX_CACTUS * 0.5;
    const seg = makeSeg(0, [makeSprite('cactus', spriteX)]);
    const { hit } = checkSegmentCollision(OFF_ROAD_RIGHT, seg);
    expect(hit?.cls).toBe(CollisionClass.Glance);
  });

  it('detects smack for palm within HITBOX_PALM', () =>
  {
    const spriteX = PLAYER_WORLD_X + HITBOX_PALM * 0.5;
    const seg = makeSeg(0, [makeSprite('palm', spriteX)]);
    const { hit } = checkSegmentCollision(OFF_ROAD_RIGHT, seg);
    expect(hit?.cls).toBe(CollisionClass.Smack);
  });

  it('detects smack for billboard using HITBOX_BILLBOARD (wider than palm)', () =>
  {
    // Billboard hitbox (700) > palm hitbox (550).  Place sprite at a distance that
    // would miss a palm but hit a billboard.
    const spriteX = PLAYER_WORLD_X + (HITBOX_PALM + HITBOX_BILLBOARD) / 2;
    const seg = makeSeg(0, [makeSprite('billboard', spriteX)]);
    const { hit } = checkSegmentCollision(OFF_ROAD_RIGHT, seg);
    expect(hit?.cls).toBe(CollisionClass.Smack);
  });

  it('detects crunch for house within HITBOX_HOUSE', () =>
  {
    const spriteX = PLAYER_WORLD_X + HITBOX_HOUSE * 0.5;
    const seg = makeSeg(0, [makeSprite('house', spriteX)]);
    const { hit } = checkSegmentCollision(OFF_ROAD_RIGHT, seg);
    expect(hit?.cls).toBe(CollisionClass.Crunch);
  });

  // ── bumpDir ────────────────────────────────────────────────────────────────

  it('bumpDir is +1 when sprite is to the right of player', () =>
  {
    // Sprite further right than player → bump pushes player left
    const spriteX = PLAYER_WORLD_X + 100;
    const seg = makeSeg(0, [makeSprite('palm', spriteX)]);
    const { hit } = checkSegmentCollision(OFF_ROAD_RIGHT, seg);
    expect(hit?.bumpDir).toBe(+1);
  });

  it('bumpDir is -1 when sprite is to the left of player (still same side)', () =>
  {
    // Sprite slightly left of player (but both positive = same side)
    const spriteX = PLAYER_WORLD_X - 100;
    const seg = makeSeg(0, [makeSprite('palm', spriteX)]);
    const { hit } = checkSegmentCollision(OFF_ROAD_RIGHT, seg);
    expect(hit?.bumpDir).toBe(-1);
  });

  // ── Near-miss band ─────────────────────────────────────────────────────────

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

describe('checkCollisions', () =>
{
  /**
   * Build a minimal segment array large enough for the window scan.
   * COLLISION_WINDOW = [-1, 0, 1, 2] so we need at least playerSegIdx + 2 entries.
   */
  function makeSegArray(count: number, spritesAt: Map<number, SpriteInstance[]>): RoadSegment[]
  {
    return Array.from({ length: count }, (_, i) =>
      makeSeg(i, spritesAt.get(i)),
    );
  }

  it('returns null when no sprites exist anywhere', () =>
  {
    const segs   = makeSegArray(20, new Map());
    const result = checkCollisions(OFF_ROAD_RIGHT, segs, segs.length, 5);
    expect(result.hit).toBeNull();
    expect(result.nearMiss).toBeNull();
  });

  /**
   * COLLISION_WINDOW = [-1, 0, 1, 2].
   * All four offsets must be scanned — test each one independently.
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

  it('does NOT detect a hit on a segment outside the window (playerSeg + 3)', () =>
  {
    const playerSeg = 5;
    const outsideSeg = playerSeg + 3;   // COLLISION_WINDOW goes up to +2
    const sprites   = new Map([[outsideSeg, [makeSprite('palm', PLAYER_WORLD_X)]]]);
    const segs      = makeSegArray(15, sprites);
    const { hit }   = checkCollisions(OFF_ROAD_RIGHT, segs, segs.length, playerSeg);
    expect(hit).toBeNull();
  });

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
