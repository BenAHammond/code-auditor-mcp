#!/usr/bin/env bash
set -euo pipefail

# Spec 28 Part C — Published Artifact Verification
#
# Installs the published code-auditor-mcp from npm in a scratch directory,
# runs a real audit against a fixture, and asserts headline features are
# observable in the published artifact:
#
#   C1. metadata.coverage present + non-empty with valid entries
#   C2. Path profiles active (violations carry `profile` field)
#   C3. Report root shape correct (all required keys)
#   C4. summary.totalViolations matches per-analyzer counts
#   C5. Analyzer status discriminants are valid
#
# Usage: ./scripts/verify-published-artifact.sh [version]
#   If no version specified, installs @latest.

SCRATCH=$(mktemp -d)
trap 'rm -rf "$SCRATCH"' EXIT

VERSION="${1:-latest}"
echo "=== Spec 28 Part C — Published Artifact Verification ==="
echo "Target: code-auditor-mcp@${VERSION}"
echo ""

# ── 1. Install published package ──────────────────────────────────────────
echo "1. Installing code-auditor-mcp@${VERSION} in scratch directory..."
cd "$SCRATCH"
npm init -y >/dev/null 2>&1
npm install "code-auditor-mcp@${VERSION}" --no-audit --no-fund >/dev/null 2>&1
INSTALLED_VERSION=$(node -e "console.log(require('./node_modules/code-auditor-mcp/package.json').version)")
echo "   Installed version: ${INSTALLED_VERSION}"

# ── 2. Create fixture project ─────────────────────────────────────────────
echo "2. Creating fixture project..."

mkdir -p src

cat > src/lib.ts << 'TSEOF'
/**
 * Sums an array of numbers.
 */
export function calculateTotal(items: number[]): number {
  let sum = 0;
  for (const item of items) sum += item;
  return sum;
}

// Undocumented export triggers function-documentation violation
export function formatResult(value: number): string {
  const prefix = "$";
  return prefix + value.toFixed(2);
}
TSEOF

# Spec file at project root triggers the built-in "scripts-and-tests" path profile
# (pattern "*.spec.*" matches filenames at the project root level).
# The violation on this file gets profile="scripts-and-tests" + severity capped to "suggestion".
cat > utils.spec.ts << 'TSEOF'
// Undocumented export in a spec file — triggers documentation violation
// with profile="scripts-and-tests" and severity capped to "suggestion"
// Body must be >= 5 lines to satisfy the universal analyzer's docsMinLines gate.
export function parseJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const result = JSON.parse(trimmed);
  return result;
}
TSEOF

cat > .codeauditor.json << 'JSONEOF'
{
  "enabledAnalyzers": ["documentation", "solid"],
  "includePaths": ["src/**/*.ts", "*.ts"],
  "excludePaths": ["**/node_modules/**", "**/*.test.ts"],
  "minSeverity": "suggestion",
  "analyzerConfigs": {
    "documentation": {
      "exemptPatterns": ["\\\\.d\\\\.ts$", "mock", "fixture"]
    }
  }
}
JSONEOF

# ── 3. Run audit ──────────────────────────────────────────────────────────
echo "3. Running audit against fixture..."
REPORT_FILE="audit-report.json"

# Use absolute project path; -o takes a directory
npx code-audit audit -p "$SCRATCH" -f json -o "$SCRATCH" 2>/dev/null

if [ ! -f "$SCRATCH/$REPORT_FILE" ]; then
  echo "   ERROR: Report not found at $SCRATCH/$REPORT_FILE"
  exit 1
fi

echo "   Report written: $SCRATCH/$REPORT_FILE"

# ── 4. Contract assertions (Node.js powered) ──────────────────────────────
echo "4. Verifying report shape against Spec 28 contract..."

node -e "
const fs = require('fs');
const report = JSON.parse(fs.readFileSync('$SCRATCH/$REPORT_FILE', 'utf-8'));

let passed = 0;
let failed = 0;

function assert(label, condition) {
  if (condition) { passed++; console.log('   ✓ ' + label); }
  else { failed++; console.error('   ✗ ' + label); }
}

// ── C1: Root keys ────────────────────────────────────────────────────────
assert('root has timestamp (string)', typeof report.timestamp === 'string');
assert('root has summary (object)', typeof report.summary === 'object');
assert('root has analyzerResults (object)', typeof report.analyzerResults === 'object');
assert('root has recommendations (array)', Array.isArray(report.recommendations));
assert('root has metadata (object)', typeof report.metadata === 'object');

// ── C2: metadata.coverage present and non-empty ──────────────────────────
const coverage = report.metadata.coverage;
assert('metadata.coverage is present', coverage !== undefined && coverage !== null);
assert('metadata.coverage is an array', Array.isArray(coverage));
assert('metadata.coverage is non-empty', Array.isArray(coverage) && coverage.length > 0);

if (Array.isArray(coverage) && coverage.length > 0) {
  const validStates = new Set(['fired', 'clean', 'notApplicable', 'unassessed']);
  // Validate shape of first 5 coverage entries
  for (let i = 0; i < Math.min(5, coverage.length); i++) {
    const c = coverage[i];
    assert('coverage[' + i + '] (' + c.ruleId + '): ruleId is string', typeof c.ruleId === 'string' && c.ruleId.length > 0);
    assert('coverage[' + i + '] (' + c.ruleId + '): analyzer is string', typeof c.analyzer === 'string' && c.analyzer.length > 0);
    assert('coverage[' + i + '] (' + c.ruleId + '): state=\"' + c.state + '\" is valid', validStates.has(c.state));
    assert('coverage[' + i + '] (' + c.ruleId + '): count is number', typeof c.count === 'number');
  }
  // All states valid
  const allStatesValid = coverage.every(c => validStates.has(c.state));
  assert('all coverage states are valid values', allStatesValid);

  // At least one 'notApplicable' entry has a non-empty reason
  const naWithReason = coverage.filter(c => c.state === 'notApplicable' && typeof c.reason === 'string' && c.reason.length > 0);
  const naTotal = coverage.filter(c => c.state === 'notApplicable');
  if (naTotal.length > 0) {
    assert('notApplicable entries include reason ('
      + naWithReason.length + '/' + naTotal.length + ')', naWithReason.length > 0);
  }
}

// ── C3: summary.totalViolations consistency ──────────────────────────────
const perAnalyzerSum = Object.values(report.analyzerResults || {})
  .reduce((s, ar) => s + (Array.isArray(ar.violations) ? ar.violations.length : 0), 0);
assert(
  'summary.totalViolations (' + report.summary.totalViolations
    + ') === sum of per-analyzer violations (' + perAnalyzerSum + ')',
  report.summary.totalViolations === perAnalyzerSum
);

assert('summary.totalViolations is a non-negative number',
  typeof report.summary.totalViolations === 'number' && report.summary.totalViolations >= 0);

// ── C4: Path profiles active ─────────────────────────────────────────────
const allViolations = Object.values(report.analyzerResults || {})
  .flatMap(ar => Array.isArray(ar.violations) ? ar.violations : []);
assert('at least one violation found (to verify profiles)',
  allViolations.length > 0);

const profileCount = allViolations.filter(v => typeof v.profile === 'string').length;
assert('path profiles active (' + profileCount + ' of ' + allViolations.length
    + ' violations have profile field)',
  profileCount > 0);

// ── C5: Analyzer status discriminants ────────────────────────────────────
const validDiscriminants = new Set(['visitor-ran', 'reducer-ran', 'notRun']);
const analyzerNames = Object.keys(report.analyzerResults || {});
assert('at least one analyzer in results', analyzerNames.length > 0);

for (const name of analyzerNames) {
  const ar = report.analyzerResults[name];
  assert('analyzer \"' + name + '\" has status object',
    ar.status !== undefined && ar.status !== null);
  assert('analyzer \"' + name + '\" status is \"' + (ar.status?.status || 'MISSING') + '\"',
    ar.status && validDiscriminants.has(ar.status.status));

  // Discriminant-specific fields
  if (ar.status?.status === 'visitor-ran') {
    assert('analyzer \"' + name + '\" visitor-ran: filesProcessed is number',
      typeof ar.status.filesProcessed === 'number');
  } else if (ar.status?.status === 'reducer-ran') {
    assert('analyzer \"' + name + '\" reducer-ran: factsConsumed is number',
      typeof ar.status.factsConsumed === 'number');
  }
  // notRun: reason checked elsewhere
}

// ── Summary ──────────────────────────────────────────────────────────────
console.log('');
console.log('─── Results ───');
console.log('  Version: ' + (report.metadata?.configUsed?.toolVersion || report.metadata?.toolVersion || '$INSTALLED_VERSION'));
console.log('  Files analyzed: ' + report.metadata?.filesAnalyzed);
console.log('  Total violations: ' + report.summary?.totalViolations);
console.log('  Coverage entries: ' + (Array.isArray(coverage) ? coverage.length : 0));
console.log('  Violations with profiles: ' + profileCount + '/' + allViolations.length);
console.log('───');
console.log('  ✓ Passed: ' + passed);
if (failed > 0) console.error('  ✗ Failed: ' + failed);
console.log('');

if (failed > 0) process.exit(1);
"

echo "=== Verification complete ==="
exit 0
