#!/usr/bin/env python3
"""
build_cactus_sheet.py

Extracts individual cactus sprites from source_for_sprites/cactus.png.
The source is a 2-D sprite sheet with text headers, labels, and multiple
cactus varieties arranged in rows.  This script:

  1. Removes the light BG colour via edge-seeded flood-fill (TOL=55).
  2. Removes dark text pixels (max channel < 80).
  3. Labels connected components; keeps seeds with area > 400 px.
  4. Dilates seeds 15 px to merge nearby fragments of the same plant.
  5. Re-labels; each group = one cactus.
  6. Extracts each group with PAD transparent margin.
  7. Stitches into a horizontal atlas: assets/cactus_sheet.png.
  8. Prints TypeScript constants ready to paste into sprites.ts.
"""

import os
import numpy as np
from PIL import Image
from scipy import ndimage as ndi

# ── Config ──────────────────────────────────────────────────────────────────

SRC          = "source_for_sprites/cactus.png"
PAD          = 10       # transparent margin around each tight-cropped sprite
TOL_BG       = 55       # flood-fill BG tolerance (per-channel max diff)
TOL_TEXT     = 80       # max-channel threshold below which a pixel = dark text
TOL_DEFRINGE = 75       # defringe pass: erase opaque border px within this of BG
SEED_MIN_PX  = 400      # minimum component area to act as a merge seed
DILATION_PX  = 15       # dilation radius used to merge cactus fragments
GROUP_MIN_PX = 1500     # minimum content pixels for a merged group to be kept
ATLAS_PAD    = 4        # padding in the final atlas between sprites
WORLD_H      = 2000     # world-unit height assigned to every cactus sprite

os.makedirs("assets/cactuses", exist_ok=True)

# ── Load & clean source ──────────────────────────────────────────────────────

print("=" * 60)
print("Loading cactus source")
print("=" * 60)
src     = Image.open(SRC).convert("RGBA")
src_arr = np.array(src)
H, W    = src_arr.shape[:2]

# Detect BG from image edges
edges = np.concatenate([
    src_arr[0, :, :3], src_arr[-1, :, :3],
    src_arr[:, 0, :3], src_arr[:, -1, :3],
])
bg = edges.mean(axis=0)
print(f"  {SRC}: {W}×{H}")
print(f"  Detected BG: R={bg[0]:.0f} G={bg[1]:.0f} B={bg[2]:.0f}")

# Flood-fill BG from all four edges
diff     = np.abs(src_arr[:, :, :3].astype(np.float32) - bg).max(axis=2)
bg_mask  = diff < TOL_BG
visited  = np.zeros((H, W), dtype=bool)
queue    = []

def _try(y, x):
    if not visited[y, x] and bg_mask[y, x]:
        visited[y, x] = True
        queue.append((y, x))

for x in range(W):
    _try(0, x); _try(H - 1, x)
for y in range(H):
    _try(y, 0); _try(y, W - 1)

i = 0
while i < len(queue):
    y, x = queue[i]; i += 1
    for ny, nx in ((y-1,x),(y+1,x),(y,x-1),(y,x+1)):
        if 0 <= ny < H and 0 <= nx < W:
            _try(ny, nx)

# Build cleaned content array
content = src_arr.copy()
content[visited, 3]                             = 0   # erase BG
content[src_arr[:, :, :3].max(axis=2) < TOL_TEXT, 3] = 0   # erase text

# Defringe: 2 passes to strip anti-aliased BG residue at silhouette edges
for _ in range(2):
    transp = content[:, :, 3] == 0
    border = np.zeros((H, W), dtype=bool)
    border[1:,  :] |= transp[:-1, :]
    border[:-1, :] |= transp[1:,  :]
    border[:,  1:] |= transp[:,  :-1]
    border[:, :-1] |= transp[:,   1:]
    border &= ~transp
    diff2 = np.abs(content[:, :, :3].astype(np.float32) - bg).max(axis=2)
    content[border & (diff2 < TOL_DEFRINGE), 3] = 0

alpha = content[:, :, 3] > 10   # boolean mask of remaining content

# ── Find individual cacti via seed-merge ─────────────────────────────────────

print()
print("=" * 60)
print("Detecting individual cacti")
print("=" * 60)

# Label raw components; keep only large ones as seeds
labeled0, _ = ndi.label(alpha)
sizes0       = ndi.sum(alpha, labeled0, range(1, labeled0.max() + 1))
seed_mask    = np.zeros((H, W), dtype=bool)
for idx, sz in enumerate(sizes0, 1):
    if sz >= SEED_MIN_PX:
        seed_mask |= (labeled0 == idx)

# Dilate seeds → merge nearby fragments → re-label
dilated        = ndi.binary_dilation(seed_mask, iterations=DILATION_PX)
labeled2, n2   = ndi.label(dilated)

# Collect valid groups (enough original pixels)
groups = []   # (index_in_source_label, area, x0, y0, x1, y1)
for idx in range(1, n2 + 1):
    group_mask   = labeled2 == idx
    orig_content = alpha & group_mask
    area         = int(orig_content.sum())
    if area < GROUP_MIN_PX:
        continue
    cys, cxs = np.where(orig_content)
    groups.append((idx, area, int(cxs.min()), int(cys.min()),
                             int(cxs.max()), int(cys.max())))

# Sort left-to-right, then top-to-bottom so numbering is predictable
groups.sort(key=lambda g: (g[2] // 200, g[2]))   # coarse x-band first
print(f"  Found {len(groups)} cactus sprites (area ≥ {GROUP_MIN_PX} px)")

# ── Extract each cactus ───────────────────────────────────────────────────────

print()
print("=" * 60)
print("Extracting sprites")
print("=" * 60)

images  = []   # (name, PIL image)
NAMES   = [f"CACTUS_C{i+1}" for i in range(len(groups))]

for name, (label_idx, area, x0, y0, x1, y1) in zip(NAMES, groups):
    # Expand bbox by PAD
    rx0 = max(0, x0 - PAD)
    ry0 = max(0, y0 - PAD)
    rx1 = min(W, x1 + PAD + 1)
    ry1 = min(H, y1 + PAD + 1)

    region = content[ry0:ry1, rx0:rx1].copy()
    # Zero out pixels that don't belong to this group's dilation mask
    group_crop = (labeled2[ry0:ry1, rx0:rx1] == label_idx)
    region[~group_crop, 3] = 0

    img      = Image.fromarray(region)
    out_path = f"assets/cactuses/{name.lower()}.png"
    img.save(out_path)

    print(f"  {name}: {area:,} px  bbox=({x0},{y0})-({x1},{y1})  "
          f"→ {img.width}×{img.height}  {out_path}")
    images.append((name, img))

# ── Build atlas ───────────────────────────────────────────────────────────────

print()
print("=" * 60)
print("Building atlas")
print("=" * 60)

sheet_h = max(img.height for _, img in images) + 2 * ATLAS_PAD
sheet_w = sum(img.width + 2 * ATLAS_PAD for _, img in images)

sheet  = Image.new("RGBA", (sheet_w, sheet_h), (0, 0, 0, 0))
rects  = {}
cx     = 0
for name, img in images:
    iy = (sheet_h - img.height) // 2
    sheet.paste(img, (cx + ATLAS_PAD, iy), img)
    rects[name] = (cx + ATLAS_PAD, iy, img.width, img.height)
    cx += img.width + 2 * ATLAS_PAD

sheet.save("assets/cactus_sheet.png")
print(f"Saved assets/cactus_sheet.png  {sheet_w}×{sheet_h}")

# ── Print TypeScript constants ────────────────────────────────────────────────

print()
print("// ── Paste into sprites.ts ───────────────────────────────────────────────────")
print()
names = [n for n, _ in images]
print("// Replace the CACTUS_* block in the SpriteId union with:")
for n in names:
    print(f"  | '{n}'")
print()
print("export const CACTUS_RECTS: Partial<Record<SpriteId, SpriteRect>> =")
print("{")
for name, (rx, ry, rw, rh) in rects.items():
    print(f"  {name}:{' ' * (12 - len(name))} {{ x: {rx:4d}, y: {ry:3d}, w: {rw:3d}, h: {rh:3d} }},")
print("};")
print()
print("export const CACTUS_WORLD_HEIGHT: Partial<Record<SpriteId, number>> =")
print("{")
for name in names:
    print(f"  {name}:{' ' * (12 - len(name))} {WORLD_H},")
print("};")
print()
print("// ── Replace the CACTI pool in road.ts plantCactuses() with:")
print("const CACTI: string[] = [")
for name in names:
    print(f"  '{name}',")
print("];")
