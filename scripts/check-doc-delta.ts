/**
 * scripts/check-doc-delta.ts
 *
 * Pre-commit doc-delta checker.
 *
 * For every staged TypeScript file in src/ or tests/, reads the file and the
 * corresponding README section, then asks Claude to identify exported symbols,
 * behaviors, or design decisions present in the source that aren't reflected
 * in the docs.
 *
 * Rules:
 *   - Exits 0 always (warn-only — never blocks a commit)
 *   - Skips silently when ANTHROPIC_API_KEY is not set (offline-friendly)
 *   - Skips generated files (road-data.ts, main.ts)
 *   - Caps at MAX_FILES per commit to keep hook latency reasonable
 *   - Runs staged files concurrently for speed
 *
 * Run manually:
 *   npx tsx scripts/check-doc-delta.ts
 *
 * Exported pure functions (used by unit tests):
 *   extractSection   — regex section parser, no FS
 *   buildWorkList    — staged-file classifier, no FS
 *   formatPrompt     — Claude prompt builder, no FS
 */

import Anthropic         from '@anthropic-ai/sdk';
import * as fs           from 'node:fs';
import * as path         from 'node:path';
import { execSync }      from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');

// ── Config ─────────────────────────────────────────────────────────────────────

/** Files to skip — generated or entry-point boilerplate. */
export const SKIP = new Set(['road-data.ts', 'main.ts']);

/** Max files checked per commit — keeps hook latency under ~15 s. */
export const MAX_FILES = 5;

/** Model used for doc checks. Haiku: fast + cheap for high-frequency hooks. */
export const MODEL = 'claude-haiku-4-5';

// ── WorkItem type ───────────────────────────────────────────────────────────────

export interface WorkItem
{
  /** Absolute path to the TypeScript source file. */
  filePath:   string;
  /** Absolute path to the README that should document this file. */
  readmePath: string;
  /** Bare filename, e.g. "audio.ts". */
  filename:   string;
}

// ── Pure functions (unit-tested) ────────────────────────────────────────────────

/**
 * Extracts the `### \`filename\`` section from README markdown content.
 *
 * A section starts at the matching `###` heading and ends at the next `###`,
 * a `---` horizontal rule, or end-of-string — whichever comes first.
 *
 * Accepts headings with or without backticks around the filename.
 * Returns null if no matching heading exists.
 */
export function extractSection(content: string, filename: string): string | null
{
  // Escape regex metacharacters in the filename (dots, dashes are common)
  const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // No 'm' flag: $ must mean end-of-string, not end-of-line.
  // With 'm', $ matches after every newline, so the lazy [\s\S]*? stops
  // immediately at zero characters — capturing only the heading itself.
  const pattern = new RegExp(
    `(### \`?${escaped}\`?[\\s\\S]*?)(?=\\n### |\\n---\\n|$)`,
  );
  const match = content.match(pattern);
  return match ? match[1].trim() : null;
}

/**
 * Classifies a list of git-relative file paths into WorkItems.
 *
 * Rules:
 *   - src/*.ts  (excluding .d.ts and SKIP set) → src/README.md
 *   - tests/*.test.ts                           → tests/README.md
 *   - Everything else is ignored
 *
 * Results are capped at MAX_FILES.
 */
export function buildWorkList(staged: string[], root: string): WorkItem[]
{
  const items: WorkItem[] = [];

  for (const rel of staged)
  {
    if (items.length >= MAX_FILES) break;

    const filename = path.basename(rel);
    if (SKIP.has(filename)) continue;

    if (rel.startsWith('src/') && rel.endsWith('.ts') && !rel.endsWith('.d.ts'))
    {
      items.push({
        filePath:   path.join(root, rel),
        readmePath: path.join(root, 'src/README.md'),
        filename,
      });
    }
    else if (rel.startsWith('tests/') && rel.endsWith('.test.ts'))
    {
      items.push({
        filePath:   path.join(root, rel),
        readmePath: path.join(root, 'tests/README.md'),
        filename,
      });
    }
  }

  return items;
}

/**
 * Builds the Claude prompt that asks for undocumented delta.
 *
 * Source is truncated to 10 KB — enough to cover all exported API surface
 * while keeping token usage predictable.
 */
export function formatPrompt(filename: string, source: string, section: string): string
{
  const truncated = source.length > 10_000
    ? source.slice(0, 10_000) + '\n// ... (truncated)'
    : source;

  return `You are a documentation reviewer for a TypeScript game codebase.

Compare the source file \`${filename}\` against its README section and list anything in the source that the README does NOT mention: exported functions, classes, constants, interfaces, significant behaviors, or important design decisions.

Be concise — bullet points only, max 5 items. If the README fully covers the file, respond with exactly the word: OK

Source file \`${filename}\`:
<source>
${truncated}
</source>

README section for \`${filename}\`:
<readme>
${section}
</readme>`;
}

// ── I/O helpers ─────────────────────────────────────────────────────────────────

/** Returns staged file paths from `git diff --cached`, or [] on error. */
function getStagedFiles(): string[]
{
  try
  {
    const out = execSync('git diff --cached --name-only', { cwd: ROOT }).toString();
    return out.trim().split('\n').filter(Boolean);
  }
  catch { return []; }
}

/** Reads a README file and extracts the section for `filename`. */
function readReadmeSection(readmePath: string, filename: string): string | null
{
  try   { return extractSection(fs.readFileSync(readmePath, 'utf8'), filename); }
  catch { return null; }
}

// ── Claude diff call ────────────────────────────────────────────────────────────

/**
 * Compares one source file against its README section using the Claude API.
 *
 * Returns a formatted finding string, or null if docs are current.
 * Missing README section is treated as an undocumented finding.
 */
async function checkDelta(
  client:   Anthropic,
  item:     WorkItem,
): Promise<string | null>
{
  const source  = fs.readFileSync(item.filePath, 'utf8');
  const section = readReadmeSection(item.readmePath, item.filename);

  if (!section)
    return `⚠️  ${item.filename}: no README section found — add one to ${path.relative(ROOT, item.readmePath)}`;

  const response = await client.messages.create({
    model:      MODEL,
    max_tokens: 512,
    messages: [{ role: 'user', content: formatPrompt(item.filename, source, section) }],
  });

  const text = response.content[0].type === 'text'
    ? response.content[0].text.trim()
    : '';

  return text === 'OK' ? null : `📝  ${item.filename}\n${text}`;
}

// ── Main ────────────────────────────────────────────────────────────────────────

async function main(): Promise<void>
{
  if (!process.env.ANTHROPIC_API_KEY)
  {
    process.exit(0); // offline / CI without key — skip silently
  }

  const workList = buildWorkList(getStagedFiles(), ROOT);
  if (workList.length === 0) process.exit(0);

  const skipped  = Math.max(0, getStagedFiles().length - workList.length);
  const client   = new Anthropic();
  const findings: string[] = [];

  const results = await Promise.allSettled(
    workList.map(item => checkDelta(client, item)),
  );

  for (const result of results)
  {
    if (result.status === 'fulfilled' && result.value !== null)
      findings.push(result.value);
  }

  if (findings.length > 0 || skipped > 0)
  {
    console.error('\n── doc-delta ───────────────────────────────────────────────');
    findings.forEach(f => console.error('\n' + f));
    if (findings.length > 0) console.error('');
    if (skipped > 0)
      console.error(`(${skipped} more file(s) not checked — cap is ${MAX_FILES})`);
    console.error('Commit proceeds. Update READMEs when convenient.');
    console.error('────────────────────────────────────────────────────────────\n');
  }

  process.exit(0);
}

// Run only when executed directly — not when imported by tests.
// Vitest sets process.env.VITEST; tsx direct execution does not.
if (!process.env.VITEST) main();
