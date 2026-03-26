#!/usr/bin/env python3
"""
extract_barney_billboards.py

Extracts two Barney billboard sprites from 'source_for_sprites/barney.png':
  • OUTRUN-PALETTE (BILLBOARDED WOODS) — wooden A-frame with Wanted poster
  • METAL TILLETIRE (BILLBOARDS)       — tilted metal-frame with Wanted poster

── Source layout ────────────────────────────────────────────────────────────

  source_for_sprites/barney.png  —  848×1234 px, RGBA.

  Row 2  y=624–962:  col 1=OUTRUN-STYLE, col 2=METAL STAND, col 3=OUTRUN-PALETTE WOODS
  Row 3  y=963–1202: col 1=METAL TILLETIRE, col 2=PASTIFNETE, col 3=DAMAGE VARIANTS

  Column boundaries (gap-column analysis): col splits at x≈288 and x≈560.

── Background ───────────────────────────────────────────────────────────────

  Background: R≈192 G≈208 B≈215 (blue-tinted grey, B−R≈23).
  Blue-tint test (B − R > BLUE_TINT_MIN) protects neutral white/tan billboard
  panels and parchment-coloured Wanted-poster paper from being removed.

── Outputs ──────────────────────────────────────────────────────────────────

  assets/billboards/billboard_barney_outrun_palette.png
  assets/billboards/billboard_barney_metal_tilletire.png
"""

import os
import numpy as np
from PIL import Image

# ── Config ──────────────────────────────────────────────────────────────────

SRC           = "source_for_sprites/barney.png"
PAD           = 8
# The barney.png grid lines below each cell (baked-in background texture) have
# diff_from_bg ≈ 63–75 — well above the usual 40 threshold.  TOLERANCE=80 is
# needed to dissolve them and disconnect the caption text from the billboard legs.
# All actual content (dark wood planks, parchment poster, Barney's purple, metal
# frame) has diff_from_bg >> 80, so nothing real is at risk.
TOLERANCE     = 80
BLUE_TINT_MIN = 6

CELLS = {
    "billboard_barney_outrun_palette":   (560, 624, 832, 962),
    "billboard_barney_metal_tilletire":  (  2, 963, 288, 1202),
}

os.makedirs("assets/billboards",        exist_ok=True)
os.makedirs("source_for_sprites/debug", exist_ok=True)

# ── Helpers (same proven pipeline as cookie / original billboard extractors) ─

def detect_bg_color(arr: np.ndarray) -> np.ndarray:
    edges = np.concatenate([arr[0,:,:3], arr[-1,:,:3], arr[:,0,:3], arr[:,-1,:3]])
    return edges.mean(axis=0)


def is_bg(arr: np.ndarray, bg: np.ndarray) -> np.ndarray:
    diff      = np.abs(arr[:,:,:3].astype(np.float32) - bg).max(axis=2)
    blue_tint = arr[:,:,2].astype(np.int32) - arr[:,:,0].astype(np.int32)
    return (diff < TOLERANCE) & (blue_tint > BLUE_TINT_MIN)


def flood_fill_bg(arr: np.ndarray, bg: np.ndarray) -> np.ndarray:
    arr     = arr.copy()
    H, W    = arr.shape[:2]
    bg_mask = is_bg(arr, bg)
    visited = np.zeros((H, W), dtype=bool)
    queue   = []

    def try_add(x: int, y: int):
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


def remove_interior_bg(arr: np.ndarray, bg: np.ndarray) -> np.ndarray:
    """Remove background-coloured blobs that don't touch the image border."""
    from scipy.ndimage import label as sp_label
    arr  = arr.copy()
    H, W = arr.shape[:2]

    opaque = arr[:,:,3] == 255
    cand   = opaque & is_bg(arr, bg)
    labeled, n = sp_label(cand)
    if n == 0:
        return arr

    border = np.zeros((H, W), dtype=bool)
    border[0,:] = border[-1,:] = border[:,0] = border[:,-1] = True
    border_labels = set(labeled[border & cand])
    border_labels.discard(0)

    arr[cand & ~np.isin(labeled, list(border_labels)), 3] = 0
    return arr


def defringe(arr: np.ndarray, bg: np.ndarray, passes: int = 2) -> np.ndarray:
    arr  = arr.copy()
    bg_m = is_bg(arr, bg)
    for _ in range(passes):
        a      = arr[:,:,3]
        opaque = (a == 255)
        transp = (a == 0)
        border = opaque & (
            np.roll(transp, 1, 0) | np.roll(transp,-1, 0) |
            np.roll(transp, 1, 1) | np.roll(transp,-1, 1)
        )
        arr[border & bg_m, 3] = 0
    return arr


def clip_above_frame(arr: np.ndarray) -> np.ndarray:
    """Zero rows above the first dense dark horizontal band (frame top edge)."""
    arr  = arr.copy()
    dark = arr[:,:,:3].max(axis=2) < 120
    for y in range(arr.shape[0]):
        if dark[y].mean() > 0.25:
            arr[:y, :, 3] = 0
            return arr
    return arr


def keep_largest(arr: np.ndarray) -> np.ndarray:
    from scipy.ndimage import label as sp_label
    arr     = arr.copy()
    labeled, n = sp_label(arr[:,:,3] > 10)
    if n <= 1:
        return arr
    sizes = np.bincount(labeled.ravel()); sizes[0] = 0
    arr[labeled != int(sizes.argmax()), 3] = 0
    return arr


def extract_billboard(full_arr: np.ndarray, bg: np.ndarray,
                      cx1: int, cy1: int, cx2: int, cy2: int) -> Image.Image:
    region = full_arr[cy1:cy2, cx1:cx2, :].copy()

    # Pass 1 — exterior bg from cell edges.
    # clip_above_frame is NOT used: barney.png cells have no section-header
    # text above the billboard content (labels appear below or outside cells),
    # and the metal billboard has light-coloured content near its top that
    # would cause clip_above_frame to trigger mid-sprite and delete content.
    region = flood_fill_bg(region, bg)
    region = defringe(region, bg)
    region = keep_largest(region)

    alpha  = region[:,:,3]
    ys, xs = np.where(alpha > 10)
    if len(xs) == 0:
        return Image.new("RGBA", (cx2-cx1, cy2-cy1), (0,0,0,0))

    x1 = max(0, int(xs.min()) - PAD)
    y1 = max(0, int(ys.min()) - PAD)
    x2 = min(region.shape[1], int(xs.max()) + PAD + 1)
    y2 = min(region.shape[0], int(ys.max()) + PAD + 1)
    cropped = region[y1:y2, x1:x2, :]

    # Pass 2 — interior bg pockets exposed by crop boundary
    cropped = flood_fill_bg(cropped, bg)
    cropped = remove_interior_bg(cropped, bg)
    cropped = defringe(cropped, bg)
    cropped = keep_largest(cropped)

    # Final tight crop
    alpha2   = cropped[:,:,3]
    ys2, xs2 = np.where(alpha2 > 10)
    if len(xs2) == 0:
        return Image.new("RGBA", (x2-x1, y2-y1), (0,0,0,0))

    ax1 = max(0, int(xs2.min()) - PAD)
    ay1 = max(0, int(ys2.min()) - PAD)
    ax2 = min(cropped.shape[1], int(xs2.max()) + PAD + 1)
    ay2 = min(cropped.shape[0], int(ys2.max()) + PAD + 1)
    return Image.fromarray(cropped[ay1:ay2, ax1:ax2, :])


# ── Main ─────────────────────────────────────────────────────────────────────

print("=" * 60)
print("Loading barney billboard source")
print("=" * 60)

src_img  = Image.open(SRC).convert("RGBA")
src_arr  = np.array(src_img)
bg_color = detect_bg_color(src_arr)

print(f"  {SRC}: {src_img.width}×{src_img.height}")
print(f"  BG colour: R={bg_color[0]:.0f} G={bg_color[1]:.0f} B={bg_color[2]:.0f}")
print()

print("=" * 60)
print("Extracting")
print("=" * 60)

for stem, (cx1, cy1, cx2, cy2) in CELLS.items():
    billboard = extract_billboard(src_arr, bg_color, cx1, cy1, cx2, cy2)
    arr    = np.array(billboard)
    filled = (arr[:,:,3] > 10).sum()

    if filled == 0:
        print(f"  WARN  {stem} — no visible pixels!")
    else:
        out_path   = f"assets/billboards/{stem}.png"
        debug_path = f"source_for_sprites/debug/{stem}.png"
        billboard.save(out_path)
        billboard.save(debug_path)
        print(f"  {stem}")
        print(f"    cell ({cx1},{cy1})–({cx2},{cy2})  →  {billboard.width}×{billboard.height}  ({filled:,} px)")
        print(f"    → {out_path}")

print()
print("Done.")
