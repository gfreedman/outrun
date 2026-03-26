# sprites/source_for_sprites/ — Original Source Art

This directory contains the **original reference images and Gemini-generated
source art** used as input to the sprite extraction pipeline. These files are
not loaded by the game — they exist only as inputs to the Python scripts in
`sprites/asset_build_scripts/`.

---

## What's here

| File | What it is |
|------|-----------|
| `hero.jpg` | Ferrari Testarossa photo used as the title screen background |
| `palm_tree_source.png` | Source sheet the palm sprites were extracted from |
| `sega.png` | Sega arcade reference image |
| `shrubz.png` | Source sheet for shrub/bush extraction |
| `cactus.png` | Source sheet for cactus extraction |
| `signs.png` / `signz.png` | Turn sign source images |
| `barney.png` / `barney_car.png` | Barney billboard and traffic car source |
| `billboard sprites.png` | General billboard source sheet |
| `big.png` | Big billboard source |
| `cookie.png` / `cookieMonster.png` | Cookie Monster billboard source |
| `houses.png` / `houses2.png` | Roadside building source sheets |
| `white_van.png` | Traffic car variant source |
| `yellow.png` / `new_yellow.png` | Yellow rival car source |
| `image.jpg` | General reference |
| `left.png` / `right.png` | Left/right directional sprite variants |
| `gemini_outrun_desert_supplemental.png` | AI-generated desert supplemental art |
| `gemini_retro_street_arcade.png` | AI-generated street/arcade reference |
| `clouds.jpg` | Cloud source image |

### Sub-directories
- `buildings/` — individual building source PNGs before sheet packing
- `houses/` — house variant sources
- `debug/` — diagnostic renders used during sprite extraction development

---

## Source analysis images

| File | Purpose |
|------|---------|
| `source_analysis_left.png` | Annotated left-side sprite analysis |
| `source_analysis_right.png` | Annotated right-side sprite analysis |
| `sprite_sheet_proof.png` | Proof render validating extracted sprite positions |

---

## Workflow

1. Source art lives here
2. Python scripts in `sprites/asset_build_scripts/` extract or composite sprites
3. Output PNGs go into `sprites/assets/`
4. `src/sprites.ts` references the output PNGs

If source art changes, update the file here, then re-run the relevant
`extract_*.py` or `build_*.py` script. See `sprites/README.md` for the
full pipeline.
