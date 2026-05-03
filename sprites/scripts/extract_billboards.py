#!/usr/bin/env python3
"""
extract_billboards.py

Extracts 12 individual billboard sprites from 'billboard sprites.png' and
saves each as a transparent PNG ready for atlas stitching.

── Source layout ──────────────────────────────────────────────────────────

  source/billboard sprites.png  —  1246×848 px.
  3 rows × 4 columns = 12 billboards.

  Each row begins with a section-header text band (e.g. "1. BEAGLE
  PROMOTIONS") that occupies the full row width.  Rows 1 and 3 also have a
  right-margin text block ("TEXT ELEMENTS / AD / OPEN / TRY ONE").

── Background ─────────────────────────────────────────────────────────────

  Background colour: approximately R=217 G=231 B=238  (light blue-grey).
  Detected from the image-edge pixels at load time.
  A flood fill from the image edges removes any pixel within TOLERANCE of
  this colour.  Dark billboard elements (black posts, dark frame edges) are
  not removed because they differ from the background by more than TOLERANCE.

── Section-header removal ─────────────────────────────────────────────────

  After background removal the section-header text letters remain (dark
  pixels at the top of every cell).  keep_largest() discards all but the
  single largest connected blob — which is always the billboard frame +
  panel + post — removing the header text automatically.

── Outputs ────────────────────────────────────────────────────────────────

  parts/billboards/billboard_beagle_pets.png
  parts/billboards/billboard_adopt_beagle.png
  parts/billboards/billboard_beagle_power.png
  parts/billboards/billboard_loyal_friendly.png
  parts/billboards/billboard_frog_tavern.png
  parts/billboards/billboard_ale_croak.png
  parts/billboards/billboard_cellar_jumpers.png
  parts/billboards/billboard_croak_tails.png
  parts/billboards/billboard_red_box.png
  parts/billboards/billboard_fine_tobacco.png
  parts/billboards/billboard_smooth_taste.png
  parts/billboards/billboard_smoke_up.png
"""

import os
import numpy as np
from PIL import Image

# ── Config ─────────────────────────────────────────────────────────────────────

SRC = "source/billboard sprites.png"

# Transparent padding (pixels) around each tight-cropped sprite.
PAD = 8

# Max per-channel distance from BG colour to be treated as background.
# Background is a BLUE-TINTED grey (≈217,231,238, B−R ≈ 21).
# Near-BG variants (≈242,250,253, B−R ≈ 11) appear in header rows.
# White/grey billboard panels are NEUTRAL (B−R ≈ 0) and must be kept.
#
# Two-condition test: pixel is BG if
#   (a) max per-channel diff from estimated BG < TOLERANCE   AND
#   (b) B − R > BLUE_TINT_MIN  (confirms it is blue-tinted, not neutral)
TOLERANCE     = 40
BLUE_TINT_MIN = 4   # blue channel must exceed red by at least this much

# ── Billboard grid: (row_band, col_index) → (x1, y1, x2, y2) ─────────────────
#
# Detected empirically:
#   Row bands (y):   Row 1 = 4–302   Row 2 = 303–572   Row 3 = 576–848
#   Col widths (x):  derived from total content width / 4 per row.
#     Row 1 content: x=19–1197  →  ~295 px/col
#     Row 2 content: x=19–1152  →  ~283 px/col
#     Row 3 content: x=35–1197  →  ~291 px/col
#
# Index layout (row-major, left-to-right, top-to-bottom):
#   0–3  = row 1  (beagle)
#   4–7  = row 2  (frog tavern)
#   8–11 = row 3  (tobacco)

def _build_cells():
    """
    Build the list of (x1, y1, x2, y2) crop rectangles for all 12 billboard cells.

    The source image is a 3-row × 4-column grid of billboard sprites.  Each row
    is preceded by a section-header text band (e.g. "1. BEAGLE PROMOTIONS") that
    must be excluded.  Column boundaries were measured empirically from the source
    image by identifying gap columns (low-variance background strips) between
    adjacent sprites.

    Grid layout (row-major, left-to-right, top-to-bottom):
      Index 0–3  : row 1 — Beagle Promotions billboards
      Index 4–7  : row 2 — Frog Tavern billboards
      Index 8–11 : row 3 — Tobacco Advertisement billboards

    The function iterates over 3 row bands × 4 column spans and appends one
    (x1, y1, x2, y2) tuple per cell, giving a flat 12-element list that maps
    directly to the TARGETS index list.

    Returns
    -------
    list of tuple(int, int, int, int)
        Each tuple is (x1, y1, x2, y2) in source-image pixel coordinates,
        covering one billboard cell including its post and base.
    """
    # cy1 is set BELOW the section-header text to avoid any header bleed:
    #   Row 1 (full band y=4–302): title + "1. BEAGLE PROMOTIONS" ≈ 92 px  → start at y=96
    #   Row 2 (full band y=303–572): "2. FROG TAVERNS…" ≈ 27 px           → start at y=330
    #   Row 3 (full band y=576–848): "3. TOBACCO ADVERTISEMENTS" ≈ 27 px  → start at y=603
    rows  = [(96, 302), (330, 572), (603, 848)]  # (y1, y2) per row — measured from source image

    # cx2 for col 4 in rows 1 and 3 is clamped to 1108 to exclude the
    # right-margin annotation block ("TEXT ELEMENTS / AD / OPEN / TRY ONE").
    cols  = [
        (19,  313, 608,  855, 1095),   # row 1: x boundaries measured from source; col 4 clamped before annotation block
        (19,  302, 585,  868, 1152),   # row 2: no right-margin annotation text; full width used
        (35,  325, 616,  906, 1085),   # row 3: billboard 4 ends ~x=1082, annotation block starts x=1113+
    ]
    cells = []
    for ri, (y1, y2) in enumerate(rows):
        xs = cols[ri]
        for ci in range(4):
            cells.append((xs[ci], y1, xs[ci + 1], y2))
    return cells

CELLS = _build_cells()

TARGETS = [
    (0,  "billboard_beagle_pets"),
    (1,  "billboard_adopt_beagle"),
    (2,  "billboard_beagle_power"),
    (3,  "billboard_loyal_friendly"),
    (4,  "billboard_frog_tavern"),
    (5,  "billboard_ale_croak"),
    (6,  "billboard_cellar_jumpers"),
    (7,  "billboard_croak_tails"),
    (8,  "billboard_red_box"),
    (9,  "billboard_fine_tobacco"),
    (10, "billboard_smooth_taste"),
    (11, "billboard_smoke_up"),
]

os.makedirs("parts/billboards", exist_ok=True)

# ── Background detection ───────────────────────────────────────────────────────

def detect_bg_color(arr: np.ndarray) -> np.ndarray:
    """Estimate background colour as the mean of all four image-edge rows/cols."""
    H, W = arr.shape[:2]
    edges = np.concatenate([
        arr[0,  :,  :3],
        arr[-1, :,  :3],
        arr[:,  0,  :3],
        arr[:, -1,  :3],
    ])
    return edges.mean(axis=0)


def is_bg(arr: np.ndarray, bg: np.ndarray) -> np.ndarray:
    """
    Return a boolean mask that is True where a pixel is background.

    Two conditions must both be true:
      (a) max per-channel diff from the estimated BG < TOLERANCE, so the
          colour is close to the blue-grey background family.
      (b) B − R > BLUE_TINT_MIN, confirming the pixel is blue-tinted.
          White (B−R=0) and neutral grey (B−R≈0) billboard panels fail
          this test and are therefore kept as content.
    """
    diff = np.abs(arr[:, :, :3].astype(np.float32) - bg).max(axis=2)
    blue_tint = arr[:, :, 2].astype(np.int32) - arr[:, :, 0].astype(np.int32)
    return (diff < TOLERANCE) & (blue_tint > BLUE_TINT_MIN)

# ── Background removal ─────────────────────────────────────────────────────────

def flood_fill_bg(arr: np.ndarray, bg: np.ndarray) -> np.ndarray:
    """
    Zero the alpha of all BG pixels reachable from the image edges.
    BG is defined by is_bg(): close to the blue-grey colour AND blue-tinted.
    """
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
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if 0 <= nx < W and 0 <= ny < H:
                try_add(nx, ny)

    arr[visited, 3] = 0
    return arr


def defringe(arr: np.ndarray, bg: np.ndarray, passes: int = 1) -> np.ndarray:
    """Erode residual BG-coloured fringe pixels from the silhouette edges."""
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
    """
    Zero every row above the first row that is predominantly dark pixels.

    The top border of the billboard frame is a near-solid horizontal band of
    dark pixels (density > 0.35).  Everything above it is section-header text
    that survived background removal.  Zeroing those rows breaks any
    "bridge" between the header text blobs and the billboard blob, letting
    keep_largest finish the job cleanly.
    """
    arr   = arr.copy()
    H, W  = arr.shape[:2]
    dark  = (arr[:, :, :3].max(axis=2) < 120) # per-pixel dark flag (120 catches mid-grey outer frame borders)
    for y in range(H):
        if dark[y].mean() > 0.35:
            # Found the billboard frame top — zero all rows above
            arr[:y, :, 3] = 0
            return arr
    return arr   # no clear frame found — return unchanged


def keep_largest(arr: np.ndarray) -> np.ndarray:
    """
    Keep only the largest connected opaque blob.

    After clip_above_frame removes header text, the billboard frame+panel+post
    is the dominant blob.  Any remaining specks (anti-alias fringe, post tips
    separated by transparency) are handled by the speckle pass; keep_largest
    provides a final insurance step.
    """
    from scipy.ndimage import label as sp_label
    arr     = arr.copy()
    visible = arr[:, :, 3] > 10
    labeled, n = sp_label(visible)
    if n <= 1:
        return arr
    sizes      = np.bincount(labeled.ravel())
    sizes[0]   = 0                           # background label = 0, ignore it
    best_label = int(sizes.argmax())
    arr[labeled != best_label, 3] = 0
    return arr

# ── Extraction ─────────────────────────────────────────────────────────────────

def extract_billboard(full_arr: np.ndarray, bg: np.ndarray,
                      cx1: int, cy1: int, cx2: int, cy2: int) -> Image.Image:
    """
    Extract and clean one billboard cell from the full source image.

    The cell boundary already covers the full billboard including post; no
    expansion is needed (unlike the palm extractor where fronds overflow).
    """
    H, W   = full_arr.shape[:2]
    region = full_arr[cy1:cy2, cx1:cx2, :].copy()

    region = flood_fill_bg(region, bg)
    region = defringe(region, bg)
    region = clip_above_frame(region)
    region = keep_largest(region)

    alpha  = region[:, :, 3]
    ys, xs = np.where(alpha > 10)
    if len(xs) == 0:
        return Image.new("RGBA", (cx2 - cx1, cy2 - cy1), (0, 0, 0, 0))

    x1 = max(0, int(xs.min()) - PAD)
    y1 = max(0, int(ys.min()) - PAD)
    x2 = min(region.shape[1], int(xs.max()) + PAD + 1)
    y2 = min(region.shape[0], int(ys.max()) + PAD + 1)

    return Image.fromarray(region[y1:y2, x1:x2, :])

# ── Main ───────────────────────────────────────────────────────────────────────

print("=" * 60)
print("Loading billboard source")
print("=" * 60)

src_img = Image.open(SRC).convert("RGBA")
src_arr = np.array(src_img)
bg_color = detect_bg_color(src_arr)
print(f"  {SRC}: {src_img.width}×{src_img.height}  mode={src_img.mode}")
print(f"  Detected BG colour: R={bg_color[0]:.0f} G={bg_color[1]:.0f} B={bg_color[2]:.0f}")
print(f"  Grid: {len(CELLS)} cells defined")
print()

print("=" * 60)
print("Extracting billboards")
print("=" * 60)

for grid_idx, stem in TARGETS:
    cx1, cy1, cx2, cy2 = CELLS[grid_idx]
    billboard = extract_billboard(src_arr, bg_color, cx1, cy1, cx2, cy2)

    arr    = np.array(billboard)
    filled = (arr[:, :, 3] > 10).sum()

    if filled == 0:
        print(f"  WARN  {stem} — no visible pixels after extraction!")
    else:
        out_path = f"parts/billboards/{stem}.png"
        billboard.save(out_path)
        print(f"  {stem}")
        print(f"    cell ({cx1},{cy1})–({cx2},{cy2})"
              f"  →  extracted {billboard.width}×{billboard.height}"
              f"  ({filled:,} px visible)")
        print(f"    → {out_path}")

print()
print("=" * 60)
print(f"DONE — {len(TARGETS)} billboards written to parts/billboards/")
print("=" * 60)
