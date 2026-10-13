/**
 * Measure the pair-level verdict difference between ΔE76 (CIE76) and ΔE00
 * (CIEDE2000) across one pinned corpus, at JND-scaled thresholds (2.3 for ΔE76,
 * 1.0 for ΔE00) — colour directive item 3. Read-only.
 *
 * A "pair" is two distinct colour values of the same CSS property (the scope the
 * `styles/value-drift` rule clusters over). For each pair it reports:
 *
 *   - whether ΔE76 emits it (labDistance < 2.3) while ΔE00 declines (ciede2000
 *     >= 1.0), or vice versa;
 *   - both colours (raw value + file:line) and both ΔE values.
 *
 * Pairs the two metrics agree on (both emit, or both decline) are not reported.
 * If no pair differs, that is reported explicitly.
 *
 * Usage:
 *   npx tsx scripts/measure-color-metric-diff.ts /path/to/corpus
 */
import { readFile } from 'node:fs/promises';
import { initializeLanguages } from '../src/languages/index.js';
import { initParsers } from '../src/languages/tree-sitter/parser.js';
import { discoverFiles, ALL_EXTENSIONS } from '../src/utils/fileDiscovery.js';
import { buildStyleDeclarations, formatFor } from '../src/phase/runner.js';
import type { InputFile } from '../src/phase/runner.js';
import { CORPUS_PRODUCERS } from '../src/phase/producers.js';
import { labDistance, ciede2000 } from '../src/phase/colorMath.js';
import type { ColorValuesFact } from '../src/phase/types.js';
import { assertCorpusPinned } from './corpus-pins.js';

const projectRoot = process.argv[2];
if (!projectRoot) {
  console.error('usage: measure-color-metric-diff.ts <projectRoot>');
  process.exit(2);
}

// Corpus-integrity gate. A dirty or drifted corpus fails here before parsing.
assertCorpusPinned(projectRoot);

const JND_76 = 2.3; // ΔE76 just-noticeable difference (commonly cited ~2.3).
const JND_00 = 1.0; // ΔE00 just-noticeable difference (commonly cited ~1.0).

interface DifferingPair {
  property: string;
  a: ColorValuesFact;
  b: ColorValuesFact;
  d76: number;
  d00: number;
  /** true when ΔE76 emits (ΔE76 < 2.3) and ΔE00 declines (ΔE00 >= 1.0). */
  cie76Only: boolean;
}

function site(cv: ColorValuesFact): string {
  return `${cv.filePath}:${cv.line}`;
}

async function main(): Promise<void> {
  initializeLanguages();
  await initParsers();

  const paths = await discoverFiles(projectRoot, { extensions: ALL_EXTENSIONS });

  // Read only the style-bearing formats the `style-declarations` producer runs
  // on (the same six `formatFor` resolves to style facts), then feed them
  // `InputFile` objects — `buildStyleDeclarations` reads content, not paths.
  const STYLE_FORMATS = new Set(['css', 'scss', 'typescript', 'tsx', 'javascript', 'markup']);
  const inputs: InputFile[] = [];
  for (const p of paths) {
    if (!STYLE_FORMATS.has(formatFor(p))) continue;
    inputs.push({ path: p, content: await readFile(p, 'utf8') });
  }

  const facts = await buildStyleDeclarations(inputs, projectRoot);
  const colorValues = CORPUS_PRODUCERS['color-values'].process({ 'style-declarations': facts });

  // Group by property — the scope the rule clusters over.
  const byProperty = new Map<string, ColorValuesFact[]>();
  for (const cv of colorValues) {
    const arr = byProperty.get(cv.property);
    if (arr) arr.push(cv);
    else byProperty.set(cv.property, [cv]);
  }

  const differing: DifferingPair[] = [];

  for (const [property, decls] of byProperty) {
    // Distinct colours by exact sRGB, first declaration as representative.
    const distinct = new Map<string, ColorValuesFact>();
    for (const d of decls) {
      const key = d.rgb.join(',');
      if (!distinct.has(key)) distinct.set(key, d);
    }
    const values = [...distinct.values()];

    for (let i = 0; i < values.length; i += 1) {
      for (let j = i + 1; j < values.length; j += 1) {
        const a = values[i];
        const b = values[j];
        const d76 = labDistance(a.lab, b.lab);
        const d00 = ciede2000(a.lab, b.lab);
        const emit76 = d76 < JND_76;
        const emit00 = d00 < JND_00;
        if (emit76 === emit00) continue;
        differing.push({ property, a, b, d76, d00, cie76Only: emit76 });
      }
    }
  }

  const cie76Only = differing.filter((d) => d.cie76Only);
  const cie00Only = differing.filter((d) => !d.cie76Only);

  console.log(`colors extracted: ${colorValues.length} across ${byProperty.size} properties`);
  console.log(`differing pairs: ${differing.length} (ΔE76-only: ${cie76Only.length}, ΔE00-only: ${cie00Only.length})`);

  if (differing.length === 0) {
    console.log('NO PAIR DIFFERS between ΔE76 (2.3) and ΔE00 (1.0).');
    return;
  }

  const label = (d: DifferingPair) => (d.cie76Only ? 'CIE76-emits/CIEDE2000-declines' : 'CIEDE2000-emits/CIE76-declines');

  for (const d of differing) {
    console.log(
      `\n${label(d)}  property=${d.property}\n` +
        `  A "${d.a.rawValue}" @ ${site(d.a)}\n` +
        `  B "${d.b.rawValue}" @ ${site(d.b)}\n` +
        `  ΔE76=${d.d76.toFixed(4)}  ΔE00=${d.d00.toFixed(4)}`,
    );
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exitCode = 1;
});
