#!/usr/bin/env python3
"""
build_sign_sheet.py

Stitches the turn-sign PNGs into a single horizontal sprite atlas
and prints the TypeScript rect constants for sprites.ts.

── Input ──────────────────────────────────────────────────────────────────

  assets/signs/sign_turn_right.png
  assets/signs/sign_turn_left.png

── Outputs ────────────────────────────────────────────────────────────────

  assets/sign_sheet.png   Horizontal atlas.
  (stdout)                TypeScript constant block ready to paste into sprites.ts.
"""

from PIL import Image

PAD = 4

ORDER = [
    ("TURN_RIGHT", "assets/signs/sign_turn_right.png"),
    ("TURN_LEFT",  "assets/signs/sign_turn_left.png"),
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

sheet.save("assets/sign_sheet.png")
print(f"Saved assets/sign_sheet.png  {sheet_w}x{sheet_h}")
print()

print("// ── Paste into sprites.ts ────────────────────────────────────────────────────")
print()
print("// Add to SpriteId union:")
for name, _ in images:
    print(f"  | 'SIGN_{name}'")
print()
print("export const SIGN_RECTS: Partial<Record<SpriteId, SpriteRect>> =")
print("{")
for name, (rx, ry, rw, rh) in rects.items():
    pad_name = f"SIGN_{name}:"
    print(f"  {pad_name:<18s} {{ x: {rx:4d}, y: {ry:3d}, w: {rw:3d}, h: {rh:3d} }},")
print("};")
print()
print("// Verify:")
for name, (rx, ry, rw, rh) in rects.items():
    print(f"//  SIGN_{name:<12s} sheet rect ({rx},{ry}) {rw}x{rh}")
