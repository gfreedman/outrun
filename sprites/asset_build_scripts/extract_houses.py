#!/usr/bin/env python3
"""
extract_houses.py

Extracts individual house/building sprites from two source images:
  source_for_sprites/houses.png   — desert adobe + Tusken habitations
  source_for_sprites/houses2.png  — colourful pixel-art buildings

Outputs transparent PNGs to:
  source_for_sprites/houses/  (adobe + desert structures)
  source_for_sprites/buildings/ (colourful buildings)
"""

import os
import numpy as np
from PIL import Image
from scipy import ndimage

OUT_ADOBE    = "source_for_sprites/houses/"
OUT_COLORFUL = "source_for_sprites/buildings/"
os.makedirs(OUT_ADOBE,    exist_ok=True)
os.makedirs(OUT_COLORFUL, exist_ok=True)

PAD       = 6    # padding around tight crop
TOLERANCE = 28   # max channel diff from BG to be considered background


def flood_fill_bg(arr: np.ndarray, bg: np.ndarray, tol: int) -> np.ndarray:
    """
    Flood-fills background pixels starting from ALL edge pixels.
    Returns a boolean mask: True = background.
    """
    h, w = arr.shape[:2]
    diff = np.abs(arr[:, :, :3].astype(int) - bg.astype(int)).max(axis=2)
    is_bg_pixel = diff < tol

    visited = np.zeros((h, w), dtype=bool)
    # Seed: all edge pixels that are BG-like
    seeds = []
    for x in range(w):
        if is_bg_pixel[0, x]:   seeds.append((0, x))
        if is_bg_pixel[h-1, x]: seeds.append((h-1, x))
    for y in range(h):
        if is_bg_pixel[y, 0]:   seeds.append((y, 0))
        if is_bg_pixel[y, w-1]: seeds.append((y, w-1))

    # BFS flood fill: starting from the border seed pixels, expand outward to
    # every 4-connected neighbour that (a) has not yet been visited and (b)
    # matches the background colour within tolerance.  This guarantees that only
    # regions physically connected to the image boundary are removed — interior
    # background pockets surrounded by sprite pixels are left untouched and must
    # be cleaned separately by a global colour-threshold pass.
    from collections import deque
    q = deque(seeds)
    for (y, x) in seeds:
        visited[y, x] = True
    while q:
        y, x = q.popleft()
        for dy, dx in [(-1,0),(1,0),(0,-1),(0,1)]:
            ny, nx = y+dy, x+dx
            if 0 <= ny < h and 0 <= nx < w and not visited[ny, nx] and is_bg_pixel[ny, nx]:
                visited[ny, nx] = True
                q.append((ny, nx))

    return visited  # True = background reached by flood fill


def remove_label_blobs(arr: np.ndarray) -> np.ndarray:
    """
    Removes small isolated annotation labels (e.g. 'A.', 'B.') from the
    top-left corner of a colorful-building crop.
    Strategy: find every connected component of opaque pixels; zero out any
    component that is entirely within the top-left 25%×25% region of the image
    AND is small (< 600 px).  The buildings themselves always extend beyond
    that corner, so they are never touched.
    """
    result = arr.copy()
    h, w   = result.shape[:2]
    opaque = (result[:, :, 3] > 10).astype(np.uint8)
    labeled, n = ndimage.label(opaque)
    corner_h = int(h * 0.30)   # top 30% of height
    corner_w = int(w * 0.22)   # left 22% of width
    for i in range(1, n + 1):
        ys, xs = np.where(labeled == i)
        # Only consider components fully inside the top-left corner
        if ys.max() < corner_h and xs.max() < corner_w and len(ys) < 1500:
            result[ys, xs, 3] = 0
    return result


def extract_sprite(arr: np.ndarray, bg: np.ndarray, tol: int, pad: int) -> Image.Image | None:
    """
    Given a crop array, flood-fills background, zeroes alpha on bg pixels,
    then returns a tight-cropped RGBA image.
    """
    result = arr.copy()
    bg_mask = flood_fill_bg(arr, bg, tol)
    result[bg_mask, 3] = 0  # zero alpha on background

    # Tight-crop: find the axis-aligned bounding box of all non-transparent pixels
    # by collapsing the alpha mask along each axis.  np.any(opaque, axis=1) yields
    # a 1-D boolean vector marking every row that contains at least one opaque pixel;
    # np.where() then gives the first and last such row (and column), defining the
    # minimal rectangle that encloses the sprite content before padding is applied.
    opaque = result[:, :, 3] > 10
    if not opaque.any():
        return None
    rows = np.any(opaque, axis=1)
    cols = np.any(opaque, axis=0)
    y0, y1 = np.where(rows)[0][[0, -1]]
    x0, x1 = np.where(cols)[0][[0, -1]]

    h, w = arr.shape[:2]
    x0 = max(0, x0 - pad)
    y0 = max(0, y0 - pad)
    x1 = min(w - 1, x1 + pad)
    y1 = min(h - 1, y1 + pad)

    cropped = result[y0:y1+1, x0:x1+1]
    return Image.fromarray(cropped, "RGBA")


# ─────────────────────────────────────────────────────────────────────────────
# houses.png — Desert Habitation Assets
# BG: ~RGB(196, 205, 214)
# ─────────────────────────────────────────────────────────────────────────────

print("── houses.png ──────────────────────────────────────────────")
img_h  = Image.open("source_for_sprites/houses.png").convert("RGBA")
arr_h  = np.array(img_h)
BG_H   = np.array([196, 205, 214])

# ── Section 8.1: 10 Adobe houses ─────────────────────────────────────────────
# 2 rows × 5 columns; cell bounds determined from blob analysis.
# Row 1 y: 155-335   Row 2 y: 330-525
# Column x ranges (shared across rows):
ADOBE_CELLS = [
    # (name,         x0,   y0,   x1,   y1 )
    ("house_a01",    65,  155,  268,  335),   # R1C1 plain square adobe
    ("house_a02",   262,  155,  455,  335),   # R1C2 two-window adobe
    ("house_a03",   453,  158,  657,  332),   # R1C3 dome-top
    ("house_a04",   643,  168,  858,  336),   # R1C4 low-profile
    ("house_a05",   843,  158, 1050,  336),   # R1C5 vigas detail
    ("house_a06",    63,  330,  266,  525),   # R2C1 two-storey light
    ("house_a07",   260,  330,  458,  520),   # R2C2 dark brown
    ("house_a08",   453,  328,  660,  525),   # R2C3 wide flat-roof
    ("house_a09",   649,  336,  855,  525),   # R2C4 dark small-windows
    ("house_a10",   843,  338, 1050,  520),   # R2C5 stone/brick
]

for (name, x0, y0, x1, y1) in ADOBE_CELLS:
    crop = arr_h[y0:y1, x0:x1]
    sprite = extract_sprite(crop, BG_H, TOLERANCE, PAD)
    if sprite:
        path = os.path.join(OUT_ADOBE, f"{name}.png")
        sprite.save(path)
        print(f"  {name}: {sprite.size[0]}×{sprite.size[1]}")
    else:
        print(f"  {name}: EMPTY — check cell bounds")

# ── Section 8.2: Desert structures ───────────────────────────────────────────
DESERT_CELLS = [
    ("house_d01",    63,  605,  477,  795),   # dome cluster (3 domes)
    ("house_d02",    63,  793,  268,  963),   # large canvas tent
    ("house_d03",   474,  812,  682,  963),   # desert hut / lean-to
    ("house_d04",   677,  798,  868,  963),   # brown tent
    ("house_d05",   860,  800, 1053,  963),   # stone bunker
]

for (name, x0, y0, x1, y1) in DESERT_CELLS:
    crop = arr_h[y0:y1, x0:x1]
    sprite = extract_sprite(crop, BG_H, TOLERANCE, PAD)
    if sprite:
        path = os.path.join(OUT_ADOBE, f"{name}.png")
        sprite.save(path)
        print(f"  {name}: {sprite.size[0]}×{sprite.size[1]}")
    else:
        print(f"  {name}: EMPTY — check cell bounds")


# ─────────────────────────────────────────────────────────────────────────────
# houses2.png — Colourful Buildings
# BG: ~RGB(219, 237, 253)
# Column dividers (from non-bg run analysis): ~362, ~677, ~1038, ~1315
# Row dividers: ~360 between row 1 and row 2
# ─────────────────────────────────────────────────────────────────────────────

print("\n── houses2.png ─────────────────────────────────────────────")
img_b  = Image.open("source_for_sprites/houses2.png").convert("RGBA")
arr_b  = np.array(img_b)
BG_B   = np.array([219, 237, 253])

BUILDING_CELLS = [
    # Row 1 (y=35-360)
    ("house_b01",    18,  35,  362,  360),   # A. Shop
    ("house_b02",   362,  35,  677,  360),   # B. Bakery
    ("house_b03",   677,  35, 1038,  360),   # C. Surf Shop
    ("house_b04",  1038,  35, 1315,  360),   # D. Cafe / dome
    ("house_b05",  1315,  35, 1660,  360),   # E. Arcade
    # Row 2 (y=360-695)
    ("house_b06",    18, 360,  362,  695),   # F. Purple house
    ("house_b07",   362, 360,  677,  695),   # G. Teal house
    ("house_b08",   677, 360, 1038,  695),   # H. Yellow/blue-roof
    ("house_b09",  1038, 360, 1315,  695),   # I. Green/orange
    ("house_b10",  1340, 360, 1660,  695),   # J. Pink building (inset avoids b09 bleed)
]

for (name, x0, y0, x1, y1) in BUILDING_CELLS:
    crop = arr_b[y0:y1, x0:x1]
    sprite = extract_sprite(crop, BG_B, TOLERANCE, PAD)
    if sprite:
        # Strip cell annotation labels ('A.', 'B.', etc.) from top-left corner
        sprite = Image.fromarray(remove_label_blobs(np.array(sprite)), "RGBA")
        path = os.path.join(OUT_COLORFUL, f"{name}.png")
        sprite.save(path)
        print(f"  {name}: {sprite.size[0]}×{sprite.size[1]}")
    else:
        print(f"  {name}: EMPTY — check cell bounds")

print("\nDone.")
