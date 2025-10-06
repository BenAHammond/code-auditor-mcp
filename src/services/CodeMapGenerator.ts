/**
 * Code Map Generator
 * Processes indexed code data into human-readable terminal-friendly maps
 */

import { getAllFunctions, getDatabase } from '../codeIndexService.js';
import { EnhancedFunctionMetadata } from '../types.js';
import { DocumentationMetrics } from '../analyzers/documentationAnalyzer.js';
import path from 'path';
import { randomBytes } from 'crypto';

export interface CodeMapOptions {
  includeComplexity?: boolean;
  includeDocumentation?: boolean;
  includeDependencies?: boolean;
  includeUsage?: boolean;
  maxDepth?: number;
  groupByDirectory?: boolean;
  showUnusedImports?: boolean;
  minComplexity?: number;
}

export interface CodeMapStats {
  totalFiles: number;
  totalFunctions: number;
  totalComponents: number;
  averageComplexity: number;
  highComplexityCount: number;
  unusedImports: number;
  documentationCoverage?: number;
  lastIndexed: Date | null;
}

export interface FileGroup {
  directory: string;
  files: FileMapInfo[];
  stats: {
    functionCount: number;
    componentCount: number;
    averageComplexity: number;
    documentationScore: number;
  };
}

export interface FileMapInfo {
  path: string;
  relativePath: string;
  functions: FunctionMapInfo[];
  components: FunctionMapInfo[];
  lineCount: number;
  complexity: number;
  unusedImports: string[];
  documentationScore: number;
}

export interface FunctionMapInfo {
  name: string;
  line: number;
  complexity?: number;
  purpose?: string;
  parameters?: string[];
  hooks?: string[];
  dependencies?: string[];
  usedBy?: string[];
  calls?: string[];
  isExported?: boolean;
  componentType?: string;
  hasDocumentation?: boolean;
}

export interface DependencyInfo {
  name: string;
  version?: string;
  usageCount: number;
  usedBy: string[];
  unusedInFiles: string[];
}

export class CodeMapGenerator {

  /**
   * Generates a complete code map for the project
   */
  async generateCodeMap(
    projectPath: string, 
    options: CodeMapOptions = {}
  ): Promise<{
    stats: CodeMapStats;
    fileGroups: FileGroup[];
    dependencies: DependencyInfo[];
    documentation?: DocumentationMetrics;
  }> {
    const functions = await getAllFunctions();
    const stats = this.calculateProjectStats(functions);
    
    // Group functions by files and directories
    const fileMap = this.groupFunctionsByFile(functions);
    const fileGroups = options.groupByDirectory 
      ? this.groupFilesByDirectory(fileMap, projectPath)
      : [{ directory: '.', files: Object.values(fileMap), stats: this.calculateGroupStats(Object.values(fileMap)) }];
    
    // Analyze dependencies
    const dependencies = this.analyzeDependencies(functions);
    
    return {
      stats,
      fileGroups,
      dependencies
    };
  }

  /**
   * Generates a paginated code map and stores sections in database
   * Returns summary with section references
   */
  async generatePaginatedCodeMap(
    projectPath: string,
    options: CodeMapOptions = {}
  ): Promise<{
    mapId: string;
    summary: {
      stats: CodeMapStats;
      sectionsAvailable: Array<{type: string, description: string, size: number}>;
      totalSections: number;
    };
    quickPreview: string;
  }> {
    // Generate the full code map data
    const fullMap = await this.generateCodeMap(projectPath, options);
    
    // Generate unique map ID
    const mapId = 'map_' + randomBytes(8).toString('hex');
    
    // Get database instance
    const db = await getDatabase();
    
    // Break into sections and store each
    const sections = await this.createCodeMapSections(fullMap, options);
    const sectionInfo: Array<{type: string, description: string, size: number}> = [];
    
    for (const [sectionType, content] of Object.entries(sections)) {
      await db.storeCodeMapSection(mapId, sectionType, content.text, content.metadata);
      sectionInfo.push({
        type: sectionType,
        description: content.description,
        size: content.text.length
      });
    }
    
    // Create quick preview (first ~1000 chars)
    const quickPreview = this.createQuickPreview(fullMap, 1000);
    
    return {
      mapId,
      summary: {
        stats: fullMap.stats,
        sectionsAvailable: sectionInfo,
        totalSections: sectionInfo.length
      },
      quickPreview
    };
  }

  /**
   * Formats the code map as terminal-friendly text
   */
  formatAsText(codeMap: Awaited<ReturnType<CodeMapGenerator['generateCodeMap']>>, options: CodeMapOptions = {}): string {
    const lines: string[] = [];
    
    // Header
    lines.push('📖 CODEBASE GUIDE');
    lines.push('');
    
    // Overview stats
    lines.push('🎯 STRUCTURE OVERVIEW');
    lines.push(`Files: ${codeMap.stats.totalFiles} | Functions: ${codeMap.stats.totalFunctions} | Components: ${codeMap.stats.totalComponents}`);
    lines.push(`Avg Complexity: ${codeMap.stats.averageComplexity.toFixed(1)} | High Complexity: ${codeMap.stats.highComplexityCount} functions`);
    
    if (options.includeDocumentation && codeMap.documentation) {
      lines.push(`Documentation Coverage: ${codeMap.documentation.coverageScore}%`);
    }
    
    if (codeMap.stats.lastIndexed) {
      const timeAgo = this.formatTimeAgo(codeMap.stats.lastIndexed);
      lines.push(`Last indexed: ${timeAgo}`);
    }
    
    lines.push('');
    
    // File groups (directories)
    lines.push('📁 Core Architecture:');
    lines.push('');
    
    for (const group of codeMap.fileGroups) {
      if (group.directory !== '.') {
        lines.push(`📁 ${group.directory}/`);
        lines.push(`├── Functions: ${group.stats.functionCount} | Components: ${group.stats.componentCount}`);
        lines.push(`├── Avg Complexity: ${group.stats.averageComplexity.toFixed(1)} | Documentation: ${group.stats.documentationScore.toFixed(0)}%`);
        lines.push('│');
      }
      
      // Files in this group
      for (const file of group.files.slice(0, options.maxDepth || 10)) {
        const indent = group.directory !== '.' ? '│   ' : '';
        lines.push(`${indent}📄 ${file.relativePath}${file.lineCount ? ` [Lines: ${file.lineCount}]` : ''}`);
        
        // Show complexity warning if high
        if (file.complexity > (options.minComplexity || 7)) {
          lines.push(`${indent}│   ⚠️  High complexity: ${file.complexity.toFixed(1)}`);
        }
        
        // Components
        if (file.components.length > 0) {
          for (const component of file.components) {
            lines.push(`${indent}│   └── 🔧 ${component.name}()${component.componentType ? ` [${component.componentType}]` : ''}`);
            
            if (component.parameters && component.parameters.length > 0) {
              lines.push(`${indent}│       ├── Props: ${component.parameters.join(', ')}`);
            }
            
            if (options.includeComplexity && component.complexity) {
              lines.push(`${indent}│       ├── Complexity: ${component.complexity.toFixed(1)}`);
            }
            
            if (component.hooks && component.hooks.length > 0) {
              lines.push(`${indent}│       ├── Hooks: ${component.hooks.join(', ')}`);
            }
            
            if (options.includeUsage && component.usedBy && component.usedBy.length > 0) {
              const usageCount = component.usedBy.length;
              const usagePreview = component.usedBy.slice(0, 3).join(', ');
              const usageText = usageCount > 3 ? `${usagePreview} (${usageCount} total)` : usagePreview;
              lines.push(`${indent}│       ├── Used by: ${usageText}`);
            }
            
            if (options.includeDocumentation) {
              const docStatus = component.hasDocumentation ? 'Good' : 'Missing';
              lines.push(`${indent}│       └── 📝 Documentation: ${docStatus}`);
            }
            
            if (component.purpose) {
              lines.push(`${indent}│       └── Context: "${component.purpose}"`);
            }
          }
        }
        
        // Regular functions (non-components)
        const regularFunctions = file.functions.filter(f => !file.components.find(c => c.name === f.name));
        if (regularFunctions.length > 0) {
          for (const func of regularFunctions.slice(0, 5)) { // Limit to avoid clutter
            lines.push(`${indent}│   └── 🔧 ${func.name}()`);
            
            if (func.purpose) {
              lines.push(`${indent}│       └── "${func.purpose}"`);
            }
            
            if (options.includeUsage && func.calls && func.calls.length > 0) {
              lines.push(`${indent}│       └── Calls: ${func.calls.slice(0, 3).join(', ')}`);
            }
          }
          
          if (regularFunctions.length > 5) {
            lines.push(`${indent}│   └── ... ${regularFunctions.length - 5} more functions`);
          }
        }
        
        // Unused imports warning
        if (options.showUnusedImports && file.unusedImports.length > 0) {
          lines.push(`${indent}│   ⚠️  Unused imports: ${file.unusedImports.join(', ')}`);
        }
        
        lines.push(`${indent}│`);
      }
      
      lines.push('');
    }
    
    // Dependencies section
    if (options.includeDependencies && codeMap.dependencies.length > 0) {
      lines.push('🔗 DEPENDENCIES');
      lines.push('');
      
      const sortedDeps = codeMap.dependencies
        .sort((a, b) => b.usageCount - a.usageCount)
        .slice(0, 10);
      
      for (const dep of sortedDeps) {
        lines.push(`├── ${dep.name}${dep.version ? ` (${dep.version})` : ''} → ${dep.usageCount} functions`);
        
        if (dep.unusedInFiles.length > 0) {
          lines.push(`│   └── ⚠️ Unused in: ${dep.unusedInFiles.slice(0, 3).join(', ')}`);
        }
      }
      
      lines.push('');
    }
    
    // Documentation section
    if (options.includeDocumentation && codeMap.documentation) {
      lines.push('📝 DOCUMENTATION QUALITY');
      lines.push('');
      lines.push(`├── Functions with JSDoc: ${codeMap.documentation.documentedFunctions}/${codeMap.documentation.totalFunctions} (${Math.round((codeMap.documentation.documentedFunctions / codeMap.documentation.totalFunctions) * 100)}%)`);
      lines.push(`├── Components documented: ${codeMap.documentation.documentedComponents}/${codeMap.documentation.totalComponents} (${Math.round((codeMap.documentation.documentedComponents / codeMap.documentation.totalComponents) * 100)}%)`);
      lines.push(`├── Files with purpose: ${codeMap.documentation.filesWithPurpose}/${codeMap.documentation.totalFiles} (${Math.round((codeMap.documentation.filesWithPurpose / codeMap.documentation.totalFiles) * 100)}%)`);
      
      if (codeMap.documentation.wellDocumentedFiles.length > 0) {
        lines.push(`└── Well documented: ${codeMap.documentation.wellDocumentedFiles.slice(0, 3).map(f => path.basename(f)).join(', ')}`);
      }
      
      lines.push('');
    }
    
    // Issues summary
    const issues: string[] = [];
    if (codeMap.stats.highComplexityCount > 0) {
      issues.push(`${codeMap.stats.highComplexityCount} functions with high complexity`);
    }
    if (codeMap.stats.unusedImports > 0) {
      issues.push(`${codeMap.stats.unusedImports} unused imports`);
    }
    
    if (issues.length > 0) {
      lines.push('⚠️  ATTENTION NEEDED:');
      issues.forEach(issue => lines.push(`├── ${issue}`));
      lines.push('');
    }
    
    return lines.join('\n');
  }

  private calculateProjectStats(functions: EnhancedFunctionMetadata[]): CodeMapStats {
    const fileSet = new Set(functions.map(f => f.filePath));
    const complexities = functions.map(f => {
      const complexity = f.complexity || (f.metadata as any)?.complexity || 0;
      return typeof complexity === 'number' ? complexity : 0;
    }).filter(c => c > 0);
    const averageComplexity = complexities.length > 0 
      ? complexities.reduce((sum, c) => sum + c, 0) / complexities.length 
      : 0;
    
    return {
      totalFiles: fileSet.size,
      totalFunctions: functions.filter(f => (f.metadata?.entityType || 'function') === 'function').length,
      totalComponents: functions.filter(f => (f.metadata?.entityType) === 'component').length,
      averageComplexity,
      highComplexityCount: complexities.filter(c => c > 7).length,
      unusedImports: functions.reduce((sum, f) => sum + (f.metadata?.unusedImports?.length || 0), 0),
      lastIndexed: functions.length > 0 ? new Date() : null
    };
  }

  private groupFunctionsByFile(functions: EnhancedFunctionMetadata[]): Record<string, FileMapInfo> {
    const fileMap: Record<string, FileMapInfo> = {};
    
    for (const func of functions) {
      if (!fileMap[func.filePath]) {
        fileMap[func.filePath] = {
          path: func.filePath,
          relativePath: path.relative(process.cwd(), func.filePath),
          functions: [],
          components: [],
          lineCount: 0,
          complexity: 0,
          unusedImports: func.metadata?.unusedImports || [],
          documentationScore: 0
        };
      }
      
      const file = fileMap[func.filePath];
      const funcInfo: FunctionMapInfo = {
        name: func.name,
        line: func.lineNumber,
        complexity: func.complexity || (func.metadata as any)?.complexity,
        purpose: func.purpose,
        parameters: func.parameters?.map(p => p.name),
        hooks: func.metadata?.hooks?.map(h => h.name),
        dependencies: func.dependencies,
        usedBy: func.metadata?.calledBy,
        calls: func.metadata?.functionCalls,
        isExported: (func.metadata as any)?.isExported,
        componentType: func.metadata?.componentType,
        hasDocumentation: !!(func.jsDoc?.description || (func.metadata as any)?.jsDoc)
      };
      
      if (func.metadata?.entityType === 'component') {
        file.components.push(funcInfo);
      } else {
        file.functions.push(funcInfo);
      }
      
      // Update file stats
      file.lineCount = Math.max(file.lineCount, func.endLine || func.lineNumber);
      file.complexity = Math.max(file.complexity, func.complexity || (func.metadata as any)?.complexity || 0);
    }
    
    // Calculate documentation scores
    for (const file of Object.values(fileMap)) {
      const allFunctions = [...file.functions, ...file.components];
      const documented = allFunctions.filter(f => f.hasDocumentation).length;
      file.documentationScore = allFunctions.length > 0 ? (documented / allFunctions.length) * 100 : 100;
    }
    
    return fileMap;
  }

  private groupFilesByDirectory(fileMap: Record<string, FileMapInfo>, projectPath: string): FileGroup[] {
    const groups: Record<string, FileGroup> = {};
    
    for (const file of Object.values(fileMap)) {
      const directory = path.dirname(file.relativePath);
      const cleanDir = directory === '.' ? '.' : directory.split('/')[0];
      
      if (!groups[cleanDir]) {
        groups[cleanDir] = {
          directory: cleanDir,
          files: [],
          stats: { functionCount: 0, componentCount: 0, averageComplexity: 0, documentationScore: 0 }
        };
      }
      
      groups[cleanDir].files.push(file);
    }
    
    // Calculate group stats
    for (const group of Object.values(groups)) {
      group.stats = this.calculateGroupStats(group.files);
    }
    
    return Object.values(groups).sort((a, b) => a.directory.localeCompare(b.directory));
  }

  private calculateGroupStats(files: FileMapInfo[]) {
    const functionCount = files.reduce((sum, f) => sum + f.functions.length, 0);
    const componentCount = files.reduce((sum, f) => sum + f.components.length, 0);
    const complexities = files.map(f => f.complexity).filter(c => c > 0);
    const averageComplexity = complexities.length > 0 
      ? complexities.reduce((sum, c) => sum + c, 0) / complexities.length 
      : 0;
    const averageDocScore = files.length > 0 
      ? files.reduce((sum, f) => sum + f.documentationScore, 0) / files.length 
      : 0;
    
    return {
      functionCount,
      componentCount,
      averageComplexity,
      documentationScore: averageDocScore
    };
  }

  private analyzeDependencies(functions: EnhancedFunctionMetadata[]): DependencyInfo[] {
    const depMap: Record<string, DependencyInfo> = {};
    
    for (const func of functions) {
      // External dependencies
      if (func.dependencies) {
        for (const dep of func.dependencies) {
          if (!depMap[dep]) {
            depMap[dep] = {
              name: dep,
              usageCount: 0,
              usedBy: [],
              unusedInFiles: []
            };
          }
          
          depMap[dep].usageCount++;
          depMap[dep].usedBy.push(`${func.name} (${path.basename(func.filePath)})`);
        }
      }
      
      // Unused imports
      if (func.metadata?.unusedImports) {
        for (const unused of func.metadata.unusedImports) {
          if (!depMap[unused]) {
            depMap[unused] = {
              name: unused,
              usageCount: 0,
              usedBy: [],
              unusedInFiles: []
            };
          }
          
          depMap[unused].unusedInFiles.push(path.basename(func.filePath));
        }
      }
    }
    
    return Object.values(depMap)
      .filter(dep => dep.usageCount > 0 || dep.unusedInFiles.length > 0)
      .sort((a, b) => b.usageCount - a.usageCount);
  }

  private formatTimeAgo(date: Date): string {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    
    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`;
    if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
    return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
  }

  /**
   * Break code map into sections for storage
   */
  private async createCodeMapSections(
    fullMap: { stats: CodeMapStats; fileGroups: FileGroup[]; dependencies: DependencyInfo[]; documentation?: DocumentationMetrics },
    options: CodeMapOptions
  ): Promise<Record<string, {text: string, description: string, metadata: any}>> {
    const sections: Record<string, {text: string, description: string, metadata: any}> = {};

    // Overview section
    sections.overview = {
      text: this.formatOverviewSection(fullMap.stats, fullMap.documentation),
      description: "Project overview and statistics",
      metadata: { stats: fullMap.stats }
    };

    // Files section (chunked by directory if large)
    if (fullMap.fileGroups.length <= 20) {
      sections.files = {
        text: this.formatFilesSection(fullMap.fileGroups, options),
        description: "Complete file structure and functions",
        metadata: { fileCount: fullMap.fileGroups.reduce((sum, g) => sum + g.files.length, 0) }
      };
    } else {
      // Split into chunks
      const chunkSize = 10;
      for (let i = 0; i < fullMap.fileGroups.length; i += chunkSize) {
        const chunk = fullMap.fileGroups.slice(i, i + chunkSize);
        const chunkNum = Math.floor(i / chunkSize) + 1;
        sections[`files_${chunkNum}`] = {
          text: this.formatFilesSection(chunk, options),
          description: `Files section ${chunkNum} (${chunk.length} directories)`,
          metadata: { chunk: chunkNum, fileCount: chunk.reduce((sum, g) => sum + g.files.length, 0) }
        };
      }
    }

    // Dependencies section
    sections.dependencies = {
      text: this.formatDependenciesSection(fullMap.dependencies),
      description: "Dependency analysis and usage",
      metadata: { dependencyCount: fullMap.dependencies.length }
    };

    // Documentation section (if enabled)
    if (options.includeDocumentation && fullMap.documentation) {
      sections.documentation = {
        text: this.formatDocumentationSection(fullMap.documentation),
        description: "Documentation quality metrics",
        metadata: { coverage: fullMap.documentation.coverageScore }
      };
    }

    return sections;
  }

  /**
   * Create a quick preview of the code map
   */
  private createQuickPreview(
    fullMap: { stats: CodeMapStats; fileGroups: FileGroup[]; dependencies: DependencyInfo[]; documentation?: DocumentationMetrics },
    maxLength: number = 1000
  ): string {
    const overview = this.formatOverviewSection(fullMap.stats, fullMap.documentation);
    
    if (overview.length <= maxLength) {
      // Add a sample of files if we have room
      const remainingSpace = maxLength - overview.length - 50; // Leave some buffer
      const filesSample = this.formatFilesSection(fullMap.fileGroups.slice(0, 2), {});
      const truncatedFiles = filesSample.length > remainingSpace 
        ? filesSample.substring(0, remainingSpace) + '...\n\n[Use get_code_map_section to see complete file listing]'
        : filesSample;
      
      return overview + '\n\n' + truncatedFiles;
    }
    
    return overview.substring(0, maxLength - 50) + '...\n\n[Use get_code_map_section for complete overview]';
  }

  /**
   * Format individual sections
   */
  private formatOverviewSection(stats: CodeMapStats, documentation?: DocumentationMetrics): string {
    return `📖 CODEBASE OVERVIEW\n\n🎯 STRUCTURE\nFiles: ${stats.totalFiles} | Functions: ${stats.totalFunctions} | Components: ${stats.totalComponents}\nAvg Complexity: ${stats.averageComplexity.toFixed(1)} | High Complexity: ${stats.highComplexityCount} functions\n${documentation ? `Documentation Coverage: ${Math.round(documentation.coverageScore)}%` : ''}\nLast indexed: ${stats.lastIndexed ? this.formatTimeAgo(stats.lastIndexed) : 'never'}\n`;
  }

  private formatFilesSection(fileGroups: FileGroup[], options: CodeMapOptions): string {
    // Use existing formatAsText logic but for files section only
    const result = [];
    result.push('📁 FILES & FUNCTIONS\n');
    
    for (const group of fileGroups) {
      result.push(`📁 ${group.directory}/`);
      result.push(`├── Functions: ${group.stats.functionCount} | Components: ${group.stats.componentCount}`);
      result.push(`├── Avg Complexity: ${group.stats.averageComplexity.toFixed(1)} | Documentation: ${Math.round(group.stats.documentationScore)}%`);
      result.push('│');
      
      // Show first few files in detail, then summarize
      const filesToShow = group.files.slice(0, 5);
      for (const file of filesToShow) {
        result.push(`│   📄 ${file.relativePath} [Lines: ${file.lineCount}]`);
        
        // Show first few functions
        const functionsToShow = file.functions.slice(0, 3);
        for (const func of functionsToShow) {
          result.push(`│   │   └── 🔧 ${func.name}()`);
          if (func.purpose) {
            result.push(`│   │       └── "${func.purpose}"`);
          }
        }
        
        if (file.functions.length > 3) {
          result.push(`│   │   └── ... ${file.functions.length - 3} more functions`);
        }
        
        if (file.unusedImports.length > 0) {
          result.push(`│   │   ⚠️  Unused imports: ${file.unusedImports.slice(0, 3).join(', ')}${file.unusedImports.length > 3 ? `, +${file.unusedImports.length - 3} more` : ''}`);
        }
        result.push('│');
      }
      
      if (group.files.length > 5) {
        result.push(`│   └── ... ${group.files.length - 5} more files`);
      }
      result.push('');
    }
    
    return result.join('\n');
  }

  private formatDependenciesSection(dependencies: DependencyInfo[]): string {
    const result = [];
    result.push('🔗 DEPENDENCIES\n');
    
    const topDeps = dependencies.slice(0, 10);
    for (const dep of topDeps) {
      result.push(`├── ${dep.name} → ${dep.usageCount} functions`);
      if (dep.unusedInFiles.length > 0) {
        const files = dep.unusedInFiles.slice(0, 3);
        result.push(`│   └── ⚠️ Unused in: ${files.join(', ')}${dep.unusedInFiles.length > 3 ? `, +${dep.unusedInFiles.length - 3} more` : ''}`);
      }
    }
    
    if (dependencies.length > 10) {
      result.push(`└── ... ${dependencies.length - 10} more dependencies`);
    }
    
    return result.join('\n');
  }

  private formatDocumentationSection(documentation: DocumentationMetrics): string {
    const result = [];
    result.push('📝 DOCUMENTATION QUALITY\n');
    
    result.push(`├── Functions with JSDoc: ${documentation.documentedFunctions}/${documentation.totalFunctions} (${Math.round((documentation.documentedFunctions / documentation.totalFunctions) * 100)}%)`);
    result.push(`├── Components documented: ${documentation.documentedComponents}/${documentation.totalComponents} (${Math.round((documentation.documentedComponents / documentation.totalComponents) * 100)}%)`);
    result.push(`├── Files with purpose: ${documentation.filesWithPurpose}/${documentation.totalFiles} (${Math.round((documentation.filesWithPurpose / documentation.totalFiles) * 100)}%)`);
    
    if (documentation.wellDocumentedFiles.length > 0) {
      result.push(`└── Well documented: ${documentation.wellDocumentedFiles.slice(0, 3).join(', ')}`);
    }
    
    return result.join('\n');
  }
}