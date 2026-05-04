# Sprite Pipeline

All game sprites are PNG files in `sprites/dist/` loaded at runtime by `src/sprites.ts`.
The Python scripts in `sprites/scripts/` are **offline build tools** — the game never
touches them.  You only need to run them when source art changes.

---

## Quick start

```bash
pip install pillow numpy scipy

# After editing any sprite sheet in Aseprite or another pixel editor:
python3 scripts/build.py

# When new raw source art arrives in source/ and needs to be extracted:
python3 scripts/build_new.py
python3 scripts/build.py
```

---

## Directory layout

```
sprites/
  dist/           ← Game loads from here.  Committed PNG atlases consumed by
  │                 src/sprites.ts.  One file per sprite family.
  │
  parts/          ← Individual cleaned sprites, one PNG per sprite.  Committed
  │                 so the pipeline is reproducible from parts/ alone.
  │                 Populated by extract_*.py (from source/) or by build.py
  │                 (reverse-extracted from dist/ after a manual edit).
  │
  source/         ← Original raw art: Photoshop exports, AI renders, JPEG
  │                 sprite sheets.  Not loaded by the game.  Read by
  │                 extract_*.py and build_cactus_sheet.py.
  │
  dist_bak/       ← Pixel-exact copies of the last known-good dist/ atlases.
  │                 Used by build.py step 3 to validate that a rebuild
  │                 produces bit-identical output.  Not committed.
  │
  scripts/        ← Offline build tools (see below).
```

---

## How the pipeline works

The pipeline has two directions depending on what changed:

### Direction A — editing an existing sprite sheet in Aseprite

```
[edit dist/palm_sheet.png in Aseprite]
        ↓
  python3 scripts/build.py
        ↓
  Step 1  build.py slices dist/ atlases back into individual parts/ files
          so parts/ reflects what the game actually loads.
        ↓
  Step 2  build_sheets.build_all() repacks parts/ into fresh dist/ atlases.
        ↓
  Step 3  Every rebuilt atlas is compared pixel-for-pixel against dist_bak/.
          Exits non-zero if anything differs — catches accidental changes.
```

### Direction B — adding new source art

```
[drop new art into source/]
        ↓
  python3 scripts/build_new.py
        (runs extract_*.py scripts: source/ → parts/)
        ↓
  python3 scripts/build.py
        (rebuild + validate as above)
        ↓
  Update dist_bak/ if the new atlas is intentionally different:
        cp dist/palm_sheet.png dist_bak/palm_sheet.png
```

---

## Script reference

### Entry points — the only scripts you run directly

| Script | When to run |
|--------|-------------|
| `build.py` | After editing any dist/ atlas. Reverse-extracts → rebuilds → validates. |
| `build_new.py` | When new raw source art arrives. Runs all extract_*.py scripts. |

### Atlas builders — called by build.py, not run directly

| Script | What it builds |
|--------|----------------|
| `build_sheets.py` | All 8 standard atlases (palms, billboards, cookie, barney, big, shrubs, signs, houses). One file, shared packing logic. |
| `build_cactus_sheet.py` | Cactus atlas only. Special case: reads `source/cactus.png` directly and extracts + packs in a single pass. |
| `build_sprite_sheet.py` | Player car animation strip. Reads `source/right.png` and `source/left.png`, extracts 37 frames, defrings, assembles. Run manually if the player car source art changes. |

### Extractors — run by build_new.py, or individually when re-extracting one family

| Script | Source → Output |
|--------|----------------|
| `extract_billboards.py` | `source/billboard sprites.png` → `parts/billboards/og_boards/` |
| `extract_big_billboard.py` | `source/big.png` → `parts/billboards/big_boards/` |
| `extract_barney_billboards.py` | `source/barney.png` → `parts/billboards/barney_boards/` |
| `extract_cookie_billboards.py` | `source/cookie.png` → `parts/billboards/cookie_boards/` |
| `extract_palms.py` | `source/palm_tree_source.png` → `parts/palms/` |
| `extract_houses.py` | `source/houses*.png` → `parts/houses/`, `parts/buildings/` |
| `extract_shrubs.py` | `source/shrubz.png` → `parts/shrubs/` |
| `extract_signs.py` | `source/signs.png` → `parts/signs/` |
| `extract_new_cars.py` | `source/image.jpg` → `dist/` (traffic cars: GottaGo, Yoshi, Banana, Mega) |
| `extract_yellow_car.py` | `source/yellow.png` → `dist/` (yellow rival car) |

---

## dist/ files consumed by the game

| File | Sprites inside |
|------|----------------|
| `palm_sheet.png` | 9 palm tree variants |
| `billboard_sheet.png` | 12 OG roadside billboards |
| `cookie_sheet.png` | 4 Cookie Monster portrait billboards |
| `barney_sheet.png` | 2 Barney-themed billboards |
| `big_sheet.png` | 1 large landscape wrestling billboard |
| `cactus_sheet.png` | 22 cactus variants |
| `shrub_sheet.png` | 3 ground-cover shrub variants |
| `sign_sheet.png` | 2 chevron turn signs (left, right) |
| `house_sheet.png` | 25 buildings (10 adobe, 5 desert, 10 colourful shops) |
| `player_car_sprites_1x.png` | 37-frame Ferrari Testarossa animation strip |
| `yellow_car_sprites.png` | Yellow rival car |
| `barney_car_sprites.png` | Barney traffic car |
| `gottago_car_sprites.png` | GottaGo traffic car |
| `banana_car_sprites.png` | Banana traffic car |
| `mega_car_sprites.png` | Mega traffic car |
| `hero.jpg` | Title screen background (desktop) |
| `mobile_hero.png` | Title screen background (mobile) |

---

## Dependencies

```bash
pip install pillow numpy scipy
```

- **Pillow** — image loading, compositing, saving
- **numpy** — pixel-level array operations (flood-fill, background removal, diff)
- **scipy** — connected-component labelling used by cactus and billboard extractors

Python 3.10 or later.

---

## Validation baseline (dist_bak/)

`dist_bak/` holds pixel-exact reference copies of the dist/ atlases at the last
known-good state.  `build.py` step 3 compares every rebuilt atlas against its
`dist_bak/` counterpart using numpy pixel comparison (not file hashing — PIL
re-encodes PNGs with non-deterministic compression, so identical pixel content
produces different file bytes).

Update the baseline after any intentional change to a dist/ atlas:

```bash
cp sprites/dist/palm_sheet.png sprites/dist_bak/palm_sheet.png
```

`dist_bak/` **is committed to git** so the validation baseline is reproducible on
any clone.  After any intentional atlas change, copy the updated file into
`dist_bak/` and commit both together so the baseline stays in sync.
