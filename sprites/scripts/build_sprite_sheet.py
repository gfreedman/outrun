#!/usr/bin/env python3
"""
build_sprite_sheet.py

Builds the 37-frame Ferrari Testarossa animation strip used by the game.

Two source sheets are processed:
  right.png — 19 frames of the car turning right, 0° → 90° in 5° steps.
  left.png  — 19 frames of the car turning left,  0° → 90° in 5° steps.

The source layouts are photorealistic renders placed on a neutral checker
background, arranged in a 3-row grid (GRID = [7, 6, 6] frames per row).
At higher turn angles the car overflows its source cell — the extraction
pipeline captures more than the nominal cell width to recover those pixels.

── Pipeline ───────────────────────────────────────────────────────────────

  Phase 1  Detect grid cell boundaries from the image itself.
  Phase 2  Extract each frame: oversized crop → flood-fill BG → keep largest.
  Phase 3  Assemble the 37-frame hybrid strip:
             strips  0–5   flipped right frames (L19–L14, extreme left turns)
             strips  6–17  left.png frames with bleed fallback to flipped right
             strip   18    right frame 0 (straight ahead)
             strips 19–36  right frames 1–18
  Phase 4  Normalise all frames into equal-sized cells; compute pivot offsets.
  Phase 5  Defringe — remove background fringing from alpha edges.
  Phase 6  Scale — output 1×, 2×, 4× versions.
  Phase 7  Write metadata JSON consumed by sprites.ts.
  Phase 8  Proof image — green border = clean, red = pixel touches cell edge.

── Outputs ────────────────────────────────────────────────────────────────

  dist/player_car_sprites_1x.png     raw resolution (loaded by game)
  source/sprite_sheet_proof.png      visual QA sheet (all frames, green/red border)
  source/debug/right_frame_NN.png    individual extracted right frames (QA)
  source/debug/left_frame_NN.png     individual extracted left frames  (QA)
"""

import json, os
import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import label as sp_label, binary_dilation, uniform_filter

# ── Config ─────────────────────────────────────────────────────────────────────

# Transparent padding (pixels) added around each extracted car frame.
# Prevents the car silhouette from touching the cell edge after compositing.
PAD = 8

# Maximum RGB chroma (sum of channel differences) for a pixel to be treated
# as achromatic background.  Values below this are grey / near-grey.
BG_CHROMA = 20

# Maximum L1 distance from the estimated background colour for flood-fill.
# Higher = more aggressive background removal.
BG_TOL = 80

# How many times wider than the nominal source cell to extract.
# Increased from 1.6 → 2.2 so the car nose at 55° (which overflows ~100px
# into the adjacent source cell) is fully captured.
# Formula: extra pixels on each side = cell_w * (EXTRACT_MULT - 1.0) / 2
EXTRACT_MULT = 2.2

# Source image filenames (relative to this script's directory).
SRC_RIGHT = "source/right.png"
SRC_LEFT  = "source/left.png"

# Number of car frames in each row of the source sheets.
# Both right.png and left.png share the same layout: 7 + 6 + 6 = 19 frames.
GRID = [7, 6, 6]

os.makedirs("source/debug", exist_ok=True)

# ── Colour helpers ─────────────────────────────────────────────────────────────

def chroma_map(arr):
    """
    Compute per-pixel chroma as the sum of absolute pairwise channel differences.
    Returns a 2-D array of the same H×W shape.  Zero = perfectly grey.

    Args:
        arr: H×W×C uint8 numpy array (C ≥ 3).

    Returns:
        H×W int32 array of chroma values.
    """
    r = arr[:,:,0].astype(np.int32)
    g = arr[:,:,1].astype(np.int32)
    b = arr[:,:,2].astype(np.int32)
    return np.abs(r-g) + np.abs(g-b) + np.abs(r-b)


def estimate_bg(arr):
    """
    Estimate the background colour by averaging clearly-grey (checker) pixels.
    Falls back to mid-grey (170, 170, 170) if too few grey pixels are found.

    Args:
        arr: H×W×C uint8 numpy array of the full source image.

    Returns:
        float32 array of shape (3,) — estimated RGB background colour.
    """
    ch   = chroma_map(arr)
    mask = ch < 8
    if mask.sum() < 50:
        return np.array([170, 170, 170], dtype=np.float32)
    return arr[:,:,:3][mask].astype(np.float32).mean(axis=0)

# ── Grid detection ─────────────────────────────────────────────────────────────

def detect_header_height(arr):
    """
    Find the Y coordinate where the title banner ends.

    Scans the first 150 rows for the last near-empty horizontal line.
    The title banner is opaque text on a dark background; content rows
    below it have significant chroma or dark pixels.

    Args:
        arr: H×W×C uint8 numpy array of the source image.

    Returns:
        int — Y pixel where usable sprite content begins.
    """
    ch   = chroma_map(arr)
    dark = (arr[:,:,:3].astype(np.int32).sum(axis=2) // 3) < 60
    active   = (ch > 30) | dark
    H        = arr.shape[0]
    last_gap = 30
    for y in range(30, min(H, 150)):
        if active[y].mean() < 0.03:
            last_gap = y
    return last_gap + 1


def find_row_start(arr, search_from_y, search_height=80):
    """
    Find the Y where the next car row begins by looking for chroma content.

    Args:
        arr:           H×W×C uint8 numpy array.
        search_from_y: Y to start scanning from.
        search_height: How many rows to scan before giving up.

    Returns:
        int — Y of the first row with significant colour content.
    """
    ch = chroma_map(arr)
    H  = arr.shape[0]
    for y in range(search_from_y, min(H, search_from_y + search_height)):
        if (ch[y] > 40).sum() > 20:
            return y
    return search_from_y


def detect_grid_positions(arr, grid=GRID):
    """
    Return bounding boxes for every cell in the source grid.

    Detects the header height then divides the remaining image into equal
    rows and columns according to the GRID frame-count list.

    Args:
        arr:  H×W×C uint8 numpy array of the full source image.
        grid: List of int — number of columns in each row.

    Returns:
        List of (x1, y1, x2, y2) tuples, one per grid cell, in row-major order.
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

# ── Extraction helpers ─────────────────────────────────────────────────────────

def flood_fill_bg(arr, bg_color, tol=BG_TOL, inner_xs=()):
    """
    Zero the alpha of background pixels reachable from the image edges.

    Seeds the flood-fill from all four edges plus any optional inner vertical
    seed columns (inner_xs).  Inner seed columns are used to reach inter-car
    background that is inaccessible from the outer edge alone.

    A pixel is added to the fill queue if it is achromatic (chroma < BG_CHROMA)
    AND its colour is within L1 distance tol of the estimated background colour.

    Args:
        arr:       H×W×4 uint8 numpy array (RGBA).
        bg_color:  float32 array of shape (3,) — estimated background RGB.
        tol:       Maximum L1 distance from bg_color to count as background.
        inner_xs:  Sequence of X columns to use as additional flood-fill seeds.

    Returns:
        Copy of arr with background pixels zeroed in the alpha channel.
    """
    arr    = arr.copy()
    H, W   = arr.shape[:2]
    visited = np.zeros((H, W), dtype=bool)
    queue   = []
    bg      = bg_color.astype(np.float32)

    def try_add(x, y):
        if visited[y, x]:
            return
        px   = arr[y, x, :3].astype(np.float32)
        px_i = arr[y, x, :3].astype(np.int32)
        ch   = (abs(int(px_i[0])-int(px_i[1])) + abs(int(px_i[1])-int(px_i[2]))
                + abs(int(px_i[0])-int(px_i[2])))
        if ch <= BG_CHROMA and float(np.abs(px - bg).sum()) <= tol:
            visited[y, x] = True
            queue.append((x, y))

    for x in range(W): try_add(x, 0); try_add(x, H-1)
    for y in range(H): try_add(0, y); try_add(W-1, y)
    for ix in inner_xs:
        if 0 <= ix < W:
            for y in range(H):
                try_add(ix, y)

    i = 0
    while i < len(queue):
        x, y = queue[i]; i += 1
        for nx, ny in ((x-1,y),(x+1,y),(x,y-1),(x,y+1)):
            if 0 <= nx < W and 0 <= ny < H:
                try_add(nx, ny)

    arr[visited, 3] = 0
    return arr


def remove_enclosed_bg(arr, bg_color, tol=70):
    """
    Zero background pixels fully enclosed within the car silhouette.

    After flood_fill_bg clears outer background, any remaining opaque grey
    pixel whose connected component does not touch the image border is
    trapped inside the outline.  Rather than zeroing (which leaves holes),
    each enclosed region is flood-filled with the average colour of
    surrounding opaque car pixels.

    Args:
        arr:      H×W×4 uint8 numpy array (RGBA), after flood_fill_bg.
        bg_color: float32 array of shape (3,) — estimated background RGB.
        tol:      Colour distance threshold for identifying background-like pixels.

    Returns:
        Copy of arr with enclosed background regions filled with car colour.
    """
    arr  = arr.copy()
    r    = arr[:,:,0].astype(np.int32)
    g    = arr[:,:,1].astype(np.int32)
    b    = arr[:,:,2].astype(np.int32)
    ch   = np.abs(r-g) + np.abs(g-b) + np.abs(r-b)
    dist = (np.abs(r - float(bg_color[0])) +
            np.abs(g - float(bg_color[1])) +
            np.abs(b - float(bg_color[2])))
    candidates       = (arr[:,:,3] > 0) & (ch < 35) & (dist < tol)
    labeled, n       = sp_label(candidates)
    if n == 0:
        return arr

    border_mask = np.zeros(labeled.shape, dtype=bool)
    border_mask[0,:] = border_mask[-1,:] = True
    border_mask[:,0] = border_mask[:,-1] = True
    border_labels = set(int(x) for x in labeled[border_mask & (labeled > 0)])

    for lbl in range(1, n + 1):
        if lbl not in border_labels:
            region   = (labeled == lbl)
            surround = binary_dilation(region, iterations=4) & ~region & (arr[:,:,3] == 255)
            if surround.any():
                fill_r = int(arr[surround, 0].astype(float).mean())
                fill_g = int(arr[surround, 1].astype(float).mean())
                fill_b = int(arr[surround, 2].astype(float).mean())
            else:
                fill_r, fill_g, fill_b = int(bg_color[0]), int(bg_color[1]), int(bg_color[2])
            arr[region, 0] = fill_r
            arr[region, 1] = fill_g
            arr[region, 2] = fill_b
            arr[region, 3] = 255
    return arr


def remove_isolated_checker(arr):
    """
    Zero grey pixels that are not adjacent to any coloured car pixel.

    Stray checker squares sometimes survive flood-fill if they are
    surrounded by car pixels on all sides but not reachable from an edge.
    This pass erodes them by requiring proximity to coloured content.

    Args:
        arr: H×W×4 uint8 numpy array (RGBA).

    Returns:
        Copy of arr with isolated grey pixels zeroed.
    """
    arr    = arr.copy()
    alpha  = arr[:,:,3]
    r      = arr[:,:,0].astype(np.int32)
    g      = arr[:,:,1].astype(np.int32)
    b      = arr[:,:,2].astype(np.int32)
    ch      = np.abs(r-g) + np.abs(g-b) + np.abs(r-b)
    bright  = (r + g + b) // 3
    checker = (alpha > 10) & (ch < 25) & (bright > 80) & (bright < 230)
    car_pixel = (ch > 30)
    car_mask  = binary_dilation(car_pixel, iterations=4)
    arr[checker & ~car_mask, 3] = 0
    return arr


def count_car_blobs(frame_img, chroma_thresh=40, min_area=1000):
    """
    Count distinct red car-body blobs in an extracted frame image.

    A clean extraction contains exactly one blob.  A bleed frame (where the
    adjacent car leaked into the extraction region) contains two or more.
    min_area filters out text labels and rendering artefacts.

    Args:
        frame_img:    PIL Image (RGBA) of the extracted frame.
        chroma_thresh: Minimum chroma for a pixel to be counted as car body.
        min_area:     Minimum blob size in pixels to count as a car.

    Returns:
        int — number of distinct car blobs detected.
    """
    arr    = np.array(frame_img)
    r      = arr[:,:,0].astype(np.int32)
    g      = arr[:,:,1].astype(np.int32)
    b      = arr[:,:,2].astype(np.int32)
    ch     = np.abs(r-g) + np.abs(g-b) + np.abs(r-b)
    seeds  = (ch > chroma_thresh) & (arr[:,:,3] > 10)
    labeled, n = sp_label(seeds)
    return sum(1 for lbl in range(1, n + 1) if (labeled == lbl).sum() >= min_area)


def keep_largest(arr):
    """
    Discard all connected components except the largest visible blob.

    Used after flood-fill to eliminate small remnants of adjacent cars that
    survived background removal.

    Args:
        arr: H×W×4 uint8 numpy array (RGBA).

    Returns:
        Copy of arr with all but the largest blob zeroed in the alpha channel.
    """
    arr    = arr.copy()
    alpha  = arr[:,:,3] > 10
    labeled, n = sp_label(alpha)
    if n <= 1:
        return arr
    sizes = np.bincount(labeled.ravel()); sizes[0] = 0
    arr[labeled != sizes.argmax(), 3] = 0
    return arr


def extract_frame(full_arr, cx1, cy1, cx2, cy2, bg_color, mult=EXTRACT_MULT):
    """
    Extract one car frame from the source image.

    The nominal grid cell (cx1, cy1, cx2, cy2) is expanded by EXTRACT_MULT
    horizontally so that cars overflowing their source cell are captured.
    Background is then removed with flood-fill and the main car body is
    isolated with keep_largest.  The result is tight-cropped to visible
    content plus PAD pixels of transparent margin on each side.

    Args:
        full_arr:  H×W×4 uint8 numpy array of the full source image.
        cx1, cy1:  Top-left corner of the nominal grid cell.
        cx2, cy2:  Bottom-right corner of the nominal grid cell.
        bg_color:  float32 array of shape (3,) — estimated background RGB.
        mult:      Extraction multiplier (× cell width).  Default = EXTRACT_MULT.

    Returns:
        PIL Image (RGBA) — the isolated car, tight-cropped with PAD margin.
    """
    H, W   = full_arr.shape[:2]
    cell_w = cx2 - cx1
    cell_h = cy2 - cy1

    extra_x = int(cell_w * (mult - 1.0) / 2)
    extra_y = int(cell_h * 0.1)

    ex1 = max(0, cx1 - extra_x)
    ey1 = max(0, cy1 - extra_y)
    ex2 = min(W, cx2 + extra_x)
    ey2 = min(H, cy2 + extra_y)

    region = full_arr[ey1:ey2, ex1:ex2, :].copy()
    region = flood_fill_bg(region, bg_color)
    region = remove_enclosed_bg(region, bg_color)
    region = remove_isolated_checker(region)
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

# ── Defringe ───────────────────────────────────────────────────────────────────

def defringe(arr):
    """
    Multi-pass removal of background fringing from the car silhouette edges.

    The source renders have a light-coloured checker background that bleeds
    into the car's alpha edges as semi-transparent or white-tinted pixels.
    Nine passes attack the problem from different angles:

      A  Zero semi-transparent near-white pixels.
      B  Recolour surviving semi-transparent pixels toward opaque neighbours.
      C  Erode stray near-transparent pixels with few opaque neighbours.
      D  Final boundary whiteness sweep on the transparent border.
      E  Four-round inward erosion of grey/white opaque edge pixels.
      G  Recolour remaining grey edge pixels toward car interior colour.
      H  Final hard sweep — zero white-contaminated edge pixels.
      I  Two rounds of isolated-pixel removal (fewer than 3 opaque neighbours).

    Args:
        arr: H×W×4 uint8 numpy array (RGBA) of the assembled strip.

    Returns:
        Defringed copy of arr.
    """
    a         = arr[:,:,3].astype(np.int32)
    r         = arr[:,:,0].astype(np.int32)
    g         = arr[:,:,1].astype(np.int32)
    b         = arr[:,:,2].astype(np.int32)
    whiteness = (r + g + b) // 3
    chroma    = np.abs(r-g) + np.abs(g-b) + np.abs(r-b)

    # Pass A: zero semi-transparent near-white pixels
    semi = (a > 0) & (a < 255)
    arr  = arr.copy()
    arr[(semi & (whiteness > 200) & (a < 180)) |
        (semi & (whiteness > 230) & (a < 220)), 3] = 0

    # Pass B: recolour surviving semi-transparent pixels toward opaque neighbours
    a    = arr[:,:,3].astype(np.int32)
    semi2 = (a > 0) & (a < 255)
    if semi2.any():
        opaque = (a == 255)
        op_f   = opaque.astype(np.float32)
        sz     = 7
        op_cnt = uniform_filter(op_f, size=sz, mode='constant') * sz * sz
        for ch_idx in range(3):
            ch_a   = arr[:,:,ch_idx].astype(np.float32)
            ch_sum = uniform_filter(np.where(opaque, ch_a, 0.0), size=sz, mode='constant') * sz * sz
            avg    = np.where(op_cnt > 0, ch_sum / np.maximum(op_cnt, 1), ch_a)
            arr[:,:,ch_idx] = np.where(semi2, np.clip(avg, 0, 255).astype(np.uint8),
                                        arr[:,:,ch_idx])

    # Pass C: erode stray near-transparent pixels
    a           = arr[:,:,3].astype(np.int32)
    near_transp = (a > 0) & (a < 40)
    opaque_bin  = (a == 255)
    op_nbrs     = sum(np.roll(np.roll(opaque_bin, dy, 0), dx, 1)
                      for dy in (-1,0,1) for dx in (-1,0,1) if not (dy==0 and dx==0))
    arr[near_transp & (op_nbrs < 2), 3] = 0

    # Pass D: final boundary whiteness sweep
    a      = arr[:,:,3].astype(np.int32)
    r      = arr[:,:,0].astype(np.int32); g = arr[:,:,1].astype(np.int32); b = arr[:,:,2].astype(np.int32)
    transp = (a == 0)
    border = (np.roll(transp,1,0)|np.roll(transp,-1,0)|np.roll(transp,1,1)|np.roll(transp,-1,1))
    arr[(a>0)&(a<128)&border&(((r+g+b)//3)>180), 3] = 0

    # Pass E: four-round inward erosion of grey/white opaque edge pixels
    def edge_mask(op, tr):
        return op & (np.roll(tr,1,0)|np.roll(tr,-1,0)|np.roll(tr,1,1)|np.roll(tr,-1,1))

    for _ in range(4):
        a      = arr[:,:,3].astype(np.int32)
        r      = arr[:,:,0].astype(np.int32); g = arr[:,:,1].astype(np.int32); b = arr[:,:,2].astype(np.int32)
        w      = (r+g+b)//3
        c      = np.abs(r-g)+np.abs(g-b)+np.abs(r-b)
        op     = (a==255); tr = (a==0)
        edge   = edge_mask(op, tr)
        arr[edge & (w > 155) & (c < 60), 3] = 0
        min_ch = np.minimum(np.minimum(r, g), b)
        arr[edge & (min_ch > 160), 3] = 0
        a2 = arr[:,:,3].astype(np.int32)
        r2=arr[:,:,0].astype(np.int32);g2=arr[:,:,1].astype(np.int32);b2=arr[:,:,2].astype(np.int32)
        w2=(r2+g2+b2)//3; c2=np.abs(r2-g2)+np.abs(g2-b2)+np.abs(r2-b2)
        arr[(a2==255)&(w2>190)&(c2<15), 3] = 0

    # Pass G: recolour remaining grey edge pixels toward car interior colour
    a      = arr[:,:,3].astype(np.int32)
    r3=arr[:,:,0].astype(np.float32);g3=arr[:,:,1].astype(np.float32);b3=arr[:,:,2].astype(np.float32)
    c3     = (np.abs(r3-g3)+np.abs(g3-b3)+np.abs(r3-b3))
    op3    = (a==255); tr3=(a==0)
    edge3  = edge_mask(op3, tr3)
    car_px = op3 & (c3 > 60)
    car_f  = car_px.astype(np.float32)
    sz     = 13
    car_cnt = uniform_filter(car_f, size=sz, mode='constant') * sz * sz
    for ch_a, ch_idx in [(r3,0),(g3,1),(b3,2)]:
        ch_sum = uniform_filter(np.where(car_px, ch_a, 0.0), size=sz, mode='constant') * sz * sz
        avg    = np.where(car_cnt > 0, ch_sum / np.maximum(car_cnt, 1), ch_a)
        gray_edge = edge3 & (c3 < 100)
        arr[:,:,ch_idx] = np.where(gray_edge & (car_cnt > 0),
                                   np.clip(avg, 0, 255).astype(np.uint8), arr[:,:,ch_idx])

    # Pass H: final hard sweep — zero any white-contaminated edge pixels
    a     = arr[:,:,3].astype(np.int32)
    op    = (a==255); tr=(a==0)
    edge_h = edge_mask(op, tr)
    r_h=arr[:,:,0].astype(np.int32); g_h=arr[:,:,1].astype(np.int32); b_h=arr[:,:,2].astype(np.int32)
    min_h = np.minimum(np.minimum(r_h, g_h), b_h)
    w_h   = (r_h + g_h + b_h) // 3
    c_h   = np.abs(r_h-g_h)+np.abs(g_h-b_h)+np.abs(r_h-b_h)
    arr[edge_h & (min_h > 150), 3] = 0
    arr[edge_h & (w_h > 170) & (c_h < 80), 3] = 0

    # Pass I: two rounds of isolated-pixel removal
    for _ in range(2):
        a   = arr[:,:,3].astype(np.int32)
        op  = (a == 255)
        nbr = sum(
            np.roll(np.roll(op, dy, 0), dx, 1)
            for dy in (-1, 0, 1) for dx in (-1, 0, 1)
            if not (dy == 0 and dx == 0)
        )
        arr[op & (nbr < 3), 3] = 0

    return arr

# ── Phase 1: Load + detect grid ────────────────────────────────────────────────

print("="*60)
print("Phase 1: Load + Detect grid cells")
print("="*60)

right_img  = Image.open(SRC_RIGHT).convert("RGBA")
left_img   = Image.open(SRC_LEFT).convert("RGBA")
right_arr  = np.array(right_img)
left_arr   = np.array(left_img)

bg_r = estimate_bg(right_arr)
bg_l = estimate_bg(left_arr)
print(f"right.png BG ≈ {bg_r.astype(int)}")
print(f"left.png  BG ≈ {bg_l.astype(int)}")

right_cells = detect_grid_positions(right_arr)
left_cells  = detect_grid_positions(left_arr)
print(f"right.png: {len(right_cells)} grid cells")
print(f"left.png:  {len(left_cells)} grid cells")

# Save annotated source analysis images for visual QA
def save_analysis(src_img, cells, path):
    """Render the detected grid boxes over a thumbnail of the source image."""
    vis  = src_img.convert("RGB").resize(
        (src_img.width//3, src_img.height//3), Image.LANCZOS)
    draw = ImageDraw.Draw(vis)
    s    = 1/3
    clrs = ["red","lime","blue","orange","magenta","cyan","yellow","white"]
    for i, (x1,y1,x2,y2) in enumerate(cells):
        c = clrs[i % len(clrs)]
        draw.rectangle([int(x1*s),int(y1*s),int(x2*s),int(y2*s)], outline=c, width=2)
        draw.text((int(x1*s)+2, int(y1*s)+2), str(i+1), fill=c)
    vis.save(path)

save_analysis(right_img, right_cells, "source/source_analysis_right.png")
save_analysis(left_img,  left_cells,  "source/source_analysis_left.png")
print("Saved source/source_analysis_right.png / source_analysis_left.png")

# ── Phase 2: Extract frames ────────────────────────────────────────────────────

print("\n" + "="*60)
print("Phase 2: Extracting frames (wide extraction + flood-fill)")
print("="*60)

right_frames = []
for i, (cx1,cy1,cx2,cy2) in enumerate(right_cells):
    frame = extract_frame(right_arr, cx1, cy1, cx2, cy2, bg_r)
    right_frames.append(frame)
    frame.save(f"source/debug/right_frame_{i+1:02d}.png")
    print(f"  R{i+1:02d}: cell({cx1},{cy1})-({cx2},{cy2}) → extracted {frame.width}×{frame.height}")

left_frames = []
for i, (cx1,cy1,cx2,cy2) in enumerate(left_cells[:13]):   # only L1–L13 needed
    frame = extract_frame(left_arr, cx1, cy1, cx2, cy2, bg_l)
    left_frames.append(frame)
    frame.save(f"source/debug/left_frame_{i+1:02d}.png")
    print(f"  L{i+1:02d}: cell({cx1},{cy1})-({cx2},{cy2}) → extracted {frame.width}×{frame.height}")

# ── Source-clip substitutions ─────────────────────────────────────────────────
#
# Some right.png frames are genuinely clipped in the source sheet — the grid
# cell was too narrow for the car at that angle, so the body is partially cut.
# No extraction method recovers pixels that were never in the source.
# Substitute with the nearest clean adjacent frame, but only if the substitute
# is meaningfully wider (>10%) — otherwise the original extraction is already OK.
#
#   Index (0-based) → substitute index
#   9  R10  45° → 8  R09  40°
#   10 R11  50° → 11 R12  55°
#   15 R16  75° → 14 R15  70°
#   16 R17  80° → 17 R18  85°
SOURCE_CLIP_SUBS = {9: 8, 10: 11, 15: 14, 16: 17}

print("\n  Source-clip substitutions:")
for bad_idx, good_idx in SOURCE_CLIP_SUBS.items():
    bad_w  = right_frames[bad_idx].width
    good_w = right_frames[good_idx].width
    if good_w > bad_w * 1.1:
        print(f"  R{bad_idx+1:02d} ({bad_w}px) → R{good_idx+1:02d} ({good_w}px)")
        right_frames[bad_idx] = right_frames[good_idx]
    else:
        print(f"  R{bad_idx+1:02d} ({bad_w}px) looks OK — skipping sub with R{good_idx+1:02d} ({good_w}px)")

# ── Phase 3: Assemble hybrid strip ────────────────────────────────────────────
#
# The 37-frame strip layout:
#
#   Index  0– 5   L19–L14 extreme left turns  (flipped right frames 19–14)
#   Index  6–17   L13–L2  left turns          (left.png with bleed fallback)
#   Index  18     STRAIGHT                    (right frame 1, 0°)
#   Index 19–36   R2–R19  right turns         (right.png frames 2–19)
#
# "Bleed fallback": if a left.png frame contains pixels from the adjacent
# car (detected by blob count or frame width), substitute it with the
# mirrored right.png frame at the same angle instead.

print("\n" + "="*60)
print("Phase 3: Assembling hybrid strip")
print("="*60)

def flip_h(img):
    """Flip a PIL Image horizontally."""
    return img.transpose(Image.FLIP_LEFT_RIGHT)

strip_frames = []
names        = []
sources      = []

# Strips 0–5: L19–L14 — flipped right frames 19–14 (indices 18–13)
for i in range(18, 12, -1):
    deg = i * 5
    if i < len(right_frames):
        strip_frames.append(flip_h(right_frames[i]))
    else:
        strip_frames.append(flip_h(right_frames[-1]))
        print(f"  WARNING: right frame {i+1} missing, using last available")
    names.append(f"L{i+1}_{deg}deg_left")
    sources.append("right_flipped")

# Strips 6–17: L13–L2 — real left frames with bleed detection fallback.
# BLEED_W: if the extracted frame is this wide or wider, the EXTRACT_MULT
# region hit the extraction limit and adjacent cars may have bled in.
BLEED_W = 290
for i in range(12, 0, -1):
    deg = i * 5
    if i < len(left_frames):
        lf          = left_frames[i]
        n_blobs     = count_car_blobs(lf)
        width_bleed = lf.width >= BLEED_W
        blob_bleed  = n_blobs > 1
        if (width_bleed or blob_bleed) and i < len(right_frames):
            reason = f"width={lf.width}px" if width_bleed else f"blobs={n_blobs}"
            print(f"  L{i+1} ({deg}°): bleed ({reason}) → flipped R{i+1}")
            strip_frames.append(flip_h(right_frames[i]))
            sources.append("right_flipped_fallback")
        else:
            strip_frames.append(lf)
            sources.append("left_real")
    else:
        strip_frames.append(left_frames[1])
        print(f"  WARNING: left frame {i+1} missing, using L2")
        sources.append("left_real")
    names.append(f"L{i+1}_{deg}deg_left")

# Strip 18: straight ahead — right frame 1 (0°)
strip_frames.append(right_frames[0])
names.append("STRAIGHT_0deg")
sources.append("shared")

# Strips 19–36: R2–R19 — right.png frames 2–19 (indices 1–18)
for i in range(1, 19):
    deg = i * 5
    if i < len(right_frames):
        strip_frames.append(right_frames[i])
    else:
        strip_frames.append(right_frames[-1])
        print(f"  WARNING: right frame {i+1} missing, using last available")
    names.append(f"R{i+1}_{deg}deg_right")
    sources.append("right_real")

total = len(strip_frames)
print(f"  Strip: {total} frames  (expected 37)")

# ── Phase 4: Normalise cell size + compute pivot offsets ──────────────────────

print("\n" + "="*60)
print("Phase 4: Normalising cell size + pivot offsets")
print("="*60)

max_w  = max(f.width  for f in strip_frames)
max_h  = max(f.height for f in strip_frames)
cell_w = max_w + PAD * 2
cell_h = max_h + PAD * 2
print(f"  Max frame: {max_w}×{max_h}  →  cell: {cell_w}×{cell_h}")


def find_pivot_x(frame_img):
    """
    Estimate the rear-axle centre X within a frame.

    Samples the bottom 15% of visible car pixels — where the rear bumper
    and axle sit regardless of steering angle — and returns the midpoint
    of their horizontal spread.

    Args:
        frame_img: PIL Image (RGBA) of a single extracted car frame.

    Returns:
        int — X coordinate of the estimated pivot in frame pixels.
    """
    arr    = np.array(frame_img)
    alpha  = arr[:,:,3]
    ys, xs = np.where(alpha > 10)
    if len(ys) == 0:
        return frame_img.width // 2
    y_bot    = int(ys.max())
    y_car_h  = y_bot - int(ys.min())
    y_sample = max(int(ys.min()), y_bot - max(5, int(y_car_h * 0.15)))
    bot_cols = np.where(alpha[y_sample:y_bot+1, :].max(axis=0) > 10)[0]
    if len(bot_cols) == 0:
        return frame_img.width // 2
    return int((int(bot_cols[0]) + int(bot_cols[-1])) / 2)


pivot_offsets = []   # pixels from cell centre, +ve = pivot left of centre


def to_cell(frame):
    """
    Centre a frame in a cell_w × cell_h canvas and record its pivot offset.

    The pivot offset tells the renderer how far the rear-axle deviates from
    the cell centre so it can compensate with a horizontal draw shift.

    Args:
        frame: PIL Image (RGBA) — a single extracted car frame.

    Returns:
        PIL Image (RGBA) of size cell_w × cell_h with the frame centred.
    """
    pivot_x_in_frame = find_pivot_x(frame)
    cell = Image.new("RGBA", (cell_w, cell_h), (0,0,0,0))
    ox   = (cell_w - frame.width)  // 2
    oy   = (cell_h - frame.height) // 2
    cell.paste(frame, (ox, oy), frame)
    pivot_x_in_cell = ox + pivot_x_in_frame
    pivot_offsets.append(cell_w // 2 - pivot_x_in_cell)
    return cell


cells = [to_cell(f) for f in strip_frames]
print(f"  Pivot offsets computed ({total} frames)")
print(f"  Offsets: {pivot_offsets}")

strip = Image.new("RGBA", (cell_w * total, cell_h), (0,0,0,0))
for i, cell in enumerate(cells):
    strip.paste(cell, (i * cell_w, 0), cell)
print(f"  Strip assembled: {strip.width}×{strip.height}")

# ── Phase 5: Defringe ─────────────────────────────────────────────────────────

print("\n" + "="*60)
print("Phase 5: Defringing")
print("="*60)
strip_arr   = np.array(strip)
strip_arr   = defringe(strip_arr)
strip_clean = Image.fromarray(strip_arr)
print("  Done")

# ── Phase 6: Scale ────────────────────────────────────────────────────────────

print("\n" + "="*60)
print("Phase 6: Scaling")
print("="*60)
W1, H1   = strip_clean.size
strip_clean.save("dist/player_car_sprites_1x.png")
print(f"  dist/player_car_sprites_1x.png  {W1}×{H1}")

# ── Phase 7: Metadata ─────────────────────────────────────────────────────────

print("\n" + "="*60)
print("Phase 7: Metadata")
print("="*60)

frames_meta = [
    {
        "index":        idx,
        "name":         name,
        "x":            idx * cell_w,
        "y":            0,
        "w":            cell_w,
        "h":            cell_h,
        "source":       src,
        "pivotOffsetX": pivot_offsets[idx],
    }
    for idx, (name, src) in enumerate(zip(names, sources))
]
meta = {
    "frameWidth":  cell_w,
    "frameHeight": cell_h,
    "totalFrames": total,
    "centerIndex": 18,
    "scale":       "1x",
    "hybridNote":  "L2-L13 left.png (correct occupants); L14-L19 flipped right.png",
    "pivotOffsets": pivot_offsets,
    "frames":      frames_meta,
}
print("  Metadata computed (rects hardcoded in src/sprites.ts)")

# ── Phase 8: Proof image ──────────────────────────────────────────────────────
#
# Renders all 37 cells in a grid.  Cells where any car pixel touches the cell
# edge are outlined in RED (clipping detected); clean cells are GREEN.

print("\n" + "="*60)
print("Phase 8: Proof image")
print("="*60)

BG   = (26, 26, 46)
COLS = 19
ROWS = (total + COLS - 1) // COLS
LPAD = 18   # label height above each cell
B    = 2    # border thickness

PW    = COLS * (cell_w + B*2 + 3) + 10
PH    = ROWS * (cell_h + LPAD + B*2 + 4) + 10
proof = Image.new("RGB", (PW, PH), BG)
draw  = ImageDraw.Draw(proof)

clipped = []
for idx, cell in enumerate(cells):
    col = idx % COLS
    row = idx // COLS
    px  = 5 + col * (cell_w + B*2 + 3)
    py  = 5 + row * (cell_h + LPAD + B*2 + 4)

    ca      = np.array(cell)[:,:,3]
    touched = ca[0,:].any() or ca[-1,:].any() or ca[:,0].any() or ca[:,-1].any()
    if touched:
        clipped.append(idx)

    border_clr = (220,50,50) if touched else (50,180,50)
    draw.rectangle([px-B, py-B, px+cell_w+B, py+cell_h+B], outline=border_clr, width=B)

    bg_patch = Image.new("RGBA", (cell_w, cell_h), (*BG, 255))
    bg_patch.paste(cell, (0,0), cell)
    proof.paste(bg_patch.convert("RGB"), (px, py))

    src_abbr = {
        "left_real":               "L",
        "right_flipped":           "F",
        "right_flipped_fallback":  "FB",
        "shared":                  "S",
        "right_real":              "R",
    }.get(sources[idx], "?")
    lbl_clr = (220,80,80) if touched else (140,200,140)
    draw.text((px, py+cell_h+2), f"{idx}:{src_abbr}", fill=lbl_clr)

proof.save("source/sprite_sheet_proof.png")
print(f"  Saved source/sprite_sheet_proof.png  ({proof.width}×{proof.height})")

if clipped:
    print(f"\n  ⚠  RED BORDER frames (car touches cell edge): {clipped}")
else:
    print("\n  ✓ All green — no clipping detected!")

print("\n" + "="*60)
print("DONE")
print(f"  {W1}×{H1}   {total} frames   cell {cell_w}×{cell_h}   center=18")
print("="*60)
