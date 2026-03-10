#!/usr/bin/env python3
"""
build_sprite_sheet.py — Final version v2.

Grid-guided extraction with OVERSIZED cells:
  - Detects header/row bounds from the image
  - Uses fixed GRID to know how many frames per row
  - Extracts WIDER than each cell (1.5×) so overflowing cars are captured
  - Flood-fills + keep_largest isolates each car cleanly
  - No car is clipped
"""

import json, os
import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import label as sp_label, binary_dilation, uniform_filter

# ── Config ────────────────────────────────────────────────────────────────────
PAD          = 8      # transparent padding added around each extracted frame
BG_CHROMA    = 20     # max chroma for a pixel to be treated as background
BG_TOL       = 80     # L1 distance from estimated BG colour for flood-fill
EXTRACT_MULT = 1.6    # how much wider to extract (× cell width) — captures overflow

SRC_RIGHT = "right.png"
SRC_LEFT  = "left.png"
GRID      = [7, 6, 6]   # frames per row (same layout for both sheets)

os.makedirs("debug", exist_ok=True)

# ── Colour helpers ────────────────────────────────────────────────────────────

def chroma_map(arr):
    r = arr[:,:,0].astype(np.int32)
    g = arr[:,:,1].astype(np.int32)
    b = arr[:,:,2].astype(np.int32)
    return np.abs(r-g) + np.abs(g-b) + np.abs(r-b)

def estimate_bg(arr):
    """Mean RGB of clearly-gray pixels (the checkerboard background)."""
    ch = chroma_map(arr)
    mask = ch < 8
    if mask.sum() < 50:
        return np.array([170, 170, 170], dtype=np.float32)
    return arr[:,:,:3][mask].astype(np.float32).mean(axis=0)

# ── Grid detection ────────────────────────────────────────────────────────────

def detect_header_height(arr) -> int:
    """Find the y where the title banner ends (last near-empty row in first 150px)."""
    ch     = chroma_map(arr)
    dark   = (arr[:,:,:3].astype(np.int32).sum(axis=2) // 3) < 60
    active = (ch > 30) | dark
    H = arr.shape[0]
    last_gap = 30
    for y in range(30, min(H, 150)):
        if active[y].mean() < 0.03:
            last_gap = y
    return last_gap + 1

def find_row_start(arr, search_from_y, search_height=80) -> int:
    """Find the y where a car row begins (first row with significant chroma content)."""
    ch = chroma_map(arr)
    H  = arr.shape[0]
    for y in range(search_from_y, min(H, search_from_y + search_height)):
        if (ch[y] > 40).sum() > 20:
            return y
    return search_from_y

def detect_grid_positions(arr, grid=GRID):
    """
    Return list of (x1, y1, x2, y2) for each grid cell.
    Detects header and row separations from the image.
    """
    H, W = arr.shape[:2]
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

# ── Extraction helpers ────────────────────────────────────────────────────────

def flood_fill_bg(arr, bg_color, tol=BG_TOL, inner_xs=()):
    """
    Flood-fill from all edges (+ optional inner vertical seed lines) zeroing
    gray background pixels.  inner_xs lists additional x-columns to seed from —
    used to reach inter-car background that is not accessible from the outer edge.
    """
    arr = arr.copy()
    H, W = arr.shape[:2]
    visited = np.zeros((H, W), dtype=bool)
    queue   = []
    bg = bg_color.astype(np.float32)

    def try_add(x, y):
        if visited[y, x]: return
        px   = arr[y, x, :3].astype(np.float32)
        px_i = arr[y, x, :3].astype(np.int32)
        ch   = (abs(int(px_i[0])-int(px_i[1])) + abs(int(px_i[1])-int(px_i[2]))
                + abs(int(px_i[0])-int(px_i[2])))
        if ch <= BG_CHROMA and float(np.abs(px - bg).sum()) <= tol:
            visited[y, x] = True
            queue.append((x, y))

    for x in range(W): try_add(x, 0); try_add(x, H-1)
    for y in range(H): try_add(0, y); try_add(W-1, y)
    # Inner seed lines (nominal cell boundaries within the extraction region)
    for ix in inner_xs:
        if 0 <= ix < W:
            for y in range(H): try_add(ix, y)

    i = 0
    while i < len(queue):
        x, y = queue[i]; i += 1
        for nx, ny in ((x-1,y),(x+1,y),(x,y-1),(x,y+1)):
            if 0 <= nx < W and 0 <= ny < H:
                try_add(nx, ny)

    arr[visited, 3] = 0
    return arr


def remove_isolated_checker(arr):
    """Zero gray pixels that are not adjacent to colored car pixels."""
    arr   = arr.copy()
    alpha = arr[:,:,3]
    r = arr[:,:,0].astype(np.int32)
    g = arr[:,:,1].astype(np.int32)
    b = arr[:,:,2].astype(np.int32)
    ch     = np.abs(r-g) + np.abs(g-b) + np.abs(r-b)
    bright = (r + g + b) // 3
    checker   = (alpha > 10) & (ch < 25) & (bright > 80) & (bright < 230)
    car_pixel = (ch > 30)
    car_mask  = binary_dilation(car_pixel, iterations=4)
    arr[checker & ~car_mask, 3] = 0
    return arr


def count_car_blobs(frame_img, chroma_thresh=40, min_area=1000):
    """
    Count distinct red car-body blobs in an already-extracted frame image.
    A clean frame has 1.  A bleed frame (adjacent car leaked in) has 2+.
    min_area filters out text/label noise.
    """
    arr = np.array(frame_img)
    r = arr[:,:,0].astype(np.int32)
    g = arr[:,:,1].astype(np.int32)
    b = arr[:,:,2].astype(np.int32)
    ch = np.abs(r-g) + np.abs(g-b) + np.abs(r-b)
    seeds  = (ch > chroma_thresh) & (arr[:,:,3] > 10)
    labeled, n = sp_label(seeds)
    return sum(1 for lbl in range(1, n + 1) if (labeled == lbl).sum() >= min_area)


def keep_largest(arr):
    """Keep only the largest connected component of visible pixels."""
    arr    = arr.copy()
    alpha  = arr[:,:,3] > 10
    labeled, n = sp_label(alpha)
    if n <= 1: return arr
    sizes = np.bincount(labeled.ravel()); sizes[0] = 0
    arr[labeled != sizes.argmax(), 3] = 0
    return arr


def extract_frame(full_arr, cx1, cy1, cx2, cy2, bg_color, mult=EXTRACT_MULT):
    """
    Extract one car frame.
    cx1..cy2 is the nominal grid cell.  We extract a WIDER region (mult×) so
    cars that overflow their cell are fully captured.  Flood-fill from outer
    edges removes background; keep_largest isolates the main car body.
    (Source-clipped frames — where the original sheet's narrow cell truncated
    the car — are substituted after Phase 2, not here.)
    """
    H, W  = full_arr.shape[:2]
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
    region = remove_isolated_checker(region)
    region = keep_largest(region)

    # Tight bounding box of visible content + PAD
    alpha = region[:,:,3]
    ys, xs = np.where(alpha > 10)
    if len(xs) == 0:
        return Image.new("RGBA", (cell_w, cell_h), (0,0,0,0))

    x1 = max(0, int(xs.min()) - PAD)
    y1 = max(0, int(ys.min()) - PAD)
    x2 = min(region.shape[1], int(xs.max()) + PAD + 1)
    y2 = min(region.shape[0], int(ys.max()) + PAD + 1)

    return Image.fromarray(region[y1:y2, x1:x2, :])

# ── Phase 5: Defringe ─────────────────────────────────────────────────────────

def defringe(arr):
    """Multi-pass defringe: semi-transparent pixels + opaque gray edge pixels."""
    a = arr[:,:,3].astype(np.int32)
    r = arr[:,:,0].astype(np.int32)
    g = arr[:,:,1].astype(np.int32)
    b = arr[:,:,2].astype(np.int32)
    whiteness = (r + g + b) // 3
    chroma    = np.abs(r-g) + np.abs(g-b) + np.abs(r-b)

    # Pass A: semi-transparent near-white
    semi = (a > 0) & (a < 255)
    arr = arr.copy()
    arr[(semi & (whiteness > 200) & (a < 180)) |
        (semi & (whiteness > 230) & (a < 220)), 3] = 0

    # Pass B: recolor surviving semi-transparent pixels toward opaque neighbours
    a = arr[:,:,3].astype(np.int32)
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
    a = arr[:,:,3].astype(np.int32)
    near_transp = (a > 0) & (a < 40)
    opaque_bin  = (a == 255)
    op_nbrs = sum(np.roll(np.roll(opaque_bin, dy, 0), dx, 1)
                  for dy in (-1,0,1) for dx in (-1,0,1) if not (dy==0 and dx==0))
    arr[near_transp & (op_nbrs < 2), 3] = 0

    # Pass D: final boundary whiteness sweep
    a = arr[:,:,3].astype(np.int32)
    r = arr[:,:,0].astype(np.int32); g = arr[:,:,1].astype(np.int32); b = arr[:,:,2].astype(np.int32)
    transp = (a == 0)
    border = (np.roll(transp,1,0)|np.roll(transp,-1,0)|np.roll(transp,1,1)|np.roll(transp,-1,1))
    arr[(a>0)&(a<128)&border&(((r+g+b)//3)>180), 3] = 0

    # Pass E: opaque gray edge pixels (main fringe source here — binary alpha in source)
    def edge_mask(op, tr):
        return op & (np.roll(tr,1,0)|np.roll(tr,-1,0)|np.roll(tr,1,1)|np.roll(tr,-1,1))

    for _ in range(2):   # two passes
        a = arr[:,:,3].astype(np.int32)
        r = arr[:,:,0].astype(np.int32); g = arr[:,:,1].astype(np.int32); b = arr[:,:,2].astype(np.int32)
        w = (r+g+b)//3
        c = np.abs(r-g)+np.abs(g-b)+np.abs(r-b)
        op = (a==255); tr = (a==0)
        edge = edge_mask(op, tr)
        arr[edge & (w > 165) & (c < 50), 3] = 0
        # also remove pure-gray interior pixels
        a2 = arr[:,:,3].astype(np.int32)
        r2=arr[:,:,0].astype(np.int32);g2=arr[:,:,1].astype(np.int32);b2=arr[:,:,2].astype(np.int32)
        w2=(r2+g2+b2)//3; c2=np.abs(r2-g2)+np.abs(g2-b2)+np.abs(r2-b2)
        arr[(a2==255)&(w2>190)&(c2<15), 3] = 0

    # Pass G: recolor opaque gray edge pixels toward car interior
    a = arr[:,:,3].astype(np.int32)
    r3=arr[:,:,0].astype(np.float32);g3=arr[:,:,1].astype(np.float32);b3=arr[:,:,2].astype(np.float32)
    c3=(np.abs(r3-g3)+np.abs(g3-b3)+np.abs(r3-b3))
    op3=(a==255); tr3=(a==0)
    edge3 = edge_mask(op3, tr3)
    car_px = op3 & (c3 > 60)
    car_f  = car_px.astype(np.float32)
    sz = 9
    car_cnt = uniform_filter(car_f, size=sz, mode='constant') * sz * sz
    for ch_a, ch_idx in [(r3,0),(g3,1),(b3,2)]:
        ch_sum = uniform_filter(np.where(car_px, ch_a, 0.0), size=sz, mode='constant') * sz * sz
        avg    = np.where(car_cnt > 0, ch_sum / np.maximum(car_cnt, 1), ch_a)
        gray_edge = edge3 & (c3 < 80)
        arr[:,:,ch_idx] = np.where(gray_edge & (car_cnt > 0),
                                   np.clip(avg, 0, 255).astype(np.uint8), arr[:,:,ch_idx])

    return arr

# ── Main ──────────────────────────────────────────────────────────────────────

print("="*60)
print("Phase 1: Load + Detect grid cells")
print("="*60)

right_img = Image.open(SRC_RIGHT).convert("RGBA")
left_img  = Image.open(SRC_LEFT).convert("RGBA")
right_arr = np.array(right_img)
left_arr  = np.array(left_img)

bg_r = estimate_bg(right_arr)
bg_l = estimate_bg(left_arr)
print(f"right.png BG ≈ {bg_r.astype(int)}")
print(f"left.png  BG ≈ {bg_l.astype(int)}")

right_cells = detect_grid_positions(right_arr)
left_cells  = detect_grid_positions(left_arr)
print(f"right.png: {len(right_cells)} grid cells")
print(f"left.png:  {len(left_cells)} grid cells")

# Save source analysis
def save_analysis(src_img, cells, path):
    vis  = src_img.convert("RGB").resize(
        (src_img.width//3, src_img.height//3), Image.LANCZOS)
    draw = ImageDraw.Draw(vis)
    s = 1/3
    clrs = ["red","lime","blue","orange","magenta","cyan","yellow","white"]
    for i, (x1,y1,x2,y2) in enumerate(cells):
        c = clrs[i % len(clrs)]
        draw.rectangle([int(x1*s),int(y1*s),int(x2*s),int(y2*s)], outline=c, width=2)
        draw.text((int(x1*s)+2, int(y1*s)+2), str(i+1), fill=c)
    vis.save(path)

save_analysis(right_img, right_cells, "source_analysis_right.png")
save_analysis(left_img,  left_cells,  "source_analysis_left.png")
print("Saved source_analysis_right.png / source_analysis_left.png")

# ── Phase 2: Extract ──────────────────────────────────────────────────────────
print("\n" + "="*60)
print("Phase 2: Extracting frames (wide extraction + flood-fill)")
print("="*60)

right_frames = []
for i, (cx1,cy1,cx2,cy2) in enumerate(right_cells):
    frame = extract_frame(right_arr, cx1, cy1, cx2, cy2, bg_r)
    right_frames.append(frame)
    frame.save(f"debug/right_frame_{i+1:02d}.png")
    print(f"  R{i+1:02d}: cell({cx1},{cy1})-({cx2},{cy2}) → extracted {frame.width}×{frame.height}")

left_frames = []
for i, (cx1,cy1,cx2,cy2) in enumerate(left_cells[:13]):   # only need L1-L13
    frame = extract_frame(left_arr, cx1, cy1, cx2, cy2, bg_l)
    left_frames.append(frame)
    frame.save(f"debug/left_frame_{i+1:02d}.png")
    print(f"  L{i+1:02d}: cell({cx1},{cy1})-({cx2},{cy2}) → extracted {frame.width}×{frame.height}")

# ── Source-clip substitution ──────────────────────────────────────────────────
# Some right.png frames are genuinely clipped in the SOURCE sprite sheet: the
# original grid cell was too narrow for the car at that angle, so the car body
# was partially cut off.  No extraction method can recover pixels that aren't
# there.  Substitute with the nearest clean adjacent frame.
#   right_frames index (0-based) → substitute index
#   [9]  R10  45° → [8]  R09  40°   (199px vs 254px expected)
#   [10] R11  50° → [11] R12  55°   (218px vs 260px, minor clip)
#   [15] R16  80° → [14] R15  70°   (203px vs 251px expected)
#   [16] R17  85° → [17] R18  90°   (217px vs 256px expected)
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
print("\n" + "="*60)
print("Phase 3: Assembling hybrid strip")
print("="*60)

# Index mapping for 37-frame strip:
# Strip:  [L19][L18]...[L2] [F1] [R2]...[R19]
#   0       1         17   18   19       36
#
# Sources:
#   L19-L14 (strip 0-5):  flipped right_frames[18..13]
#   L13-L2  (strip 6-17): left_frames[12..1]
#   F1      (strip 18):   right_frames[0]   (0° straight)
#   R2-R19  (strip 19-36):right_frames[1..18]

def flip_h(img):
    return img.transpose(Image.FLIP_LEFT_RIGHT)

strip_frames = []
names        = []
sources      = []

# L19..L14 (strip indices 0-5) — flipped right frames 19..14 (0-indexed 18..13)
for i in range(18, 12, -1):   # 18,17,16,15,14,13 → L19,L18,L17,L16,L15,L14
    deg = i * 5
    if i < len(right_frames):
        strip_frames.append(flip_h(right_frames[i]))
    else:
        strip_frames.append(flip_h(right_frames[-1]))
        print(f"  WARNING: right frame {i+1} missing, using last available")
    names.append(f"L{i+1}_{deg}deg_left")
    sources.append("right_flipped")

# L13..L2 (strip indices 6-17) — real left frames 13..2 (0-indexed 12..1)
# Bleed detection: use width ceiling (extraction-limit hit) OR multi-blob check
# (count_car_blobs > 1 = adjacent car leaked into the extracted frame).
BLEED_W = 290
for i in range(12, 0, -1):    # 12,11,...,1 → L13,L12,...,L2
    deg = i * 5
    if i < len(left_frames):
        lf = left_frames[i]
        n_blobs   = count_car_blobs(lf)
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

# F1 / straight (strip index 18) — right frame 1 (0-indexed 0)
strip_frames.append(right_frames[0])
names.append("STRAIGHT_0deg")
sources.append("shared")

# R2..R19 (strip indices 19-36) — right frames 2..19 (0-indexed 1..18)
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

# ── Phase 4: Normalize cell size ─────────────────────────────────────────────
max_w  = max(f.width  for f in strip_frames)
max_h  = max(f.height for f in strip_frames)
cell_w = max_w + PAD * 2
cell_h = max_h + PAD * 2
print(f"  Max frame: {max_w}×{max_h}  →  cell: {cell_w}×{cell_h}")

def to_cell(frame):
    cell = Image.new("RGBA", (cell_w, cell_h), (0,0,0,0))
    ox   = (cell_w - frame.width)  // 2
    oy   = (cell_h - frame.height) // 2
    cell.paste(frame, (ox, oy), frame)
    return cell

cells = [to_cell(f) for f in strip_frames]

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
W1, H1 = strip_clean.size
strip_2x = strip_clean.resize((W1*2, H1*2), Image.NEAREST)
strip_4x = strip_clean.resize((W1*4, H1*4), Image.NEAREST)
strip_clean.save("player_car_sprites_1x.png")
strip_2x.save("player_car_sprites_2x.png")
strip_4x.save("player_car_sprites_4x.png")
print(f"  player_car_sprites_1x.png  {W1}×{H1}")
print(f"  player_car_sprites_2x.png  {W1*2}×{H1*2}")
print(f"  player_car_sprites_4x.png  {W1*4}×{H1*4}")

# ── Phase 7: Metadata ─────────────────────────────────────────────────────────
frames_meta = [
    {"index": idx, "name": name, "x": idx*cell_w, "y": 0,
     "w": cell_w, "h": cell_h, "source": src}
    for idx, (name, src) in enumerate(zip(names, sources))
]
meta = {
    "frameWidth":  cell_w, "frameHeight": cell_h,
    "totalFrames": total,  "centerIndex": 18, "scale": "1x",
    "hybridNote": "L2-L13 left.png (correct occupants); L14-L19 flipped right.png",
    "frames": frames_meta,
}
with open("player_car_sprites.json", "w") as f:
    json.dump(meta, f, indent=2)
print("\nSaved player_car_sprites.json")

# ── Phase 8: Proof image ──────────────────────────────────────────────────────
print("\n" + "="*60)
print("Phase 8: Proof image")
print("="*60)

BG   = (26, 26, 46)
COLS = 19
ROWS = (total + COLS - 1) // COLS
LPAD = 18   # label height
B    = 2    # border

PW = COLS * (cell_w + B*2 + 3) + 10
PH = ROWS * (cell_h + LPAD + B*2 + 4) + 10
proof = Image.new("RGB", (PW, PH), BG)
draw  = ImageDraw.Draw(proof)

clipped = []
for idx, cell in enumerate(cells):
    col = idx % COLS
    row = idx // COLS
    px  = 5 + col * (cell_w + B*2 + 3)
    py  = 5 + row * (cell_h + LPAD + B*2 + 4)

    ca = np.array(cell)[:,:,3]
    touched = ca[0,:].any() or ca[-1,:].any() or ca[:,0].any() or ca[:,-1].any()
    if touched: clipped.append(idx)

    border_clr = (220,50,50) if touched else (50,180,50)
    draw.rectangle([px-B, py-B, px+cell_w+B, py+cell_h+B], outline=border_clr, width=B)

    bg_patch = Image.new("RGBA", (cell_w, cell_h), (*BG, 255))
    bg_patch.paste(cell, (0,0), cell)
    proof.paste(bg_patch.convert("RGB"), (px, py))

    src_abbr = {"left_real":"L","right_flipped":"F","right_flipped_fallback":"FB","shared":"S","right_real":"R"}.get(sources[idx],"?")
    lbl_clr  = (220,80,80) if touched else (140,200,140)
    draw.text((px, py+cell_h+2), f"{idx}:{src_abbr}", fill=lbl_clr)

proof.save("sprite_sheet_proof.png")
print(f"  Saved sprite_sheet_proof.png  ({proof.width}×{proof.height})")

if clipped:
    print(f"\n  ⚠  RED BORDER frames (car touches cell edge): {clipped}")
else:
    print("\n  ✓ All green — no clipping detected!")

print("\n" + "="*60)
print("DONE")
print(f"  {W1}×{H1}   {total} frames   cell {cell_w}×{cell_h}   center=18")
print("="*60)
