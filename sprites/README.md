# Sprite Pipeline

All game sprites live in `sprites/assets/` as pre-built PNG sprite sheets.
The Python scripts here are **offline build tools** — you only need them when
source art changes. Running the game never touches them.

## Quick start

```bash
cd sprites/
pip install pillow numpy scipy
python3 build_all.py
```

`build_all.py` runs the full pipeline in dependency order and is idempotent
— safe to re-run at any time.

## Directory layout

```
sprites/
  assets/              # committed PNG sheets consumed by src/sprites.ts
  source_for_sprites/  # original reference art (Photoshop exports, AI images)
  build_all.py         # full pipeline runner — start here
  build_*.py           # per-family sheet assemblers (palm, cactus, billboard…)
  extract_*.py         # frame extractors for source sheets with complex layouts
```

## What each script does

| Script | Purpose |
|--------|---------|
| `build_all.py` | Runs everything in order |
| `build_palm_sheet.py` | Palm tree sprite strip |
| `build_cactus_sheet.py` | Cactus sprite strip |
| `build_shrub_sheet.py` | Shrub/bush sprite strip |
| `build_sign_sheet.py` | Roadside sign strip |
| `build_house_sheet.py` | House sprite strip |
| `build_billboard_sheet.py` | Billboard sprite sheet (source for extract_billboards) |
| `extract_billboards.py` | Individual billboard frames → `assets/billboards_*.png` |
| `extract_barney_billboards.py` | Barney car frames |
| `extract_big_billboard.py` | Big billboard variant |
| `extract_cookie_billboards.py` | Cookie Monster billboard |
| `extract_new_cars.py` | GOTTA GO / YOSHI / BANANA / MEGA traffic cars |
| `build_sprite_sheet.py` | Generic extractor utility (imported by other scripts) |

## Dependencies

- Python 3.10+
- `pillow`, `numpy`, `scipy`

## When to regenerate

Re-run the pipeline if:
- New source art lands in `source_for_sprites/`
- A sprite hitbox or frame count changes (update `src/constants.ts` to match)
- You see a white halo or clipping artifact in-game
