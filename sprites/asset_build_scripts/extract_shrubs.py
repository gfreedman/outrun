#!/usr/bin/env python3
"""
extract_shrubs.py

Extracts S1, S2, S6 shrub sprites from source_for_sprites/shrubz.png
and saves each as a transparent PNG into assets/shrubs/.

── Source layout ──────────────────────────────────────────────────────────
  2107×496 px.  10 sprites per row, 2 rows.
  Row 1 = S1–S10  (y ≈ 0–265)
  Cell width ≈ 210.7 px  →  10 even columns.
  Sprite content ends at y ≈ 222; label text at y ≈ 225–262.

── Background ─────────────────────────────────────────────────────────────
  Background: R≈214 G≈234 B≈234 (teal-grey grid).
  Flood fill from cell edges removes all bg pixels within TOLERANCE.
  keep_largest() discards any surviving header/label text fragments.

── Outputs ────────────────────────────────────────────────────────────────
  assets/shrubs/shrub_s1.png
  assets/shrubs/shrub_s2.png
  assets/shrubs/shrub_s6.png
"""

import os
import numpy as np
from PIL import Image

# ── Config ─────────────────────────────────────────────────────────────────────

SRC = "source_for_sprites/shrubz.png"
PAD = 8

# Max per-channel distance from bg to be treated as background.
TOLERANCE = 70   # grid lines R≈163–186 need generous headroom; plant greens are far enough away

# ── Cell grid ──────────────────────────────────────────────────────────────────
# Row 1 spans y=0–265 (includes sprite + label band below it).
# Column boundaries derived from image width 2107 / 10 columns.

CW = 2107 / 10   # ≈ 210.7 px per column

def col_x(c):
    return int(round(c * CW)), int(round((c + 1) * CW))

ROW1_Y      = (92, 222)  # start just above the last header text band; zero it out below
HEADER_ROWS = 30         # rows to blank at top of cell (covers y=92–121 header text in full image)

# Sprites we want: S1=col0, S2=col1, S6=col5
TARGETS = [
    ("shrub_s1", 0),
    ("shrub_s2", 1),
    ("shrub_s6", 5),
]

os.makedirs("assets/shrubs", exist_ok=True)

# ── Background helpers ─────────────────────────────────────────────────────────

def detect_bg(arr: np.ndarray) -> np.ndarray:
    H, W = arr.shape[:2]
    edges = np.concatenate([arr[0,:,:3], arr[-1,:,:3], arr[:,0,:3], arr[:,-1,:3]])
    return edges.mean(axis=0)


def is_bg(arr: np.ndarray, bg: np.ndarray) -> np.ndarray:
    diff = np.abs(arr[:,:,:3].astype(np.float32) - bg).max(axis=2)
    return diff < TOLERANCE


def flood_fill_bg(arr: np.ndarray, bg: np.ndarray) -> np.ndarray:
    arr     = arr.copy()
    H, W    = arr.shape[:2]
    bg_mask = is_bg(arr, bg)
    visited = np.zeros((H, W), dtype=bool)
    queue   = []

    def try_add(x, y):
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
        for nx, ny in ((x-1,y),(x+1,y),(x,y-1),(x,y+1)):
            if 0 <= nx < W and 0 <= ny < H:
                try_add(nx, ny)

    arr[visited, 3] = 0
    return arr


def defringe(arr: np.ndarray, bg: np.ndarray, passes: int = 1) -> np.ndarray:
    arr  = arr.copy()
    bg_m = is_bg(arr, bg)
    for _ in range(passes):
        a      = arr[:,:,3]
        opaque = (a == 255)
        transp = (a == 0)
        border = opaque & (
            np.roll(transp,  1, 0) | np.roll(transp, -1, 0) |
            np.roll(transp,  1, 1) | np.roll(transp, -1, 1)
        )
        arr[border & bg_m, 3] = 0
    return arr


def keep_largest(arr: np.ndarray) -> np.ndarray:
    """Discard all but the largest connected opaque blob (removes stray label text)."""
    from scipy.ndimage import label as sp_label
    arr     = arr.copy()
    visible = arr[:,:,3] > 10
    labeled, n = sp_label(visible)
    if n <= 1:
        return arr
    sizes          = np.bincount(labeled.ravel())
    sizes[0]       = 0
    best           = int(sizes.argmax())
    arr[labeled != best, 3] = 0
    return arr

# ── Extraction ─────────────────────────────────────────────────────────────────

print("Loading", SRC)
src_img = Image.open(SRC).convert("RGBA")
src_arr = np.array(src_img)
bg_full = detect_bg(src_arr)
print(f"  {src_img.width}×{src_img.height}  BG: R={bg_full[0]:.0f} G={bg_full[1]:.0f} B={bg_full[2]:.0f}")
print()

for name, col in TARGETS:
    x1, x2     = col_x(col)
    y1, y2     = ROW1_Y
    region     = src_arr[y1:y2, x1:x2, :].copy()

    # Use the full-image bg (more accurate — per-cell edges are skewed by plant pixels)
    bg = bg_full

    region = flood_fill_bg(region, bg)
    # Second pass: zero any remaining enclosed bg pockets (unreachable from edges).
    bg_mask = is_bg(region, bg)
    region[bg_mask, 3] = 0
    region = defringe(region, bg, passes=2)
    # Blank the header text band at the top of the cell before tight-cropping.
    region[:HEADER_ROWS, :, 3] = 0

    alpha  = region[:,:,3]
    ys, xs = np.where(alpha > 10)
    if len(xs) == 0:
        print(f"  WARN {name} — no visible pixels!")
        continue

    cx1 = max(0, int(xs.min()) - PAD)
    cy1 = max(0, int(ys.min()) - PAD)
    cx2 = min(region.shape[1], int(xs.max()) + PAD + 1)
    cy2 = min(region.shape[0], int(ys.max()) + PAD + 1)

    out    = Image.fromarray(region[cy1:cy2, cx1:cx2, :])
    path   = f"assets/shrubs/{name}.png"
    out.save(path)
    filled = int((alpha > 10).sum())
    print(f"  {name}: cell col={col} ({x1},{y1})–({x2},{y2})  →  {out.width}×{out.height}  ({filled:,} px visible)")
    print(f"    → {path}")

print()
print("Done.")
