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

import { CollisionClass, RoadSegment } from './types';
import {
  ROAD_WIDTH,
  HITBOX_CACTUS, HITBOX_PALM, HITBOX_HOUSE,
  BLOCK_SMACK, BLOCK_HOUSE,
  NEAR_MISS_RATIO, COLLISION_MIN_OFFSET,
} from './constants';

export type { CollisionClass };

// ── Classification ────────────────────────────────────────────────────────────

/**
 * Maps a SpriteId string to its collision class.
 * Uses prefix matching — works for all current sprite families and any future
 * ones that follow the same naming convention.
 */
export function getCollisionClass(id: string): CollisionClass
{
  if (id.startsWith('SHRUB_'))     return 'ghost';
  if (id.startsWith('SIGN_'))      return 'ghost';
  if (id.startsWith('CACTUS_'))    return 'glance';
  if (id.startsWith('PALM_'))      return 'smack';
  if (id.startsWith('BILLBOARD_')) return 'smack';
  if (id.startsWith('COOKIE_'))    return 'smack';
  if (id.startsWith('BARNEY_'))    return 'smack';
  if (id.startsWith('BIG_'))       return 'smack';
  if (id.startsWith('HOUSE_'))     return 'crunch';
  return 'ghost';
}

/**
 * Returns the lateral detection radius (world units) for a collision class.
 * Ghost returns 0 — it will never match a delta check.
 */
export function getHitboxRadius(cls: CollisionClass): number
{
  switch (cls)
  {
    case 'glance': return HITBOX_CACTUS;
    case 'smack':  return HITBOX_PALM;
    case 'crunch': return HITBOX_HOUSE;
    default:       return 0;
  }
}

/**
 * Returns the physical blocking radius (world units) — the hard wall the player
 * cannot penetrate.  Tighter than the detection radius so the detection zone
 * is more forgiving than the solid wall.
 */
export function getBlockingRadius(id: string): number
{
  // BLOCK_HOUSE < HITBOX_HOUSE — keeps player inside detection zone at the wall
  // so crunch effects always fire on contact.
  if (id.startsWith('HOUSE_'))  return BLOCK_HOUSE;
  // palms, billboards, cookie, barney, BIG — tight trunk/post radius (250 << 550 detection)
  const cls = getCollisionClass(id);
  return cls === 'smack' ? BLOCK_SMACK : 0;
}

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

const CLASS_ORDER: CollisionClass[] = ['ghost', 'glance', 'smack', 'crunch'];

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
    const cls = getCollisionClass(sprite.id);
    if (cls === 'ghost') continue;

    const radius   = getHitboxRadius(cls);
    const delta    = Math.abs(playerWorldX - sprite.worldX);
    const sameSide = Math.sign(playerWorldX) === Math.sign(sprite.worldX);

    if (!sameSide) continue;

    if (delta < radius)
    {
      const bumpDir = sprite.worldX > playerWorldX ? +1 : -1;
      if (worstHit === null || CLASS_ORDER.indexOf(cls) > CLASS_ORDER.indexOf(worstHit.cls))
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
  const WINDOW = [-1, 0, 1, 2];

  let worstHit:      HitResult | null      = null;
  let firstNearMiss: NearMissResult | null = null;

  for (const offset of WINDOW)
  {
    const idx = ((playerSegIdx + offset) % segmentCount + segmentCount) % segmentCount;
    const { hit, nearMiss } = checkSegmentCollision(playerX, segments[idx]);

    if (hit)
    {
      if (worstHit === null || CLASS_ORDER.indexOf(hit.cls) > CLASS_ORDER.indexOf(worstHit.cls))
        worstHit = hit;
    }
    else if (nearMiss && firstNearMiss === null)
    {
      firstNearMiss = nearMiss;
    }
  }

  return { hit: worstHit, nearMiss: firstNearMiss };
}
