#!/usr/bin/env python3
"""
build_all.py

Thin runner that documents and executes the full sprite-extraction pipeline
in the correct dependency order.  Can be run from anywhere:

    python3 sprites/asset_build_scripts/build_all.py

── Pipeline order ────────────────────────────────────────────────────────────

  1. build_billboard_sheet.py   — roadside billboard sprite sheet
  2. extract_barney_billboards.py
     extract_big_billboard.py
     extract_billboards.py
     extract_cookie_billboards.py  — individual billboard frames
  3. extract_barney_billboards.py — Barney traffic car (sourced separately)
  4. extract_new_cars.py          — GOTTA GO, YOSHI, BANANA, MEGA traffic cars

Each script is standalone and idempotent.  You can re-run any one individually
without needing to re-run the full pipeline.  This file exists solely to
record the order and make a full rebuild one command.
"""

import os
import subprocess
import sys

# All build scripts reference asset paths relative to the sprites/ directory
# (e.g. "parts/palms/…", "source/…").  Changing to that directory
# here ensures every sibling script resolves those paths correctly regardless
# of where build_all.py itself is invoked from (repo root, IDE, CI, etc.).
os.chdir(os.path.join(os.path.dirname(__file__), ".."))

SCRIPTS = [
    os.path.join("scripts", s) for s in [
        "build_billboard_sheet.py",
        "extract_billboards.py",
        "extract_big_billboard.py",
        "extract_barney_billboards.py",
        "extract_cookie_billboards.py",
        "extract_new_cars.py",
        "extract_yellow_car.py",
    ]]

def run(script: str) -> None:
    """Run a single build script as a subprocess and abort the pipeline on failure.

    Args:
        script: Path to the Python script to execute, relative to the cwd set
                by the os.chdir() call above (i.e. the sprites/ directory).

    Returns:
        None on success.  On failure, prints an error message and calls
        sys.exit(result.returncode), terminating the entire pipeline with the
        failing script's exit code so CI / shell callers can detect the error.
    """
    print(f"\n{'=' * 60}")
    print(f"  {script}")
    print(f"{'=' * 60}")
    result = subprocess.run([sys.executable, script], check=False)
    if result.returncode != 0:
        print(f"\n  ✗  {script} exited with code {result.returncode}")
        sys.exit(result.returncode)

if __name__ == "__main__":
    for script in SCRIPTS:
        run(script)
    print("\nAll sprite scripts completed successfully.")
