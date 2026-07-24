/**
 * Spec 14 R5 — DOT and Mermaid Graph Output Formatting
 *
 * Zero rendering dependencies — just string emission.
 * Produces valid Graphviz DOT and Mermaid graph TD formats.
 */

import type { CallGraph } from './callGraph.js';
import type { ImportGraph } from './importGraph.js';

// ── Types ────────────────────────────────────────────────────────────────

export interface DotOptions {
  /** Graph label */
  label?: string;
  /** Node labels: nodeKey → display label */
  nodeLabels?: Map<string, string>;
  /** Community assignments for coloring: nodeKey → community ID */
  communities?: Map<string, number>;
  /** Legend toggle */
  legend?: boolean;
  /** Direction: TD (top-down) or LR (left-right) */
  rankdir?: 'TD' | 'LR';
  /** Max nodes to include (for large graphs) */
  maxNodes?: number;
  /** Show edge weights */
  showWeights?: boolean;
  /** Context depth (for risk neighborhood) */
  depth?: number;
}

export interface MermaidOptions {
  /** Graph label */
  label?: string;
  /** Node labels */
  nodeLabels?: Map<string, string>;
  /** Community assignments for styling */
  communities?: Map<string, number>;
  /** Max nodes */
  maxNodes?: number;
  /** Show edge weights */
  showWeights?: boolean;
}

// ── Color palette for communities ───────────────────────────────────────

const COMMUNITY_COLORS = [
  '#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f',
  '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac',
  '#86bcb6', '#8cd17d', '#d37295', '#b6992d', '#499894',
  '#e8a838', '#9d7660', '#bc80bd', '#dfc27d', '#a6611a',
];

function communityColor(communityId: number): string {
  return COMMUNITY_COLORS[communityId % COMMUNITY_COLORS.length];
}

// ── Node ID sanitization ────────────────────────────────────────────────

/** Sanitize an identifier for use in DOT/Mermaid output. */
function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, '_');
}

/** Truncate a label for display. */
function truncateLabel(label: string, maxLen: number = 60): string {
  if (label.length <= maxLen) return label;
  return label.substring(0, maxLen - 3) + '...';
}

function escapeLabel(label: string): string {
  return label.replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

// ── DOT output ──────────────────────────────────────────────────────────

/**
 * Emit a Graphviz DOT-format string for the given call graph.
 */
export function callGraphToDot(graph: CallGraph, options: DotOptions = {}): string {
  const {
    label,
    nodeLabels,
    communities,
    legend = true,
    rankdir = 'TB',
    maxNodes,
    showWeights = false,
    depth,
  } = options;

  const lines: string[] = [];
  lines.push(`digraph calls {`);
  if (label) lines.push(`  label="${escapeLabel(label)}";`);
  lines.push(`  rankdir=${rankdir};`);
  lines.push(`  node [shape=box, style=filled, fontname="Helvetica"];`);
  lines.push(`  edge [fontname="Helvetica", fontsize=10];`);

  const nodes = [...graph.nodeIds];
  const included = new Set<number>();

  // If depth is specified, only include the first maxNodes (already sorted by risk)
  if (maxNodes && maxNodes > 0) {
    for (let i = 0; i < Math.min(maxNodes, nodes.length); i++) {
      included.add(nodes[i]);
    }
  } else {
    for (const n of nodes) included.add(n);
  }

  // Emit nodes
  for (const nodeId of included) {
    const name = graph.nodeNames.get(nodeId) ?? String(nodeId);
    const labelText = nodeLabels?.get(String(nodeId)) ?? name;
    const comm = communities?.get(String(nodeId));
    const color = comm !== undefined ? communityColor(comm) : '#e0e0e0';
    const nodeIdStr = sanitizeId(`n${nodeId}`);

    lines.push(`  ${nodeIdStr} [label="${escapeLabel(truncateLabel(labelText))}", fillcolor="${color}"];`);
  }

  // Emit edges
  for (const [srcId, neighbors] of graph.adjacency) {
    if (!included.has(srcId)) continue;
    const srcStr = sanitizeId(`n${srcId}`);

    for (const [dstId, weight] of neighbors) {
      if (!included.has(dstId)) continue;
      const dstStr = sanitizeId(`n${dstId}`);
      const labelAttr = showWeights ? ` [label="${weight}"]` : '';
      lines.push(`  ${srcStr} -> ${dstStr}${labelAttr};`);
    }
  }

  // Legend
  if (legend && communities) {
    const uniqueComms = new Set(communities.values());
    lines.push(`  subgraph cluster_legend {`);
    lines.push(`    label="Communities";`);
    lines.push(`    style=filled;`);
    lines.push(`    color=lightgrey;`);
    for (const comm of uniqueComms) {
      const color = communityColor(comm);
      lines.push(`    legend_${comm} [label="Community ${comm}", shape=ellipse, fillcolor="${color}", fontsize=8];`);
    }
    lines.push(`  }`);
  }

  lines.push(`}`);
  return lines.join('\n') + '\n';
}

/**
 * Emit a Graphviz DOT-format string for the given import graph.
 */
export function importGraphToDot(graph: ImportGraph, options: DotOptions = {}): string {
  const {
    label,
    communities,
    legend = true,
    rankdir = 'TB',
    maxNodes,
    showWeights = false,
  } = options;

  const lines: string[] = [];
  lines.push(`digraph imports {`);
  if (label) lines.push(`  label="${escapeLabel(label)}";`);
  lines.push(`  rankdir=${rankdir};`);
  lines.push(`  node [shape=folder, style=filled, fontname="Helvetica"];`);
  lines.push(`  edge [fontname="Helvetica", fontsize=10];`);

  const files = [...graph.filePaths];
  const included = new Set<string>();

  if (maxNodes && maxNodes > 0) {
    for (let i = 0; i < Math.min(maxNodes, files.length); i++) {
      included.add(files[i]);
    }
  } else {
    for (const f of files) included.add(f);
  }

  // Emit nodes
  for (const filePath of included) {
    const comm = communities?.get(filePath);
    const color = comm !== undefined ? communityColor(comm) : '#e0e0e0';
    const nodeId = sanitizeId(filePath);
    // Show just filename for brevity
    const displayLabel = filePath.split('/').pop() ?? filePath;

    lines.push(`  ${nodeId} [label="${escapeLabel(displayLabel)}", fillcolor="${color}", tooltip="${escapeLabel(filePath)}"];`);
  }

  // Emit edges
  for (const [srcFile, neighbors] of graph.adjacency) {
    if (!included.has(srcFile)) continue;
    const srcId = sanitizeId(srcFile);

    for (const [dstFile, weight] of neighbors) {
      if (!included.has(dstFile)) continue;
      const dstId = sanitizeId(dstFile);
      if (srcId === dstId) continue;
      const labelAttr = showWeights ? ` [label="${weight}"]` : '';
      lines.push(`  ${srcId} -> ${dstId}${labelAttr};`);
    }
  }

  // Legend
  if (legend && communities) {
    const uniqueComms = new Set(communities.values());
    lines.push(`  subgraph cluster_legend {`);
    lines.push(`    label="Communities";`);
    lines.push(`    style=filled;`);
    lines.push(`    color=lightgrey;`);
    for (const comm of uniqueComms) {
      const color = communityColor(comm);
      lines.push(`    legend_${comm} [label="Community ${comm}", shape=ellipse, fillcolor="${color}", fontsize=8];`);
    }
    lines.push(`  }`);
  }

  lines.push(`}`);
  return lines.join('\n') + '\n';
}

// ── Mermaid output ──────────────────────────────────────────────────────

/**
 * Emit a Mermaid graph TD string for the given call graph.
 */
export function callGraphToMermaid(graph: CallGraph, options: MermaidOptions = {}): string {
  const { label, nodeLabels, communities, maxNodes, showWeights = false } = options;

  const lines: string[] = [];
  lines.push('```mermaid');
  lines.push('graph TD');
  if (label) lines.push(`  %% ${label}`);

  const nodes = [...graph.nodeIds];
  const included = new Set<number>();

  if (maxNodes && maxNodes > 0) {
    for (let i = 0; i < Math.min(maxNodes, nodes.length); i++) {
      included.add(nodes[i]);
    }
  } else {
    for (const n of nodes) included.add(n);
  }

  // Define community styles
  if (communities) {
    const uniqueComms = new Set(communities.values());
    for (const comm of uniqueComms) {
      const color = communityColor(comm);
      lines.push(`  classDef comm${comm} fill:${color},stroke:#333,stroke-width:1px;`);
    }
  }

  // Emit edges first (so they define nodes implicitly)
  for (const [srcId, neighbors] of graph.adjacency) {
    if (!included.has(srcId)) continue;
    const srcLabel = sanitizeId(`n${srcId}`);

    for (const [dstId, weight] of neighbors) {
      if (!included.has(dstId)) continue;
      const dstLabel = sanitizeId(`n${dstId}`);
      const weightStr = showWeights ? `|${weight}|` : ' --> ';
      const edgeStr = showWeights
        ? `  ${srcLabel} -- "${weight}" --> ${dstLabel}`
        : `  ${srcLabel} --> ${dstLabel}`;
      lines.push(edgeStr);
    }
  }

  // Emit node labels
  for (const nodeId of included) {
    const name = graph.nodeNames.get(nodeId) ?? String(nodeId);
    const labelText = nodeLabels?.get(String(nodeId)) ?? name;
    const nodeIdStr = sanitizeId(`n${nodeId}`);
    lines.push(`  ${nodeIdStr}["${escapeLabel(truncateLabel(labelText))}"]`);

    // Assign community class
    if (communities) {
      const comm = communities.get(String(nodeId));
      if (comm !== undefined) {
        lines.push(`  class ${nodeIdStr} comm${comm}`);
      }
    }
  }

  lines.push('```');
  return lines.join('\n') + '\n';
}

/**
 * Emit a Mermaid graph TD string for the given import graph.
 */
export function importGraphToMermaid(graph: ImportGraph, options: MermaidOptions = {}): string {
  const { label, communities, maxNodes, showWeights = false } = options;

  const lines: string[] = [];
  lines.push('```mermaid');
  lines.push('graph TD');
  if (label) lines.push(`  %% ${label}`);

  const files = [...graph.filePaths];
  const included = new Set<string>();

  if (maxNodes && maxNodes > 0) {
    for (let i = 0; i < Math.min(maxNodes, files.length); i++) {
      included.add(files[i]);
    }
  } else {
    for (const f of files) included.add(f);
  }

  // Define community styles
  if (communities) {
    const uniqueComms = new Set(communities.values());
    for (const comm of uniqueComms) {
      const color = communityColor(comm);
      lines.push(`  classDef comm${comm} fill:${color},stroke:#333,stroke-width:1px;`);
    }
  }

  // Emit edges
  for (const [srcFile, neighbors] of graph.adjacency) {
    if (!included.has(srcFile)) continue;
    const srcId = sanitizeId(srcFile);

    for (const [dstFile, weight] of neighbors) {
      if (!included.has(dstFile)) continue;
      const dstId = sanitizeId(dstFile);
      if (srcId === dstId) continue;

      if (showWeights) {
        lines.push(`  ${srcId} -- "${weight}" --> ${dstId}`);
      } else {
        lines.push(`  ${srcId} --> ${dstId}`);
      }
    }
  }

  // Emit node labels
  for (const filePath of included) {
    const nodeId = sanitizeId(filePath);
    const displayLabel = filePath.split('/').pop() ?? filePath;
    lines.push(`  ${nodeId}["${escapeLabel(displayLabel)}"]`);

    if (communities) {
      const comm = communities.get(filePath);
      if (comm !== undefined) {
        lines.push(`  class ${nodeId} comm${comm}`);
      }
    }
  }

  lines.push('```');
  return lines.join('\n') + '\n';
}
