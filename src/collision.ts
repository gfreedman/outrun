/**
 * collision.ts
 *
 * Roadside object collision classification and detection.
 *
 * This module answers two questions per frame:
 *   1. Which collision class does a given SpriteId belong to?
 *   2. Is the player currently overlapping any sprite on their segment window?
 *
 * All values are pure functions — no state lives here. State (cooldown timers,
 * grind timers, shake timers) lives in game.ts alongside the physics simulation.
 */

import { CollisionClass, RoadSegment, SpriteFamily } from './types';
import {
  ROAD_WIDTH,
  HITBOX_CACTUS, HITBOX_PALM, HITBOX_BILLBOARD, HITBOX_HOUSE,
  BLOCK_SMACK, BLOCK_HOUSE,
  NEAR_MISS_RATIO, COLLISION_MIN_OFFSET,
  COLLISION_WINDOW,
} from './constants';

export { CollisionClass };

// ── Classification tables — O(1) lookup by family ────────────────────────────
//
// Now that sprites carry a pre-classified family field (set at placement time
// in road.ts), all collision checks use direct property lookup instead of
// repeated id.startsWith() chains in the hot path.

/** Maps sprite family to its collision class. */
const FAMILY_COLLISION_CLASS: Record<SpriteFamily, CollisionClass> =
{
  palm:      CollisionClass.Smack,
  billboard: CollisionClass.Smack,
  cookie:    CollisionClass.Smack,
  barney:    CollisionClass.Smack,
  big:       CollisionClass.Smack,
  cactus:    CollisionClass.Glance,
  shrub:     CollisionClass.Ghost,
  sign:      CollisionClass.Ghost,
  house:     CollisionClass.Crunch,
};

/**
 * Maps sprite family to its lateral detection hitbox (world units).
 * Billboards use HITBOX_BILLBOARD (700) — wider than palms (550) because the
 * sign face extends further from the post.  HITBOX_BILLBOARD was previously
 * defined but unconnected; this table makes it active (M8).
 */
const FAMILY_HITBOX_RADIUS: Record<SpriteFamily, number> =
{
  palm:      HITBOX_PALM,
  billboard: HITBOX_BILLBOARD,   // 700 > 550 — wider than a palm trunk
  cookie:    HITBOX_PALM,
  barney:    HITBOX_PALM,
  big:       HITBOX_PALM,
  cactus:    HITBOX_CACTUS,
  shrub:     0,
  sign:      0,
  house:     HITBOX_HOUSE,
};

/** Maps sprite family to its physical blocking radius (world units). */
const FAMILY_BLOCKING_RADIUS: Record<SpriteFamily, number> =
{
  palm:      BLOCK_SMACK,
  billboard: BLOCK_SMACK,
  cookie:    BLOCK_SMACK,
  barney:    BLOCK_SMACK,
  big:       BLOCK_SMACK,
  cactus:    0,
  shrub:     0,
  sign:      0,
  // BLOCK_HOUSE < HITBOX_HOUSE — keeps player inside detection zone at the wall.
  house:     BLOCK_HOUSE,
};

/**
 * Returns the physical blocking radius (world units) for a sprite family.
 * Used by game.ts to prevent the player from phasing through solid objects.
 */
export function getBlockingRadius(family: SpriteFamily): number
{
  return FAMILY_BLOCKING_RADIUS[family];
}

// ── Module-level constants (hoisted to avoid per-frame allocation) ────────────

// COLLISION_WINDOW imported from constants — see that file for the asymmetry explanation (L5).

/**
 * Severity rank for each collision class.
 * Used instead of CLASS_ORDER.indexOf() to avoid O(n) linear scans per comparison.
 */
const CLASS_RANK: Record<CollisionClass, number> =
{
  [CollisionClass.Ghost]:  0,
  [CollisionClass.Glance]: 1,
  [CollisionClass.Smack]:  2,
  [CollisionClass.Crunch]: 3,
};

// ── Hit result ────────────────────────────────────────────────────────────────

export interface HitResult
{
  /** The severity class of the collision. */
  cls:     CollisionClass;
  /**
   * Direction of the impacted sprite from the player.
   * +1 = sprite was to the RIGHT (bump pushes left away from it).
   * -1 = sprite was to the LEFT  (bump pushes right away from it).
   */
  bumpDir: number;
}

export interface NearMissResult
{
  /** Tiny lateral wobble direction (+1 or -1). */
  wobbleDir: number;
}

// ── Detection ─────────────────────────────────────────────────────────────────

/**
 * Scans a single road segment's sprites for a collision or near-miss.
 *
 * Returns the WORST (highest severity) collision found, or null.
 * Near-miss is only returned when no full hit is found.
 *
 * @param playerX  - Normalised lateral position (0 = centre, ±1 = road edges).
 * @param segment  - The road segment to inspect.
 */
export function checkSegmentCollision(
  playerX: number,
  segment: RoadSegment,
): { hit: HitResult | null; nearMiss: NearMissResult | null }
{
  // Collisions only fire when at or past the road edge — prevents on-road
  // drivers from clipping objects placed just off the road (worldX 2000-2400).
  if (Math.abs(playerX) < COLLISION_MIN_OFFSET) return { hit: null, nearMiss: null };

  const playerWorldX = playerX * ROAD_WIDTH;

  let worstHit: HitResult | null      = null;
  let nearMiss: NearMissResult | null = null;

  for (const sprite of segment.sprites ?? [])
  {
    const cls = FAMILY_COLLISION_CLASS[sprite.family];
    if (cls === CollisionClass.Ghost) continue;

    const radius   = FAMILY_HITBOX_RADIUS[sprite.family];
    const delta    = Math.abs(playerWorldX - sprite.worldX);
    const sameSide = Math.sign(playerWorldX) === Math.sign(sprite.worldX);

    if (!sameSide) continue;

    if (delta < radius)
    {
      const bumpDir = sprite.worldX > playerWorldX ? +1 : -1;
      if (worstHit === null || CLASS_RANK[cls] > CLASS_RANK[worstHit.cls])
        worstHit = { cls, bumpDir };
    }
    else if (delta < radius * NEAR_MISS_RATIO && worstHit === null)
    {
      nearMiss = { wobbleDir: sprite.worldX > playerWorldX ? +1 : -1 };
    }
  }

  return { hit: worstHit, nearMiss };
}

/**
 * Checks a window of segments around the player's current position.
 *
 * Returns the worst hit found across the window, or null if clear.
 * Near-miss returns the first one found (only when no full hit anywhere).
 *
 * @param playerX       - Normalised lateral position.
 * @param segments      - Full road segment array.
 * @param segmentCount  - Total number of segments (for modulo wrap).
 * @param playerSegIdx  - Index of the segment the player is currently on.
 */
export function checkCollisions(
  playerX:      number,
  segments:     readonly RoadSegment[],
  segmentCount: number,
  playerSegIdx: number,
): { hit: HitResult | null; nearMiss: NearMissResult | null }
{
  let worstHit:      HitResult | null      = null;
  let firstNearMiss: NearMissResult | null = null;

  for (const offset of COLLISION_WINDOW)
  {
    const idx = ((playerSegIdx + offset) % segmentCount + segmentCount) % segmentCount;
    const { hit, nearMiss } = checkSegmentCollision(playerX, segments[idx]);

    if (hit)
    {
      if (worstHit === null || CLASS_RANK[hit.cls] > CLASS_RANK[worstHit.cls])
        worstHit = hit;
    }
    else if (nearMiss && firstNearMiss === null)
    {
      firstNearMiss = nearMiss;
    }
  }

  return { hit: worstHit, nearMiss: firstNearMiss };
}
