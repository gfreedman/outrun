#!/usr/bin/env python3
"""
build_palm_sheet.py

Stitches the individual extracted palm PNGs into a single horizontal
sprite atlas and prints the TypeScript rect constants for sprites.ts.

Each palm is placed with PAD transparent pixels of padding on each side.
Sheet height equals the tallest palm + 2 × PAD; sprites are centred vertically.

── Input ──────────────────────────────────────────────────────────────────

  assets/palms/palm_t1_straight.png
  assets/palms/palm_t2_bent_left.png
  assets/palms/palm_t2_bent_right.png
  assets/palms/palm_t3_young.png
  assets/palms/palm_t4_fruiting.png
  assets/palms/palm_t6_luxuriant.png
  assets/palms/palm_t7_slender.png
  assets/palms/palm_t8_medium.png
  assets/palms/palm_t10_large.png

── Outputs ────────────────────────────────────────────────────────────────

  assets/palm_sheet.png   Horizontal atlas — 9 palms in a single PNG.
  (stdout)                TypeScript constant block ready to paste into sprites.ts.
"""

from PIL import Image

# ── Config ─────────────────────────────────────────────────────────────────────

# Transparent padding (pixels) added around each sprite within the atlas.
PAD = 4

# Palms in left-to-right atlas order.
# Each entry: (TypeScript identifier suffix, source path)
ORDER = [
    ("T1_STRAIGHT",   "assets/palms/palm_t1_straight.png"),
    ("T2_BENT_LEFT",  "assets/palms/palm_t2_bent_left.png"),
    ("T2_BENT_RIGHT", "assets/palms/palm_t2_bent_right.png"),
    ("T3_YOUNG",      "assets/palms/palm_t3_young.png"),
    ("T4_FRUITING",   "assets/palms/palm_t4_fruiting.png"),
    ("T6_LUXURIANT",  "assets/palms/palm_t6_luxuriant.png"),
    ("T7_SLENDER",    "assets/palms/palm_t7_slender.png"),
    ("T8_MEDIUM",     "assets/palms/palm_t8_medium.png"),
    ("T10_LARGE",     "assets/palms/palm_t10_large.png"),
]

# ── Load images ────────────────────────────────────────────────────────────────

images = [(name, Image.open(path).convert("RGBA")) for name, path in ORDER]

# ── Compute atlas dimensions ───────────────────────────────────────────────────

sheet_h = max(img.height for _, img in images) + 2 * PAD
sheet_w = sum(img.width  + 2 * PAD for _, img in images)

# ── Compose atlas ──────────────────────────────────────────────────────────────

sheet = Image.new("RGBA", (sheet_w, sheet_h), (0, 0, 0, 0))

# Maps sprite name → (x, y, w, h): top-left corner in the output sheet plus
# the unpadded sprite dimensions, ready to emit as TypeScript SpriteRect values.
rects = {}
x = 0
for name, img in images:
    # Vertically centre shorter sprites so all sprites share a common bottom
    # baseline — shorter images sit higher by exactly half the height difference.
    iy = (sheet_h - img.height) // 2   # centre vertically
    sheet.paste(img, (x + PAD, iy), img)
    rects[name] = (x + PAD, iy, img.width, img.height)
    x += img.width + 2 * PAD

sheet.save("assets/palm_sheet.png")
print(f"Saved assets/palm_sheet.png  {sheet_w}×{sheet_h}")
print()

# ── Print TypeScript constants ─────────────────────────────────────────────────

print("// ── Paste into sprites.ts ────────────────────────────────────────────────────")
print()
print("export type PalmId =")
names = [name for name, _ in images]
for i, name in enumerate(names):
    sep = " |" if i < len(names) - 1 else " ;"
    print(f"  'PALM_{name}'{sep}")
print()
print("export const PALM_RECTS: Record<PalmId, SpriteRect> =")
print("{")
for name, (rx, ry, rw, rh) in rects.items():
    print(f"  PALM_{name}: {{ x: {rx:4d}, y: {ry:3d}, w: {rw:3d}, h: {rh:3d} }},")
print("};")
print()
print("// Verify:")
for name, (rx, ry, rw, rh) in rects.items():
    print(f"//  PALM_{name:<16s} sheet rect ({rx},{ry}) {rw}×{rh}")
