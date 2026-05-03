#!/usr/bin/env python3
"""
extract_yellow_car.py

Extracts the yellow traffic car sprite from:
  source/new_yellow.png

The source is a 1401×752 px PNG of the yellow car on a near-black navy
background (#24242E).  Two hazards beyond the plain background:

  1. Dashed road-lane markings — horizontal white dashed lines run across
     the full image at the top and bottom thirds.  They are outside the car
     silhouette, so keep_largest() discards them as small disconnected blobs
     after BFS removes the dark background.

  2. Sparkle artefact — a single decorative star glyph sits in the
     bottom-right corner of the source image.  keep_largest() discards it
     alongside the road markings.

── Pipeline ──────────────────────────────────────────────────────────────────

  1. flood_fill_bg   — BFS from all four edges; removes dark exterior.
  2. keep_largest    — discards road dashes, sparkle, and any other stray blobs.
  3. tight_crop      — trims transparent margins, adds PAD pixels of breathing room.

── Output ────────────────────────────────────────────────────────────────────

  dist/yellow_car_sprites.png

Run from the sprites/ directory:
  python3 asset_build_scripts/extract_yellow_car.py
"""

import numpy as np
from PIL import Image
from scipy.ndimage import label as sp_label

# ── Config ────────────────────────────────────────────────────────────────────

SRC = "source/new_yellow.png"
OUT = "dist/yellow_car_sprites.png"

# Padding (transparent pixels) added around the tight-cropped sprite so the
# renderer has a small buffer before the car silhouette begins.
PAD = 6

# Background colour tolerance.  The source background is ~(36, 36, 44) — a
# near-black navy.  BG_TOL=80 comfortably captures all background shades
# (including slightly lighter corner pixels) while staying well clear of the
# car's dark tyre and shadow pixels (~(60-90, 60-90, 60-90) chroma ≥ 10).
BG_TOL = 80

# Chroma threshold.  Background pixels are achromatic (|R-G|+|G-B|+|R-B| < 8).
# Car pixels have colour.  30 gives ample headroom.
BG_CHROMA = 55   # background has a slight blue cast (~chroma 40 at corners); 55 clears it safely


# ── Helpers ───────────────────────────────────────────────────────────────────

def chroma(arr: np.ndarray) -> np.ndarray:
    """Per-pixel chroma: sum of absolute pairwise channel differences."""
    r = arr[:, :, 0].astype(np.int32)
    g = arr[:, :, 1].astype(np.int32)
    b = arr[:, :, 2].astype(np.int32)
    return np.abs(r - g) + np.abs(g - b) + np.abs(r - b)


def is_bg(arr: np.ndarray, bg: np.ndarray) -> np.ndarray:
    """
    Returns a boolean mask: True where a pixel matches the background.

    A pixel is background if BOTH:
      - Its L1 distance from `bg` is within BG_TOL, AND
      - Its chroma is below BG_CHROMA (i.e. it is achromatic / grey).

    The dual condition prevents dark-coloured car pixels (tyres, shadows)
    from being mistakenly erased even if they happen to be close in L1.

    Args:
        arr: RGBA image array, shape (H, W, 4).
        bg:  Reference background colour, shape (3,) float32.

    Returns:
        Boolean array of shape (H, W).
    """
    diff = np.abs(arr[:, :, :3].astype(np.float32) - bg).sum(axis=2)
    ch   = chroma(arr)
    return (diff < BG_TOL) & (ch < BG_CHROMA)


def flood_fill_bg(arr: np.ndarray, bg: np.ndarray) -> np.ndarray:
    """
    BFS flood-fill from all four image edges to erase the exterior background.

    Seeds every border pixel that passes is_bg(), then expands 4-connectedly
    to neighbours that also pass is_bg().  All reached pixels have their alpha
    set to 0.  Interior background pockets (e.g. enclosed shadows) are left
    for keep_largest() to handle via connected-component analysis.

    Args:
        arr: RGBA image array (H, W, 4).  Modified in-place on a copy.
        bg:  Reference background colour (3,) float32.

    Returns:
        New RGBA array with background pixels made transparent.
    """
    arr     = arr.copy()
    H, W    = arr.shape[:2]
    bg_mask = is_bg(arr, bg)
    visited = np.zeros((H, W), dtype=bool)
    queue   = []

    def try_add(x: int, y: int) -> None:
        # Enqueue a pixel only if it hasn't been visited and matches background.
        if not visited[y, x] and bg_mask[y, x]:
            visited[y, x] = True
            queue.append((x, y))

    # Seed from all four borders.
    for x in range(W):
        try_add(x, 0); try_add(x, H - 1)
    for y in range(H):
        try_add(0, y); try_add(W - 1, y)

    # BFS expansion — 4-connected neighbours only.
    i = 0
    while i < len(queue):
        x, y = queue[i]; i += 1
        for nx, ny in ((x-1, y), (x+1, y), (x, y-1), (x, y+1)):
            if 0 <= nx < W and 0 <= ny < H:
                try_add(nx, ny)

    arr[visited, 3] = 0
    return arr


def keep_largest(arr: np.ndarray) -> np.ndarray:
    """
    Erases all connected components of opaque pixels except the largest one.

    After BFS removes the exterior background, stray blobs (road dashes,
    the sparkle glyph, separator artefacts) remain as small isolated islands
    of opaque pixels.  Labelling and keeping only the biggest island removes
    them all in one pass without needing to know their exact positions.

    Args:
        arr: RGBA image array (H, W, 4).

    Returns:
        New RGBA array with all non-largest blobs erased (alpha → 0).
    """
    arr        = arr.copy()
    labeled, n = sp_label(arr[:, :, 3] > 10)
    if n <= 1:
        return arr
    # bincount gives the pixel count of each label; ignore label 0 (transparent).
    sizes      = np.bincount(labeled.ravel())
    sizes[0]   = 0
    arr[labeled != int(sizes.argmax()), 3] = 0
    return arr


def tight_crop(arr: np.ndarray) -> np.ndarray:
    """
    Crops to the bounding box of all opaque pixels, plus PAD pixels of margin.

    Args:
        arr: RGBA image array (H, W, 4).

    Returns:
        Cropped RGBA array.  Returns arr unchanged if no opaque pixels found.
    """
    H, W   = arr.shape[:2]
    ys, xs = np.where(arr[:, :, 3] > 10)
    if len(xs) == 0:
        return arr
    x1 = max(0, int(xs.min()) - PAD)
    y1 = max(0, int(ys.min()) - PAD)
    x2 = min(W, int(xs.max()) + PAD + 1)
    y2 = min(H, int(ys.max()) + PAD + 1)
    return arr[y1:y2, x1:x2]


# ── Helpers (continued) ───────────────────────────────────────────────────────

def chroma_crop(arr: np.ndarray, min_chroma: int = 60, min_pixels: int = 10,
                margin: int = 20) -> np.ndarray:
    """
    Crops the image to the vertical extent of the car body.

    The source image has road-lane dashes (white horizontal lines) above and
    below the car.  These dashes are achromatic — they pass the background
    tolerance check — but they lie BETWEEN the image border and the dark
    background strip adjacent to the car.  This means the BFS flood-fill
    seeds from the top/bottom borders, clears the outermost dark background,
    then STOPS at the first dash row because dashes are not background-coloured.
    The dark strip between the dashes and the car body is therefore never
    reached by the BFS.

    Solution: pre-crop to the rows that contain actual car pixels (identified
    by high chroma, > 60) BEFORE running BFS.  With the dash rows removed,
    the BFS seeds directly onto the dark strip adjacent to the car and clears
    it cleanly.

    Args:
        arr:        RGBA image array (H, W, 4).
        min_chroma: Minimum per-pixel chroma to count as a car pixel.
        min_pixels: Minimum number of high-chroma pixels per row to qualify.
        margin:     Extra rows to keep above/below the detected car extent.

    Returns:
        Vertically cropped RGBA array (width unchanged).
    """
    r  = arr[:, :, 0].astype(np.int32)
    g  = arr[:, :, 1].astype(np.int32)
    b  = arr[:, :, 2].astype(np.int32)
    ch = np.abs(r - g) + np.abs(g - b) + np.abs(r - b)
    row_hits = (ch > min_chroma).sum(axis=1)
    car_rows = np.where(row_hits >= min_pixels)[0]
    if len(car_rows) == 0:
        return arr
    H = arr.shape[0]
    y1 = max(0, int(car_rows[0])  - margin)
    y2 = min(H, int(car_rows[-1]) + margin + 1)
    return arr[y1:y2, :, :]


def road_crop(arr: np.ndarray,
              cx_frac: float = 0.4,
              road_chroma_max: float = 15,
              road_lum_min: float = 60,
              road_lum_max: float = 160,
              margin: int = 5) -> np.ndarray:
    """
    Crops away the road surface that appears below the car's tyres.

    The source image is a scene render: the car sits on a simulated road plane
    that fills the full image width below the tyres.  That road is achromatic
    (grey asphalt, chroma < 15) and medium-luminance (60–160).  Scanning the
    centre columns — well clear of the left/right tyre positions — finds the
    first (topmost) road row from the bottom.  Everything at and below that
    row (minus a small margin) is road and is cropped out.

    Args:
        arr:             RGBA image array (H, W, 4).
        cx_frac:         Fraction of image width to use as the centre window
                         (avoids the tyre columns on the left and right).
        road_chroma_max: Maximum mean chroma to qualify a row as road.
        road_lum_min:    Minimum mean luminance to qualify a row as road.
        road_lum_max:    Maximum mean luminance to qualify a row as road.
        margin:          Rows to keep below the detected road top as a safety
                         buffer so the tyre bottoms are not clipped.

    Returns:
        Vertically cropped array with the road surface removed.
    """
    H, W = arr.shape[:2]
    # Centre window: the horizontal band between the two tyres.
    cx1 = int(W * (0.5 - cx_frac / 2))
    cx2 = int(W * (0.5 + cx_frac / 2))
    centre = arr[:, cx1:cx2, :3]

    r  = centre[:, :, 0].astype(np.int32)
    g  = centre[:, :, 1].astype(np.int32)
    b  = centre[:, :, 2].astype(np.int32)
    ch = (np.abs(r - g) + np.abs(g - b) + np.abs(r - b)).mean(axis=1)
    lm = ((r + g + b) / 3).mean(axis=1)

    road_top = H  # default: no road found, keep everything
    for y in range(H - 1, 0, -1):
        if ch[y] < road_chroma_max and road_lum_min < lm[y] < road_lum_max:
            road_top = y
        else:
            if road_top < H:
                break   # first non-road row scanning up → road band found

    cut = max(0, road_top - margin)
    if cut < H:
        print(f"  Road surface detected at row {road_top}; cropping to row {cut}")
    return arr[:cut, :, :]


# ── Main ──────────────────────────────────────────────────────────────────────

print(f"Loading {SRC}")
src = Image.open(SRC).convert("RGBA")
arr = np.array(src)
print(f"  Source: {src.width}×{src.height} px")

# Estimate background colour from the four image corners (far from the car).
corner_size = 30
corners = [
    arr[:corner_size,  :corner_size,  :3],   # top-left
    arr[:corner_size,  -corner_size:, :3],   # top-right
    arr[-corner_size:, :corner_size,  :3],   # bottom-left
    arr[-corner_size:, -corner_size:, :3],   # bottom-right
]
bg = np.concatenate([c.reshape(-1, 3) for c in corners], axis=0).mean(axis=0)
print(f"  Background ≈ R={bg[0]:.0f} G={bg[1]:.0f} B={bg[2]:.0f}")

# Pre-crop to the car's chroma extent to eliminate the road dash rows that
# would otherwise block the BFS flood-fill from reaching the background strip
# between the dashes and the car body (see chroma_crop docstring for details).
arr = chroma_crop(arr, margin=0)
arr = road_crop(arr)
print(f"  After chroma+road crop: {arr.shape[1]}×{arr.shape[0]} px")

# Pipeline
arr = flood_fill_bg(arr, bg)
arr = keep_largest(arr)
arr = tight_crop(arr)

out_img = Image.fromarray(arr)
out_img.save(OUT)

opaque = int((arr[:, :, 3] > 10).sum())
print(f"  → {out_img.width}×{out_img.height} px  ({opaque:,} opaque pixels)")
print(f"  Saved: {OUT}")
print("Done.")
