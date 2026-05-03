#!/usr/bin/env python3
"""
build_shrub_sheet.py

Stitches the shrub PNGs into a single horizontal sprite atlas
and prints the TypeScript rect constants for sprites.ts.

Shrubs are roadside decorations (low ground-cover plants) distinct from the
taller palm trees — they use a separate atlas and SpriteId prefix (SHRUB_*)
so the renderer can apply a different world-space scale factor and placement
density.

Distinct class from all other sprites — own sheet (shrub_sheet.png),
own SpriteId prefix (SHRUB_*).

Run from the repo root (the directory that contains the ``assets/`` folder):

    python sprites/asset_build_scripts/build_shrub_sheet.py

── Input ──────────────────────────────────────────────────────────────────

  parts/shrubs/shrub_s1.png   small shrub variant 1
  parts/shrubs/shrub_s2.png   small shrub variant 2
  parts/shrubs/shrub_s6.png   small shrub variant 6

── Outputs ────────────────────────────────────────────────────────────────

  dist/shrub_sheet.png   Horizontal atlas — all shrub variants packed into
                           a single PNG row, separated by PAD-pixel gutters.
  (stdout)                 TypeScript constant block ready to paste into
                           sprites.ts (SpriteId union lines + SHRUB_RECTS
                           object + verification comments).
"""

from PIL import Image

# ── Config ─────────────────────────────────────────────────────────────────────

PAD = 4   # pixel border added on all four sides of every sprite inside the atlas;
          # prevents texture bleeding when the GPU samples adjacent sprites at
          # sub-pixel boundaries during canvas drawImage() scaling.

# Ordered list of (SpriteId-suffix, source-file) pairs.  Atlas columns appear
# left-to-right in this exact order; TypeScript SHRUB_RECTS preserves the same
# order so index-based iteration in sprites.ts is stable.
# Variant numbers (S1, S2, S6) correspond to the shrub artwork series;
# gaps in the sequence (S3–S5 absent) indicate unused or not-yet-created variants.
ORDER = [
    ("S1", "parts/shrubs/shrub_s1.png"),
    ("S2", "parts/shrubs/shrub_s2.png"),
    ("S6", "parts/shrubs/shrub_s6.png"),
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

sheet.save("dist/shrub_sheet.png")
print(f"Saved dist/shrub_sheet.png  {sheet_w}x{sheet_h}")
print()

# ── Print TypeScript constants ─────────────────────────────────────────────────

# Emit a ready-to-paste TypeScript block: SpriteId union additions first,
# then the SHRUB_RECTS export, then human-readable verification lines.
print("// ── Paste into sprites.ts ────────────────────────────────────────────────────")
print()
# Union member lines — one per sprite; paste into the SpriteId type definition.
print("// Add to SpriteId union:")
for name, _ in images:
    print(f"  | 'SHRUB_{name}'")
print()
# Rect map — key is the full SpriteId string; values are pixel coords in the atlas.
print("export const SHRUB_RECTS: Partial<Record<SpriteId, SpriteRect>> =")
print("{")
for name, (rx, ry, rw, rh) in rects.items():
    pad_name = f"SHRUB_{name}:"
    # Left-pad the key to 12 chars so all value objects align in a column.
    print(f"  {pad_name:<12s} {{ x: {rx:4d}, y: {ry:3d}, w: {rw:3d}, h: {rh:3d} }},")
print("};")
print()
# Verification block — commented out; used to visually cross-check atlas
# dimensions against each sprite's expected pixel footprint.
print("// Verify:")
for name, (rx, ry, rw, rh) in rects.items():
    print(f"//  SHRUB_{name:<8s} sheet rect ({rx},{ry}) {rw}x{rh}")
