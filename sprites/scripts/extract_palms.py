#!/usr/bin/env python3
"""
extract_palms.py

Extracts individual palm tree sprites from palm_tree_source.png and saves
each as a transparent PNG with a tight crop and PAD pixels of margin.

── Source layout ──────────────────────────────────────────────────────────

  palm_tree_source.png is a 1380×752 px sprite sheet arranged in three
  rows using the same GRID = [7, 6, 6] layout as the car source images.
  The checker background is painted (alpha = 255 everywhere), so the
  background must be removed from the RGB data.

── Why a chroma-based flood fill instead of colour-match ─────────────────

  The car sources used a single near-grey background colour (~164,163,164)
  that was easy to match with one estimate.  Here the checker alternates
  between a light warm-grey (~182,180,167, chroma≈30) and a dark warm-grey
  (~100,97,86, chroma≈25).  Both colours have low chroma, while all tree
  content (green fronds, brown trunk, shadows) has chroma ≥ 40.

  The flood fill therefore uses a pure chroma threshold: any pixel with
  chroma < BG_CHROMA that is 4-connected to the image edge is background.
  This catches both checker square colours in a single pass.

── Defringe ───────────────────────────────────────────────────────────────

  Anti-aliased silhouette edges leave residual checker-coloured pixels
  immediately inside the newly-transparent border.  Two inward erosion
  passes remove them: a pixel is erased if it is opaque, adjacent to a
  transparent pixel, and its chroma is below BG_CHROMA.

── Outputs ────────────────────────────────────────────────────────────────

  parts/palms/palm_t1_straight.png
  parts/palms/palm_t2_bent_left.png
  parts/palms/palm_t2_bent_right.png
  parts/palms/palm_t3_young.png
  parts/palms/palm_t4_fruiting.png
  parts/palms/palm_t6_luxuriant.png
  parts/palms/palm_t7_slender.png
  parts/palms/palm_t8_medium.png
  parts/palms/palm_t10_large.png
"""

import os
import numpy as np
from PIL import Image

# ── Config ─────────────────────────────────────────────────────────────────────

# Source image path (relative to this script's directory).
SRC = "source/palm_tree_source.png"

# Transparent padding (pixels) added around each tight-cropped tree.
PAD = 8

# Chroma threshold that separates background checker squares from tree pixels.
# Light checker squares measure chroma ≈ 36, dark checker ≈ 25–28.
# Tree content (green fronds, brown trunk, even dark shadows) has chroma ≥ 60.
# 40 sits safely between the two populations with headroom on both sides.
BG_CHROMA = 40

# How much wider/taller than the nominal source cell to extract.
# A small EXTRACT_MULT is enough for palm trees — they mostly fit their cells.
# The extra margin helps capture frond tips that overflow slightly.
EXTRACT_MULT_X = 1.3   # expand cell width by 30% (15% on each side)
EXTRACT_MULT_Y = 1.2   # expand cell height by 20% (10% on each side)

# Number of frames per row in the source grid.
GRID = [7, 6, 6]

# Trees to extract: (source_grid_index, output_stem, label)
# Grid index is 0-based, reading left-to-right across all rows.
#   Row 1 (7 cols): indices 0–6  →  T1–T7
#   Row 2 (6 cols): indices 7–12 →  T8–T13
#   Row 3 (6 cols): indices 13–18→  T14–T19
TARGETS = [
    (0,  "palm_t1_straight",   "T1  Straight – Full Grown"),
    (1,  "palm_t2_bent",       "T2  Bent Left – Coastal"),
    (2,  "palm_t3_young",      "T3  Young – Shorter Trunk"),
    (3,  "palm_t4_fruiting",   "T4  Fruiting – Clustered Coconuts"),
    (5,  "palm_t6_luxuriant",  "T6  Luxuriant – Dense Crown"),
    (6,  "palm_t7_slender",    "T7  Slender – Extra Tall"),
    (7,  "palm_t8_medium",     "T8  Size Medium"),
    (9,  "palm_t10_large",     "T10 Size Large"),
]

os.makedirs("parts/palms", exist_ok=True)

# ── Grid detection ─────────────────────────────────────────────────────────────

def detect_header_height(arr):
    """
    Find the Y where the title banner ends.

    Scans the first 150 rows for the last near-empty horizontal line
    (very few chromatic pixels).  The banner text shows low chroma overall;
    the tree rows that follow show high chroma immediately.

    Args:
        arr: H×W×C uint8 numpy array.

    Returns:
        int — first Y row of usable sprite content.
    """
    r     = arr[:,:,0].astype(np.int32)
    g     = arr[:,:,1].astype(np.int32)
    b     = arr[:,:,2].astype(np.int32)
    chroma = np.abs(r-g) + np.abs(g-b) + np.abs(r-b)
    H     = arr.shape[0]
    last_gap = 30
    for y in range(30, min(H, 150)):
        if (chroma[y] > 30).mean() < 0.03:
            last_gap = y
    return last_gap + 1


def detect_grid_positions(arr, grid=GRID):
    """
    Return bounding boxes for every cell in the source grid.

    Detects the header height, then divides the remaining image into rows
    and columns according to the GRID frame-count list.

    Args:
        arr:  H×W×C uint8 numpy array.
        grid: List of int — number of columns in each row.

    Returns:
        List of (x1, y1, x2, y2) tuples in row-major order.
    """
    H, W     = arr.shape[:2]
    header_y = detect_header_height(arr)
    usable_h = H - header_y
    row_h    = usable_h // len(grid)

    cells = []
    for row_idx, n_cols in enumerate(grid):
        row_y1 = header_y + row_idx * row_h
        row_y2 = header_y + (row_idx + 1) * row_h
        col_w  = W // n_cols
        for col_idx in range(n_cols):
            cx1 = col_idx * col_w
            cx2 = cx1 + col_w if col_idx < n_cols - 1 else W
            cells.append((cx1, row_y1, cx2, row_y2))
    return cells

# ── Background removal ─────────────────────────────────────────────────────────

def flood_fill_bg(arr, chroma_thresh=BG_CHROMA):
    """
    Zero the alpha of background pixels reachable from the image edges.

    Uses a chroma-only criterion: a pixel is background if its RGB chroma
    (sum of absolute pairwise channel differences) is below chroma_thresh.
    This catches both the light checker squares (~chroma 30) and the dark
    checker squares (~chroma 25) in a single pass, without needing to match
    against a specific background colour.

    Args:
        arr:          H×W×4 uint8 numpy array (RGBA).
        chroma_thresh: Maximum chroma for a pixel to be treated as background.

    Returns:
        Copy of arr with background pixels zeroed in the alpha channel.
    """
    arr     = arr.copy()
    H, W    = arr.shape[:2]
    r       = arr[:,:,0].astype(np.int32)
    g       = arr[:,:,1].astype(np.int32)
    b       = arr[:,:,2].astype(np.int32)
    chroma  = np.abs(r-g) + np.abs(g-b) + np.abs(r-b)

    visited = np.zeros((H, W), dtype=bool)
    queue   = []

    def try_add(x, y):
        if visited[y, x]:
            return
        if chroma[y, x] < chroma_thresh:
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


def defringe(arr, chroma_thresh=BG_CHROMA, passes=2):
    """
    Erode residual checker-coloured pixels from the tree silhouette edges.

    After flood_fill_bg, anti-aliased edge pixels with blended checker colour
    remain as opaque pixels immediately inside the new transparent border.
    Each pass zeros opaque pixels that are both adjacent to a transparent
    pixel AND below chroma_thresh.  Green frond pixels and brown trunk pixels
    are always above the threshold and are never touched.

    Args:
        arr:          H×W×4 uint8 numpy array (RGBA), after flood_fill_bg.
        chroma_thresh: Maximum chroma to treat as residual background.
        passes:       Number of inward erosion rounds.

    Returns:
        Defringed copy of arr.
    """
    arr = arr.copy()
    for _ in range(passes):
        a       = arr[:,:,3]
        r       = arr[:,:,0].astype(np.int32)
        g_ch    = arr[:,:,1].astype(np.int32)
        b       = arr[:,:,2].astype(np.int32)
        chroma  = np.abs(r-g_ch) + np.abs(g_ch-b) + np.abs(r-b)
        opaque  = (a == 255)
        transp  = (a == 0)
        # A pixel is on the silhouette border if it is opaque and any of its
        # 4-connected neighbours is transparent.
        border  = opaque & (
            np.roll(transp,  1, 0) | np.roll(transp, -1, 0) |
            np.roll(transp,  1, 1) | np.roll(transp, -1, 1)
        )
        arr[border & (chroma < chroma_thresh), 3] = 0
    return arr


def keep_largest(arr):
    """
    Discard all connected components except the largest visible blob.

    Used after drop_speckle to remove partial adjacent-tree bleeds that
    survived the minimum-size filter (e.g. T6's fronds appearing in T7's
    extraction region).  For trees with a single clean blob this is a no-op.

    Args:
        arr: H×W×4 uint8 numpy array (RGBA).

    Returns:
        Copy of arr with all but the largest blob zeroed in the alpha channel.
    """
    from scipy.ndimage import label as sp_label

    arr      = arr.copy()
    visible  = arr[:,:,3] > 10
    labeled, n = sp_label(visible)
    if n <= 1:
        return arr
    sizes = np.bincount(labeled.ravel()); sizes[0] = 0
    arr[labeled != sizes.argmax(), 3] = 0
    return arr


def drop_speckle(arr, min_blob_px=300):
    """
    Remove isolated specks left after flood-fill by discarding small blobs.

    The palm tree forms one large connected component.  Residual checker
    squares — especially those with a slight greenish tint that escaped the
    chroma-based flood fill — appear as many tiny disconnected blobs.
    Any blob smaller than min_blob_px pixels is zeroed.

    A min of 300 px is intentionally conservative: even a single frond tip
    is much larger than the largest individual checker square (~100–150 px).

    Args:
        arr:         H×W×4 uint8 numpy array (RGBA).
        min_blob_px: Minimum connected-component size to keep.

    Returns:
        Copy of arr with small isolated blobs zeroed in the alpha channel.
    """
    from scipy.ndimage import label as sp_label

    arr      = arr.copy()
    visible  = arr[:,:,3] > 10
    labeled, n = sp_label(visible)
    if n == 0:
        return arr
    for lbl in range(1, n + 1):
        if (labeled == lbl).sum() < min_blob_px:
            arr[labeled == lbl, 3] = 0
    return arr

# ── Extraction ─────────────────────────────────────────────────────────────────

def extract_tree(full_arr, cx1, cy1, cx2, cy2):
    """
    Extract one palm tree from the source image and return it as a PIL Image.

    Expands the nominal grid cell by EXTRACT_MULT_X horizontally and
    EXTRACT_MULT_Y vertically before running background removal, so frond
    tips that slightly overflow the source cell boundary are captured.

    Steps:
      1. Crop the expanded region from the source.
      2. flood_fill_bg removes the checker background.
      3. defringe erodes residual checker-coloured edge pixels.
      4. Tight-crop to visible content with PAD pixels of transparent margin.

    Args:
        full_arr:       H×W×4 uint8 numpy array of the full source image.
        cx1, cy1:       Top-left of the nominal grid cell.
        cx2, cy2:       Bottom-right of the nominal grid cell.

    Returns:
        PIL Image (RGBA) — the isolated tree, tight-cropped with PAD margin.
    """
    H, W   = full_arr.shape[:2]
    cell_w = cx2 - cx1
    cell_h = cy2 - cy1

    extra_x = int(cell_w * (EXTRACT_MULT_X - 1.0) / 2)
    extra_y = int(cell_h * (EXTRACT_MULT_Y - 1.0) / 2)

    ex1 = max(0, cx1 - extra_x)
    ey1 = max(0, cy1 - extra_y)
    ex2 = min(W, cx2 + extra_x)
    ey2 = min(H, cy2 + extra_y)

    region = full_arr[ey1:ey2, ex1:ex2, :].copy()
    region = flood_fill_bg(region)
    region = defringe(region)
    region = drop_speckle(region)
    region = keep_largest(region)

    alpha  = region[:,:,3]
    ys, xs = np.where(alpha > 10)
    if len(xs) == 0:
        return Image.new("RGBA", (cell_w, cell_h), (0,0,0,0))

    x1 = max(0, int(xs.min()) - PAD)
    y1 = max(0, int(ys.min()) - PAD)
    x2 = min(region.shape[1], int(xs.max()) + PAD + 1)
    y2 = min(region.shape[0], int(ys.max()) + PAD + 1)

    return Image.fromarray(region[y1:y2, x1:x2, :])

# ── Main ───────────────────────────────────────────────────────────────────────

print("="*60)
print("Loading source image")
print("="*60)

src_img = Image.open(SRC).convert("RGBA")
src_arr = np.array(src_img)
print(f"  {SRC}: {src_img.width}×{src_img.height}  mode={src_img.mode}")

cells = detect_grid_positions(src_arr)
print(f"  Detected {len(cells)} grid cells  (expected {sum(GRID)})")

print()
print("="*60)
print("Extracting trees")
print("="*60)

for grid_idx, stem, label in TARGETS:
    if grid_idx >= len(cells):
        print(f"  SKIP {label} — grid index {grid_idx} out of range")
        continue

    cx1, cy1, cx2, cy2 = cells[grid_idx]
    tree = extract_tree(src_arr, cx1, cy1, cx2, cy2)

    # Verify the result has content
    arr    = np.array(tree)
    filled = (arr[:,:,3] > 10).sum()
    if filled == 0:
        print(f"  WARN {label} — no visible pixels after extraction!")
    else:
        out_path = f"parts/palms/{stem}.png"
        tree.save(out_path)
        print(f"  {label}")
        print(f"    cell ({cx1},{cy1})–({cx2},{cy2})  →  extracted {tree.width}×{tree.height}  ({filled} px visible)")
        print(f"    → {out_path}")

print()
print("="*60)
print(f"DONE — {len(TARGETS)} trees written to parts/palms/")
print("="*60)
