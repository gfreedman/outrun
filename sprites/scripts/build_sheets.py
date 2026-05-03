#!/usr/bin/env python3
"""
build_sheets.py

Packs all parts/ sprite groups into their dist/ atlas PNGs.

A sprite atlas (also called a sprite sheet) is a single image that contains
many smaller sprites packed side by side.  The game loads one atlas file per
sprite family (palms, billboards, houses, etc.) instead of dozens of small
files, which is faster and requires fewer browser network requests.

Each atlas is a horizontal strip: sprites are laid out left to right with
PAD-pixel transparent gutters between them.  Every sprite is vertically
centred within the strip so they all share the same bottom baseline — this
lets the renderer anchor sprites to the ground plane using a single y offset
rather than computing a different one for each sprite height.

Also prints TypeScript rect constants to stdout.  These are only needed when
adding new sprites and regenerating the RECTS blocks in src/sprites.ts; for
normal builds the printed output can be ignored.

Run from the sprites/ directory:
    python3 scripts/build_sheets.py

Called programmatically by build.py, which also handles reverse-extraction
and pixel-level validation against dist_bak/.
"""

import os
import sys
from PIL import Image

# PAD=4 prevents texture bleeding when canvas drawImage() samples an atlas at
# sub-pixel boundaries during the renderer's perspective scaling step.
PAD = 4

# ── Sheet definitions ──────────────────────────────────────────────────────────
#
# Each entry: (output_path, ts_prefix, ts_const_name, order)
# order:      List of (name_suffix, parts_path) pairs, left-to-right.

SHEETS = [

    ("dist/palm_sheet.png", "PALM_", "PALM_RECTS", [
        ("T1_STRAIGHT",   "parts/palms/palm_t1_straight.png"),
        ("T2_BENT_LEFT",  "parts/palms/palm_t2_bent_left.png"),
        ("T2_BENT_RIGHT", "parts/palms/palm_t2_bent_right.png"),
        ("T3_YOUNG",      "parts/palms/palm_t3_young.png"),
        ("T4_FRUITING",   "parts/palms/palm_t4_fruiting.png"),
        ("T6_LUXURIANT",  "parts/palms/palm_t6_luxuriant.png"),
        ("T7_SLENDER",    "parts/palms/palm_t7_slender.png"),
        ("T8_MEDIUM",     "parts/palms/palm_t8_medium.png"),
        ("T10_LARGE",     "parts/palms/palm_t10_large.png"),
    ]),

    ("dist/billboard_sheet.png", "BILLBOARD_", "BILLBOARD_RECTS", [
        ("BEAGLE_PETS",    "parts/billboards/og_boards/billboard_beagle_pets.png"),
        ("ADOPT_BEAGLE",   "parts/billboards/og_boards/billboard_adopt_beagle.png"),
        ("BEAGLE_POWER",   "parts/billboards/og_boards/billboard_beagle_power.png"),
        ("LOYAL_FRIENDLY", "parts/billboards/og_boards/billboard_loyal_friendly.png"),
        ("FROG_TAVERN",    "parts/billboards/og_boards/billboard_frog_tavern.png"),
        ("ALE_CROAK",      "parts/billboards/og_boards/billboard_ale_croak.png"),
        ("CELLAR_JUMPERS", "parts/billboards/og_boards/billboard_cellar_jumpers.png"),
        ("CROAK_TAILS",    "parts/billboards/og_boards/billboard_croak_tails.png"),
        ("RED_BOX",        "parts/billboards/og_boards/billboard_red_box.png"),
        ("FINE_TOBACCO",   "parts/billboards/og_boards/billboard_fine_tobacco.png"),
        ("SMOOTH_TASTE",   "parts/billboards/og_boards/billboard_smooth_taste.png"),
        ("WRESTLING",      "parts/billboards/og_boards/billboard_wrestling.png"),
    ]),

    ("dist/cookie_sheet.png", "COOKIE_", "COOKIE_RECTS", [
        ("HAPPY_SMOKING", "parts/billboards/cookie_boards/billboard_cookie_monster_happy_smoking.png"),
        ("PREMIUM_CIGS",  "parts/billboards/cookie_boards/billboard_cookie_monster_premium_cigs.png"),
        ("SMOKIN_NOW",    "parts/billboards/cookie_boards/billboard_cookie_monster_smokin_now.png"),
        ("CIG_RESERVES",  "parts/billboards/cookie_boards/billboard_cookie_monster_cig_reserves.png"),
    ]),

    ("dist/barney_sheet.png", "BARNEY_", "BARNEY_RECTS", [
        ("METAL_TILLETIRE", "parts/billboards/barney_boards/billboard_barney_metal_tilletire.png"),
        ("OUTRUN_PALETTE",  "parts/billboards/barney_boards/billboard_barney_outrun_palette.png"),
    ]),

    ("dist/big_sheet.png", "BIG_", "BIG_RECTS", [
        ("WRESTLING", "parts/billboards/big_boards/billboard_wrestling.png"),
    ]),

    ("dist/shrub_sheet.png", "SHRUB_", "SHRUB_RECTS", [
        ("S1", "parts/shrubs/shrub_s1.png"),
        ("S2", "parts/shrubs/shrub_s2.png"),
        ("S6", "parts/shrubs/shrub_s6.png"),
    ]),

    ("dist/sign_sheet.png", "SIGN_", "SIGN_RECTS", [
        ("TURN_RIGHT", "parts/signs/sign_turn_right.png"),
        ("TURN_LEFT",  "parts/signs/sign_turn_left.png"),
    ]),

]

# Houses are defined separately because each entry carries a worldH value.
# worldH is the sprite's height in world units; the renderer divides it by
# camera distance to compute on-screen pixel height for perspective scaling.
# Typical values: ~2200 for tall shop fronts, ~1400 for low desert shelters.
HOUSE_ORDER = [
    # (name_suffix, parts_path, worldH)
    ("HOUSE_ADOBE_1",  "parts/houses/house_a01.png",    1800),
    ("HOUSE_ADOBE_2",  "parts/houses/house_a02.png",    1800),
    ("HOUSE_ADOBE_3",  "parts/houses/house_a03.png",    2000),
    ("HOUSE_ADOBE_4",  "parts/houses/house_a04.png",    1600),
    ("HOUSE_ADOBE_5",  "parts/houses/house_a05.png",    1700),
    ("HOUSE_ADOBE_6",  "parts/houses/house_a06.png",    2000),
    ("HOUSE_ADOBE_7",  "parts/houses/house_a07.png",    1800),
    ("HOUSE_ADOBE_8",  "parts/houses/house_a08.png",    1700),
    ("HOUSE_ADOBE_9",  "parts/houses/house_a09.png",    1600),
    ("HOUSE_ADOBE_10", "parts/houses/house_a10.png",    1800),
    ("HOUSE_DOME",     "parts/houses/house_d01.png",    1600),
    ("HOUSE_TENT_L",   "parts/houses/house_d02.png",    1400),
    ("HOUSE_HUT",      "parts/houses/house_d03.png",    1300),
    ("HOUSE_TENT_S",   "parts/houses/house_d04.png",    1400),
    ("HOUSE_BUNKER",   "parts/houses/house_d05.png",    1500),
    ("HOUSE_SHOP",     "parts/buildings/house_b01.png", 2200),
    ("HOUSE_BAKERY",   "parts/buildings/house_b02.png", 2500),
    ("HOUSE_SURF",     "parts/buildings/house_b03.png", 2200),
    ("HOUSE_CAFE",     "parts/buildings/house_b04.png", 2600),
    ("HOUSE_ARCADE",   "parts/buildings/house_b05.png", 2200),
    ("HOUSE_PURPLE",   "parts/buildings/house_b06.png", 2000),
    ("HOUSE_TEAL",     "parts/buildings/house_b07.png", 2000),
    ("HOUSE_YELLOW",   "parts/buildings/house_b08.png", 2100),
    ("HOUSE_GREEN",    "parts/buildings/house_b09.png", 2000),
    ("HOUSE_PINK",     "parts/buildings/house_b10.png", 2000),
]

# ── Atlas builder ──────────────────────────────────────────────────────────────

def _pack_atlas(out_path, prefix, const_name, order):
    """Composite a horizontal atlas PNG from a list of named sprites.

    Sprites are loaded from parts/, composited side-by-side with PAD-pixel
    gutters, and saved to out_path.  TypeScript rect constants are printed to
    stdout for use when updating src/sprites.ts.

    Args:
        out_path:   Destination atlas PNG path, relative to sprites/.
        prefix:     TypeScript SpriteId prefix, e.g. "PALM_".
        const_name: TypeScript exported const name, e.g. "PALM_RECTS".
        order:      List of (name_suffix, source_path) pairs, left-to-right.
    """
    images = [(name, Image.open(path).convert("RGBA")) for name, path in order]

    sheet_h = max(img.height for _, img in images) + 2 * PAD
    sheet_w = sum(img.width  + 2 * PAD for _, img in images)
    sheet   = Image.new("RGBA", (sheet_w, sheet_h), (0, 0, 0, 0))

    rects = {}
    x = 0
    for name, img in images:
        # Centre each sprite vertically so that shorter sprites sit higher,
        # giving every sprite the same bottom edge position in the atlas.
        # The renderer uses this common baseline to place sprites on the ground.
        iy = (sheet_h - img.height) // 2
        # PIL's paste() third argument is an alpha mask.  Passing the image
        # itself as the mask uses its own alpha channel, so semi-transparent
        # edge pixels are blended correctly rather than hard-stamped opaque.
        sheet.paste(img, (x + PAD, iy), img)
        rects[name] = (x + PAD, iy, img.width, img.height)
        x += img.width + 2 * PAD

    sheet.save(out_path)
    print(f"Saved {out_path}  {sheet_w}×{sheet_h}")

    # Compute column width so all TypeScript values align at the same column.
    key_w = max(len(f"{prefix}{n}:") for n in rects) + 1
    print(f"\nexport const {const_name}: Partial<Record<SpriteId, SpriteRect>> = {{")
    for name, (rx, ry, rw, rh) in rects.items():
        key = f"{prefix}{name}:"
        print(f"  {key:<{key_w}} {{ x: {rx:4d}, y: {ry:3d}, w: {rw:3d}, h: {rh:3d} }},")
    print("};\n")


def _pack_house_atlas(out_path, order):
    """Composite the house atlas and emit HOUSE_RECTS and HOUSE_WORLD_HEIGHT.

    Identical layout logic to _pack_atlas, but each entry carries a worldH
    value so the renderer can apply per-sprite perspective scaling.  Emits
    two TypeScript const blocks: one for pixel rects, one for world heights.

    Args:
        out_path: Destination atlas PNG path, relative to sprites/.
        order:    List of (name_suffix, source_path, world_h) triples.
    """
    images = [(name, wh, Image.open(path).convert("RGBA"))
              for name, path, wh in order]

    sheet_h = max(img.height for _, _, img in images) + 2 * PAD
    sheet_w = sum(img.width  + 2 * PAD for _, _, img in images)
    sheet   = Image.new("RGBA", (sheet_w, sheet_h), (0, 0, 0, 0))

    rects = {}
    x = 0
    for name, wh, img in images:
        iy = (sheet_h - img.height) // 2   # same vertical-centering logic as _pack_atlas
        sheet.paste(img, (x + PAD, iy), img)   # img used as its own alpha mask
        rects[name] = (x + PAD, iy, img.width, img.height, wh)
        x += img.width + 2 * PAD

    sheet.save(out_path)
    print(f"Saved {out_path}  {sheet_w}×{sheet_h}")

    key_w = max(len(f"{n}:") for n in rects) + 1
    print(f"\nexport const HOUSE_RECTS: Partial<Record<SpriteId, SpriteRect>> = {{")
    for name, (rx, ry, rw, rh, _) in rects.items():
        key = f"{name}:"
        print(f"  {key:<{key_w}} {{ x: {rx:5d}, y: {ry:3d}, w: {rw:3d}, h: {rh:3d} }},")
    print("};")

    print(f"\nexport const HOUSE_WORLD_HEIGHT: Partial<Record<SpriteId, number>> = {{")
    for name, (_, _, _, _, wh) in rects.items():
        key = f"{name}:"
        print(f"  {key:<{key_w}} {wh},")
    print("};\n")


# ── Public entry point ─────────────────────────────────────────────────────────

def build_all():
    """Build all 8 standard sprite atlases from parts/.

    build_cactus_sheet.py is excluded: it reads directly from source/ and
    performs its own extraction, so it does not fit the parts/-driven pattern.
    build.py calls it separately via subprocess.
    """
    for spec in SHEETS:
        _pack_atlas(*spec)
    _pack_house_atlas("dist/house_sheet.png", HOUSE_ORDER)


if __name__ == "__main__":
    os.chdir(os.path.join(os.path.dirname(__file__), ".."))
    build_all()
