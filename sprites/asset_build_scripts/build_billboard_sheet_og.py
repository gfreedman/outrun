#!/usr/bin/env python3
"""
build_billboard_sheet_og.py

Stitches the 9 og_boards billboard PNGs into a single horizontal sprite atlas
and prints the TypeScript rect constants for sprites.ts.

Follows the exact same pattern as build_palm_sheet.py.

── Input ──────────────────────────────────────────────────────────────────

  assets/billboards/og_boards/billboard_*.png

── Outputs ────────────────────────────────────────────────────────────────

  assets/billboard_sheet.png   Horizontal atlas — 9 billboards in a single PNG.
  (stdout)                     TypeScript constant block ready to paste into sprites.ts.
"""

from PIL import Image

# ── Config ─────────────────────────────────────────────────────────────────────

PAD = 4   # transparent padding (pixels) around each sprite within the atlas

ORDER = [
    ("BEAGLE_PETS",      "assets/billboards/og_boards/billboard_beagle_pets.png"),
    ("ADOPT_BEAGLE",     "assets/billboards/og_boards/billboard_adopt_beagle.png"),
    ("BEAGLE_POWER",     "assets/billboards/og_boards/billboard_beagle_power.png"),
    ("LOYAL_FRIENDLY",   "assets/billboards/og_boards/billboard_loyal_friendly.png"),
    ("FROG_TAVERN",      "assets/billboards/og_boards/billboard_frog_tavern.png"),
    ("ALE_CROAK",        "assets/billboards/og_boards/billboard_ale_croak.png"),
    ("CELLAR_JUMPERS",   "assets/billboards/og_boards/billboard_cellar_jumpers.png"),
    ("CROAK_TAILS",      "assets/billboards/og_boards/billboard_croak_tails.png"),
    ("RED_BOX",          "assets/billboards/og_boards/billboard_red_box.png"),
    ("FINE_TOBACCO",     "assets/billboards/og_boards/billboard_fine_tobacco.png"),
    ("SMOOTH_TASTE",     "assets/billboards/og_boards/billboard_smooth_taste.png"),
    ("WRESTLING",        "assets/billboards/og_boards/billboard_wrestling.png"),
]

# ── Load images ────────────────────────────────────────────────────────────────

images = [(name, Image.open(path).convert("RGBA")) for name, path in ORDER]

# ── Compute atlas dimensions ───────────────────────────────────────────────────

sheet_h = max(img.height for _, img in images) + 2 * PAD
sheet_w = sum(img.width  + 2 * PAD for _, img in images)

# ── Compose atlas ──────────────────────────────────────────────────────────────

sheet = Image.new("RGBA", (sheet_w, sheet_h), (0, 0, 0, 0))

rects = {}
x = 0
for name, img in images:
    iy = (sheet_h - img.height) // 2   # centre vertically
    sheet.paste(img, (x + PAD, iy), img)
    rects[name] = (x + PAD, iy, img.width, img.height)
    x += img.width + 2 * PAD

sheet.save("assets/billboard_sheet.png")
print(f"Saved assets/billboard_sheet.png  {sheet_w}x{sheet_h}")
print()

# ── Print TypeScript constants ─────────────────────────────────────────────────

print("// ── Paste into sprites.ts ────────────────────────────────────────────────────")
print()
print("// Add to SpriteId union:")
for name, _ in images:
    print(f"  | 'BILLBOARD_{name}'")
print()
print("export const BILLBOARD_RECTS: Partial<Record<SpriteId, SpriteRect>> =")
print("{")
for name, (rx, ry, rw, rh) in rects.items():
    pad_name = f"BILLBOARD_{name}:"
    print(f"  {pad_name:<26s} {{ x: {rx:4d}, y: {ry:3d}, w: {rw:3d}, h: {rh:3d} }},")
print("};")
print()
print("// Verify:")
for name, (rx, ry, rw, rh) in rects.items():
    print(f"//  BILLBOARD_{name:<18s} sheet rect ({rx},{ry}) {rw}x{rh}")
