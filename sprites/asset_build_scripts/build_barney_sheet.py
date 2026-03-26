#!/usr/bin/env python3
"""
build_barney_sheet.py

Stitches the barney_boards PNGs into a single horizontal sprite atlas
and prints the TypeScript rect constants for sprites.ts.

Distinct class from og_boards and cookie_boards — own sheet (barney_sheet.png),
own SpriteId prefix (BARNEY_*).

── Input ──────────────────────────────────────────────────────────────────

  assets/billboards/barney_boards/billboard_barney_*.png

── Outputs ────────────────────────────────────────────────────────────────

  assets/barney_sheet.png   Horizontal atlas.
  (stdout)                  TypeScript constant block ready to paste into sprites.ts.
"""

from PIL import Image

PAD = 4

ORDER = [
    ("METAL_TILLETIRE",  "assets/billboards/barney_boards/billboard_barney_metal_tilletire.png"),
    ("OUTRUN_PALETTE",   "assets/billboards/barney_boards/billboard_barney_outrun_palette.png"),
]

images = [(name, Image.open(path).convert("RGBA")) for name, path in ORDER]

sheet_h = max(img.height for _, img in images) + 2 * PAD
sheet_w = sum(img.width  + 2 * PAD for _, img in images)

sheet = Image.new("RGBA", (sheet_w, sheet_h), (0, 0, 0, 0))

rects = {}
x = 0
for name, img in images:
    iy = (sheet_h - img.height) // 2
    sheet.paste(img, (x + PAD, iy), img)
    rects[name] = (x + PAD, iy, img.width, img.height)
    x += img.width + 2 * PAD

sheet.save("assets/barney_sheet.png")
print(f"Saved assets/barney_sheet.png  {sheet_w}x{sheet_h}")
print()

print("// ── Paste into sprites.ts ────────────────────────────────────────────────────")
print()
print("// Add to SpriteId union:")
for name, _ in images:
    print(f"  | 'BARNEY_{name}'")
print()
print("export const BARNEY_RECTS: Partial<Record<SpriteId, SpriteRect>> =")
print("{")
for name, (rx, ry, rw, rh) in rects.items():
    pad_name = f"BARNEY_{name}:"
    print(f"  {pad_name:<24s} {{ x: {rx:4d}, y: {ry:3d}, w: {rw:3d}, h: {rh:3d} }},")
print("};")
print()
print("// Verify:")
for name, (rx, ry, rw, rh) in rects.items():
    print(f"//  BARNEY_{name:<18s} sheet rect ({rx},{ry}) {rw}x{rh}")
