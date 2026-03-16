#!/usr/bin/env python3
"""
build_shrub_sheet.py

Stitches the shrubs PNGs into a single horizontal sprite atlas
and prints the TypeScript rect constants for sprites.ts.

Distinct class from all other sprites — own sheet (shrub_sheet.png),
own SpriteId prefix (SHRUB_*).

── Input ──────────────────────────────────────────────────────────────────

  assets/shrubs/shrub_s1.png
  assets/shrubs/shrub_s2.png
  assets/shrubs/shrub_s6.png

── Outputs ────────────────────────────────────────────────────────────────

  assets/shrub_sheet.png   Horizontal atlas.
  (stdout)                 TypeScript constant block ready to paste into sprites.ts.
"""

from PIL import Image

PAD = 4

ORDER = [
    ("S1", "assets/shrubs/shrub_s1.png"),
    ("S2", "assets/shrubs/shrub_s2.png"),
    ("S6", "assets/shrubs/shrub_s6.png"),
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

sheet.save("assets/shrub_sheet.png")
print(f"Saved assets/shrub_sheet.png  {sheet_w}x{sheet_h}")
print()

print("// ── Paste into sprites.ts ────────────────────────────────────────────────────")
print()
print("// Add to SpriteId union:")
for name, _ in images:
    print(f"  | 'SHRUB_{name}'")
print()
print("export const SHRUB_RECTS: Partial<Record<SpriteId, SpriteRect>> =")
print("{")
for name, (rx, ry, rw, rh) in rects.items():
    pad_name = f"SHRUB_{name}:"
    print(f"  {pad_name:<12s} {{ x: {rx:4d}, y: {ry:3d}, w: {rw:3d}, h: {rh:3d} }},")
print("};")
print()
print("// Verify:")
for name, (rx, ry, rw, rh) in rects.items():
    print(f"//  SHRUB_{name:<8s} sheet rect ({rx},{ry}) {rw}x{rh}")
