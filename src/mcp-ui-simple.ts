#!/usr/bin/env node

/**
 * Simple MCP-UI HTTP Server for Code Auditor
 * 
 * This provides HTTP endpoints that return UI resources for interactive dashboards
 * while reusing all the existing audit tool logic.
 */

import express from 'express';
import cors from 'cors';
import { randomUUID } from 'crypto';
import { createUIResource } from '@mcp-ui/server';
import { tools, uiTools, ToolHandlers } from './mcp-tools-shared.js';
import chalk from 'chalk';

const app: express.Application = express();
const PORT = process.env.MCP_UI_PORT || 3001;

// Middleware
app.use(express.json());
app.use(cors({
  origin: '*',
  exposedHeaders: ['Content-Type'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

/**
 * API endpoint to run audit and return UI resource
 */
app.post('/api/audit-dashboard', async (req, res) => {
  try {
    const args = req.body || {};
    
    // Run the audit using shared handler
    const auditResult = await ToolHandlers.handleAudit(args);
    
    // Create session-specific data storage key
    const sessionKey = randomUUID();
    
    // Store audit results for dashboard access
    global.auditSessions = global.auditSessions || new Map();
    global.auditSessions.set(sessionKey, {
      auditResult,
      timestamp: new Date().toISOString(),
      path: args.path || '.'
    });
    
    // Generate UI resource pointing to dashboard
    const uiResource = createUIResource({
      uri: `ui://code-auditor/dashboard/${sessionKey}`,
      content: {
        type: 'externalUrl',
        iframeUrl: `http://localhost:${PORT}/dashboard/${sessionKey}`
      },
      encoding: 'text'
    });
    
    res.json({
      success: true,
      uiResource,
      sessionKey,
      summary: auditResult.summary
    });
  } catch (error) {
    console.error(chalk.red('[API ERROR]'), 'Audit dashboard failed:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * API endpoint to run code map and return UI resource
 */
app.post('/api/code-map-viewer', async (req, res) => {
  try {
    const args = req.body || {};
    
    // Generate audit result to get code map
    const auditResult = await ToolHandlers.handleAudit({
      ...args,
      generateCodeMap: true,
      indexFunctions: true
    });
    
    const sessionKey = randomUUID();
    
    global.codeMapSessions = global.codeMapSessions || new Map();
    global.codeMapSessions.set(sessionKey, {
      codeMap: auditResult.codeMap,
      timestamp: new Date().toISOString(),
      path: args.path || '.'
    });
    
    const uiResource = createUIResource({
      uri: `ui://code-auditor/codemap/${sessionKey}`,
      content: {
        type: 'externalUrl',
        iframeUrl: `http://localhost:${PORT}/codemap/${sessionKey}`
      },
      encoding: 'text'
    });
    
    res.json({
      success: true,
      uiResource,
      sessionKey,
      codeMap: auditResult.codeMap?.summary
    });
  } catch (error) {
    console.error(chalk.red('[API ERROR]'), 'Code map viewer failed:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Dashboard route - serves the interactive audit dashboard
 */
app.get('/dashboard/:sessionKey', (req, res) => {
  const { sessionKey } = req.params;
  const sessionData = global.auditSessions?.get(sessionKey);
  
  if (!sessionData) {
    return res.status(404).send(`
      <html><body>
        <h1>Audit Session Not Found</h1>
        <p>Session key: ${sessionKey}</p>
        <p>This session may have expired or been cleaned up.</p>
      </body></html>
    `);
  }
  
  const { auditResult } = sessionData;
  const violations = ToolHandlers.getAllViolations(auditResult).slice(0, 50);
  
  // Enhanced dashboard HTML
  const dashboardHtml = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Code Audit Dashboard</title>
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #f8fafc; color: #2d3748; }
            .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
            .header { 
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
                color: white; padding: 30px; border-radius: 12px; margin-bottom: 30px; 
                box-shadow: 0 10px 25px rgba(0,0,0,0.1); 
            }
            .header h1 { font-size: 2.5rem; margin-bottom: 10px; }
            .header p { font-size: 1.1rem; opacity: 0.9; }
            .stats-grid { 
                display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); 
                gap: 20px; margin-bottom: 30px; 
            }
            .stat-card { 
                background: white; padding: 25px; border-radius: 12px; 
                box-shadow: 0 4px 15px rgba(0,0,0,0.08); border-left: 4px solid #667eea; 
                transition: transform 0.2s; 
            }
            .stat-card:hover { transform: translateY(-2px); }
            .stat-card h3 { color: #4a5568; margin-bottom: 15px; font-size: 1.1rem; }
            .stat-value { font-size: 2rem; font-weight: bold; color: #2d3748; margin-bottom: 5px; }
            .stat-label { color: #718096; font-size: 0.9rem; }
            .severity-critical { border-left-color: #e53e3e; }
            .severity-warning { border-left-color: #dd6b20; }
            .severity-info { border-left-color: #3182ce; }
            .violations-section { 
                background: white; border-radius: 12px; 
                box-shadow: 0 4px 15px rgba(0,0,0,0.08); overflow: hidden; 
            }
            .section-header { 
                background: #f7fafc; padding: 20px; border-bottom: 1px solid #e2e8f0; 
            }
            .section-header h2 { color: #2d3748; font-size: 1.5rem; }
            .filters { display: flex; gap: 10px; margin-top: 15px; flex-wrap: wrap; }
            .filter-btn { 
                padding: 8px 16px; border: 1px solid #e2e8f0; background: white; 
                border-radius: 6px; cursor: pointer; transition: all 0.2s; 
            }
            .filter-btn:hover, .filter-btn.active { 
                background: #667eea; color: white; border-color: #667eea; 
            }
            .violations-list { max-height: 600px; overflow-y: auto; }
            .violation { 
                padding: 20px; border-bottom: 1px solid #f1f5f9; transition: background 0.2s; 
            }
            .violation:hover { background: #f8fafc; }
            .violation:last-child { border-bottom: none; }
            .violation-title { 
                font-weight: 600; color: #2d3748; font-size: 1.1rem; margin-bottom: 5px; 
            }
            .violation-meta { 
                display: flex; gap: 15px; font-size: 0.9rem; color: #718096; margin-bottom: 10px; 
            }
            .violation-file { 
                font-family: 'Monaco', 'Menlo', monospace; background: #f7fafc; 
                padding: 4px 8px; border-radius: 4px; 
            }
            .severity-badge { 
                padding: 4px 8px; border-radius: 4px; font-size: 0.8rem; 
                font-weight: 600; text-transform: uppercase; 
            }
            .severity-critical { background: #fed7d7; color: #c53030; }
            .severity-warning { background: #feebc8; color: #c05621; }
            .severity-info { background: #bee3f8; color: #2c5aa0; }
            .recommendation { 
                background: #f0fff4; border: 1px solid #9ae6b4; border-radius: 6px; 
                padding: 12px; margin-top: 10px; 
            }
            .recommendation::before { content: "💡 "; font-size: 1.2rem; }
            .health-score { text-align: center; padding: 20px; }
            .health-circle { 
                width: 120px; height: 120px; border-radius: 50%; margin: 0 auto 15px; 
                display: flex; align-items: center; justify-content: center; 
                font-size: 2rem; font-weight: bold; color: white; 
            }
            .loading { text-align: center; padding: 40px; color: #718096; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>🔍 Code Audit Dashboard</h1>
                <p>Interactive analysis results for ${sessionData.path} • ${auditResult.summary?.filesAnalyzed || 0} files analyzed</p>
            </div>
            
            <div class="stats-grid">
                <div class="stat-card">
                    <h3>📊 Health Score</h3>
                    <div class="health-score">
                        <div class="health-circle" style="background: ${(auditResult.summary?.healthScore || 0) >= 80 ? '#48bb78' : (auditResult.summary?.healthScore || 0) >= 60 ? '#ed8936' : '#f56565'}">
                            ${auditResult.summary?.healthScore || 0}%
                        </div>
                        <div class="stat-label">Overall code quality</div>
                    </div>
                </div>
                
                <div class="stat-card severity-critical">
                    <h3>🚨 Critical Issues</h3>
                    <div class="stat-value">${auditResult.summary?.criticalIssues || 0}</div>
                    <div class="stat-label">Requires immediate attention</div>
                </div>
                
                <div class="stat-card severity-warning">
                    <h3>⚠️ Warnings</h3>
                    <div class="stat-value">${auditResult.summary?.warnings || 0}</div>
                    <div class="stat-label">Should be addressed</div>
                </div>
                
                <div class="stat-card severity-info">
                    <h3>💡 Suggestions</h3>
                    <div class="stat-value">${auditResult.summary?.suggestions || 0}</div>
                    <div class="stat-label">Improvement opportunities</div>
                </div>
            </div>
            
            <div class="violations-section">
                <div class="section-header">
                    <h2>🚨 Violations</h2>
                    <div class="filters">
                        <button class="filter-btn active" onclick="filterViolations('all')">All</button>
                        <button class="filter-btn" onclick="filterViolations('critical')">Critical</button>
                        <button class="filter-btn" onclick="filterViolations('warning')">Warnings</button>
                        <button class="filter-btn" onclick="filterViolations('info')">Info</button>
                    </div>
                </div>
                
                <div class="violations-list" id="violations-list">
                    ${violations.length === 0 ? '<div class="loading">No violations found! 🎉</div>' : 
                      violations.map(violation => `
                        <div class="violation" data-severity="${violation.severity}">
                            <div class="violation-title">${violation.message}</div>
                            <div class="violation-meta">
                                <span class="violation-file">${violation.file}:${violation.line}:${violation.column}</span>
                                <span class="severity-badge severity-${violation.severity}">${violation.severity}</span>
                                <span>Analyzer: ${violation.analyzer}</span>
                            </div>
                            ${violation.recommendation ? `<div class="recommendation">${violation.recommendation}</div>` : ''}
                        </div>
                      `).join('')}
                </div>
            </div>
        </div>
        
        <script>
            let allViolations = ${JSON.stringify(violations)};
            
            function filterViolations(severity) {
                const buttons = document.querySelectorAll('.filter-btn');
                buttons.forEach(btn => btn.classList.remove('active'));
                event.target.classList.add('active');
                
                const violationsList = document.getElementById('violations-list');
                let filteredViolations = severity === 'all' ? allViolations : allViolations.filter(v => v.severity === severity);
                
                violationsList.innerHTML = filteredViolations.length === 0 
                    ? '<div class="loading">No violations found for this filter.</div>'
                    : filteredViolations.map(violation => createViolationHTML(violation)).join('');
            }
            
            function createViolationHTML(violation) {
                return \`
                    <div class="violation" data-severity="\${violation.severity}">
                        <div class="violation-title">\${violation.message}</div>
                        <div class="violation-meta">
                            <span class="violation-file">\${violation.file}:\${violation.line}:\${violation.column}</span>
                            <span class="severity-badge severity-\${violation.severity}">\${violation.severity}</span>
                            <span>Analyzer: \${violation.analyzer}</span>
                        </div>
                        \${violation.recommendation ? \`<div class="recommendation">\${violation.recommendation}</div>\` : ''}
                    </div>
                \`;
            }
            
            console.log('🎯 Interactive Audit Dashboard Loaded');
            console.log('📊 Audit Data:', {
                totalViolations: ${auditResult.summary?.totalViolations || 0},
                healthScore: ${auditResult.summary?.healthScore || 0},
                filesAnalyzed: ${auditResult.summary?.filesAnalyzed || 0}
            });
        </script>
    </body>
    </html>
  `;
  
  res.send(dashboardHtml);
});

/**
 * Code map viewer route
 */
app.get('/codemap/:sessionKey', (req, res) => {
  const { sessionKey } = req.params;
  const sessionData = global.codeMapSessions?.get(sessionKey);
  
  if (!sessionData) {
    return res.status(404).send(`
      <html><body>
        <h1>Code Map Session Not Found</h1>
        <p>Session key: ${sessionKey}</p>
      </body></html>
    `);
  }
  
  const { codeMap } = sessionData;
  
  const codeMapHtml = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Interactive Code Map</title>
        <style>
            body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
            .header { background: #059669; color: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; }
            .content { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
            pre { background: #f8f9fa; padding: 15px; border-radius: 4px; overflow-x: auto; }
        </style>
    </head>
    <body>
        <div class="header">
            <h1>🗺️ Interactive Code Map</h1>
            <p>Navigable codebase structure and analysis</p>
        </div>
        
        <div class="content">
            <h2>📊 Map Summary</h2>
            <p><strong>Map ID:</strong> ${codeMap?.mapId || 'N/A'}</p>
            <p><strong>Total Sections:</strong> ${codeMap?.summary?.totalSections || 0}</p>
            
            <h2>🔍 Quick Preview</h2>
            <pre>${codeMap?.quickPreview || 'No preview available'}</pre>
            
            ${codeMap?.summary?.sectionsAvailable ? `
            <h2>📑 Available Sections</h2>
            ${codeMap.summary.sectionsAvailable.map(section => `
                <div style="margin: 10px 0; padding: 10px; background: #f8f9fa; border-radius: 4px;">
                    <strong>${section.type}</strong> (${section.size} characters)<br>
                    <em>${section.description}</em>
                </div>
            `).join('')}
            ` : ''}
        </div>
        
        <script>
            console.log('🗺️ Code Map Viewer Loaded');
        </script>
    </body>
    </html>
  `;
  
  res.send(codeMapHtml);
});

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    mode: 'ui-server'
  });
});

/**
 * API endpoint to get audit data as JSON
 */
app.get('/api/audit/:sessionKey', (req, res) => {
  const { sessionKey } = req.params;
  const sessionData = global.auditSessions?.get(sessionKey);
  
  if (!sessionData) {
    return res.status(404).json({ error: 'Audit session not found' });
  }
  
  res.json(sessionData);
});

/**
 * Start the MCP-UI HTTP server
 */
export function startMcpUIServer() {
  app.listen(PORT, () => {
    console.error(chalk.green('🚀 MCP-UI Code Auditor Server running on'), chalk.cyan(`http://localhost:${PORT}`));
    console.error(chalk.blue('📡 API endpoints:'));
    console.error(chalk.blue('  POST'), chalk.cyan(`http://localhost:${PORT}/api/audit-dashboard`));
    console.error(chalk.blue('  POST'), chalk.cyan(`http://localhost:${PORT}/api/code-map-viewer`));
    console.error(chalk.blue('❤️  Health check:'), chalk.cyan(`http://localhost:${PORT}/health`));
    console.error(chalk.gray('Ready to serve interactive audit interfaces...'));
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.error(chalk.yellow('\n🛑 Shutting down MCP-UI server...'));
    process.exit(0);
  });
}

// Declare global session storage types
declare global {
  var auditSessions: Map<string, {
    auditResult: any;
    timestamp: string;
    path: string;
  }>;
  var codeMapSessions: Map<string, {
    codeMap: any;
    timestamp: string;
    path: string;
  }>;
}

// Start the server if this file is run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  startMcpUIServer();
}

export { app };