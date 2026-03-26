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
 *   - Skips generated files (road-data.ts)
 *   - Caps at 5 files per commit to keep latency reasonable
 *   - Runs staged files concurrently for speed
 *
 * Run manually:
 *   npx tsx scripts/check-doc-delta.ts
 */

import Anthropic                from '@anthropic-ai/sdk';
import * as crypto              from 'node:crypto';
import * as fs                  from 'node:fs';
import * as path                from 'node:path';
import { execSync }             from 'node:child_process';
import { fileURLToPath }        from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');

// ── Config ─────────────────────────────────────────────────────────────────────

// Generated or trivial files — not worth documenting
const SKIP = new Set(['road-data.ts', 'main.ts']);

// Max files checked per commit — keeps hook latency under ~15 s
const MAX_FILES = 5;

// Haiku 4.5: fast and cheap for a high-frequency pre-commit check.
// Swap to 'claude-opus-4-6' for deeper analysis if you prefer.
const MODEL = 'claude-haiku-4-5';

// ── Git helpers ─────────────────────────────────────────────────────────────────

function getStagedFiles(): string[]
{
  try
  {
    const out = execSync('git diff --cached --name-only', { cwd: ROOT }).toString();
    return out.trim().split('\n').filter(Boolean);
  }
  catch { return []; }
}

// ── README section extraction ───────────────────────────────────────────────────

/**
 * Extracts the section in `readmePath` whose heading contains `filename`.
 * Sections are delineated by `###` headings or `---` horizontal rules.
 * Returns null if no matching section is found.
 */
function readReadmeSection(readmePath: string, filename: string): string | null
{
  try
  {
    const content = fs.readFileSync(readmePath, 'utf8');
    // Match ### `filename` or ### filename (with or without backticks)
    const escaped = filename.replace('.', '\\.').replace('-', '\\-');
    const pattern = new RegExp(
      `(### \`?${escaped}\`?[\\s\\S]*?)(?=\\n### |\\n---\\n|$)`,
      'm',
    );
    const match = content.match(pattern);
    return match ? match[1].trim() : null;
  }
  catch { return null; }
}

// ── Claude diff call ────────────────────────────────────────────────────────────

/**
 * Asks Claude to compare a source file against its README section and return
 * a concise bullet list of undocumented items, or "OK" if docs are current.
 */
async function checkDelta(
  client:     Anthropic,
  filePath:   string,
  readmePath: string,
  filename:   string,
): Promise<string | null>
{
  const source  = fs.readFileSync(filePath, 'utf8');
  const section = readReadmeSection(readmePath, filename);

  if (!section)
    return `⚠️  ${filename}: no README section found — add one to ${path.relative(ROOT, readmePath)}`;

  // Truncate very large files — first 10 KB covers all exported API surface
  const truncated = source.length > 10_000
    ? source.slice(0, 10_000) + '\n// ... (truncated)'
    : source;

  const response = await client.messages.create({
    model:      MODEL,
    max_tokens: 512,
    messages: [{
      role:    'user',
      content: `You are a documentation reviewer for a TypeScript game codebase.

Compare the source file \`${filename}\` against its README section and list anything in the source that the README does NOT mention: exported functions, classes, constants, interfaces, significant behaviors, or important design decisions.

Be concise — bullet points only, max 5 items. If the README fully covers the file, respond with exactly the word: OK

Source file \`${filename}\`:
<source>
${truncated}
</source>

README section for \`${filename}\`:
<readme>
${section}
</readme>`,
    }],
  });

  const text = response.content[0].type === 'text'
    ? response.content[0].text.trim()
    : '';

  if (text === 'OK') return null;
  return `📝  ${filename}\n${text}`;
}

// ── Main ────────────────────────────────────────────────────────────────────────

async function main(): Promise<void>
{
  if (!process.env.ANTHROPIC_API_KEY)
  {
    // Offline / CI without key — skip silently, never block
    process.exit(0);
  }

  const staged = getStagedFiles();

  // Build work list: only src/*.ts and tests/*.test.ts, skip generated files
  type WorkItem = { filePath: string; readmePath: string; filename: string };
  const workList: WorkItem[] = [];

  for (const rel of staged)
  {
    const filename = path.basename(rel);
    if (SKIP.has(filename)) continue;

    if (rel.startsWith('src/') && rel.endsWith('.ts') && !rel.endsWith('.d.ts'))
    {
      workList.push({
        filePath:   path.join(ROOT, rel),
        readmePath: path.join(ROOT, 'src/README.md'),
        filename,
      });
    }
    else if (rel.startsWith('tests/') && rel.endsWith('.test.ts'))
    {
      workList.push({
        filePath:   path.join(ROOT, rel),
        readmePath: path.join(ROOT, 'tests/README.md'),
        filename,
      });
    }
  }

  if (workList.length === 0) process.exit(0);

  const capped  = workList.slice(0, MAX_FILES);
  const skipped = workList.length - capped.length;

  const client   = new Anthropic();
  const findings: string[] = [];

  // Run all checks concurrently
  const results = await Promise.allSettled(
    capped.map(({ filePath, readmePath, filename }) =>
      checkDelta(client, filePath, readmePath, filename),
    ),
  );

  for (const result of results)
  {
    if (result.status === 'fulfilled' && result.value !== null)
      findings.push(result.value);
    // API errors are non-fatal — silently skip
  }

  if (findings.length > 0 || skipped > 0)
  {
    console.error('\n── doc-delta ───────────────────────────────────────────────');

    if (findings.length > 0)
    {
      findings.forEach(f => console.error('\n' + f));
      console.error('');
    }

    if (skipped > 0)
      console.error(`(${skipped} more file(s) not checked — cap is ${MAX_FILES})`);

    console.error('Commit proceeds. Update READMEs when convenient.');
    console.error('────────────────────────────────────────────────────────────\n');
  }

  process.exit(0); // always exit 0 — warn only, never block
}

main();
