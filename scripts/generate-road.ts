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
 */

import { Road }            from '../src/road';
import * as fs             from 'node:fs';
import * as path           from 'node:path';
import { fileURLToPath }   from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const road     = new Road('default');
const roadHard = new Road('hard');
const data     = road.toJSON();
const dataHard = roadHard.toJSON();

const outPath = path.resolve(__dirname, '../src/road-data.ts');
const banner  = [
  '// AUTO-GENERATED — do not edit by hand.',
  '// Regenerate with:  npm run prebuild',
  '//',
  `// ROAD_DATA:      ${data.length} segments (easy/medium course)`,
  `// ROAD_DATA_HARD: ${dataHard.length} segments (hard course — sweepers, blind crests, chicanes)`,
  `// Generated: ${new Date().toISOString()}`,
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
].join('\n');

fs.writeFileSync(outPath, content, 'utf8');
console.log(`generate-road: wrote ${data.length} + ${dataHard.length} segments → src/road-data.ts (${(content.length / 1024).toFixed(1)} KB)`);
