/**
 * scripts/generate-road.ts
 *
 * Build-time road serializer (M15).
 *
 * Run via:  npx tsx scripts/generate-road.ts
 * Or:       npm run prebuild
 *
 * Imports the Road class, runs the full track layout (including all nine
 * plant passes), serializes the result to the minimal SerializedSegment
 * format, and writes src/road-data.ts.
 *
 * At runtime game.ts imports ROAD_DATA from road-data.ts and calls
 * Road.fromData(ROAD_DATA), skipping the 50–200 ms synchronous plant passes
 * entirely.
 *
 * Idempotent: if the serialized output is identical to the existing file,
 * the file is not touched — preserving mtime and avoiding spurious esbuild
 * rebuilds on `npm run dev` when the course layout hasn't changed.
 */

import { Road }            from '../src/road';
import * as crypto         from 'node:crypto';
import * as fs             from 'node:fs';
import * as path           from 'node:path';
import { fileURLToPath }   from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const road         = new Road('default');
const roadHard     = new Road('hard');
const roadLegend   = new Road('legendary');
const data         = road.toJSON();
const dataHard     = roadHard.toJSON();
const dataLegend   = roadLegend.toJSON();

const outPath = path.resolve(__dirname, '../src/road-data.ts');
const banner  = [
  '// AUTO-GENERATED — do not edit by hand.',
  '// Regenerate with:  npm run prebuild',
  '//',
  `// ROAD_DATA:            ${data.length} segments (default course)`,
  `// ROAD_DATA_HARD:       ${dataHard.length} segments (hard course — sweepers, blind crests, chicanes)`,
  `// ROAD_DATA_LEGENDARY:  ${dataLegend.length} segments (THE CATHEDRAL — Spa × Nürburgring)`,
  '',
].join('\n');

const content = [
  banner,
  `import type { SerializedSegment } from './road';`,
  '',
  `export const ROAD_DATA: SerializedSegment[] = ${JSON.stringify(data)};`,
  '',
  `export const ROAD_DATA_HARD: SerializedSegment[] = ${JSON.stringify(dataHard)};`,
  '',
  `export const ROAD_DATA_LEGENDARY: SerializedSegment[] = ${JSON.stringify(dataLegend)};`,
  '',
].join('\n');

// Content-hash guard: skip writing if the file hasn't changed.
// Prevents esbuild from seeing a touched file and triggering a full re-bundle
// on every `npm run dev` when the course layout is unchanged.
function sha256(s: string): string
{
  return crypto.createHash('sha256').update(s).digest('hex');
}

let existingHash = '';
try   { existingHash = sha256(fs.readFileSync(outPath, 'utf8')); }
catch { /* file doesn't exist yet — first run */ }

if (sha256(content) === existingHash)
{
  console.log(`generate-road: no changes — ${data.length} + ${dataHard.length} + ${dataLegend.length} segments unchanged`);
  process.exit(0);
}

fs.writeFileSync(outPath, content, 'utf8');
console.log(`generate-road: wrote ${data.length} + ${dataHard.length} + ${dataLegend.length} segments → src/road-data.ts (${(content.length / 1024).toFixed(1)} KB)`);
