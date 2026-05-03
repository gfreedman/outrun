#!/usr/bin/env python3
"""
build_sign_sheet.py

Stitches the roadside turn-sign PNGs into a single horizontal sprite atlas
and prints the TypeScript rect constants for sprites.ts.

Turn signs are the chevron arrow signs placed at the entrance to curves —
right-arrow for right-hand bends, left-arrow for left-hand bends.  They use
a dedicated atlas (sign_sheet.png) and SpriteId prefix (SIGN_*) so the
renderer can look them up independently from billboard sprites.

Run from the repo root (the directory that contains the ``assets/`` folder):

    python sprites/asset_build_scripts/build_sign_sheet.py

── Input ──────────────────────────────────────────────────────────────────

  parts/signs/sign_turn_right.png   chevron arrow pointing right
  parts/signs/sign_turn_left.png    chevron arrow pointing left

── Outputs ────────────────────────────────────────────────────────────────

  dist/sign_sheet.png   Horizontal atlas — both signs packed into a single
                          PNG row, separated by PAD-pixel gutters.
  (stdout)                TypeScript constant block ready to paste into
                          sprites.ts (SpriteId union lines + SIGN_RECTS
                          object + verification comments).
"""

from PIL import Image

# ── Config ─────────────────────────────────────────────────────────────────────

PAD = 4   # pixel border added on all four sides of every sprite inside the atlas;
          # prevents texture bleeding when the GPU samples adjacent sprites at
          # sub-pixel boundaries during canvas drawImage() scaling.

# Ordered list of (SpriteId-suffix, source-file) pairs.  Each tuple names the
# sprite (used as the SIGN_* SpriteId suffix) and points to its source PNG.
# Atlas columns appear left-to-right in this exact order; TypeScript SIGN_RECTS
# preserves the same order so index-based iteration in sprites.ts is stable.
ORDER = [
    ("TURN_RIGHT", "parts/signs/sign_turn_right.png"),   # right-curve chevron
    ("TURN_LEFT",  "parts/signs/sign_turn_left.png"),    # left-curve chevron
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
    iy = (sheet_h - img.height) // 2   # centre sprite vertically within the atlas row
    # Paste using the image itself as a mask so semi-transparent pixels are
    # composited correctly rather than overwriting the transparent background.
    sheet.paste(img, (x + PAD, iy), img)
    # Record content-pixel rect (after PAD offset) for the TypeScript constants.
    rects[name] = (x + PAD, iy, img.width, img.height)
    x += img.width + 2 * PAD   # advance cursor by sprite width + both side gutters

# ── Save atlas ─────────────────────────────────────────────────────────────────

sheet.save("dist/sign_sheet.png")
# Confirmation message — dimensions help verify the atlas wasn't truncated.
print(f"Saved dist/sign_sheet.png  {sheet_w}x{sheet_h}")
print()

# ── Print TypeScript constants ─────────────────────────────────────────────────

# Emit a ready-to-paste TypeScript block: SpriteId union additions first,
# then the SIGN_RECTS export, then human-readable verification lines.
print("// ── Paste into sprites.ts ────────────────────────────────────────────────────")
print()
# Union member lines — one per sprite; paste into the SpriteId type definition.
print("// Add to SpriteId union:")
for name, _ in images:
    print(f"  | 'SIGN_{name}'")
print()
# Rect map — key is the full SpriteId string; values are pixel coords in the atlas.
print("export const SIGN_RECTS: Partial<Record<SpriteId, SpriteRect>> =")
print("{")
for name, (rx, ry, rw, rh) in rects.items():
    pad_name = f"SIGN_{name}:"
    # Left-pad the key to 18 chars so all value objects align in a column.
    print(f"  {pad_name:<18s} {{ x: {rx:4d}, y: {ry:3d}, w: {rw:3d}, h: {rh:3d} }},")
print("};")
print()
# Verification block — commented out; used to visually cross-check atlas
# dimensions against each sprite's expected pixel footprint.
print("// Verify:")
for name, (rx, ry, rw, rh) in rects.items():
    print(f"//  SIGN_{name:<12s} sheet rect ({rx},{ry}) {rw}x{rh}")
