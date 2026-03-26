#!/usr/bin/env python3
"""
build_big_sheet.py

Stitches the big_boards PNGs into a single horizontal sprite atlas
and prints the TypeScript rect constants for sprites.ts.

Distinct class from og_boards, cookie_boards, barney_boards — own sheet (big_sheet.png),
own SpriteId prefix (BIG_*).

── Input ──────────────────────────────────────────────────────────────────

  assets/billboards/big_boards/billboard_*.png

── Outputs ────────────────────────────────────────────────────────────────

  assets/big_sheet.png   Horizontal atlas.
  (stdout)               TypeScript constant block ready to paste into sprites.ts.
"""

from PIL import Image

PAD = 4

ORDER = [
    ("WRESTLING", "assets/billboards/big_boards/billboard_wrestling.png"),
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

sheet.save("assets/big_sheet.png")
print(f"Saved assets/big_sheet.png  {sheet_w}x{sheet_h}")
print()

print("// ── Paste into sprites.ts ────────────────────────────────────────────────────")
print()
print("// Add to SpriteId union:")
for name, _ in images:
    print(f"  | 'BIG_{name}'")
print()
print("export const BIG_RECTS: Partial<Record<SpriteId, SpriteRect>> =")
print("{")
for name, (rx, ry, rw, rh) in rects.items():
    pad_name = f"BIG_{name}:"
    print(f"  {pad_name:<24s} {{ x: {rx:4d}, y: {ry:3d}, w: {rw:3d}, h: {rh:3d} }},")
print("};")
print()
print("// Verify:")
for name, (rx, ry, rw, rh) in rects.items():
    print(f"//  BIG_{name:<18s} sheet rect ({rx},{ry}) {rw}x{rh}")
