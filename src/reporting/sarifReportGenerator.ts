/**
 * SARIF 2.1.0 Report Generator
 *
 * Produces valid SARIF output consumable by GitHub Code Scanning
 * (via github/codeql-action/upload-sarif).
 *
 * Spec 06 — R1: SARIF 2.1.0 emitter for code-auditor-mcp.
 */

import type { AuditResult, Violation } from '../types.js';
import { PACKAGE_VERSION } from '../constants.js';
import { fingerprint, buildFingerprintInput } from '../fingerprint.js';

// ── Constants ───────────────────────────────────────────────────────────────

const SARIF_SCHEMA =
  'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json';
const SARIF_VERSION = '2.1.0';
const TOOL_NAME = 'code-auditor-mcp';
const INFORMATION_URI = 'https://github.com/BenAHammond/code-auditor-mcp';

// ── Severity mapping (Spec 06 R1.4) ────────────────────────────────────────

const SEVERITY_TO_LEVEL: Record<string, string> = {
  critical: 'error',
  warning: 'warning',
  suggestion: 'note',
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
  return `${normalizeAnalyzerName(analyzerName)}/${localId}`;
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
    'cross-language-solid-analyzer': 'solid',
    'solid': 'solid',
    'dry': 'dry',
    'react': 'react',
    'data-access': 'data-access',
    'documentation': 'documentation',
    'schema': 'schema',
    'universal-schema': 'universal-schema',
    'invariants': 'invariants',
    'dependency-graph': 'dependency-graph',
    'cross-language-solid': 'solid',
  };
  return mapping[name] ?? name.replace(/[^a-z0-9-]/g, '-').toLowerCase();
}

// ── SARIF generation ────────────────────────────────────────────────────────

export interface SARIFReportConfig {
  /** Base path for making artifact URIs relative (default: process.cwd()) */
  rootDir?: string;
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
        driverRules.push({
          id: fullRuleId,
          shortDescription: {
            text: buildShortDescription(normName, resolveRuleId(violation)),
          },
          fullDescription: {
            text: violation.message,
          },
          helpUri: buildHelpUri(fullRuleId),
        });
      }

      // Build result
      const region: SARIFRegion = {};
      if (violation.line != null) {
        region.startLine = violation.line;
        region.endLine = violation.line;
      }
      if (violation.column != null) {
        region.startColumn = violation.column;
      }

      const artifactUri = makeRelativeUri(violation.file, rootDir);

      const sarifResult: SARIFResult = {
        ruleId: fullRuleId,
        level: mapSeverity(violation.severity),
        message: {
          text: violation.message,
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
        partialFingerprints: buildPartialFingerprints(analyzerName, violation),
      };

      // Add suggestion as a fix if present
      if (violation.suggestion) {
        sarifResult.fixes = [
          {
            description: {
              text: `Suggestion: ${violation.suggestion}`,
            },
          },
        ];
      }

      // Add baseline status as a property (Spec 18 R5)
      if (violation.new !== undefined) {
        sarifResult.properties = {
          ...sarifResult.properties,
          baseline: violation.new ? 'new' : 'known',
        };
      }

      results.push(sarifResult);
    }
  }

  // Build the SARIF log
  const sarifLog = {
    $schema: SARIF_SCHEMA,
    version: SARIF_VERSION,
    runs: [
      {
        tool: {
          driver: {
            name: TOOL_NAME,
            version: PACKAGE_VERSION,
            informationUri: INFORMATION_URI,
            rules: driverRules,
          },
        },
        results,
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
  fixes?: Array<{ description: { text: string } }>;
}

function mapSeverity(severity: string): string {
  return SEVERITY_TO_LEVEL[severity] ?? 'warning';
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

function buildPartialFingerprints(_analyzerName: string, violation: Violation): Record<string, string> {
  const fp = fingerprint(buildFingerprintInput(violation));
  return {
    'primary': fp,
  };
}

// ── Backward-compatible object export ────────────────────────────────────────

export const SARIFReportGenerator = {
  generate: generateSARIFReport,
};
