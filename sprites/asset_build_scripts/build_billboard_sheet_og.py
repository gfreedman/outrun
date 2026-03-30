#!/usr/bin/env python3
"""
build_billboard_sheet_og.py

Stitches the og_boards billboard PNGs into a single horizontal sprite atlas
and prints the TypeScript rect constants for sprites.ts.

Run from the repo root (the directory that contains the ``assets/`` folder):

    python sprites/asset_build_scripts/build_billboard_sheet_og.py

Follows the exact same pattern as build_palm_sheet.py.

── Input ──────────────────────────────────────────────────────────────────

  assets/billboards/og_boards/billboard_*.png   (12 billboard PNGs, one per entry
                                                 in the ORDER list below)

── Outputs ────────────────────────────────────────────────────────────────

  assets/billboard_sheet.png   Horizontal atlas — all billboards packed into a
                               single PNG row, separated by PAD-pixel gutters.
  (stdout)                     TypeScript constant block ready to paste into
                               sprites.ts (SpriteId union lines + BILLBOARD_RECTS
                               object + verification comments).

Note on dimension strings in print() calls below: the save confirmation uses
the ASCII letter "x" (e.g. "512x128") while verification comment lines use the
Unicode multiplication sign "×" style inherited from build_palm_sheet.py.
Both are intentional string literals — do not normalise them.
"""

from PIL import Image

# ── Config ─────────────────────────────────────────────────────────────────────

PAD = 4   # pixel border added on all four sides of every sprite inside the atlas;
          # prevents texture bleeding when the GPU samples adjacent sprites at
          # sub-pixel boundaries during canvas drawImage() scaling.

# Ordered list of (SpriteId-suffix, source-file) pairs.  Atlas columns appear
# left-to-right in this exact order; the TypeScript BILLBOARD_RECTS object
# preserves the same order so index-based iteration in sprites.ts is stable.
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

# Convert every source image to RGBA so that paste() receives a consistent
# alpha channel regardless of the original PNG colour mode (RGB, P, etc.).
images = [(name, Image.open(path).convert("RGBA")) for name, path in ORDER]

# ── Compute atlas dimensions ───────────────────────────────────────────────────

# Height = tallest sprite + top and bottom PAD (all sprites are centred vertically).
# Width  = sum of (sprite width + left and right PAD) across all sprites.
sheet_h = max(img.height for _, img in images) + 2 * PAD
sheet_w = sum(img.width  + 2 * PAD for _, img in images)

# ── Compose atlas ──────────────────────────────────────────────────────────────

# Blank transparent canvas that will hold all sprites side by side.
sheet = Image.new("RGBA", (sheet_w, sheet_h), (0, 0, 0, 0))

rects = {}   # maps SpriteId-suffix → (x, y, w, h) rect inside the atlas
x = 0        # running left edge of the current sprite's padded cell
for name, img in images:
    iy = (sheet_h - img.height) // 2   # centre vertically within the atlas row
    # Paste using the image itself as a mask so semi-transparent pixels are
    # composited correctly rather than overwriting the transparent background.
    sheet.paste(img, (x + PAD, iy), img)
    # Record the rect at the sprite's actual pixel position (after PAD offset)
    # so the TypeScript constants reference content pixels, not gutter pixels.
    rects[name] = (x + PAD, iy, img.width, img.height)
    x += img.width + 2 * PAD   # advance cursor by sprite width + both side gutters

sheet.save("assets/billboard_sheet.png")
print(f"Saved assets/billboard_sheet.png  {sheet_w}x{sheet_h}")
print()

# ── Print TypeScript constants ─────────────────────────────────────────────────

# Emit a ready-to-paste TypeScript block: SpriteId union additions first,
# then the BILLBOARD_RECTS export, then human-readable verification lines.
print("// ── Paste into sprites.ts ────────────────────────────────────────────────────")
print()
# Union member lines — one per sprite; paste into the SpriteId type definition.
print("// Add to SpriteId union:")
for name, _ in images:
    print(f"  | 'BILLBOARD_{name}'")
print()
# Rect map — key is the full SpriteId string; values are pixel coords in the atlas.
print("export const BILLBOARD_RECTS: Partial<Record<SpriteId, SpriteRect>> =")
print("{")
for name, (rx, ry, rw, rh) in rects.items():
    pad_name = f"BILLBOARD_{name}:"
    # Left-pad the key to 26 chars so all value objects align in a column.
    print(f"  {pad_name:<26s} {{ x: {rx:4d}, y: {ry:3d}, w: {rw:3d}, h: {rh:3d} }},")
print("};")
print()
# Verification block — commented out, used to visually cross-check the atlas
# dimensions against each sprite's expected pixel footprint.
print("// Verify:")
for name, (rx, ry, rw, rh) in rects.items():
    print(f"//  BILLBOARD_{name:<18s} sheet rect ({rx},{ry}) {rw}x{rh}")
