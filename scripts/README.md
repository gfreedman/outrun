# scripts/ — Build Tools

## `generate-road.ts`

**What it does:** Builds the road at compile time instead of at runtime.

The `Road` class constructs the full track by running through the course
definition and placing ~3000 roadside sprites across all segments. This takes
50–200 ms synchronously on the main thread — visible startup jank on mid-range
hardware.

This script runs that construction *once* at build time, serializes the result
to a minimal `SerializedSegment[]` array, and writes it to `src/road-data.ts`.
At runtime, `game.ts` just imports the pre-computed array and calls
`Road.fromData(ROAD_DATA)` — no construction cost.

**When it runs:**
```bash
npm run build   # prebuild hook runs this automatically before esbuild
npm run dev     # predev hook runs this automatically before esbuild watch
```

Or manually:
```bash
npx tsx scripts/generate-road.ts
```

**Idempotent:** The script hashes the output before writing. If the serialized
content is identical to the existing `src/road-data.ts`, it exits without
touching the file — no spurious esbuild rebuild on `npm run dev` when the
course hasn't changed.

**Output:** `src/road-data.ts` — committed to git.
`road-data.ts` is checked in so CI can run tests without needing `tsx`
installed, and `git diff` shows exactly what segments changed when the
course layout is modified.

**When to re-run manually:** Only if you change the course layout in
`src/road.ts`. The prebuild/predev hooks handle it automatically otherwise.
