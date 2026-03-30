#!/usr/bin/env python3
"""
build_billboard_sheet.py

Stitches the 19 individual extracted billboard PNGs into a single horizontal
sprite atlas and prints the TypeScript rect constants for sprites.ts.

── Input ──────────────────────────────────────────────────────────────────

  assets/billboards/billboard_beagle_pets.png
  assets/billboards/billboard_adopt_beagle.png
  assets/billboards/billboard_beagle_power.png
  assets/billboards/billboard_loyal_friendly.png
  assets/billboards/billboard_frog_tavern.png
  assets/billboards/billboard_ale_croak.png
  assets/billboards/billboard_cellar_jumpers.png
  assets/billboards/billboard_croak_tails.png
  assets/billboards/billboard_red_box.png
  assets/billboards/billboard_fine_tobacco.png
  assets/billboards/billboard_smooth_taste.png
  assets/billboards/billboard_smoke_up.png

── Outputs ────────────────────────────────────────────────────────────────

  assets/billboard_sheet.png   Horizontal atlas — 19 billboards in a single PNG.
  (stdout)                     TypeScript constant block ready to paste into sprites.ts.
"""

from PIL import Image

# ── Config ─────────────────────────────────────────────────────────────────────

# Transparent padding (pixels) added around each sprite within the atlas.
PAD = 4

# Billboards in left-to-right atlas order.
# Each entry: (TypeScript identifier suffix, source path)
ORDER = [
    ("BEAGLE_PETS",      "assets/billboards/billboard_beagle_pets.png"),
    ("ADOPT_BEAGLE",     "assets/billboards/billboard_adopt_beagle.png"),
    ("BEAGLE_POWER",     "assets/billboards/billboard_beagle_power.png"),
    ("LOYAL_FRIENDLY",   "assets/billboards/billboard_loyal_friendly.png"),
    ("FROG_TAVERN",      "assets/billboards/billboard_frog_tavern.png"),
    ("ALE_CROAK",        "assets/billboards/billboard_ale_croak.png"),
    ("CELLAR_JUMPERS",   "assets/billboards/billboard_cellar_jumpers.png"),
    ("CROAK_TAILS",      "assets/billboards/billboard_croak_tails.png"),
    ("RED_BOX",          "assets/billboards/billboard_red_box.png"),
    ("FINE_TOBACCO",     "assets/billboards/billboard_fine_tobacco.png"),
    ("SMOOTH_TASTE",     "assets/billboards/billboard_smooth_taste.png"),
    ("SMOKE_UP",         "assets/billboards/billboard_smoke_up.png"),
    ("HAPPY_SMOKING",    "assets/billboards/billboard_cookie_monster_happy_smoking.png"),
    ("PREMIUM_CIGS",     "assets/billboards/billboard_cookie_monster_premium_cigs.png"),
    ("SMOKIN_NOW",       "assets/billboards/billboard_cookie_monster_smokin_now.png"),
    ("CIG_RESERVES",     "assets/billboards/billboard_cookie_monster_cig_reserves.png"),
    ("BARNEY_OUTRUN_PALETTE",  "assets/billboards/billboard_barney_outrun_palette.png"),
    ("BARNEY_METAL_TILLETIRE", "assets/billboards/billboard_barney_metal_tilletire.png"),
    ("WRESTLING",              "assets/billboards/billboard_wrestling.png"),
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

sheet.save("assets/billboard_sheet.png")
print(f"Saved assets/billboard_sheet.png  {sheet_w}×{sheet_h}")
print()

# ── Print TypeScript constants ─────────────────────────────────────────────────

print("// ── Paste into sprites.ts ────────────────────────────────────────────────────")
print()
print("export type BillboardId =")
names = [name for name, _ in images]
for i, name in enumerate(names):
    sep = " |" if i < len(names) - 1 else " ;"
    print(f"  'BILLBOARD_{name}'{sep}")
print()
print("export const BILLBOARD_RECTS: Record<BillboardId, SpriteRect> =")
print("{")
for name, (rx, ry, rw, rh) in rects.items():
    print(f"  BILLBOARD_{name}: {{ x: {rx:4d}, y: {ry:3d}, w: {rw:3d}, h: {rh:3d} }},")
print("};")
print()
print("// Verify:")
for name, (rx, ry, rw, rh) in rects.items():
    print(f"//  BILLBOARD_{name:<16s} sheet rect ({rx},{ry}) {rw}×{rh}")
