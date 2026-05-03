#!/usr/bin/env python3
"""
build_big_sheet.py

Stitches the big_boards PNGs into a single horizontal sprite atlas
and prints the TypeScript rect constants for sprites.ts.

"Big boards" are oversized billboard sprites that occupy more screen width
than the standard og_boards — they use a separate atlas and SpriteId prefix
so the renderer can apply a different world-space scale factor.

Distinct class from og_boards, cookie_boards, barney_boards — own sheet
(big_sheet.png), own SpriteId prefix (BIG_*).

Run from the repo root (the directory that contains the ``assets/`` folder):

    python sprites/asset_build_scripts/build_big_sheet.py

── Input ──────────────────────────────────────────────────────────────────

  parts/billboards/big_boards/billboard_*.png
  (1 or more billboard PNGs, one per entry in the ORDER list below)

── Outputs ────────────────────────────────────────────────────────────────

  dist/big_sheet.png   Horizontal atlas — all big boards packed into a
                         single PNG row, separated by PAD-pixel gutters.
  (stdout)               TypeScript constant block ready to paste into
                         sprites.ts (SpriteId union lines + BIG_RECTS
                         object + verification comments).
"""

from PIL import Image

# ── Config ─────────────────────────────────────────────────────────────────────

PAD = 4   # pixel border added on all four sides of every sprite inside the atlas;
          # prevents texture bleeding when the GPU samples adjacent sprites at
          # sub-pixel boundaries during canvas drawImage() scaling.

# Ordered list of (SpriteId-suffix, source-file) pairs.  Atlas columns appear
# left-to-right in this exact order; TypeScript BIG_RECTS preserves the same
# order so index-based iteration in sprites.ts is stable.
ORDER = [
    ("WRESTLING", "parts/billboards/big_boards/billboard_wrestling.png"),
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

sheet.save("dist/big_sheet.png")
print(f"Saved dist/big_sheet.png  {sheet_w}x{sheet_h}")
print()

# ── Print TypeScript constants ─────────────────────────────────────────────────

# Emit a ready-to-paste TypeScript block: SpriteId union additions first,
# then the BIG_RECTS export, then human-readable verification lines.
print("// ── Paste into sprites.ts ────────────────────────────────────────────────────")
print()
# Union member lines — one per sprite; paste into the SpriteId type definition.
print("// Add to SpriteId union:")
for name, _ in images:
    print(f"  | 'BIG_{name}'")
print()
# Rect map — key is the full SpriteId string; values are pixel coords in the atlas.
print("export const BIG_RECTS: Partial<Record<SpriteId, SpriteRect>> =")
print("{")
for name, (rx, ry, rw, rh) in rects.items():
    pad_name = f"BIG_{name}:"
    # Left-pad the key to 24 chars so all value objects align in a column.
    print(f"  {pad_name:<24s} {{ x: {rx:4d}, y: {ry:3d}, w: {rw:3d}, h: {rh:3d} }},")
print("};")
print()
# Verification block — commented out; used to visually cross-check atlas
# dimensions against each sprite's expected pixel footprint.
print("// Verify:")
for name, (rx, ry, rw, rh) in rects.items():
    print(f"//  BIG_{name:<18s} sheet rect ({rx},{ry}) {rw}x{rh}")
