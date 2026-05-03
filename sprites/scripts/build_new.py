#!/usr/bin/env python3
"""
build_new.py

Runs the extraction pipeline when new source art has been added to source/.

Each extract_*.py script reads a raw source file (PNG, JPEG, or layered
sprite sheet) and writes cleaned individual sprites into the appropriate
parts/ subdirectory.  After extraction, run build.py to repack those parts/
files into dist/ atlases and validate them against dist_bak/.

Typical workflow when adding new art:
    1. Drop the new source file into source/.
    2. Add the extraction logic to the relevant extract_*.py (or write a new
       one following the same pattern).
    3. python3 scripts/build_new.py
    4. python3 scripts/build.py

Run from the sprites/ directory:
    python3 scripts/build_new.py
"""

import os
import subprocess
import sys

# All extract scripts resolve asset paths relative to sprites/.
os.chdir(os.path.join(os.path.dirname(__file__), ".."))

# Run order matters only where one script's output feeds another's input.
# Currently all extract scripts are independent, so order is arbitrary.
SCRIPTS = [
    os.path.join("scripts", s) for s in [
        "extract_palms.py",             # source/palm_tree_source.png  → parts/palms/
        "extract_billboards.py",        # source/billboard sprites.png → parts/billboards/og_boards/
        "extract_big_billboard.py",     # source/big.png               → parts/billboards/big_boards/
        "extract_barney_billboards.py", # source/barney.png            → parts/billboards/barney_boards/
        "extract_cookie_billboards.py", # source/cookie.png            → parts/billboards/cookie_boards/
        "extract_shrubs.py",            # source/shrubz.png            → parts/shrubs/
        "extract_signs.py",             # source/signs.png             → parts/signs/
        "extract_houses.py",            # source/houses*.png           → parts/houses/ + parts/buildings/
        "extract_new_cars.py",          # source/image.jpg             → dist/  (traffic cars)
        "extract_yellow_car.py",        # source/yellow.png            → dist/  (yellow traffic car)
    ]
]


def run(script):
    """Run one extraction script as a subprocess; abort the pipeline on failure.

    Args:
        script: Path to the script, relative to sprites/.
    """
    print(f"\n{'=' * 60}\n  {script}\n{'=' * 60}")
    result = subprocess.run([sys.executable, script], check=False)
    if result.returncode != 0:
        print(f"\n  FAIL  {script}  (exit code {result.returncode})")
        sys.exit(result.returncode)


if __name__ == "__main__":
    for script in SCRIPTS:
        run(script)
    print("\nAll extraction scripts completed.  Run build.py to repack and validate.")
