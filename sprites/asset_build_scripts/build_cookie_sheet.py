#!/usr/bin/env python3
"""
build_cookie_sheet.py

Stitches the cookie_boards portrait billboard PNGs into a single horizontal
sprite atlas and prints the TypeScript rect constants for sprites.ts.

These are a DISTINCT class from og_boards — portrait orientation, separate
sheet (cookie_sheet.png), separate SpriteId prefix (COOKIE_*).

Follows the same atlas pattern as build_palm_sheet.py.

── Input ──────────────────────────────────────────────────────────────────

  assets/billboards/cookie_boards/billboard_cookie_monster_*.png

── Outputs ────────────────────────────────────────────────────────────────

  assets/cookie_sheet.png   Horizontal atlas — 4 portrait signs in one PNG.
  (stdout)                  TypeScript constant block ready to paste into sprites.ts.
"""

from PIL import Image

PAD = 4

ORDER = [
    ("HAPPY_SMOKING",  "assets/billboards/cookie_boards/billboard_cookie_monster_happy_smoking.png"),
    ("PREMIUM_CIGS",   "assets/billboards/cookie_boards/billboard_cookie_monster_premium_cigs.png"),
    ("SMOKIN_NOW",     "assets/billboards/cookie_boards/billboard_cookie_monster_smokin_now.png"),
    ("CIG_RESERVES",   "assets/billboards/cookie_boards/billboard_cookie_monster_cig_reserves.png"),
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

sheet.save("assets/cookie_sheet.png")
print(f"Saved assets/cookie_sheet.png  {sheet_w}x{sheet_h}")
print()

print("// ── Paste into sprites.ts ────────────────────────────────────────────────────")
print()
print("// Add to SpriteId union:")
for name, _ in images:
    print(f"  | 'COOKIE_{name}'")
print()
print("export const COOKIE_RECTS: Partial<Record<SpriteId, SpriteRect>> =")
print("{")
for name, (rx, ry, rw, rh) in rects.items():
    pad_name = f"COOKIE_{name}:"
    print(f"  {pad_name:<22s} {{ x: {rx:4d}, y: {ry:3d}, w: {rw:3d}, h: {rh:3d} }},")
print("};")
print()
print("// Verify:")
for name, (rx, ry, rw, rh) in rects.items():
    print(f"//  COOKIE_{name:<16s} sheet rect ({rx},{ry}) {rw}x{rh}")
