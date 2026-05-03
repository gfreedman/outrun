#!/usr/bin/env python3
"""
build.py

Main build script for the sprite pipeline.

Run this after editing any sprite sheet in Aseprite (or any pixel editor):

  Step 1 — Reverse-extract: slice each dist/ atlas back into individual
            parts/ files.  This keeps parts/ in sync with whatever the game
            actually loads, so subsequent builds reproduce the same output.

  Step 2 — Rebuild: repack all parts/ files into dist/ atlases via
            build_sheets.build_all().  build_cactus_sheet.py is invoked
            separately because it reads source/ directly rather than parts/.

  Step 3 — Validate: compare every rebuilt atlas pixel-for-pixel against the
            dist_bak/ reference copies.  Exits non-zero on any mismatch so
            CI and shell callers can detect unintended changes.

Run from the sprites/ directory:
    python3 scripts/build.py
"""

import os, sys, subprocess
import numpy as np
from PIL import Image

os.chdir(os.path.join(os.path.dirname(__file__), ".."))

# Python does not automatically search sibling directories for modules.
# Inserting the scripts/ directory lets us import build_sheets by name.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_sheets

# ── Reverse-extraction table ───────────────────────────────────────────────────
#
# Defines exactly which pixels in each dist/ atlas correspond to which parts/
# file.  Coordinates were measured from the atlas and must stay in sync with
# the ORDER lists in build_sheets.py.  If you resize or reorder sprites in an
# atlas, update the matching entry here.
#
# Format: (atlas_path, [(sprite_name, x, y, w, h, out_path), ...])

EXTRACTIONS = [

  # ── Palms ──────────────────────────────────────────────────────────────────
  ("dist/palm_sheet.png", [
    ("PALM_T1_STRAIGHT",   4,   4, 133, 216, "parts/palms/palm_t1_straight.png"),
    ("PALM_T2_BENT_LEFT",145,   9, 153, 205, "parts/palms/palm_t2_bent_left.png"),
    ("PALM_T2_BENT_RIGHT",306,  9, 153, 205, "parts/palms/palm_t2_bent_right.png"),
    ("PALM_T3_YOUNG",    467,  32, 103, 160, "parts/palms/palm_t3_young.png"),
    ("PALM_T4_FRUITING", 578,   6, 133, 212, "parts/palms/palm_t4_fruiting.png"),
    ("PALM_T6_LUXURIANT",719,   9, 152, 205, "parts/palms/palm_t6_luxuriant.png"),
    ("PALM_T7_SLENDER",  879,   4, 114, 215, "parts/palms/palm_t7_slender.png"),
    ("PALM_T8_MEDIUM",  1001,  34, 107, 156, "parts/palms/palm_t8_medium.png"),
    ("PALM_T10_LARGE",  1116,  26, 126, 171, "parts/palms/palm_t10_large.png"),
  ]),

  # ── OG Billboards ──────────────────────────────────────────────────────────
  ("dist/billboard_sheet.png", [
    ("BILLBOARD_BEAGLE_PETS",    4, 217, 284, 200, "parts/billboards/og_boards/billboard_beagle_pets.png"),
    ("BILLBOARD_ADOPT_BEAGLE", 296, 217, 283, 200, "parts/billboards/og_boards/billboard_adopt_beagle.png"),
    ("BILLBOARD_BEAGLE_POWER", 587, 217, 246, 200, "parts/billboards/og_boards/billboard_beagle_power.png"),
    ("BILLBOARD_LOYAL_FRIENDLY",841,217, 239, 200, "parts/billboards/og_boards/billboard_loyal_friendly.png"),
    ("BILLBOARD_FROG_TAVERN", 1088, 207, 276, 219, "parts/billboards/og_boards/billboard_frog_tavern.png"),
    ("BILLBOARD_ALE_CROAK",   1372, 209, 267, 215, "parts/billboards/og_boards/billboard_ale_croak.png"),
    ("BILLBOARD_CELLAR_JUMPERS",1647,209,272, 215, "parts/billboards/og_boards/billboard_cellar_jumpers.png"),
    ("BILLBOARD_CROAK_TAILS", 1927, 209, 264, 215, "parts/billboards/og_boards/billboard_croak_tails.png"),
    ("BILLBOARD_RED_BOX",     2199, 206, 285, 222, "parts/billboards/og_boards/billboard_red_box.png"),
    ("BILLBOARD_FINE_TOBACCO",2492, 206, 274, 222, "parts/billboards/og_boards/billboard_fine_tobacco.png"),
    ("BILLBOARD_SMOOTH_TASTE",2774, 207, 270, 219, "parts/billboards/og_boards/billboard_smooth_taste.png"),
    ("BILLBOARD_WRESTLING",   3052,   4,1089, 626, "parts/billboards/og_boards/billboard_wrestling.png"),
  ]),

  # ── Cookie boards ──────────────────────────────────────────────────────────
  ("dist/cookie_sheet.png", [
    ("COOKIE_HAPPY_SMOKING",  4,  4, 240, 374, "parts/billboards/cookie_boards/billboard_cookie_monster_happy_smoking.png"),
    ("COOKIE_PREMIUM_CIGS", 252,  4, 277, 374, "parts/billboards/cookie_boards/billboard_cookie_monster_premium_cigs.png"),
    ("COOKIE_SMOKIN_NOW",   537,  4, 270, 374, "parts/billboards/cookie_boards/billboard_cookie_monster_smokin_now.png"),
    ("COOKIE_CIG_RESERVES", 815,  4, 250, 374, "parts/billboards/cookie_boards/billboard_cookie_monster_cig_reserves.png"),
  ]),

  # ── Barney boards ──────────────────────────────────────────────────────────
  ("dist/barney_sheet.png", [
    ("BARNEY_METAL_TILLETIRE",  4, 41, 261, 232, "parts/billboards/barney_boards/billboard_barney_metal_tilletire.png"),
    ("BARNEY_OUTRUN_PALETTE", 273,  4, 262, 306, "parts/billboards/barney_boards/billboard_barney_outrun_palette.png"),
  ]),

  # ── Big boards ─────────────────────────────────────────────────────────────
  ("dist/big_sheet.png", [
    ("BIG_WRESTLING", 4, 4, 1089, 626, "parts/billboards/big_boards/billboard_wrestling.png"),
  ]),

  # Cactus is intentionally absent from EXTRACTIONS.
  # build_cactus_sheet.py (step 2) re-derives every cactus sprite directly
  # from source/cactus.png using its own flood-fill extraction pass, which
  # overwrites parts/cactuses/ anyway.  Reverse-extracting here would just
  # be wasted work.  To change a cactus, edit source/cactus.png and re-run
  # build_cactus_sheet.py.

  # ── Shrubs ─────────────────────────────────────────────────────────────────
  ("dist/shrub_sheet.png", [
    ("SHRUB_S1",  4, 20, 116, 38, "parts/shrubs/shrub_s1.png"),
    ("SHRUB_S2", 128,  4, 144, 71, "parts/shrubs/shrub_s2.png"),
    ("SHRUB_S6", 280, 23, 160, 32, "parts/shrubs/shrub_s6.png"),
  ]),

  # ── Signs ──────────────────────────────────────────────────────────────────
  ("dist/sign_sheet.png", [
    ("SIGN_TURN_RIGHT", 4,  4, 73, 131, "parts/signs/sign_turn_right.png"),
    ("SIGN_TURN_LEFT", 85,  4, 69, 131, "parts/signs/sign_turn_left.png"),
  ]),

  # ── Houses ─────────────────────────────────────────────────────────────────
  ("dist/house_sheet.png", [
    ("HOUSE_ADOBE_1",     4,  81, 195, 180, "parts/houses/house_a01.png"),
    ("HOUSE_ADOBE_2",   207,  88, 178, 167, "parts/houses/house_a02.png"),
    ("HOUSE_ADOBE_3",   393,  90, 189, 163, "parts/houses/house_a03.png"),
    ("HOUSE_ADOBE_4",   590,  93, 215, 156, "parts/houses/house_a04.png"),
    ("HOUSE_ADOBE_5",   813,  82, 207, 178, "parts/houses/house_a05.png"),
    ("HOUSE_ADOBE_6",  1028,  74, 194, 195, "parts/houses/house_a06.png"),
    ("HOUSE_ADOBE_7",  1230,  86, 184, 170, "parts/houses/house_a07.png"),
    ("HOUSE_ADOBE_8",  1422,  81, 189, 180, "parts/houses/house_a08.png"),
    ("HOUSE_ADOBE_9",  1619,  86, 189, 170, "parts/houses/house_a09.png"),
    ("HOUSE_ADOBE_10", 1816,  80, 197, 182, "parts/houses/house_a10.png"),
    ("HOUSE_DOME",     2021,  76, 414, 190, "parts/houses/house_d01.png"),
    ("HOUSE_TENT_L",   2443,  86, 205, 170, "parts/houses/house_d02.png"),
    ("HOUSE_HUT",      2656,  99, 208, 145, "parts/houses/house_d03.png"),
    ("HOUSE_TENT_S",   2872,  92, 191, 159, "parts/houses/house_d04.png"),
    ("HOUSE_BUNKER",   3071,  90, 193, 163, "parts/houses/house_d05.png"),
    ("HOUSE_SHOP",     3272,   9, 344, 325, "parts/buildings/house_b01.png"),
    ("HOUSE_BAKERY",   3624,   9, 315, 325, "parts/buildings/house_b02.png"),
    ("HOUSE_SURF",     3947,   9, 361, 325, "parts/buildings/house_b03.png"),
    ("HOUSE_CAFE",     4316,   9, 277, 325, "parts/buildings/house_b04.png"),
    ("HOUSE_ARCADE",   4601,   9, 345, 325, "parts/buildings/house_b05.png"),
    ("HOUSE_PURPLE",   4954,   4, 344, 335, "parts/buildings/house_b06.png"),
    ("HOUSE_TEAL",     5306,  21, 315, 300, "parts/buildings/house_b07.png"),
    ("HOUSE_YELLOW",   5629,   4, 361, 335, "parts/buildings/house_b08.png"),
    ("HOUSE_GREEN",    5998,  22, 277, 299, "parts/buildings/house_b09.png"),
    ("HOUSE_PINK",     6283,   4, 320, 335, "parts/buildings/house_b10.png"),
  ]),
]

# ── Step 1: Reverse-extract ────────────────────────────────────────────────────

print("── Step 1: Extracting sprites from dist/ atlases into parts/ ─────────")
for atlas_path, sprites in EXTRACTIONS:
    sheet = Image.open(atlas_path).convert("RGBA")
    for name, x, y, w, h, out_path in sprites:
        region = sheet.crop((x, y, x + w, y + h))
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        region.save(out_path)
        print(f"  {name:35s} → {out_path}")

print()

# ── Step 2: Rebuild all atlases from parts/ ───────────────────────────────────

print("── Step 2: Rebuilding atlases from parts/ ────────────────────────────")
build_sheets.build_all()

# Cactus is handled separately: build_cactus_sheet.py reads source/cactus.png
# directly and performs its own extraction, so it does not use parts/.
result = subprocess.run(
    ["python3", "scripts/build_cactus_sheet.py"],
    capture_output=True, text=True,
)
if result.returncode != 0:
    print(f"  FAIL build_cactus_sheet.py\n{result.stderr}")
    sys.exit(1)
first_line = (result.stdout.strip().splitlines()[0]
              if result.stdout.strip() else "(no output)")
print(f"  OK   build_cactus_sheet.py  —  {first_line}")

print()

# ── Step 3: Validate against dist_bak/ ────────────────────────────────────────

print("── Step 3: Validating rebuilt atlases against dist_bak/ ──────────────")

ATLASES_TO_VALIDATE = [
    "dist/palm_sheet.png",
    "dist/billboard_sheet.png",
    "dist/cookie_sheet.png",
    "dist/barney_sheet.png",
    "dist/big_sheet.png",
    "dist/cactus_sheet.png",
    "dist/shrub_sheet.png",
    "dist/sign_sheet.png",
    "dist/house_sheet.png",
]


def _pixels_match(path_a, path_b):
    """Compare two PNG files pixel-for-pixel.

    Uses numpy array comparison rather than file hashing because PIL re-encodes
    PNGs with non-deterministic compression, so identical pixels produce
    different file bytes.

    Args:
        path_a: Path to the first PNG.
        path_b: Path to the second PNG.

    Returns:
        Tuple of (match: bool, detail: str) where detail describes the
        dimension mismatch or differing pixel count.
    """
    a = np.array(Image.open(path_a).convert("RGBA"))
    b = np.array(Image.open(path_b).convert("RGBA"))
    if a.shape != b.shape:
        return False, f"size {a.shape} vs {b.shape}"
    # np.any(..., axis=2) collapses the four RGBA channels per pixel into a
    # single True/False: True means at least one channel differs.  .sum()
    # then counts how many pixels have any difference across the whole image.
    diff = int(np.any(a != b, axis=2).sum())
    return diff == 0, f"{diff} pixels differ"


failures = []
for atlas in ATLASES_TO_VALIDATE:
    bak = atlas.replace("dist/", "dist_bak/")
    if not os.path.exists(bak):
        print(f"  SKIP   {atlas}  (no dist_bak/ counterpart)")
        continue
    ok, detail = _pixels_match(atlas, bak)
    if ok:
        print(f"  MATCH  {atlas}")
    else:
        print(f"  DIFFER {atlas}  ← {detail}")
        failures.append(atlas)

print()
if failures:
    print(f"FAIL — {len(failures)} atlas(es) do not match dist_bak/:")
    for f in failures:
        print(f"  {f}")
    sys.exit(1)
else:
    print("ALL ATLASES MATCH dist_bak/ — build complete.")
