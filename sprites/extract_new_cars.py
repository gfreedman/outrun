#!/usr/bin/env python3
"""
extract_new_cars.py

Extracts four traffic-car sprites from the JPEG sprite sheet
  source_for_sprites/image.jpg

The sheet is a 4×4 grid of fun vehicles on a checker background, with a
dark title header at the top.  Target cars:

  GOTTA GO  — blue car with red racing stripes  (grid row 0, col 2)
  YOSHI     — green spotted egg on orange feet   (grid row 2, col 0)
  BANANA    — wood-panelled pickup truck         (grid row 2, col 2)
  MEGA      — blue-grey retro sports car         (grid row 3, col 0)

── Why tiny margins? ─────────────────────────────────────────────────────────

JPEG lossy compression creates a colour-bleed halo ≈ 8–15 px wide around
every high-chroma pixel.  If the crop margin is larger than this radius, the
crop's own border falls inside the bleed zone, making those border checker
squares appear slightly chromatic (chroma 30–60).  The BFS flood-fill seeds
from the crop border — if those seeds don't pass is_bg(BG_CHROMA=60), the
entire flood-fill fails and the checker background is never removed.

By using a 3-pixel margin we keep the crop border far outside the bleed zone
(checker squares there have chroma < 10, well inside BG_CHROMA=60), so seeds
fire reliably.  Any small bleed of adjacent content (e.g. row separator bars)
is handled by keep_largest: those blobs are tiny vs the main car silhouette.

── Outputs ───────────────────────────────────────────────────────────────────

  assets/cars/gottago_car_sprites.png
  assets/cars/yoshi_car_sprites.png
  assets/cars/banana_car_sprites.png
  assets/cars/mega_car_sprites.png
"""

import os
import numpy as np
from PIL import Image
from scipy.ndimage import label as sp_label

# ── Config ────────────────────────────────────────────────────────────────────

SRC        = "source_for_sprites/image.jpg"
PAD        = 8    # transparent padding around each extracted sprite

BG_CHROMA  = 60   # max chroma — JPEG bleeds car hue into checker squares (measured ~46 near blue car)
BG_TOL     = 120  # max L1 distance — checker shades ~99 L1 from mean, bleed adds ~6 more

MARGIN     = 3    # tiny inward crop on all sides (stays outside JPEG bleed zone)
DEFRINGE   = 1    # rounds of edge-pixel erosion (3 was too aggressive, ate blue car edges)

# Grid: 4 rows × 4 cols.  Map (row, col) → output stem.
TARGETS = {
    (0, 2): "gottago",
    (2, 0): "yoshi",
    (2, 2): "banana",
    (3, 0): "mega",
}

# Per-target extra pixels to add beyond the cell's y2 boundary.
# GOTTA GO's lower body (taillights, bumper) overflows 37px below the cell edge.
# The next cell's car starts much further down, so overlapping is safe.
BOTTOM_EXT = {
    "gottago": 65,   # tires extend ~37px below cell + 28px more to clear them fully
}

os.makedirs("assets/cars",              exist_ok=True)
os.makedirs("source_for_sprites/debug", exist_ok=True)


# ── Helpers ───────────────────────────────────────────────────────────────────

def chroma_map(arr: np.ndarray) -> np.ndarray:
    r = arr[:, :, 0].astype(np.int32)
    g = arr[:, :, 1].astype(np.int32)
    b = arr[:, :, 2].astype(np.int32)
    return np.abs(r - g) + np.abs(g - b) + np.abs(r - b)


def detect_header_height(arr: np.ndarray) -> int:
    lum  = arr[:, :, :3].astype(np.float32).mean(axis=2)
    last = 0
    for y in range(min(arr.shape[0], 140)):
        if lum[y].mean() < 130:
            last = y
    return last + 2


def detect_grid(arr: np.ndarray, rows: int = 4, cols: int = 4):
    H, W     = arr.shape[:2]
    header_y = detect_header_height(arr)
    usable_h = H - header_y
    row_h    = usable_h // rows
    col_w    = W // cols
    grid = []
    for r in range(rows):
        y1 = header_y + r * row_h
        y2 = header_y + (r + 1) * row_h if r < rows - 1 else H
        row_cells = []
        for c in range(cols):
            x1 = c * col_w
            x2 = (c + 1) * col_w if c < cols - 1 else W
            row_cells.append((x1, y1, x2, y2))
        grid.append(row_cells)
    return grid


def estimate_bg_from_cell_corners(full_arr: np.ndarray, grid) -> np.ndarray:
    """
    Estimate checker BG by sampling 20×20 px blocks from the four corners
    of every cell in the grid.  The corners are the farthest points from
    any centered car sprite, so they reliably contain pure checker.

    Per-cell edge sampling fails when MARGIN=3 lands inside the JPEG bleed
    zone around car colours.  Global image sampling fails because the dark
    title header dominates.  Corner blocks avoid both problems.
    """
    samples = []
    corner_size = 20
    for row_cells in grid:
        for (x1, y1, x2, y2) in row_cells:
            corners = [
                full_arr[y1:y1+corner_size, x1:x1+corner_size, :3],
                full_arr[y1:y1+corner_size, x2-corner_size:x2,  :3],
                full_arr[y2-corner_size:y2, x1:x1+corner_size, :3],
                full_arr[y2-corner_size:y2, x2-corner_size:x2,  :3],
            ]
            for block in corners:
                flat = block.reshape(-1, 3).astype(np.int32)
                r, g, b = flat[:, 0], flat[:, 1], flat[:, 2]
                ch = np.abs(r - g) + np.abs(g - b) + np.abs(r - b)
                mask = ch < 20
                if mask.sum() > 5:
                    samples.append(flat[mask].astype(np.float32))

    if not samples:
        return np.array([167.0, 167.0, 167.0], dtype=np.float32)
    all_samples = np.concatenate(samples, axis=0)
    return all_samples.mean(axis=0)


def is_bg(arr: np.ndarray, bg: np.ndarray) -> np.ndarray:
    diff = np.abs(arr[:, :, :3].astype(np.float32) - bg).sum(axis=2)
    ch   = chroma_map(arr)
    return (diff < BG_TOL) & (ch < BG_CHROMA)


def flood_fill_bg(arr: np.ndarray, bg: np.ndarray) -> np.ndarray:
    """BFS flood-fill from all four image edges."""
    arr     = arr.copy()
    H, W    = arr.shape[:2]
    bg_mask = is_bg(arr, bg)
    visited = np.zeros((H, W), dtype=bool)
    queue   = []

    def try_add(x: int, y: int) -> None:
        if not visited[y, x] and bg_mask[y, x]:
            visited[y, x] = True
            queue.append((x, y))

    for x in range(W):
        try_add(x, 0); try_add(x, H - 1)
    for y in range(H):
        try_add(0, y); try_add(W - 1, y)

    i = 0
    while i < len(queue):
        x, y = queue[i]; i += 1
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if 0 <= nx < W and 0 <= ny < H:
                try_add(nx, ny)

    arr[visited, 3] = 0
    return arr


def remove_interior_bg(arr: np.ndarray, bg: np.ndarray) -> np.ndarray:
    """Remove background-coloured blobs that don't touch the image border."""
    arr      = arr.copy()
    H, W     = arr.shape[:2]
    opaque   = arr[:, :, 3] == 255
    cand     = opaque & is_bg(arr, bg)
    labeled, n = sp_label(cand)
    if n == 0:
        return arr
    border     = np.zeros((H, W), dtype=bool)
    border[0,  :] = border[-1, :] = True
    border[:,  0] = border[:, -1] = True
    border_lbl = set(int(x) for x in labeled[border & cand])
    border_lbl.discard(0)
    arr[cand & ~np.isin(labeled, list(border_lbl)), 3] = 0
    return arr


def keep_largest(arr: np.ndarray) -> np.ndarray:
    arr        = arr.copy()
    labeled, n = sp_label(arr[:, :, 3] > 10)
    if n <= 1:
        return arr
    sizes = np.bincount(labeled.ravel()); sizes[0] = 0
    arr[labeled != int(sizes.argmax()), 3] = 0
    return arr


def defringe(arr: np.ndarray, bg: np.ndarray, passes: int = DEFRINGE) -> np.ndarray:
    arr = arr.copy()
    for _ in range(passes):
        a      = arr[:, :, 3]
        opaque = (a == 255)
        transp = (a == 0)
        edge   = opaque & (
            np.roll(transp,  1, 0) | np.roll(transp, -1, 0) |
            np.roll(transp,  1, 1) | np.roll(transp, -1, 1)
        )
        ch   = chroma_map(arr)
        diff = np.abs(arr[:, :, :3].astype(np.float32) - bg).sum(axis=2)
        arr[edge & (ch < BG_CHROMA) & (diff < BG_TOL + 20), 3] = 0
    return arr


def tight_crop(arr: np.ndarray) -> np.ndarray:
    H, W   = arr.shape[:2]
    ys, xs = np.where(arr[:, :, 3] > 10)
    if len(xs) == 0:
        return arr
    x1 = max(0, int(xs.min()) - PAD)
    y1 = max(0, int(ys.min()) - PAD)
    x2 = min(W, int(xs.max()) + PAD + 1)
    y2 = min(H, int(ys.max()) + PAD + 1)
    return arr[y1:y2, x1:x2, :]


# ── Main extraction ───────────────────────────────────────────────────────────

def extract_car(full_arr: np.ndarray, gx1: int, gy1: int,
                gx2: int, gy2: int, stem: str, bg: np.ndarray,
                bottom_ext: int = 0) -> Image.Image:
    """
    Extract one car sprite.  Pipeline:

    Pass 1:
      1. Crop with tiny MARGIN (3 px) so border checker is outside JPEG bleed.
      2. Flood-fill from edges (BG_CHROMA=60, BG_TOL=120): removes exterior checker.
         NOTE: No second flood-fill in pass 2 — the tight-crop border sits flush
         against the car and a second BFS would seed from the car's own pixels,
         eating wheels and lower-body detail.
      3. keep_largest: discards tiny separator blobs and stray noise.
      4. Tight-crop with PAD.

    Pass 2:
      5. remove_interior_bg: cleans enclosed checker in windows/wheel-wells.
      6. Defringe: erodes residual grey-halo pixels from silhouette edge.
      7. keep_largest + tight_crop.
    """
    H, W = full_arr.shape[:2]
    cx1  = max(0, gx1 + MARGIN)
    cy1  = max(0, gy1 + MARGIN)
    cx2  = min(W, gx2 - MARGIN)
    cy2  = min(H, gy2 - MARGIN + bottom_ext)

    region = full_arr[cy1:cy2, cx1:cx2, :].copy()

    # Pass 1
    region = flood_fill_bg(region, bg)
    region = keep_largest(region)
    Image.fromarray(region).save(f"source_for_sprites/debug/car_{stem}_pass1.png")

    # Tight-crop before pass 2 (new border = car edge, not cell edge)
    region = tight_crop(region)

    # Pass 2 — no second flood fill; the pass-1 BFS already cleared the exterior.
    # A second flood fill would seed from the tight-crop border which may sit flush
    # against the car bottom (no padding), eating wheels and lower-body pixels.
    # remove_interior_bg handles enclosed checker holes (windows, wheel-wells).
    region = remove_interior_bg(region, bg)
    region = defringe(region, bg)
    region = keep_largest(region)
    region = tight_crop(region)

    img = Image.fromarray(region)
    img.save(f"source_for_sprites/debug/car_{stem}_final.png")
    return img


# ── Main ──────────────────────────────────────────────────────────────────────

print("=" * 60)
print("Loading source image")
print("=" * 60)

src_rgb  = Image.open(SRC).convert("RGB")
src_rgba = Image.new("RGBA", src_rgb.size, (0, 0, 0, 255))
src_rgba.paste(src_rgb)
src_arr  = np.array(src_rgba)

header_y = detect_header_height(src_arr)
grid     = detect_grid(src_arr)
print(f"  {SRC}: {src_rgb.width}×{src_rgb.height}  header_y={header_y}")

global_bg = estimate_bg_from_cell_corners(src_arr, grid)
print(f"  Global BG ≈ R={global_bg[0]:.0f} G={global_bg[1]:.0f} B={global_bg[2]:.0f}")

results = {}
for (row, col), stem in sorted(TARGETS.items()):
    gx1, gy1, gx2, gy2 = grid[row][col]
    print(f"\n[{row},{col}] {stem}  cell ({gx1},{gy1})–({gx2},{gy2})")

    img    = extract_car(src_arr, gx1, gy1, gx2, gy2, stem, global_bg,
                         bottom_ext=BOTTOM_EXT.get(stem, 0))
    arr    = np.array(img)
    filled = int((arr[:, :, 3] > 10).sum())
    out    = f"assets/cars/{stem}_car_sprites.png"

    if filled == 0:
        print(f"  ⚠  WARN: 0 visible pixels!")
        continue

    img.save(out)
    print(f"  → {img.width}×{img.height}  ({filled:,} px)  {out}")
    results[stem] = (img.width, img.height)

print()
print("=" * 60)
print("Output dimensions  (update TRAFFIC_CAR_SPECS in src/sprites.ts if changed)")
print("=" * 60)
for stem, (w, h) in sorted(results.items()):
    print(f"  {stem:<10}  frameW={w}  frameH={h}")
print()
print("Done.")
