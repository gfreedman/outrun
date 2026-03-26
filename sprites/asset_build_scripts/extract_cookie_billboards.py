#!/usr/bin/env python3
"""
extract_cookie_billboards.py

Extracts the last four Cookie Monster billboard sprites from
'source_for_sprites/cookie.png' and saves each as a clean transparent PNG.

── Source layout ────────────────────────────────────────────────────────────

  source_for_sprites/cookie.png  —  2107×496 px, RGBA.

  Left section (~x 0–680):   Section 3 road environment assets (palms, cacti).
  Right section (x 680–2093): Section 6 — five Cookie Monster billboards.

  Billboard x ranges (detected from gap columns):
    Bill 1  TOBACCO TASTE        x  680 –  906   (skipped)
    Bill 2  HAPPY SMOKING TIME   x  951 – 1191
    Bill 3  PREMIUM CIGARETTES   x 1223 – 1500
    Bill 4  SMOKIN NOW           x 1543 – 1813
    Bill 5  CIGARETTE RESERVES   x 1843 – 2093

  Full row y range: y 0 – 495.
  Top header band (~y 0–55) is stripped by clip_above_frame().

── Background ───────────────────────────────────────────────────────────────

  Background: R≈230 G≈242 B≈243 (light blue-tinted grey).
  Blue-tint test (B − R > BLUE_TINT_MIN) distinguishes it from the neutral
  white/grey billboard panels, which must be kept as content.

  Two-pass flood fill:
    Pass 1 — on the source cell: removes exterior background reachable from
             the cell edges.
    Pass 2 — on the cropped extracted sprite: removes the enclosed interior
             background (below the sign panel, between the posts) that was
             inaccessible from the source-cell edges because the sign's solid
             bottom border sealed it off.

── Outputs ──────────────────────────────────────────────────────────────────

  assets/billboards/billboard_cookie_monster_happy_smoking.png
  assets/billboards/billboard_cookie_monster_premium_cigs.png
  assets/billboards/billboard_cookie_monster_smokin_now.png
  assets/billboards/billboard_cookie_monster_cig_reserves.png
"""

import os
import numpy as np
from PIL import Image

# ── Config ──────────────────────────────────────────────────────────────────

SRC = "source_for_sprites/cookie.png"
PAD = 8

# Background detection thresholds.
# The source grid/shadow elements below the sign panels have diff_from_bg ≈ 50–53
# and B-R ≈ 8–20.  TOLERANCE=55 + BLUE_TINT_MIN=8 catches them while leaving the
# sign frame (diff >> 55 or B-R < 8) and white billboard panel (B-R ≈ 0) untouched.
TOLERANCE     = 55
BLUE_TINT_MIN = 8

CELLS = {
    "billboard_cookie_monster_happy_smoking":  ( 951,  0, 1191, 496),
    "billboard_cookie_monster_premium_cigs":   (1223,  0, 1500, 496),
    "billboard_cookie_monster_smokin_now":     (1543,  0, 1813, 496),
    "billboard_cookie_monster_cig_reserves":   (1843,  0, 2093, 496),
}

os.makedirs("assets/billboards", exist_ok=True)
os.makedirs("source_for_sprites/debug", exist_ok=True)

# ── Background helpers ───────────────────────────────────────────────────────

def detect_bg_color(arr: np.ndarray) -> np.ndarray:
    edges = np.concatenate([
        arr[0,  :,  :3],
        arr[-1, :,  :3],
        arr[:,  0,  :3],
        arr[:, -1,  :3],
    ])
    return edges.mean(axis=0)


def is_bg(arr: np.ndarray, bg: np.ndarray) -> np.ndarray:
    """True where pixel is background-blue-grey (not neutral white/panel)."""
    diff       = np.abs(arr[:, :, :3].astype(np.float32) - bg).max(axis=2)
    blue_tint  = arr[:, :, 2].astype(np.int32) - arr[:, :, 0].astype(np.int32)
    return (diff < TOLERANCE) & (blue_tint > BLUE_TINT_MIN)


def flood_fill_bg(arr: np.ndarray, bg: np.ndarray) -> np.ndarray:
    """Zero alpha of all BG pixels reachable from image edges."""
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
        try_add(x, 0)
        try_add(x, H - 1)
    for y in range(H):
        try_add(0, y)
        try_add(W - 1, y)

    i = 0
    while i < len(queue):
        x, y = queue[i]; i += 1
        for nx, ny in ((x-1, y), (x+1, y), (x, y-1), (x, y+1)):
            if 0 <= nx < W and 0 <= ny < H:
                try_add(nx, ny)

    arr[visited, 3] = 0
    return arr


def remove_interior_bg(arr: np.ndarray, bg: np.ndarray) -> np.ndarray:
    """
    Remove background-colored blobs that are fully interior (don't touch
    the image border).  These are the enclosed dead-space pockets below
    the billboard sign panel that the edge-seeded flood fill cannot reach.
    """
    from scipy.ndimage import label as sp_label

    arr  = arr.copy()
    H, W = arr.shape[:2]

    # Candidate interior-bg pixels: alpha=255 AND bg-coloured
    opaque = arr[:, :, 3] == 255
    bg_col = is_bg(arr, bg)
    cand   = opaque & bg_col

    labeled, n = sp_label(cand)
    if n == 0:
        return arr

    # A blob touches the border if any of its pixels sits on the outer ring
    border_mask = np.zeros((H, W), dtype=bool)
    border_mask[0, :]  = True
    border_mask[-1, :] = True
    border_mask[:, 0]  = True
    border_mask[:, -1] = True

    border_labels = set(labeled[border_mask & cand])
    border_labels.discard(0)

    # Any labeled blob not touching the border is interior — kill it
    interior = cand & ~np.isin(labeled, list(border_labels))
    arr[interior, 3] = 0
    return arr


def defringe(arr: np.ndarray, bg: np.ndarray, passes: int = 2) -> np.ndarray:
    """Erode residual BG-coloured fringe pixels from silhouette edges."""
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


def clip_above_frame(arr: np.ndarray) -> np.ndarray:
    """Zero every row above the first near-solid dark horizontal band."""
    arr  = arr.copy()
    dark = arr[:, :, :3].max(axis=2) < 120
    for y in range(arr.shape[0]):
        if dark[y].mean() > 0.35:
            arr[:y, :, 3] = 0
            return arr
    return arr


def keep_largest(arr: np.ndarray) -> np.ndarray:
    """Keep only the largest connected opaque blob."""
    from scipy.ndimage import label as sp_label
    arr     = arr.copy()
    visible = arr[:, :, 3] > 10
    labeled, n = sp_label(visible)
    if n <= 1:
        return arr
    sizes       = np.bincount(labeled.ravel())
    sizes[0]    = 0
    best_label  = int(sizes.argmax())
    arr[labeled != best_label, 3] = 0
    return arr


def trim_posts(arr: np.ndarray, max_post_px: int = 55) -> np.ndarray:
    """
    Cap post height to max_post_px below the sign panel bottom.

    The sign panel bottom is the last row where visible content spans more than
    40% of the image width.  Everything below that row beyond max_post_px is
    zeroed — removing the long shadow/base area while keeping real post pixels.
    """
    arr = arr.copy()
    H, W = arr.shape[:2]
    alpha = arr[:, :, 3]

    row_widths = np.array([(alpha[y] > 10).sum() for y in range(H)])
    wide_rows  = np.where(row_widths > W * 0.4)[0]
    if len(wide_rows) == 0:
        return arr

    sign_bottom_y = int(wide_rows[-1])
    cutoff_y      = sign_bottom_y + max_post_px + 1
    if cutoff_y < H:
        arr[cutoff_y:, :, 3] = 0
    return arr


def extract_billboard(full_arr: np.ndarray, bg: np.ndarray,
                      cx1: int, cy1: int, cx2: int, cy2: int) -> Image.Image:
    region = full_arr[cy1:cy2, cx1:cx2, :].copy()

    # Pass 1: remove exterior bg from source-cell edges
    region = flood_fill_bg(region, bg)
    region = defringe(region, bg)
    region = clip_above_frame(region)
    region = keep_largest(region)

    # Tight-crop to visible pixels
    alpha  = region[:, :, 3]
    ys, xs = np.where(alpha > 10)
    if len(xs) == 0:
        return Image.new("RGBA", (cx2 - cx1, cy2 - cy1), (0, 0, 0, 0))

    x1 = max(0, int(xs.min()) - PAD)
    y1 = max(0, int(ys.min()) - PAD)
    x2 = min(region.shape[1], int(xs.max()) + PAD + 1)
    y2 = min(region.shape[0], int(ys.max()) + PAD + 1)
    cropped = region[y1:y2, x1:x2, :]

    # Pass 2: remove interior bg enclosed by the sign panel bottom edge.
    # The crop boundary now abuts the post bases, making the enclosed pocket
    # reachable from the new image edges.
    cropped = flood_fill_bg(cropped, bg)
    cropped = remove_interior_bg(cropped, bg)
    cropped = defringe(cropped, bg)
    cropped = keep_largest(cropped)
    # Trim overlong post shadow below the sign body.
    cropped = trim_posts(cropped, max_post_px=55)

    # Re-crop after pass 2 (removes whitespace rows/cols added by enclosed bg)
    alpha2  = cropped[:, :, 3]
    ys2, xs2 = np.where(alpha2 > 10)
    if len(xs2) == 0:
        return Image.new("RGBA", (x2 - x1, y2 - y1), (0, 0, 0, 0))

    ax1 = max(0, int(xs2.min()) - PAD)
    ay1 = max(0, int(ys2.min()) - PAD)
    ax2 = min(cropped.shape[1], int(xs2.max()) + PAD + 1)
    ay2 = min(cropped.shape[0], int(ys2.max()) + PAD + 1)

    return Image.fromarray(cropped[ay1:ay2, ax1:ax2, :])


# ── Main ─────────────────────────────────────────────────────────────────────

print("=" * 60)
print("Loading cookie billboard source")
print("=" * 60)

src_img  = Image.open(SRC).convert("RGBA")
src_arr  = np.array(src_img)
bg_color = detect_bg_color(src_arr)

print(f"  {SRC}: {src_img.width}×{src_img.height}")
print(f"  Detected BG colour: R={bg_color[0]:.0f} G={bg_color[1]:.0f} B={bg_color[2]:.0f}")
print(f"  Extracting {len(CELLS)} billboards")
print()

print("=" * 60)
print("Extracting")
print("=" * 60)

for stem, (cx1, cy1, cx2, cy2) in CELLS.items():
    billboard = extract_billboard(src_arr, bg_color, cx1, cy1, cx2, cy2)

    arr    = np.array(billboard)
    filled = (arr[:, :, 3] > 10).sum()

    if filled == 0:
        print(f"  WARN  {stem} — no visible pixels!")
    else:
        out_path   = f"assets/billboards/{stem}.png"
        debug_path = f"source_for_sprites/debug/{stem}.png"
        billboard.save(out_path)
        billboard.save(debug_path)
        print(f"  {stem}")
        print(f"    cell ({cx1},{cy1})–({cx2},{cy2})"
              f"  →  {billboard.width}×{billboard.height}"
              f"  ({filled:,} px visible)")
        print(f"    → {out_path}")

print()
print("=" * 60)
print(f"DONE — 4 cookie monster billboards written to assets/billboards/")
print("=" * 60)
