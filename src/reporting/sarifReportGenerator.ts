/**
 * SARIF 2.1.0 Report Generator
 *
 * Produces valid SARIF output consumable by GitHub Code Scanning
 * (via github/codeql-action/upload-sarif).
 *
 * Spec 06 — R1: SARIF 2.1.0 emitter for code-auditor-mcp.
 */

import type { AuditResult, Violation } from '../types.js';
import { getFilesProcessed } from '../pipeline.js';
import { PACKAGE_VERSION } from '../constants.js';
import { fingerprint, buildFingerprintInput } from '../fingerprint.js';
import { execSync } from 'node:child_process';

// ── Constants ───────────────────────────────────────────────────────────────

const SARIF_SCHEMA =
  'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json';
const SARIF_VERSION = '2.1.0';
const TOOL_NAME = 'code-auditor-mcp';
const INFORMATION_URI = 'https://github.com/BenAHammond/code-auditor-mcp';

// ── Severity mapping (Spec 06 R1.4) ────────────────────────────────────────

const SEVERITY_TO_LEVEL: Record<string, string> = {
  critical: 'error',
  severe: 'error',
  high: 'note',
};

// ── Rule ID resolution ──────────────────────────────────────────────────────

/**
 * Resolves the stable rule identifier for a violation.
 * The format is `{analyzerName}/{ruleId}`.
 *
 * Precedence for the rule-id portion:
 *   1. `violation.rule`      (React, Universal Schema, Invariants)
 *   2. `violation.principle`  (SOLID)
 *   3. `violation.details.rule` (React — nested)
 *   4. `violation.type`       (DRY, Data Access, Dependency Graph)
 *   5. `violation.schemaType`  (Schema)
 *   6. `violation.violationType` (general fallback)
 *   7. `'unknown'`
 */
export function resolveRuleId(violation: Violation): string {
  if (violation.rule && typeof violation.rule === 'string') {
    return violation.rule;
  }
  if (violation.principle && typeof violation.principle === 'string') {
    return violation.principle;
  }
  if (
    violation.details &&
    typeof violation.details === 'object' &&
    !Array.isArray(violation.details) &&
    violation.details.rule &&
    typeof violation.details.rule === 'string'
  ) {
    return violation.details.rule;
  }
  if (violation.type && typeof violation.type === 'string') {
    return violation.type;
  }
  if (violation.schemaType && typeof violation.schemaType === 'string') {
    return violation.schemaType;
  }
  if (violation.violationType && typeof violation.violationType === 'string') {
    return violation.violationType;
  }
  return 'unknown';
}

/**
 * Builds the full SARIF rule ID: `{analyzerName}/{localRuleId}`.
 */
export function buildFullRuleId(analyzerName: string, violation: Violation): string {
  const localId = resolveRuleId(violation);
  const normName = normalizeAnalyzerName(analyzerName);
  // The analyzer may already emit a namespaced rule ID (e.g. `solid/class-size`);
  // don't double-prefix it into `solid/solid/class-size`.
  if (localId.startsWith(`${normName}/`)) return localId;
  return `${normName}/${localId}`;
}

/**
 * Normalizes analyzer names to short kebab-case identifiers.
 */
function normalizeAnalyzerName(name: string): string {
  const mapping: Record<string, string> = {
    'solid-analyzer': 'solid',
    'dry-analyzer': 'dry',
    'react-analyzer': 'react',
    'data-access-analyzer': 'data-access',
    'documentation-analyzer': 'documentation',
    'schema-analyzer': 'schema',
    'universal-schema-analyzer': 'universal-schema',
    'invariants-analyzer': 'invariants',
    'dependency-graph-analyzer': 'dependency-graph',
    'solid': 'solid',
    'dry': 'dry',
    'react': 'react',
    'data-access': 'data-access',
    'documentation': 'documentation',
    'schema': 'schema',
    'universal-schema': 'universal-schema',
    'invariants': 'invariants',
    'dependency-graph': 'dependency-graph',
  };
  return mapping[name] ?? name.replace(/[^a-z0-9-]/g, '-').toLowerCase();
}

// ── SARIF generation ────────────────────────────────────────────────────────

export interface SARIFReportConfig {
  /** Base path for making artifact URIs relative (default: process.cwd()) */
  rootDir?: string;
  /** Repository URI for `versionControlProvenance` (e.g. `https://github.com/owner/repo`). */
  repositoryUri?: string;
  /** Commit SHA for `versionControlProvenance` (e.g. `git rev-parse HEAD`). */
  revisionId?: string;
}

/**
 * Generates a SARIF 2.1.0 log string from an AuditResult.
 */
export function generateSARIFReport(result: AuditResult, config?: SARIFReportConfig): string {
  const rootDir = config?.rootDir ?? process.cwd();
  const driverRules: DriverRule[] = [];
  const seenRuleIds = new Set<string>();
  const results: SARIFResult[] = [];

  // Walk all analyzer results and build rules + results
  for (const [analyzerName, analyzerResult] of Object.entries(result.analyzerResults)) {
    const normName = normalizeAnalyzerName(analyzerName);

    for (const violation of analyzerResult.violations) {
      const fullRuleId = buildFullRuleId(analyzerName, violation);

      // Collect unique rules
      if (!seenRuleIds.has(fullRuleId)) {
        seenRuleIds.add(fullRuleId);
        const rule: DriverRule = {
          id: fullRuleId,
          shortDescription: {
            text: buildShortDescription(normName, resolveRuleId(violation)),
          },
          fullDescription: {
            text: violation.message,
          },
          helpUri: buildHelpUri(fullRuleId),
        };
        // Carry the remediation guidance on the rule so GitHub surfaces it as
        // per-rule help alongside the alert (Spec 06 R1.5).
        if (violation.suggestion) {
          rule.help = { text: violation.suggestion };
        }
        driverRules.push(rule);
      }

      // Build result
      const region: SARIFRegion = {};
      if (violation.line != null) {
        region.startLine = violation.line;
        region.endLine = violation.line;
      }
      // SARIF `startColumn` has `minimum: 1`; a 0-based or unknown column is not
      // representable. Omit it rather than clamping to 1 (Spec 06 R1.5).
      if (violation.column != null && violation.column >= 1) {
        region.startColumn = violation.column;
      }

      const artifactUri = makeRelativeUri(violation.file, rootDir);

      const sarifResult: SARIFResult = {
        ruleId: fullRuleId,
        level: mapSeverity(violation.severity),
        message: {
          text: buildResultMessage(violation),
        },
        locations: [
          {
            physicalLocation: {
              artifactLocation: {
                uri: artifactUri,
              },
              region: Object.keys(region).length > 0 ? region : undefined,
            },
          },
        ],
        partialFingerprints: buildPartialFingerprints(analyzerName, violation, artifactUri),
      };

      // Carry the suggestion as a machine-readable property. It is NOT emitted as
      // a `fixes` array — a SARIF fix requires `artifactChanges`, which we don't
      // produce, so a bare `fixes` entry is schema-invalid (Spec 06 R1.5).
      if (violation.suggestion) {
        sarifResult.properties = {
          ...sarifResult.properties,
          resolution: violation.suggestion,
        };
      }

      // Add baseline status as a property (Spec 18 R5)
      if (violation.new !== undefined) {
        sarifResult.properties = {
          ...sarifResult.properties,
          baseline: violation.new ? 'new' : 'known',
        };
      }

      // Add hotspot score as a property (Spec 13 R2)
      if (violation.hotspot !== undefined && violation.hotspot > 0) {
        sarifResult.properties = {
          ...sarifResult.properties,
          hotspot: String(Math.round(violation.hotspot * 1000) / 1000),
        };
      }

      results.push(sarifResult);
    }
  }

  // Build per-analyzer filesProcessed summary for run properties
  const analyzerFileCounts: Record<string, number> = {};
  for (const [analyzerName, analyzerResult] of Object.entries(result.analyzerResults)) {
    analyzerFileCounts[analyzerName] = getFilesProcessed(analyzerResult.status);
  }

  // Build the SARIF log
  const versionControlProvenance =
    config?.repositoryUri && config?.revisionId
      ? [{ repositoryUri: config.repositoryUri, revisionId: config.revisionId }]
      : undefined;

  const sarifLog = {
    $schema: SARIF_SCHEMA,
    version: SARIF_VERSION,
    runs: [
      {
        // `automationDetails.id` is parsed by GitHub as `category/run-id`: the
        // segment before the first `/` is the analysis category. A tool-scoped
        // category lets this tool's uploads coexist with other tools' uploads
        // (e.g. CodeQL) under distinct categories on GitHub.
        automationDetails: {
          id: `${TOOL_NAME}/${PACKAGE_VERSION}`,
        },
        ...(versionControlProvenance ? { versionControlProvenance } : {}),
        tool: {
          driver: {
            name: TOOL_NAME,
            version: PACKAGE_VERSION,
            informationUri: INFORMATION_URI,
            rules: driverRules,
          },
        },
        results,
        properties: {
          analyzerFilesProcessed: analyzerFileCounts,
          // Spec 57 — the dismissed count is reported alongside the total
          // (results.length), never subtracted from it.
          dismissed: result.summary.dismissed ?? 0,
        },
      },
    ],
  };

  return JSON.stringify(sarifLog, null, 2);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

interface DriverRule {
  id: string;
  shortDescription: { text: string };
  fullDescription: { text: string };
  helpUri?: string;
  help?: { text: string };
}

interface SARIFRegion {
  startLine?: number;
  endLine?: number;
  startColumn?: number;
}

interface SARIFResult {
  ruleId: string;
  level: string;
  message: { text: string };
  locations: Array<{
    physicalLocation: {
      artifactLocation: { uri: string };
      region?: SARIFRegion;
    };
  }>;
  partialFingerprints: Record<string, string>;
  properties?: Record<string, string>;
}

function mapSeverity(severity: string): string {
  return SEVERITY_TO_LEVEL[severity] ?? 'error';
}

function makeRelativeUri(filePath: string, rootDir: string): string {
  // Normalize and make relative to root directory
  const normalized = filePath.replace(/\\/g, '/');
  if (rootDir && normalized.startsWith(rootDir.replace(/\\/g, '/'))) {
    let relative = normalized.slice(rootDir.replace(/\\/g, '/').length);
    if (relative.startsWith('/')) {
      relative = relative.slice(1);
    }
    return relative || '.';
  }
  return normalized;
}

function buildShortDescription(analyzerName: string, ruleId: string): string {
  return `${analyzerName}: ${ruleId}`;
}

function buildHelpUri(fullRuleId: string): string {
  return `${INFORMATION_URI}#${fullRuleId.replace(/\//g, '-')}`;
}

function buildResultMessage(violation: Violation): string {
  if (!violation.suggestion) return violation.message;
  return `${violation.message}\n\nSuggested resolution: ${violation.suggestion}`;
}

function buildPartialFingerprints(_analyzerName: string, violation: Violation, relativeFile: string): Record<string, string> {
  // GitHub alert identity must be stable across checkouts and machines, so the
  // SARIF partial fingerprint is computed from the repo-relative path rather
  // than the absolute path that feeds the internal baseline fingerprint
  // (`fingerprint.ts`). The internal fingerprint is intentionally unchanged.
  const input = buildFingerprintInput(violation);
  const fp = fingerprint({ ...input, file: relativeFile });
  return {
    'primary': fp,
  };
}

/**
 * Best-effort read of version-control provenance for a SARIF run.
 *
 * `repositoryUri` is the `origin` remote and `revisionId` is the current HEAD
 * commit. Any failure (not a git repo, no commits, no remote) yields an empty
 * object — provenance is optional and must never break SARIF generation.
 */
export function readVersionControlProvenance(rootDir: string): { repositoryUri?: string; revisionId?: string } {
  const result: { repositoryUri?: string; revisionId?: string } = {};
  try {
    const rev = execSync('git rev-parse HEAD', { cwd: rootDir, stdio: 'pipe', timeout: 5000 })
      .toString()
      .trim();
    if (rev) result.revisionId = rev;
  } catch {
    // not a git repo, or no commits yet
  }
  try {
    const uri = execSync('git config --get remote.origin.url', { cwd: rootDir, stdio: 'pipe', timeout: 5000 })
      .toString()
      .trim();
    if (uri) result.repositoryUri = uri;
  } catch {
    // no origin remote
  }
  return result;
}

// ── Backward-compatible object export ────────────────────────────────────────

export const SARIFReportGenerator = {
  generate: generateSARIFReport,
};
