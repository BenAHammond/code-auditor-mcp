#!/usr/bin/env node
/**
 * verify-recall-value-drift.ts — the I/O half of the `verify:recall-value-drift`
 * gate.
 *
 * The retired gate diffed a stored baseline (a count plus a pair list) against
 * the current run. This replacement is an *invariant over the rule's own output*:
 * it builds a synthetic CSS fixture carrying one near-identical color pair the
 * rule must flag and two far colors it must decline, runs the real
 * `styles/value-drift` rule, then recomputes every pair's ΔE00 through the rule's
 * own distance function (`parseColorToRGB → rgbToLab → ciede2000`) — not by
 * trusting the finding message — and feeds the emitted + declined pairs to
 * `checkValueDriftInvariant` (the pure predicate in the `.core.mjs` half).
 *
 * The predicate asserts the one property the rule's name promises: an *emitted*
 * pair is always below `colorDeltaE`, and a *declined* pair is always at or above
 * it. A finding whose recomputed ΔE no longer clears the threshold, or a near
 * pair the rule failed to flag, both fail here. Exit 1 iff the invariant breaks.
 */
import { initializeLanguages, initParsers } from '../src/languages/index.js';
import { runStylesSlice } from '../src/phase/runner.js';
import { parseColorToRGB, rgbToLab, ciede2000 } from '../src/phase/colorMath.js';
import { DEFAULT_COLOR_DELTA_E } from '../src/config/defaults.js';
import { checkValueDriftInvariant } from './verify-recall-value-drift-core.mjs';

/** The rule's `colorDeltaE` default (`DEFAULT_COLOR_DELTA_E` in `config/defaults.ts`). */
const THRESHOLD = DEFAULT_COLOR_DELTA_E;

/**
 * Four colors on one color property: `#ffffff` / `#fefefe` are near-identical
 * (ΔE00 ≈ 0.20, below threshold — the rule must flag them); `#000000` / `#ff0000`
 * are far (ΔE00 ≫ threshold — the rule must decline every pair involving them).
 */
const FIXTURE = `.card { background-color: #ffffff; }
.muted { background-color: #fefefe; }
.dark { background-color: #000000; }
.danger { background-color: #ff0000; }
`;

/** The distinct colors in the fixture, in declaration order. */
const COLORS = ['#ffffff', '#fefefe', '#000000', '#ff0000'] as const;

/** The finding message shape emitted by `flagColorDriftMembers`. */
const DRIFT_MESSAGE_RE =
  /Color drift in "[^"]*": "([^"]+)" is near-identical to "([^"]+)" \(used \d+ times?, ΔE = ([0-9.]+)\)/;

/** ΔE00 via the rule's own distance function (never the finding's printed ΔE). */
function deltaE00(a: string, b: string): number {
  const rgbA = parseColorToRGB(a);
  const rgbB = parseColorToRGB(b);
  if (!rgbA || !rgbB) throw new Error(`unparseable fixture color: ${!rgbA ? a : b}`);
  return ciede2000(rgbToLab(rgbA), rgbToLab(rgbB));
}

async function main(): Promise<void> {
  initializeLanguages();
  await initParsers();

  const findings = await runStylesSlice([
    { path: '/tmp/ca-value-drift-fixture.css', content: FIXTURE },
  ]);

  // Emitted pairs — the pairs the rule flagged, each with a recomputed ΔE.
  const emitted: Array<{ drift: string; canonical: string; deltaE00: number }> = [];
  for (const f of findings) {
    if (f.ruleId !== 'styles/value-drift') continue;
    const m = DRIFT_MESSAGE_RE.exec(f.message);
    if (!m) throw new Error(`value-drift finding with unrecognized message: ${f.message}`);
    emitted.push({ drift: m[1], canonical: m[2], deltaE00: deltaE00(m[1], m[2]) });
  }

  const isEmittedPair = (a: string, b: string): boolean =>
    emitted.some((p) => (p.drift === a && p.canonical === b) || (p.drift === b && p.canonical === a));

  // Declined pairs — every distinct color pair the rule did not flag, each with
  // a recomputed ΔE. A near pair that lands here is a miss the invariant catches.
  const declined: Array<{ drift: string; canonical: string; deltaE00: number }> = [];
  for (let i = 0; i < COLORS.length; i++) {
    for (let j = i + 1; j < COLORS.length; j++) {
      const [a, b] = [COLORS[i], COLORS[j]];
      if (isEmittedPair(a, b)) continue;
      declined.push({ drift: a, canonical: b, deltaE00: deltaE00(a, b) });
    }
  }

  const drift = checkValueDriftInvariant({ emitted, declined, threshold: THRESHOLD });
  for (const line of drift) console.error(`value-drift invariant violated: ${line}`);
  if (drift.length > 0) process.exit(1);
  console.log(
    `value-drift invariant holds: ${emitted.length} emitted, ${declined.length} declined pair(s) at ΔE00 threshold ${THRESHOLD}.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
