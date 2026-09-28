/**
 * MCP Tool Handlers for Whitelist Management
 */

import { 
  getWhitelist, 
  addWhitelistEntry, 
  updateWhitelistStatus,
  detectWhitelistCandidates,
  autoPopulateWhitelist
} from '../services/whitelistService.js';
import { WhitelistType, WhitelistStatus } from '../types/whitelist.js';
import path from 'path';

/**
 * Retrieve whitelist entries, optionally filtered by type and status.
 * @param args - The tool arguments (type, status).
 * @returns The matching whitelist entries, or an error object.
 */
export async function handleWhitelistGet(args: any) {
  const type = args.type as WhitelistType | undefined;
  const status = args.status as WhitelistStatus | undefined;
  
  try {
    const entries = await getWhitelist(type, status);
    return {
      success: true,
      count: entries.length,
      entries: entries.map(entry => ({
        name: entry.name,
        type: entry.type,
        status: entry.status,
        category: entry.category,
        description: entry.description,
        patterns: entry.patterns,
        addedBy: entry.addedBy,
        addedAt: entry.addedAt
      }))
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to retrieve whitelist'
    };
  }
}

/**
 * Add a new entry to the whitelist.
 * @param args - The tool arguments (name, type, description, patterns).
 * @returns The added entry, or an error object.
 */
export async function handleWhitelistAdd(args: any) {
  const { name, type, description, patterns } = args as {
    name: string;
    type: WhitelistType;
    description?: string;
    patterns?: string[];
  };
  
  try {
    const entry = await addWhitelistEntry(name, type, description, patterns);
    
    return {
      success: true,
      message: `Added ${name} to whitelist as ${type}`,
      entry: {
        name: entry.name,
        type: entry.type,
        status: entry.status,
        description: entry.description
      }
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to add whitelist entry'
    };
  }
}

/**
 * Update the status of an existing whitelist entry.
 * @param args - The tool arguments (name, status).
 * @returns A success message, or an error object.
 */
export async function handleWhitelistUpdateStatus(args: any) {
  const { name, status } = args as { name: string; status: WhitelistStatus };
  
  try {
    await updateWhitelistStatus(name, status);
    return {
      success: true,
      message: `Updated ${name} status to ${status}`
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update whitelist status'
    };
  }
}

/**
 * Detect whitelist candidates, optionally auto-populating high-confidence entries.
 * @param args - The tool arguments (path, includePackageJson, autoPopulate).
 * @returns The detected suggestions, or an error object.
 */
export async function handleWhitelistDetect(args: any) {
  const projectPath = (args.path as string) || process.cwd();
  const includePackageJson = (args.includePackageJson as boolean) !== false;
  
  try {
    const suggestions = includePackageJson 
      ? await detectWhitelistCandidates(projectPath)
      : [];
    
    // Option to auto-populate high confidence entries
    if (args.autoPopulate) {
      const result = await autoPopulateWhitelist(projectPath);
      return {
        success: true,
        autoAdded: result.added,
        suggestions: result.suggestions,
        message: `Automatically added ${result.added} high-confidence entries. ${result.suggestions.length} suggestions require review.`
      };
    }
    
    return {
      success: true,
      count: suggestions.length,
      suggestions: suggestions.slice(0, 50).map(s => ({
        name: s.name,
        type: s.type,
        reason: s.reason,
        confidence: s.confidence
      })),
      message: suggestions.length > 50 ? `Showing first 50 of ${suggestions.length} suggestions` : undefined
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to detect whitelist candidates'
    };
  }
}