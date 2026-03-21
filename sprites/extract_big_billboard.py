#!/usr/bin/env python3
"""
extract_big_billboard.py

Extracts the large horizontal wrestling billboard from
'source_for_sprites/big.png'.

── Source layout ────────────────────────────────────────────────────────────

  source_for_sprites/big.png  —  1528×688 px.

  Row gap at y=43–53 separates the title header from the content band.
  Content band y=54–688 contains:
    • Small reference figures + "3. ROAD ENVIRONMENT ASSETS" label (x≈12–330)
    • The big landscape wrestling billboard (x≈340–1412)
    • SEGA/FINISH signs + UI labels on the far right (x≈1413–1528)

  keep_largest() isolates the billboard from the small reference clutter.

── Background ───────────────────────────────────────────────────────────────

  BG: R≈225 G≈234 B≈240 (blue-tinted grey, B−R≈15).
  TOLERANCE raised to 55 so the baked-in grid lines (diff≈40–50) are swept
  into the flood-fill without touching actual billboard content.

── Output ───────────────────────────────────────────────────────────────────

  assets/billboards/billboard_wrestling.png
"""

import os
import numpy as np
from PIL import Image

SRC           = "source_for_sprites/big.png"
PAD           = 8
TOLERANCE     = 55
BLUE_TINT_MIN = 5

# Full content band — keep_largest isolates the billboard from small items.
CELL = (12, 54, 1415, 688)

os.makedirs("assets/billboards",        exist_ok=True)
os.makedirs("source_for_sprites/debug", exist_ok=True)

# ── Pipeline ────────────────────────────────────────────────────────────────

def detect_bg_color(arr):
    edges = np.concatenate([arr[0,:,:3], arr[-1,:,:3], arr[:,0,:3], arr[:,-1,:3]])
    return edges.mean(axis=0)


def is_bg(arr, bg):
    diff = np.abs(arr[:,:,:3].astype(np.float32) - bg).max(axis=2)
    bt   = arr[:,:,2].astype(np.int32) - arr[:,:,0].astype(np.int32)
    return (diff < TOLERANCE) & (bt > BLUE_TINT_MIN)


def flood_fill_bg(arr, bg):
    arr     = arr.copy()
    H, W    = arr.shape[:2]
    bg_mask = is_bg(arr, bg)
    visited = np.zeros((H, W), dtype=bool)
    queue   = []

    def try_add(x, y):
        if not visited[y, x] and bg_mask[y, x]:
            visited[y, x] = True
            queue.append((x, y))

    for x in range(W): try_add(x, 0); try_add(x, H-1)
    for y in range(H): try_add(0, y); try_add(W-1, y)

    i = 0
    while i < len(queue):
        x, y = queue[i]; i += 1
        for nx, ny in ((x-1,y),(x+1,y),(x,y-1),(x,y+1)):
            if 0 <= nx < W and 0 <= ny < H:
                try_add(nx, ny)
    arr[visited, 3] = 0
    return arr


def remove_interior_bg(arr, bg):
    from scipy.ndimage import label as sp_label
    arr  = arr.copy()
    H, W = arr.shape[:2]
    cand = (arr[:,:,3] == 255) & is_bg(arr, bg)
    labeled, n = sp_label(cand)
    if n == 0: return arr
    border = np.zeros((H, W), dtype=bool)
    border[0,:] = border[-1,:] = border[:,0] = border[:,-1] = True
    bl = set(labeled[border & cand]); bl.discard(0)
    arr[cand & ~np.isin(labeled, list(bl)), 3] = 0
    return arr


def defringe(arr, bg, passes=2):
    arr  = arr.copy()
    bg_m = is_bg(arr, bg)
    for _ in range(passes):
        a = arr[:,:,3]; op = a==255; tr = a==0
        border = op & (np.roll(tr,1,0)|np.roll(tr,-1,0)|np.roll(tr,1,1)|np.roll(tr,-1,1))
        arr[border & bg_m, 3] = 0
    return arr


def keep_largest(arr):
    from scipy.ndimage import label as sp_label
    arr = arr.copy()
    labeled, n = sp_label(arr[:,:,3] > 10)
    if n <= 1: return arr
    sizes = np.bincount(labeled.ravel()); sizes[0] = 0
    arr[labeled != int(sizes.argmax()), 3] = 0
    return arr


def extract(full_arr, bg, cx1, cy1, cx2, cy2):
    region = full_arr[cy1:cy2, cx1:cx2, :].copy()

    # Pass 1 — exterior bg from cell edges
    region = flood_fill_bg(region, bg)
    region = defringe(region, bg)
    region = keep_largest(region)

    alpha  = region[:,:,3]
    ys, xs = np.where(alpha > 10)
    if len(xs) == 0:
        return Image.new("RGBA", (cx2-cx1, cy2-cy1), (0,0,0,0))

    x1 = max(0, xs.min()-PAD);  y1 = max(0, ys.min()-PAD)
    x2 = min(region.shape[1], xs.max()+PAD+1)
    y2 = min(region.shape[0], ys.max()+PAD+1)
    cropped = region[y1:y2, x1:x2]

    # Pass 2 — interior bg pockets exposed by crop
    cropped = flood_fill_bg(cropped, bg)
    cropped = remove_interior_bg(cropped, bg)
    cropped = defringe(cropped, bg)
    cropped = keep_largest(cropped)

    # Final tight crop
    alpha2   = cropped[:,:,3]
    ys2, xs2 = np.where(alpha2 > 10)
    if len(xs2) == 0:
        return Image.new("RGBA", (x2-x1, y2-y1), (0,0,0,0))
    ax1 = max(0, xs2.min()-PAD);  ay1 = max(0, ys2.min()-PAD)
    ax2 = min(cropped.shape[1], xs2.max()+PAD+1)
    ay2 = min(cropped.shape[0], ys2.max()+PAD+1)
    return Image.fromarray(cropped[ay1:ay2, ax1:ax2])


# ── Main ─────────────────────────────────────────────────────────────────────

src_img  = Image.open(SRC).convert("RGBA")
src_arr  = np.array(src_img)
bg_color = detect_bg_color(src_arr)

print(f"{SRC}: {src_img.width}×{src_img.height}")
print(f"BG: R={bg_color[0]:.0f} G={bg_color[1]:.0f} B={bg_color[2]:.0f}")

cx1, cy1, cx2, cy2 = CELL
billboard = extract(src_arr, bg_color, cx1, cy1, cx2, cy2)

filled = (np.array(billboard)[:,:,3] > 10).sum()
print(f"\nbillboard_wrestling: {billboard.width}×{billboard.height}  ({filled:,} px)")

billboard.save("assets/billboards/billboard_wrestling.png")
billboard.save("source_for_sprites/debug/billboard_wrestling.png")
print("→ assets/billboards/billboard_wrestling.png")
