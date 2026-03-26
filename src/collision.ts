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

// ── Per-family collision configuration ───────────────────────────────────────
//
// Sprites carry a pre-classified `family` field set at placement time in road.ts,
// so all hot-path checks are O(1) property lookups with no string scanning.
//
// Adding a new SpriteFamily requires ONE entry here instead of three separate
// tables.  TypeScript enforces exhaustiveness via Record<SpriteFamily, ...>.

interface FamilyConfig
{
  /** Collision severity: ghost = no effect, glance = cactus poke, smack = palm/post, crunch = house grind. */
  cls:          CollisionClass;
  /**
   * Lateral detection hitbox half-width (world units).
   * Billboards (700) are wider than palms (550) because the sign face extends
   * further from the post.  Ghost and ghost-adjacent sprites use 0.
   */
  hitboxRadius: number;
  /**
   * Physical blocking radius (world units).
   * Prevents the player from phasing through solid objects.
   * Must be < hitboxRadius so the player is inside the detection zone at impact.
   * 0 = not a solid wall (cactus, shrub, sign).
   */
  blockRadius:  number;
}

const FAMILY_CONFIG: Record<SpriteFamily, FamilyConfig> =
{
  palm:      { cls: CollisionClass.Smack,  hitboxRadius: HITBOX_PALM,      blockRadius: BLOCK_SMACK },
  billboard: { cls: CollisionClass.Smack,  hitboxRadius: HITBOX_BILLBOARD,  blockRadius: BLOCK_SMACK },
  cookie:    { cls: CollisionClass.Smack,  hitboxRadius: HITBOX_PALM,       blockRadius: BLOCK_SMACK },
  barney:    { cls: CollisionClass.Smack,  hitboxRadius: HITBOX_PALM,       blockRadius: BLOCK_SMACK },
  big:       { cls: CollisionClass.Smack,  hitboxRadius: HITBOX_PALM,       blockRadius: BLOCK_SMACK },
  cactus:    { cls: CollisionClass.Glance, hitboxRadius: HITBOX_CACTUS,     blockRadius: 0           },
  shrub:      { cls: CollisionClass.Ghost,  hitboxRadius: 0,                 blockRadius: 0           },
  sign:       { cls: CollisionClass.Ghost,  hitboxRadius: 0,                 blockRadius: 0           },
  // BLOCK_HOUSE < HITBOX_HOUSE so the player is inside the detection zone at the wall boundary.
  house:      { cls: CollisionClass.Crunch, hitboxRadius: HITBOX_HOUSE,      blockRadius: BLOCK_HOUSE },
  // Finish-line gates are purely decorative — the car drives through them.
  gate_start:  { cls: CollisionClass.Ghost,  hitboxRadius: 0,                 blockRadius: 0           },
  gate_finish: { cls: CollisionClass.Ghost,  hitboxRadius: 0,                 blockRadius: 0           },
};

/**
 * Returns the physical blocking radius (world units) for a sprite family.
 * Used by game.ts to prevent the player from phasing through solid objects.
 */
export function getBlockingRadius(family: SpriteFamily): number
{
  return FAMILY_CONFIG[family].blockRadius;
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
    const { cls, hitboxRadius: radius } = FAMILY_CONFIG[sprite.family];
    if (cls === CollisionClass.Ghost) continue;
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
