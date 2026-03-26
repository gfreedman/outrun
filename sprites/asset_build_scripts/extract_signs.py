#!/usr/bin/env python3
"""
extract_signs.py

Extracts the turn-right and turn-left road signs from source_for_sprites/signz.png
and saves each as a transparent PNG into assets/signs/.

── Source layout ──────────────────────────────────────────────────────────
  175×141 px.  Two signs side by side, gap at x=74–104.
  Sign 1 (turn right): x=0–73
  Sign 2 (turn left):  x=105–174

── Background ─────────────────────────────────────────────────────────────
  Background: R≈240 G≈249 B≈252 (light teal-white grid).
  TOLERANCE=70 covers both grid cell interiors and darker grid lines.
  Global bg pass cleans any enclosed pockets after flood fill.

── Outputs ────────────────────────────────────────────────────────────────
  assets/signs/sign_turn_right.png
  assets/signs/sign_turn_left.png
"""

import os
import numpy as np
from PIL import Image

SRC       = "source_for_sprites/signz.png"
PAD       = 6
TOLERANCE = 70

CELLS = [
    ("sign_turn_right", 0,   0, 73,  141),
    ("sign_turn_left",  105, 0, 174, 141),
]

os.makedirs("assets/signs", exist_ok=True)

# ── Background helpers ─────────────────────────────────────────────────────────

def is_bg(arr: np.ndarray, bg: np.ndarray) -> np.ndarray:
    return np.abs(arr[:, :, :3].astype(np.float32) - bg).max(axis=2) < TOLERANCE


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
        a      = arr[:, :, 3]
        opaque = (a == 255)
        transp = (a == 0)
        border = opaque & (
            np.roll(transp,  1, 0) | np.roll(transp, -1, 0) |
            np.roll(transp,  1, 1) | np.roll(transp, -1, 1)
        )
        arr[border & bg_m, 3] = 0
    return arr

# ── Main ───────────────────────────────────────────────────────────────────────

print("Loading", SRC)
src_img = Image.open(SRC).convert("RGBA")
src_arr = np.array(src_img)

edges = np.concatenate([src_arr[0,:,:3], src_arr[-1,:,:3], src_arr[:,0,:3], src_arr[:,-1,:3]])
bg    = edges.mean(axis=0)
print(f"  {src_img.width}×{src_img.height}  BG: R={bg[0]:.0f} G={bg[1]:.0f} B={bg[2]:.0f}")
print()

for name, x1, y1, x2, y2 in CELLS:
    region = src_arr[y1:y2, x1:x2, :].copy()

    region = flood_fill_bg(region, bg)
    # Clean any enclosed bg pockets
    region[is_bg(region, bg), 3] = 0
    region = defringe(region, bg, passes=2)

    alpha  = region[:, :, 3]
    ys, xs = np.where(alpha > 10)
    if len(xs) == 0:
        print(f"  WARN {name} — no visible pixels!")
        continue

    cx1 = max(0, int(xs.min()) - PAD)
    cy1 = max(0, int(ys.min()) - PAD)
    cx2 = min(region.shape[1], int(xs.max()) + PAD + 1)
    cy2 = min(region.shape[0], int(ys.max()) + PAD + 1)

    out    = Image.fromarray(region[cy1:cy2, cx1:cx2, :])
    path   = f"assets/signs/{name}.png"
    out.save(path)
    filled = int((alpha > 10).sum())
    print(f"  {name}: ({x1},{y1})–({x2},{y2})  →  {out.width}×{out.height}  ({filled:,} px visible)")
    print(f"    → {path}")

print()
print("Done.")
