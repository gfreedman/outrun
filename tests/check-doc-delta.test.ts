/**
 * check-doc-delta.test.ts
 *
 * Unit tests for the three pure functions exported by scripts/check-doc-delta.ts.
 *
 * No network, no filesystem, no Claude API calls — every test is deterministic.
 *
 *   1. extractSection  — regex section parser
 *   2. buildWorkList   — staged-file classifier and WorkItem builder
 *   3. formatPrompt    — Claude prompt assembler
 */

import { describe, it, expect } from 'vitest';
import {
  extractSection,
  buildWorkList,
  formatPrompt,
  SKIP,
  MAX_FILES,
} from '../scripts/check-doc-delta';

// ── 1. extractSection ──────────────────────────────────────────────────────────

describe('extractSection', () =>
{
  // ── Happy path ───────────────────────────────────────────────────────────────

  /**
   * Standard README format: ### `filename.ts` with backticks.
   * Content runs until the next ### heading.
   */
  it('extracts a section delimited by the next ### heading', () =>
  {
    const content = `
### \`audio.ts\`
Drives the Web Audio engine.

### \`game.ts\`
The game loop.
`.trim();

    const result = extractSection(content, 'audio.ts');
    expect(result).toContain('Drives the Web Audio engine.');
    expect(result).not.toContain('game.ts');
  });

  /**
   * Sections can also be delimited by a --- horizontal rule.
   */
  it('extracts a section delimited by a --- horizontal rule', () =>
  {
    const content = `
### \`physics.ts\`
Pure physics functions.

---

### \`collision.ts\`
Collision detection.
`.trim();

    const result = extractSection(content, 'physics.ts');
    expect(result).toContain('Pure physics functions.');
    expect(result).not.toContain('collision.ts');
  });

  /**
   * The last section in a file has no trailing heading or rule —
   * it should still be captured up to end-of-string.
   */
  it('extracts the final section (no trailing heading)', () =>
  {
    const content = `
### \`road.ts\`
Track definition and segment lookup.
`.trim();

    const result = extractSection(content, 'road.ts');
    expect(result).toContain('Track definition and segment lookup.');
  });

  /**
   * Headings without backticks should also match.
   */
  it('matches headings without backticks', () =>
  {
    const content = `### renderer.ts\nTwo-pass canvas renderer.`;
    expect(extractSection(content, 'renderer.ts')).toContain('Two-pass canvas renderer.');
  });

  // ── Not found ────────────────────────────────────────────────────────────────

  it('returns null when the filename is not in the README', () =>
  {
    const content = `### \`audio.ts\`\nSound engine.`;
    expect(extractSection(content, 'nonexistent.ts')).toBeNull();
  });

  it('returns null for empty content', () =>
  {
    expect(extractSection('', 'audio.ts')).toBeNull();
  });

  // ── Regex safety ─────────────────────────────────────────────────────────────

  /**
   * Filenames contain dots and dashes — both are regex metacharacters.
   * extractSection must escape them so "audio.ts" doesn't match "audioXts".
   */
  it('escapes dots in filename so "audio.ts" does not match "audioXts"', () =>
  {
    const content = `### \`audioXts\`\nWrong match.\n\n### \`audio.ts\`\nCorrect match.`;
    const result = extractSection(content, 'audio.ts');
    expect(result).toContain('Correct match.');
    expect(result).not.toContain('Wrong match.');
  });

  it('escapes dashes in filename (e.g. intro-controller.ts)', () =>
  {
    const content = `### \`intro-controller.ts\`\nMenu state machine.`;
    expect(extractSection(content, 'intro-controller.ts')).toContain('Menu state machine.');
  });

  /**
   * A filename like "road-data.ts" contains both a dash and a dot —
   * both must be escaped independently.
   */
  it('escapes both dash and dot in road-data.ts', () =>
  {
    const content = `### \`road-data.ts\`\nPre-generated segments.`;
    expect(extractSection(content, 'road-data.ts')).toContain('Pre-generated segments.');
  });

  // ── Multi-line content ───────────────────────────────────────────────────────

  it('captures multi-paragraph section content', () =>
  {
    const content = `
### \`types.ts\`
Shared TypeScript interfaces.

No logic — just type definitions.

### \`constants.ts\`
Tuning values.
`.trim();

    const result = extractSection(content, 'types.ts');
    expect(result).toContain('Shared TypeScript interfaces.');
    expect(result).toContain('No logic — just type definitions.');
  });
});

// ── 2. buildWorkList ───────────────────────────────────────────────────────────

describe('buildWorkList', () =>
{
  const ROOT = '/fake/root';

  // ── Source file classification ────────────────────────────────────────────

  it('maps src/*.ts to src/README.md', () =>
  {
    const items = buildWorkList(['src/audio.ts'], ROOT);
    expect(items).toHaveLength(1);
    expect(items[0].filename).toBe('audio.ts');
    expect(items[0].readmePath).toBe(`${ROOT}/src/README.md`);
    expect(items[0].filePath).toBe(`${ROOT}/src/audio.ts`);
  });

  it('maps tests/*.test.ts to tests/README.md', () =>
  {
    const items = buildWorkList(['tests/physics.test.ts'], ROOT);
    expect(items).toHaveLength(1);
    expect(items[0].filename).toBe('physics.test.ts');
    expect(items[0].readmePath).toBe(`${ROOT}/tests/README.md`);
  });

  // ── Ignored files ─────────────────────────────────────────────────────────

  it('ignores files not in src/ or tests/', () =>
  {
    const items = buildWorkList([
      'sprites/README.md',
      'PLAN.md',
      'package.json',
      'outrun.code-workspace',
    ], ROOT);
    expect(items).toHaveLength(0);
  });

  it('ignores .d.ts declaration files', () =>
  {
    const items = buildWorkList(['src/types.d.ts'], ROOT);
    expect(items).toHaveLength(0);
  });

  it('ignores non-.test.ts files in tests/', () =>
  {
    // A helper file in tests/ that isn't a test suite
    const items = buildWorkList(['tests/helpers.ts'], ROOT);
    expect(items).toHaveLength(0);
  });

  // ── SKIP list ─────────────────────────────────────────────────────────────

  it('skips every filename in the SKIP set', () =>
  {
    const skipped = [...SKIP].map(f => `src/${f}`);
    const items   = buildWorkList(skipped, ROOT);
    expect(items).toHaveLength(0);
  });

  it('skips road-data.ts specifically', () =>
  {
    expect(buildWorkList(['src/road-data.ts'], ROOT)).toHaveLength(0);
  });

  it('skips main.ts specifically', () =>
  {
    expect(buildWorkList(['src/main.ts'], ROOT)).toHaveLength(0);
  });

  // ── MAX_FILES cap ─────────────────────────────────────────────────────────

  /**
   * When more than MAX_FILES qualifying files are staged, only the first
   * MAX_FILES are included — protecting hook latency.
   */
  it(`caps output at MAX_FILES (${MAX_FILES})`, () =>
  {
    const staged = Array.from(
      { length: MAX_FILES + 3 },
      (_, i) => `src/file${i}.ts`,
    );
    const items = buildWorkList(staged, ROOT);
    expect(items).toHaveLength(MAX_FILES);
  });

  it('includes all files when count is exactly MAX_FILES', () =>
  {
    const staged = Array.from({ length: MAX_FILES }, (_, i) => `src/file${i}.ts`);
    expect(buildWorkList(staged, ROOT)).toHaveLength(MAX_FILES);
  });

  it('includes all files when count is below MAX_FILES', () =>
  {
    const staged = ['src/audio.ts', 'src/physics.ts'];
    expect(buildWorkList(staged, ROOT)).toHaveLength(2);
  });

  // ── Mixed input ───────────────────────────────────────────────────────────

  it('handles a realistic mixed commit — keeps only qualifying files', () =>
  {
    const staged = [
      'src/audio.ts',               // ✓ src file
      'src/road-data.ts',           // ✗ SKIP
      'tests/physics.test.ts',      // ✓ test file
      'PLAN.md',                    // ✗ not src or tests
      'sprites/assets/README.md',   // ✗ not src or tests
      'src/main.ts',                // ✗ SKIP
    ];
    const items = buildWorkList(staged, ROOT);
    expect(items).toHaveLength(2);
    expect(items.map(i => i.filename)).toEqual(['audio.ts', 'physics.test.ts']);
  });
});

// ── 3. formatPrompt ───────────────────────────────────────────────────────────

describe('formatPrompt', () =>
{
  const FILENAME = 'audio.ts';
  const SOURCE   = 'export function playMusic() {}';
  const SECTION  = '### `audio.ts`\nDrives the Web Audio engine.';

  // ── Content presence ──────────────────────────────────────────────────────

  it('includes the filename in the prompt', () =>
  {
    expect(formatPrompt(FILENAME, SOURCE, SECTION)).toContain(FILENAME);
  });

  it('includes the source code', () =>
  {
    expect(formatPrompt(FILENAME, SOURCE, SECTION)).toContain(SOURCE);
  });

  it('includes the README section', () =>
  {
    expect(formatPrompt(FILENAME, SOURCE, SECTION)).toContain(SECTION);
  });

  it('instructs Claude to respond with exactly "OK" when docs are current', () =>
  {
    expect(formatPrompt(FILENAME, SOURCE, SECTION)).toContain('OK');
  });

  // ── Truncation ────────────────────────────────────────────────────────────

  /**
   * Files longer than 10 KB are truncated to keep token usage predictable.
   * The truncation marker must appear so Claude knows the file is incomplete.
   */
  it('truncates source files longer than 10 KB', () =>
  {
    const longSource = 'x'.repeat(11_000);
    const prompt     = formatPrompt(FILENAME, longSource, SECTION);
    expect(prompt).toContain('// ... (truncated)');
    // The full source must NOT be present — only the first 10 KB
    expect(prompt).not.toContain(longSource);
  });

  it('does not truncate source files of exactly 10 KB', () =>
  {
    const exactSource = 'x'.repeat(10_000);
    const prompt      = formatPrompt(FILENAME, exactSource, SECTION);
    expect(prompt).not.toContain('// ... (truncated)');
  });

  it('does not truncate source files shorter than 10 KB', () =>
  {
    const shortSource = 'export const X = 1;';
    const prompt      = formatPrompt(FILENAME, shortSource, SECTION);
    expect(prompt).toContain(shortSource);
    expect(prompt).not.toContain('// ... (truncated)');
  });

  // ── Structure ─────────────────────────────────────────────────────────────

  it('wraps source in <source> tags', () =>
  {
    const prompt = formatPrompt(FILENAME, SOURCE, SECTION);
    expect(prompt).toContain('<source>');
    expect(prompt).toContain('</source>');
  });

  it('wraps README section in <readme> tags', () =>
  {
    const prompt = formatPrompt(FILENAME, SOURCE, SECTION);
    expect(prompt).toContain('<readme>');
    expect(prompt).toContain('</readme>');
  });
});
