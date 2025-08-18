/**
 * HTML Report Generator (Functional)
 * Generates HTML formatted audit reports
 */

import { AuditResult, Violation } from '../types.js';

export interface HTMLReportConfig {
  theme?: 'light' | 'dark';
  includeCharts?: boolean;
  customCSS?: string;
}

/**
 * Generate an HTML report from audit results
 */
export function generateHTMLReport(
  result: AuditResult, 
  config?: HTMLReportConfig
): string {
  const theme = config?.theme || 'light';
  const css = getDefaultCSS(theme) + (config?.customCSS || '');
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Code Audit Report - ${new Date(result.timestamp).toLocaleDateString()}</title>
    <style>${css}</style>
</head>
<body>
    <div class="container">
        <header>
            <h1>Code Audit Report</h1>
            <p class="timestamp">Generated: ${new Date(result.timestamp).toLocaleString()}</p>
        </header>
        
        ${generateSummarySection(result)}
        ${generateViolationsSection(result)}
        ${generateMetadataSection(result)}
    </div>
</body>
</html>`;
}

/**
 * Generate the summary section
 */
function generateSummarySection(result: AuditResult): string {
  const { summary } = result;
  
  return `
    <section class="summary">
        <h2>Summary</h2>
        <div class="stats-grid">
            <div class="stat-card critical">
                <h3>${summary.criticalIssues}</h3>
                <p>Critical Issues</p>
            </div>
            <div class="stat-card warning">
                <h3>${summary.warnings}</h3>
                <p>Warnings</p>
            </div>
            <div class="stat-card suggestion">
                <h3>${summary.suggestions}</h3>
                <p>Suggestions</p>
            </div>
            <div class="stat-card total">
                <h3>${summary.totalViolations}</h3>
                <p>Total Violations</p>
            </div>
        </div>
        
        ${generateViolationsByCategoryChart(summary.violationsByCategory)}
    </section>`;
}

/**
 * Generate violations by category chart
 */
function generateViolationsByCategoryChart(violationsByCategory: Record<string, number>): string {
  const categories = Object.entries(violationsByCategory)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5);
  
  if (categories.length === 0) return '';
  
  return `
    <div class="category-chart">
        <h3>Top Violation Categories</h3>
        <div class="chart-bars">
            ${categories.map(([category, count]) => `
                <div class="chart-bar">
                    <div class="bar" style="width: ${(count / Math.max(...categories.map(([, c]) => c))) * 100}%">
                        <span class="count">${count}</span>
                    </div>
                    <span class="label">${category}</span>
                </div>
            `).join('')}
        </div>
    </div>`;
}

/**
 * Generate the violations section
 */
function generateViolationsSection(result: AuditResult): string {
  const allViolations: Array<Violation & { analyzer: string }> = [];
  
  for (const [analyzer, analyzerResult] of Object.entries(result.analyzerResults)) {
    for (const violation of analyzerResult.violations) {
      allViolations.push({ ...violation, analyzer });
    }
  }
  
  // Sort by severity
  const sortedViolations = allViolations.sort((a, b) => {
    const severityOrder = { critical: 3, warning: 2, suggestion: 1 };
    return severityOrder[b.severity] - severityOrder[a.severity];
  });
  
  return `
    <section class="violations">
        <h2>Violations</h2>
        <div class="violations-list">
            ${sortedViolations.map(violation => generateViolationCard(violation)).join('')}
        </div>
    </section>`;
}

/**
 * Generate a violation card
 */
function generateViolationCard(violation: Violation & { analyzer: string }): string {
  return `
    <div class="violation-card ${violation.severity}">
        <div class="violation-header">
            <span class="severity-badge">${violation.severity.toUpperCase()}</span>
            <span class="analyzer-badge">${violation.analyzer}</span>
            <span class="file-path">${violation.file}${violation.line ? `:${violation.line}` : ''}</span>
        </div>
        <div class="violation-body">
            <p class="message">${escapeHtml(violation.message)}</p>
            ${violation.recommendation ? `<p class="recommendation"><strong>Recommendation:</strong> ${escapeHtml(violation.recommendation)}</p>` : ''}
            ${violation.snippet ? `<pre class="code-snippet"><code>${escapeHtml(violation.snippet)}</code></pre>` : ''}
        </div>
    </div>`;
}

/**
 * Generate the metadata section
 */
function generateMetadataSection(result: AuditResult): string {
  const { metadata } = result;
  
  return `
    <section class="metadata">
        <h2>Audit Metadata</h2>
        <dl>
            <dt>Duration</dt>
            <dd>${metadata.auditDuration}ms</dd>
            
            <dt>Files Analyzed</dt>
            <dd>${metadata.filesAnalyzed}</dd>
            
            <dt>Analyzers Run</dt>
            <dd>${metadata.analyzersRun.join(', ')}</dd>
        </dl>
    </section>`;
}

/**
 * Get default CSS for the theme
 */
function getDefaultCSS(theme: 'light' | 'dark'): string {
  const themes = {
    light: {
      bg: '#ffffff',
      text: '#333333',
      border: '#e0e0e0',
      cardBg: '#f5f5f5',
      critical: '#d32f2f',
      warning: '#f57c00',
      suggestion: '#1976d2'
    },
    dark: {
      bg: '#1e1e1e',
      text: '#ffffff',
      border: '#333333',
      cardBg: '#2d2d2d',
      critical: '#f44336',
      warning: '#ff9800',
      suggestion: '#2196f3'
    }
  };
  
  const colors = themes[theme];
  
  return `
    body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
        background-color: ${colors.bg};
        color: ${colors.text};
        line-height: 1.6;
        margin: 0;
        padding: 0;
    }
    
    .container {
        max-width: 1200px;
        margin: 0 auto;
        padding: 2rem;
    }
    
    header {
        border-bottom: 2px solid ${colors.border};
        padding-bottom: 1rem;
        margin-bottom: 2rem;
    }
    
    h1 {
        margin: 0;
        font-size: 2.5rem;
    }
    
    .timestamp {
        color: ${colors.text}80;
        margin: 0.5rem 0 0;
    }
    
    .stats-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
        gap: 1rem;
        margin: 1rem 0;
    }
    
    .stat-card {
        background: ${colors.cardBg};
        padding: 1.5rem;
        border-radius: 8px;
        text-align: center;
        border: 1px solid ${colors.border};
    }
    
    .stat-card h3 {
        margin: 0;
        font-size: 2rem;
    }
    
    .stat-card p {
        margin: 0.5rem 0 0;
        font-size: 0.9rem;
        opacity: 0.8;
    }
    
    .stat-card.critical { border-left: 4px solid ${colors.critical}; }
    .stat-card.warning { border-left: 4px solid ${colors.warning}; }
    .stat-card.suggestion { border-left: 4px solid ${colors.suggestion}; }
    
    .violation-card {
        background: ${colors.cardBg};
        border: 1px solid ${colors.border};
        border-radius: 8px;
        padding: 1rem;
        margin-bottom: 1rem;
    }
    
    .violation-card.critical { border-left: 4px solid ${colors.critical}; }
    .violation-card.warning { border-left: 4px solid ${colors.warning}; }
    .violation-card.suggestion { border-left: 4px solid ${colors.suggestion}; }
    
    .violation-header {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        margin-bottom: 0.5rem;
        flex-wrap: wrap;
    }
    
    .severity-badge, .analyzer-badge {
        padding: 0.25rem 0.5rem;
        border-radius: 4px;
        font-size: 0.75rem;
        font-weight: bold;
    }
    
    .severity-badge {
        background: ${colors.critical}20;
        color: ${colors.critical};
    }
    
    .analyzer-badge {
        background: ${colors.suggestion}20;
        color: ${colors.suggestion};
    }
    
    .file-path {
        font-family: monospace;
        font-size: 0.875rem;
        opacity: 0.8;
        margin-left: auto;
    }
    
    .code-snippet {
        background: ${colors.bg};
        border: 1px solid ${colors.border};
        border-radius: 4px;
        padding: 1rem;
        overflow-x: auto;
        margin-top: 0.5rem;
    }
    
    .category-chart {
        margin-top: 2rem;
    }
    
    .chart-bars {
        margin-top: 1rem;
    }
    
    .chart-bar {
        display: flex;
        align-items: center;
        margin-bottom: 0.5rem;
    }
    
    .bar {
        background: ${colors.suggestion};
        height: 24px;
        border-radius: 4px;
        display: flex;
        align-items: center;
        justify-content: flex-end;
        padding-right: 0.5rem;
        margin-right: 0.5rem;
        min-width: 50px;
    }
    
    .bar .count {
        color: white;
        font-size: 0.875rem;
        font-weight: bold;
    }
    
    dl {
        display: grid;
        grid-template-columns: max-content 1fr;
        gap: 0.5rem 1rem;
    }
    
    dt {
        font-weight: bold;
    }
    
    dd {
        margin: 0;
    }
  `;
}

/**
 * Escape HTML special characters
 */
function escapeHtml(str: string): string {
  const htmlEscapes: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  };
  
  return str.replace(/[&<>"']/g, char => htmlEscapes[char]);
}

// Backwards compatibility export
export const HTMLReportGenerator = {
  generate: generateHTMLReport
};