# sprites/source/ — Original Source Art

Raw input files for the sprite extraction pipeline.  These are not loaded by
the game — they exist only as inputs to the Python scripts in `sprites/scripts/`.

---

## Files

| File | Used by |
|------|---------|
| `right.png` / `left.png` | `build_sprite_sheet.py` — player car animation frames |
| `palm_tree_source.png` | `extract_palms.py` |
| `cactus.png` | `build_cactus_sheet.py` |
| `shrubz.png` | `extract_shrubs.py` |
| `signs.png` | `extract_signs.py` |
| `billboard sprites.png` | `extract_billboards.py` |
| `big.png` | `extract_big_billboard.py` |
| `barney.png` | `extract_barney_billboards.py` |
| `cookie.png` | `extract_cookie_billboards.py` |
| `houses.png` / `houses2.png` | `extract_houses.py` |
| `image.jpg` | `extract_new_cars.py` — GottaGo, Yoshi, Banana, Mega traffic cars |
| `yellow.png` | `extract_yellow_car.py` |
| `hero.jpg` | Copied directly to `dist/hero.jpg` (title screen, desktop) |
| `mobile_hero.png` | Copied directly to `dist/mobile_hero.png` (title screen, mobile) |

## Workflow

1. Drop updated source art here.
2. Run the relevant `extract_*.py` (or `build_new.py` for all of them).
3. Run `build.py` to repack the atlases and validate against `dist_bak/`.

See `sprites/README.md` for the full pipeline.
