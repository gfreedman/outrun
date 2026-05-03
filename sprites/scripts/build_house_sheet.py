#!/usr/bin/env python3
"""
build_house_sheet.py

Stitches all extracted house/building PNGs into a single horizontal atlas
and prints the TypeScript rect/worldH constants for sprites.ts.

── Input (25 sprites total) ──────────────────────────────────────────────────

  parts/houses/    house_a01…a10 (adobe) + house_d01…d05 (desert)
  parts/buildings/ house_b01…b10 (colourful buildings)

── Outputs ───────────────────────────────────────────────────────────────────

  dist/house_sheet.png   Horizontal atlas.
  (stdout)                 TypeScript constant block ready to paste into sprites.ts.
"""

import os
from PIL import Image

PAD = 4

# ── Sprite order and metadata ─────────────────────────────────────────────────
# (SpriteId suffix,  filename,                             worldH)
# worldH chosen so houses appear building-sized in the pseudo-3D view:
#   ~2200 wu → tall colourful shop fronts
#   ~1800 wu → standard adobe houses
#   ~1400 wu → low desert structures (tent, hut)

ORDER = [
    # ── Adobe houses (OG OutRun inspired) ─────────────────────────────────────
    ("HOUSE_ADOBE_1",  "source/houses/house_a01.png",   1800),
    ("HOUSE_ADOBE_2",  "source/houses/house_a02.png",   1800),
    ("HOUSE_ADOBE_3",  "source/houses/house_a03.png",   2000),  # dome
    ("HOUSE_ADOBE_4",  "source/houses/house_a04.png",   1600),
    ("HOUSE_ADOBE_5",  "source/houses/house_a05.png",   1700),
    ("HOUSE_ADOBE_6",  "source/houses/house_a06.png",   2000),  # two-storey
    ("HOUSE_ADOBE_7",  "source/houses/house_a07.png",   1800),
    ("HOUSE_ADOBE_8",  "source/houses/house_a08.png",   1700),
    ("HOUSE_ADOBE_9",  "source/houses/house_a09.png",   1600),
    ("HOUSE_ADOBE_10", "source/houses/house_a10.png",   1800),
    # ── Desert structures (Tusken / Tatooine) ─────────────────────────────────
    ("HOUSE_DOME",     "source/houses/house_d01.png",   1600),  # dome cluster
    ("HOUSE_TENT_L",   "source/houses/house_d02.png",   1400),  # large canvas tent
    ("HOUSE_HUT",      "source/houses/house_d03.png",   1300),  # desert lean-to
    ("HOUSE_TENT_S",   "source/houses/house_d04.png",   1400),  # smaller brown tent
    ("HOUSE_BUNKER",   "source/houses/house_d05.png",   1500),  # stone bunker
    # ── Colourful buildings (shops + residences) ──────────────────────────────
    ("HOUSE_SHOP",     "source/buildings/house_b01.png", 2200),
    ("HOUSE_BAKERY",   "source/buildings/house_b02.png", 2500),  # tall
    ("HOUSE_SURF",     "source/buildings/house_b03.png", 2200),
    ("HOUSE_CAFE",     "source/buildings/house_b04.png", 2600),  # tallest (dome)
    ("HOUSE_ARCADE",   "source/buildings/house_b05.png", 2200),
    ("HOUSE_PURPLE",   "source/buildings/house_b06.png", 2000),
    ("HOUSE_TEAL",     "source/buildings/house_b07.png", 2000),
    ("HOUSE_YELLOW",   "source/buildings/house_b08.png", 2100),
    ("HOUSE_GREEN",    "source/buildings/house_b09.png", 2000),
    ("HOUSE_PINK",     "source/buildings/house_b10.png", 2000),
]

# Load all images
images = [(name, wh, Image.open(path).convert("RGBA")) for (name, path, wh) in ORDER]

# Compute sheet dimensions
sheet_h = max(img.height for _, _, img in images) + 2 * PAD
sheet_w = sum(img.width + 2 * PAD for _, _, img in images)

sheet = Image.new("RGBA", (sheet_w, sheet_h), (0, 0, 0, 0))

# Maps sprite name → (x, y, w, h, worldH): top-left corner and unpadded
# dimensions in the output sheet, plus the game world-unit height used by
# the renderer for perspective scaling — taller worldH values make the sprite
# appear larger at a given road depth.
rects = {}
x = 0
for name, worldH, img in images:
    # Vertically centre shorter sprites so all sprites share a common bottom
    # baseline — shorter images sit higher by exactly half the height difference.
    iy = (sheet_h - img.height) // 2
    sheet.paste(img, (x + PAD, iy), img)
    rects[name] = (x + PAD, iy, img.width, img.height, worldH)
    x += img.width + 2 * PAD

os.makedirs("assets", exist_ok=True)
sheet.save("dist/house_sheet.png")
print(f"Saved dist/house_sheet.png  {sheet_w}×{sheet_h}")
print()

print("// ── Paste into sprites.ts ────────────────────────────────────────────────────")
print()
print("// Add to SpriteId union:")
for name, _, _ in images:
    print(f"  | '{name}'")
print()

print("export const HOUSE_RECTS: Partial<Record<SpriteId, SpriteRect>> =")
print("{")
for name, (rx, ry, rw, rh, _) in rects.items():
    pad_name = f"  {name}:"
    print(f"{pad_name:<18s} {{ x: {rx:5d}, y: {ry:3d}, w: {rw:3d}, h: {rh:3d} }},")
print("};")
print()

print("export const HOUSE_WORLD_HEIGHT: Partial<Record<SpriteId, number>> =")
print("{")
for name, (_, _, _, _, wh) in rects.items():
    pad_name = f"  {name}:"
    print(f"{pad_name:<18s} {wh},")
print("};")
print()

print("// Verify dimensions:")
for name, (rx, ry, rw, rh, wh) in rects.items():
    print(f"//  {name:<18s} ({rx},{ry}) {rw}×{rh}  worldH={wh}")
