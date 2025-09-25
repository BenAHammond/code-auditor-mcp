/**
 * Whitelist types for managing allowed dependencies and instantiations
 */

export enum WhitelistType {
  PlatformAPI = 'platform-api',      // Browser/Node.js built-in APIs
  FrameworkClass = 'framework-class', // Framework classes meant to be instantiated
  ProjectDependency = 'project-dep',  // Project-specific dependencies
  SharedLibrary = 'shared-library',   // Common libraries (detected or manual)
  NodeBuiltin = 'node-builtin'       // Node.js built-in modules
}

export enum WhitelistStatus {
  Active = 'active',
  Pending = 'pending',      // Awaiting LLM confirmation
  Rejected = 'rejected',    // LLM rejected this suggestion
  Disabled = 'disabled'     // Temporarily disabled
}

export interface WhitelistEntry {
  id?: string;
  name: string;                    // Class name or import path
  type: WhitelistType;
  status: WhitelistStatus;
  category?: string;               // Sub-category (e.g., 'dom', 'http', 'database')
  description?: string;            // Why this is whitelisted
  patterns?: string[];             // Regex patterns to match variations
  addedBy: 'system' | 'user' | 'auto-detect' | 'llm';
  addedAt: Date;
  updatedAt?: Date;
  metadata?: {
    packageName?: string;          // From package.json
    packageVersion?: string;       // Version constraint
    frequency?: number;            // How often it appears in codebase
    lastSeen?: Date;              // Last time it was encountered
    suggestedBy?: string;         // Which analyzer suggested this
    confidence?: number;          // Confidence score for auto-detected entries
  };
}

export interface WhitelistSuggestion {
  name: string;
  type: WhitelistType;
  reason: string;
  frequency: number;
  examples: Array<{
    file: string;
    line: number;
    context: string;
  }>;
  confidence: number;
}

export interface ProjectWhitelistConfig {
  projectPath: string;
  autoDetect: boolean;              // Enable auto-detection
  requireLLMConfirmation: boolean;  // Require LLM approval for auto-detected
  inheritGlobal: boolean;           // Include global whitelist entries
  customEntries: WhitelistEntry[];  // Project-specific entries
}