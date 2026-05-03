#!/usr/bin/env python3
"""
extract_clouds.py

Extracts individual white cloud sprites from clouds.jpg (JPEG source, blue BG).

JPEG-specific considerations
─────────────────────────────
  • The background is a flat blue but JPEG compression bleeds it into cloud
    edges, so we cannot use an exact color match.  We BFS from the image
    boundary with a generous L1 tolerance (BG_TOL = 40) to eat the halo.
  • After BFS removal, a second erosion pass on semi-transparent edge pixels
    cleans JPEG ringing without touching the real cloud body.

Dark-cloud filtering
─────────────────────
  The sheet contains both white cumulus and dark storm clouds.
  After connected-component labelling we compute the median brightness of
  each blob and reject anything below DARK_THRESH (0-255).  This keeps
  white/light-gray clouds and drops the storm gray ones.

Output
───────
  sprites/dist/clouds_1x.png  — horizontal strip of white clouds
  sprites/dist/clouds_2x.png
  sprites/dist/clouds_4x.png
  sprites/dist/clouds.json    — frame metadata
"""

import json
import math
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image

# ── Paths ─────────────────────────────────────────────────────────────────────

SRC   = Path(__file__).parent / 'source' / 'clouds.jpg'
OUT   = Path(__file__).parent / 'dist'
DEBUG = Path(__file__).parent / 'source' / 'debug'
OUT.mkdir(exist_ok=True)
DEBUG.mkdir(exist_ok=True)

# ── Tuning ────────────────────────────────────────────────────────────────────

BG_TOL      = 40    # L1 distance from bg_color to treat a pixel as background
DARK_THRESH = 145   # median brightness below this → dark storm cloud, skip
MIN_AREA    = 800   # minimum pixel area to keep a blob (filters tiny JPEG noise)
PAD         = 12    # transparent padding around each extracted cloud

# ── Background removal ────────────────────────────────────────────────────────

def estimate_bg(rgb: np.ndarray) -> np.ndarray:
    """Sample mean color of the four image corners (8×8 px each)."""
    h, w = rgb.shape[:2]
    corners = [
        rgb[:8,  :8],
        rgb[:8,  w-8:],
        rgb[h-8:, :8],
        rgb[h-8:, w-8:],
    ]
    return np.mean(np.concatenate([c.reshape(-1, 3) for c in corners], axis=0), axis=0)


def bfs_remove_bg(rgba: np.ndarray, bg_color: np.ndarray, tol: int) -> np.ndarray:
    """
    BFS flood-fill from the image boundary.
    Any pixel within L1 distance `tol` of bg_color gets alpha = 0.
    Returns a copy of rgba with background pixels zeroed.
    """
    h, w = rgba.shape[:2]
    rgb   = rgba[:, :, :3].astype(np.int32)
    alpha = rgba[:, :, 3].copy()
    visited = np.zeros((h, w), dtype=bool)

    queue = deque()
    for y in range(h):
        for x in [0, w - 1]:
            if not visited[y, x]:
                visited[y, x] = True
                queue.append((y, x))
    for x in range(w):
        for y in [0, h - 1]:
            if not visited[y, x]:
                visited[y, x] = True
                queue.append((y, x))

    while queue:
        y, x = queue.popleft()
        dist = int(np.sum(np.abs(rgb[y, x] - bg_color)))
        if dist > tol:
            continue
        alpha[y, x] = 0
        for dy, dx in [(-1,0),(1,0),(0,-1),(0,1)]:
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and not visited[ny, nx]:
                visited[ny, nx] = True
                queue.append((ny, nx))

    out = rgba.copy()
    out[:, :, 3] = alpha
    return out


def clean_jpeg_fringe(rgba: np.ndarray, bg_color: np.ndarray) -> np.ndarray:
    """
    After BFS, JPEG ringing leaves semi-blue fringe pixels at cloud edges.
    Zero any opaque pixel that is still very close to bg_color.
    """
    rgb   = rgba[:, :, :3].astype(np.int32)
    alpha = rgba[:, :, 3].copy()
    mask  = alpha > 0
    dist  = np.sum(np.abs(rgb - bg_color), axis=2)
    # Fringe: pixels that survived BFS (interior-adjacent, not reachable from the
    # border) but are still very close to the background colour.  Using half the
    # normal background tolerance (BG_TOL // 2) as a tighter threshold targets only
    # the most background-like survivors — pixels closer to the background colour
    # get a hard erasure here rather than a gradual alpha fade, removing JPEG ringing
    # without eating into the bright cloud body.
    fringe = mask & (dist < BG_TOL // 2)
    alpha[fringe] = 0
    out = rgba.copy()
    out[:, :, 3] = alpha
    return out

# ── Connected components (simple flood-fill labelling) ────────────────────────

def label_blobs(alpha: np.ndarray) -> tuple[np.ndarray, int]:
    """Label connected non-zero alpha regions. Returns (label_map, count)."""
    h, w   = alpha.shape
    labels = np.zeros((h, w), dtype=np.int32)
    current = 0

    for sy in range(h):
        for sx in range(w):
            if alpha[sy, sx] > 0 and labels[sy, sx] == 0:
                current += 1
                queue = deque([(sy, sx)])
                labels[sy, sx] = current
                while queue:
                    y, x = queue.popleft()
                    # 8-connectivity (including diagonals) ensures cloud blobs
                    # don't split at diagonal junctions — two cloud pixels that
                    # touch only at a corner are still treated as one cloud.
                    for dy, dx in [(-1,0),(1,0),(0,-1),(0,1),
                                   (-1,-1),(-1,1),(1,-1),(1,1)]:
                        ny, nx = y + dy, x + dx
                        if 0 <= ny < h and 0 <= nx < w \
                                and alpha[ny, nx] > 0 \
                                and labels[ny, nx] == 0:
                            labels[ny, nx] = current
                            queue.append((ny, nx))

    return labels, current

# ── Brightness filter ─────────────────────────────────────────────────────────

def median_brightness(rgba: np.ndarray, mask: np.ndarray) -> float:
    """Median luminance of pixels inside mask."""
    pixels = rgba[:, :, :3][mask]
    if len(pixels) == 0:
        return 0.0
    lum = 0.299 * pixels[:, 0] + 0.587 * pixels[:, 1] + 0.114 * pixels[:, 2]
    return float(np.median(lum))

# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    print(f'Loading {SRC}')
    img  = Image.open(SRC).convert('RGBA')
    rgba = np.array(img, dtype=np.uint8)

    bg_color = estimate_bg(rgba[:, :, :3].astype(np.float64))
    print(f'Estimated background color: {bg_color.astype(int).tolist()}')

    print('BFS background removal…')
    rgba = bfs_remove_bg(rgba, bg_color.astype(np.int32), BG_TOL)
    rgba = clean_jpeg_fringe(rgba, bg_color.astype(np.int32))

    print('Labelling blobs…')
    labels, count = label_blobs(rgba[:, :, 3])
    print(f'  {count} raw blobs found')

    clouds = []
    rejected = 0

    for blob_id in range(1, count + 1):
        mask = labels == blob_id
        area = int(mask.sum())

        if area < MIN_AREA:
            rejected += 1
            continue

        brightness = median_brightness(rgba, mask)
        if brightness < DARK_THRESH:
            print(f'  Blob {blob_id}: area={area}, brightness={brightness:.0f} → DARK (skipped)')
            rejected += 1
            continue

        ys, xs = np.where(mask)
        y0, y1 = int(ys.min()), int(ys.max())
        x0, x1 = int(xs.min()), int(xs.max())

        # Crop with padding
        y0p = max(0, y0 - PAD)
        y1p = min(rgba.shape[0], y1 + PAD + 1)
        x0p = max(0, x0 - PAD)
        x1p = min(rgba.shape[1], x1 + PAD + 1)

        crop = rgba[y0p:y1p, x0p:x1p].copy()
        clouds.append({
            'image':      Image.fromarray(crop, 'RGBA'),
            'brightness': brightness,
            'area':       area,
        })
        print(f'  Blob {blob_id}: area={area}, brightness={brightness:.0f} → KEPT '
              f'({crop.shape[1]}×{crop.shape[0]}px)')

    print(f'\nKept {len(clouds)} white clouds, rejected {rejected} blobs.')

    # Sort roughly left→right, top→bottom for consistent ordering
    clouds.sort(key=lambda c: -c['area'])   # largest first (most prominent)

    if not clouds:
        print('ERROR: No clouds extracted — tune BG_TOL or DARK_THRESH.')
        return

    # ── Normalise cell size ────────────────────────────────────────────────────
    max_w = max(c['image'].width  for c in clouds)
    max_h = max(c['image'].height for c in clouds)
    print(f'Cell size: {max_w}×{max_h}')

    strip_w = max_w * len(clouds)
    strip   = Image.new('RGBA', (strip_w, max_h), (0, 0, 0, 0))

    meta = []
    for i, c in enumerate(clouds):
        img_c = c['image']
        # Centre in cell
        ox = (max_w - img_c.width)  // 2
        oy = (max_h - img_c.height) // 2
        strip.paste(img_c, (i * max_w + ox, oy))
        meta.append({
            'index': i,
            'x': i * max_w, 'y': 0,
            'w': max_w,      'h': max_h,
        })

    # ── Save ──────────────────────────────────────────────────────────────────
    for scale, suffix in [(1, '1x'), (2, '2x'), (4, '4x')]:
        out_path = OUT / f'clouds_{suffix}.png'
        scaled = strip.resize(
            (strip_w * scale, max_h * scale),
            Image.NEAREST,
        )
        scaled.save(out_path)
        print(f'Saved {out_path}  ({scaled.width}×{scaled.height})')

    json_path = OUT / 'clouds.json'
    with open(json_path, 'w') as f:
        json.dump({'cellW': max_w, 'cellH': max_h, 'frames': meta}, f, indent=2)
    print(f'Saved {json_path}')

    # ── Debug proof ───────────────────────────────────────────────────────────
    cols    = math.ceil(math.sqrt(len(clouds)))
    rows    = math.ceil(len(clouds) / cols)
    proof_w = max_w * cols
    proof_h = max_h * rows
    proof   = Image.new('RGBA', (proof_w, proof_h), (26, 26, 46, 255))

    for i, c in enumerate(clouds):
        col, row = i % cols, i // cols
        img_c = c['image']
        ox = col * max_w + (max_w - img_c.width)  // 2
        oy = row * max_h + (max_h - img_c.height) // 2
        proof.paste(img_c, (ox, oy), img_c)

    proof_path = DEBUG / 'clouds_proof.png'
    proof.save(proof_path)
    print(f'Proof saved to {proof_path}')


if __name__ == '__main__':
    main()
