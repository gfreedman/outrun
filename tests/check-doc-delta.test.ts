/**
 * check-doc-delta.test.ts
 *
 * Unit tests for the three pure functions exported by scripts/check-doc-delta.ts.
 *
 * Context — what is check-doc-delta?
 * ─────────────────────────────────────
 * check-doc-delta.ts is a pre-commit hook script that compares staged source
 * files against their corresponding README sections and asks Claude to flag
 * any documentation drift.  It is the "documentation CI" layer for this repo.
 *
 * The three functions under test are the pure core of that script:
 *
 *   extractSection(content, filename) → string | null
 *     Parses a README to find and return the section that documents `filename`.
 *     A section is delimited by the next `### ` heading or a `---` rule.
 *     Returns null if the filename is not found.
 *
 *   buildWorkList(stagedFiles, root) → WorkItem[]
 *     Classifies a list of staged file paths (relative to the repo root).
 *     Keeps only src/*.ts and tests/*.test.ts files not in the SKIP set.
 *     Caps the output at MAX_FILES to bound hook latency on large commits.
 *
 *   formatPrompt(filename, source, section) → string
 *     Assembles the Claude prompt that wraps source code and README section
 *     in XML-like tags and asks Claude to respond with "OK" if docs are current
 *     or a description of the drift if they are not.
 *
 * Testing strategy:
 *   No network, no filesystem, no Claude API calls — every test is deterministic.
 *   Inputs are small inline strings so each test exercises one property in
 *   isolation.  Regex-safety tests use strategically crafted filenames
 *   (with dots and dashes) to flush out unescaped metacharacter bugs.
 *
 * Why pure functions are easy to test:
 *   All three functions are "data in → data out" with no side effects.
 *   This makes it trivial to run them hundreds of times across the test suite
 *   without mocking a file system or an HTTP client.
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
//
// extractSection uses a regex with the multiline `m` flag to find a section
// heading of the form `### `filename`` (with or without backticks) and
// captures all content up to the next heading or horizontal rule.
//
// The key design choices under test:
//   - Section boundary detection (### heading vs --- rule vs end of string).
//   - Regex metacharacter escaping (dots and dashes in filenames).
//   - Graceful null return for missing sections or empty content.

describe('extractSection', () =>
{
  // ── Happy path ───────────────────────────────────────────────────────────────

  /**
   * Standard case: a section delimited by the NEXT `### ` heading.
   * The extracted content must include the section body ("Drives the Web Audio
   * engine.") and must NOT bleed into the next section ("game.ts").
   *
   * Without correct boundary detection, the function would return everything
   * from the target heading to the end of the file — including every subsequent
   * section, which would massively inflate the Claude prompt with irrelevant docs.
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
   * Alternative boundary: a `---` horizontal rule separates sections in some
   * README layouts.  The function must treat `---` as a section end, identical
   * to a `### ` heading.  Without this, a README that uses `---` rules would
   * return oversized sections that include the next file's documentation.
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
   * Edge case: the last section in a file has no trailing heading or rule.
   * The regex must capture content up to end-of-string in this case.
   * Without an end-of-string anchor in the lookahead, the regex would return
   * null for any file whose target section happens to be last.
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
   * Some README sections use headings WITHOUT backtick quotes around the
   * filename (e.g., `### renderer.ts` instead of `### \`renderer.ts\``).
   * Both formats must match.  The regex must handle the optional backtick so
   * the same function works on both README styles in this repo.
   */
  it('matches headings without backticks', () =>
  {
    const content = `### renderer.ts\nTwo-pass canvas renderer.`;
    expect(extractSection(content, 'renderer.ts')).toContain('Two-pass canvas renderer.');
  });

  // ── Not found ────────────────────────────────────────────────────────────────

  /**
   * A filename not present in the README must return null.  The caller uses
   * this to skip sending a Claude prompt for files with no documentation
   * section — a common case for newly added files.
   */
  it('returns null when the filename is not in the README', () =>
  {
    const content = `### \`audio.ts\`\nSound engine.`;
    expect(extractSection(content, 'nonexistent.ts')).toBeNull();
  });

  /**
   * An empty string input must return null without throwing.  This guards
   * against a file-read error or an empty README that produces an empty string
   * before the function is called.
   */
  it('returns null for empty content', () =>
  {
    expect(extractSection('', 'audio.ts')).toBeNull();
  });

  // ── Regex safety ─────────────────────────────────────────────────────────────
  //
  // Filenames contain dots (.) and dashes (-), both of which are regex
  // metacharacters.  An unescaped `.` matches any character; an unescaped `-`
  // inside a character class creates a range.  The function must escape them.

  /**
   * An unescaped dot in "audio.ts" would match "audioXts", "audio ts", or any
   * other string differing by one character at that position.  The test has BOTH
   * "audioXts" and "audio.ts" sections and verifies that only the exact filename
   * is matched.  Without escaping, the wrong section could be returned.
   */
  it('escapes dots in filename so "audio.ts" does not match "audioXts"', () =>
  {
    const content = `### \`audioXts\`\nWrong match.\n\n### \`audio.ts\`\nCorrect match.`;
    const result = extractSection(content, 'audio.ts');
    expect(result).toContain('Correct match.');
    expect(result).not.toContain('Wrong match.');
  });

  /**
   * Dashes in filenames (e.g., "intro-controller.ts") must also be escaped.
   * An unescaped dash in a character class would create a character range;
   * outside a character class it is literal, but it is still good practice
   * to escape it to make the intent explicit and prevent future regressions
   * if the regex is ever refactored with character classes.
   */
  it('escapes dashes in filename (e.g. intro-controller.ts)', () =>
  {
    const content = `### \`intro-controller.ts\`\nMenu state machine.`;
    expect(extractSection(content, 'intro-controller.ts')).toContain('Menu state machine.');
  });

  /**
   * A filename containing BOTH a dash AND a dot (like "road-data.ts") exercises
   * both escape paths simultaneously.  This guards against a regex-escape
   * implementation that only escapes the first metacharacter type encountered.
   */
  it('escapes both dash and dot in road-data.ts', () =>
  {
    const content = `### \`road-data.ts\`\nPre-generated segments.`;
    expect(extractSection(content, 'road-data.ts')).toContain('Pre-generated segments.');
  });

  // ── Multi-line content ───────────────────────────────────────────────────────

  /**
   * A section may span multiple paragraphs.  The regex must capture ALL content
   * until the next boundary, not just the first line.  Without the DOTALL-style
   * capture (or multiline alternation), only the first line of documentation
   * would be returned, truncating multi-paragraph explanations.
   */
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
//
// buildWorkList receives a flat list of staged file paths (relative to the repo
// root) and returns a WorkItem array containing only the files that should be
// doc-checked.  The filtering rules are:
//
//   INCLUDE  — src/*.ts (not .d.ts) and tests/*.test.ts
//   EXCLUDE  — files in the SKIP set (road-data.ts, main.ts, etc.)
//   EXCLUDE  — files outside src/ and tests/
//   CAP      — at most MAX_FILES items in the output
//
// The function also resolves absolute paths (root + relative) for both the
// source file and its README so the caller can read them without any path math.

describe('buildWorkList', () =>
{
  const ROOT = '/fake/root';

  // ── Source file classification ────────────────────────────────────────────

  /**
   * A plain src/*.ts file must be classified as a source file, mapped to
   * src/README.md, and given a fully-resolved filePath.  All three fields
   * (filename, readmePath, filePath) must be correct — the caller reads them
   * blindly without re-parsing.
   */
  it('maps src/*.ts to src/README.md', () =>
  {
    const items = buildWorkList(['src/audio.ts'], ROOT);
    expect(items).toHaveLength(1);
    expect(items[0].filename).toBe('audio.ts');
    expect(items[0].readmePath).toBe(`${ROOT}/src/README.md`);
    expect(items[0].filePath).toBe(`${ROOT}/src/audio.ts`);
  });

  /**
   * A tests/*.test.ts file must be mapped to tests/README.md.
   * The tests README is a separate file from the src README — mixing them up
   * would send source file docs as context for a test file check (or vice
   * versa), producing meaningless Claude responses.
   */
  it('maps tests/*.test.ts to tests/README.md', () =>
  {
    const items = buildWorkList(['tests/physics.test.ts'], ROOT);
    expect(items).toHaveLength(1);
    expect(items[0].filename).toBe('physics.test.ts');
    expect(items[0].readmePath).toBe(`${ROOT}/tests/README.md`);
  });

  // ── Ignored files ─────────────────────────────────────────────────────────

  /**
   * Files outside src/ and tests/ (README.md, package.json, workspace files,
   * sprite assets) must be completely ignored.  Sending a package.json to Claude
   * and asking "are the docs current?" would be meaningless and waste API tokens.
   */
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

  /**
   * TypeScript declaration files (*.d.ts) are type-only shims, not source
   * code.  They have no corresponding README sections and should be silently
   * skipped to avoid sending empty documentation contexts to Claude.
   */
  it('ignores .d.ts declaration files', () =>
  {
    const items = buildWorkList(['src/types.d.ts'], ROOT);
    expect(items).toHaveLength(0);
  });

  /**
   * Non-test TypeScript files in tests/ (e.g., shared helpers) must be ignored.
   * Only files matching *.test.ts are test files by convention — a plain
   * helpers.ts in tests/ has no test README section and should be skipped.
   */
  it('ignores non-.test.ts files in tests/', () =>
  {
    // A helper file in tests/ that isn't a test suite
    const items = buildWorkList(['tests/helpers.ts'], ROOT);
    expect(items).toHaveLength(0);
  });

  // ── SKIP list ─────────────────────────────────────────────────────────────
  //
  // Some src/ files are permanently excluded from doc-checking.  SKIP contains
  // files that are either auto-generated (road-data.ts), entry-point boilerplate
  // (main.ts), or otherwise unsuitable for Claude doc review.

  /**
   * Every filename in the SKIP set must produce zero WorkItems when staged.
   * The test constructs `src/${f}` paths from the exported SKIP set itself,
   * so adding a new entry to SKIP automatically protects it from doc-checking
   * without requiring a separate test update.
   */
  it('skips every filename in the SKIP set', () =>
  {
    const skipped = [...SKIP].map(f => `src/${f}`);
    const items   = buildWorkList(skipped, ROOT);
    expect(items).toHaveLength(0);
  });

  /**
   * road-data.ts is auto-generated pre-baked segment data.  It is thousands
   * of lines of array literals with no meaningful narrative documentation.
   * Doc-checking it would always produce false drift alerts.
   */
  it('skips road-data.ts specifically', () =>
  {
    expect(buildWorkList(['src/road-data.ts'], ROOT)).toHaveLength(0);
  });

  /**
   * main.ts is entry-point bootstrapping code (canvas init, resize handlers,
   * event wiring).  Its README section is intentionally minimal and changes
   * rarely — including it in every commit's doc check would create noise.
   */
  it('skips main.ts specifically', () =>
  {
    expect(buildWorkList(['src/main.ts'], ROOT)).toHaveLength(0);
  });

  // ── MAX_FILES cap ─────────────────────────────────────────────────────────
  //
  // The hook must complete within a reasonable time budget.  Each file triggers
  // one Claude API call (sequential by default), so a large commit with many
  // staged files could block the commit for 30+ seconds.  MAX_FILES caps this
  // by processing only the first N qualifying files.

  /**
   * When more than MAX_FILES qualifying files are staged, only the first
   * MAX_FILES must be included.  The cap is non-negotiable: even a single
   * file over the limit would be dropped.  Testing with MAX_FILES + 3 confirms
   * the cap applies strictly, not approximately.
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

  /**
   * Exactly MAX_FILES qualifying files must all be included — the cap is
   * exclusive (> MAX_FILES), not inclusive (>= MAX_FILES).  Without this
   * boundary check, an off-by-one could drop the last file on a commit of
   * exactly MAX_FILES files.
   */
  it('includes all files when count is exactly MAX_FILES', () =>
  {
    const staged = Array.from({ length: MAX_FILES }, (_, i) => `src/file${i}.ts`);
    expect(buildWorkList(staged, ROOT)).toHaveLength(MAX_FILES);
  });

  /**
   * Below the cap, every qualifying file must be included.  The cap must only
   * activate when the count exceeds MAX_FILES — it must not truncate smaller
   * commits.
   */
  it('includes all files when count is below MAX_FILES', () =>
  {
    const staged = ['src/audio.ts', 'src/physics.ts'];
    expect(buildWorkList(staged, ROOT)).toHaveLength(2);
  });

  // ── Mixed input ───────────────────────────────────────────────────────────

  /**
   * A realistic commit mixes qualifying files with non-qualifying ones.
   * buildWorkList must correctly filter and classify them in one pass.
   *
   * Expected outcome:
   *   audio.ts      → kept (src file)
   *   road-data.ts  → dropped (SKIP)
   *   physics.test.ts → kept (test file)
   *   PLAN.md       → dropped (not src or tests)
   *   sprites/...   → dropped (not src or tests)
   *   main.ts       → dropped (SKIP)
   *
   * The output order must match the input order of kept files.
   */
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
//
// formatPrompt builds the exact string sent to the Claude API.  The contract
// is strict: the prompt must contain all required context (filename, source,
// README section), wrap them in the correct XML tags, include the "OK" signal
// instruction, and truncate oversized source files to bound token usage.

describe('formatPrompt', () =>
{
  const FILENAME = 'audio.ts';
  const SOURCE   = 'export function playMusic() {}';
  const SECTION  = '### `audio.ts`\nDrives the Web Audio engine.';

  // ── Content presence ──────────────────────────────────────────────────────

  /**
   * The filename must appear in the prompt so Claude knows which file is being
   * reviewed.  Without the filename, Claude cannot provide specific actionable
   * feedback ("the README for audio.ts should say X").
   */
  it('includes the filename in the prompt', () =>
  {
    expect(formatPrompt(FILENAME, SOURCE, SECTION)).toContain(FILENAME);
  });

  /**
   * The source code must be included verbatim so Claude can compare the actual
   * implementation against the README description.  Without the source code,
   * Claude is reviewing a README section in isolation with no ground truth.
   */
  it('includes the source code', () =>
  {
    expect(formatPrompt(FILENAME, SOURCE, SECTION)).toContain(SOURCE);
  });

  /**
   * The README section must be included so Claude has the current documentation
   * to check against the source.  Without it, Claude has nothing to compare and
   * would always respond with an irrelevant or hallucinated answer.
   */
  it('includes the README section', () =>
  {
    expect(formatPrompt(FILENAME, SOURCE, SECTION)).toContain(SECTION);
  });

  /**
   * The prompt must instruct Claude to respond with exactly "OK" when the docs
   * are current.  The check-doc-delta script parses the response and uses "OK"
   * as the no-drift signal.  Without this instruction, Claude would always
   * produce a descriptive response, making every commit fail the hook.
   */
  it('instructs Claude to respond with exactly "OK" when docs are current', () =>
  {
    expect(formatPrompt(FILENAME, SOURCE, SECTION)).toContain('OK');
  });

  // ── Truncation ────────────────────────────────────────────────────────────
  //
  // Each Claude API call costs tokens proportional to input length.  A single
  // large source file could consume the entire context window (200K tokens) or
  // cost several dollars per commit.  Truncating at 10 KB keeps costs bounded
  // while still providing enough context for Claude to detect documentation drift.

  /**
   * Source files longer than 10 KB must be truncated and a truncation marker
   * `// ... (truncated)` must appear in the prompt.  The marker signals to
   * Claude that the file is incomplete — without it, Claude might assume the
   * truncated code is the entire file and give misleading feedback about
   * missing exported symbols that are actually present beyond the cut point.
   *
   * The full longSource (11 KB) must NOT appear in the prompt — only the first
   * 10 KB should be present.
   */
  it('truncates source files longer than 10 KB', () =>
  {
    const longSource = 'x'.repeat(11_000);
    const prompt     = formatPrompt(FILENAME, longSource, SECTION);
    expect(prompt).toContain('// ... (truncated)');
    // The full source must NOT be present — only the first 10 KB
    expect(prompt).not.toContain(longSource);
  });

  /**
   * A file of exactly 10 KB must NOT be truncated.  The truncation threshold
   * is `> 10_000`, not `>= 10_000`.  An off-by-one here would truncate every
   * file at exactly the boundary — even short ones that happen to hit the limit.
   */
  it('does not truncate source files of exactly 10 KB', () =>
  {
    const exactSource = 'x'.repeat(10_000);
    const prompt      = formatPrompt(FILENAME, exactSource, SECTION);
    expect(prompt).not.toContain('// ... (truncated)');
  });

  /**
   * Short source files (well under 10 KB) must be included verbatim.
   * The full content must appear in the prompt and no truncation marker
   * should be present — truncating a short file would lose important context
   * and produce false drift reports.
   */
  it('does not truncate source files shorter than 10 KB', () =>
  {
    const shortSource = 'export const X = 1;';
    const prompt      = formatPrompt(FILENAME, shortSource, SECTION);
    expect(prompt).toContain(shortSource);
    expect(prompt).not.toContain('// ... (truncated)');
  });

  // ── Structure ─────────────────────────────────────────────────────────────
  //
  // The prompt uses XML-like tags to delimit the source and README sections.
  // Claude's instruction-following is sensitive to tag format — these tests
  // lock the exact tags so a refactoring of formatPrompt doesn't silently
  // change the tag names and break Claude's parsing context.

  /**
   * Source code must be wrapped in `<source>` / `</source>` tags.
   * Both opening and closing tags must be present — a missing closing tag
   * would cause Claude to read past the source into the README section,
   * confusing the two inputs.
   */
  it('wraps source in <source> tags', () =>
  {
    const prompt = formatPrompt(FILENAME, SOURCE, SECTION);
    expect(prompt).toContain('<source>');
    expect(prompt).toContain('</source>');
  });

  /**
   * README section must be wrapped in `<readme>` / `</readme>` tags.
   * Both tags must be present for the same reason: a missing closing tag
   * would blur the boundary between the README content and the instruction
   * text, potentially causing Claude to treat instructions as documentation.
   */
  it('wraps README section in <readme> tags', () =>
  {
    const prompt = formatPrompt(FILENAME, SOURCE, SECTION);
    expect(prompt).toContain('<readme>');
    expect(prompt).toContain('</readme>');
  });
});
