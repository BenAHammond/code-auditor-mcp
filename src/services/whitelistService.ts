/**
 * Whitelist Service
 * Manages whitelisted dependencies and classes for SOLID analyzer
 */

import { getDatabase } from '../codeIndexService.js';
import { 
  WhitelistEntry, 
  WhitelistType, 
  WhitelistStatus,
  WhitelistSuggestion 
} from '../types/whitelist.js';
import { promises as fs } from 'fs';
import path from 'path';

/**
 * Manages whitelisted dependencies and classes for the SOLID analyzer.
 */
export class WhitelistService {
  private static instance: WhitelistService;

  private constructor() {}

  /**
   * Return the process-wide singleton service instance.
   *
   * @returns The singleton `WhitelistService`.
   */
  static getInstance(): WhitelistService {
    if (!WhitelistService.instance) {
      WhitelistService.instance = new WhitelistService();
    }
    return WhitelistService.instance;
  }

  /**
   * Get whitelist entries by type and status
   */
  async getWhitelist(type?: WhitelistType, status?: WhitelistStatus): Promise<WhitelistEntry[]> {
    const db = await getDatabase();
    return db.getWhitelist(type, status);
  }

  /**
   * Add a new whitelist entry.
   *
   * @param name - The entry name to whitelist.
   * @param type - The whitelist type.
   * @param description - Optional entry description.
   * @param patterns - Optional matching patterns.
   * @returns The created whitelist entry.
   */
  async addEntry(
    name: string,
    type: WhitelistType,
    description?: string,
    patterns?: string[]
  ): Promise<WhitelistEntry> {
    const db = await getDatabase();
    return db.addWhitelistEntry({
      name,
      type,
      status: WhitelistStatus.Active,
      description,
      patterns,
      addedBy: 'user'
    });
  }

  /**
   * Update the status of a whitelist entry
   */
  async updateStatus(name: string, status: WhitelistStatus): Promise<void> {
    const db = await getDatabase();
    await db.updateWhitelistStatus(name, status);
  }

  /**
   * Check if a name is whitelisted
   */
  async isWhitelisted(name: string, type: WhitelistType): Promise<boolean> {
    const db = await getDatabase();
    return db.isWhitelisted(name, type);
  }

  /**
   * Detect whitelist candidates from package.json.
   *
   * @param projectPath - The project path whose dependencies are scanned.
   * @returns The candidate whitelist suggestions.
   */
  async detectFromPackageJson(projectPath: string): Promise<WhitelistSuggestion[]> {
    const suggestions: WhitelistSuggestion[] = [];
    const packageJsonPath = path.join(projectPath, 'package.json');

    try {
      const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));
      const allDeps = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
        ...packageJson.peerDependencies
      };

      for (const [dep, version] of Object.entries(allDeps)) {
        // Skip if already whitelisted
        if (await this.isWhitelisted(dep, WhitelistType.ProjectDependency)) {
          continue;
        }

        // Categorize common dependencies
        const suggestion: WhitelistSuggestion = {
          name: dep,
          type: WhitelistType.ProjectDependency,
          reason: `Project dependency (${version})`,
          frequency: 1,
          examples: [],
          confidence: 0.9
        };

        // Check if it's a well-known framework
        if (this.isFrameworkLibrary(dep)) {
          suggestion.type = WhitelistType.FrameworkClass;
          suggestion.reason = `Common framework library (${version})`;
          suggestion.confidence = 0.95;
        }

        // Check if it's a shared/utility library
        if (this.isSharedLibrary(dep)) {
          suggestion.type = WhitelistType.SharedLibrary;
          suggestion.reason = `Shared utility library (${version})`;
          suggestion.confidence = 0.95;
        }

        suggestions.push(suggestion);
      }
    } catch (error) {
      // No package.json or error reading it
      console.warn(`Could not read package.json at ${packageJsonPath}:`, error);
    }

    return suggestions;
  }

  /**
   * Detect whitelist candidates from usage patterns.
   *
   * @param projectPath - The project path to scan for usage patterns.
   * @returns The candidate whitelist suggestions.
   */
  async detectFromUsagePatterns(projectPath: string): Promise<WhitelistSuggestion[]> {
    // TODO: Implement usage pattern detection
    // This could analyze the codebase for frequently instantiated classes
    // or commonly imported modules that aren't in package.json
    return [];
  }

  /**
   * Auto-populate whitelist for a project.
   *
   * @param projectPath - The project whose high-confidence candidates are added.
   * @returns The number added and the remaining low-confidence suggestions.
   */
  async autoPopulateWhitelist(projectPath: string): Promise<{
    added: number;
    suggestions: WhitelistSuggestion[];
  }> {
    const suggestions = await this.detectFromPackageJson(projectPath);
    let added = 0;

    // Automatically add high-confidence suggestions
    for (const suggestion of suggestions) {
      if (suggestion.confidence >= 0.95) {
        try {
          await this.addEntry(
            suggestion.name,
            suggestion.type,
            suggestion.reason
          );
          added++;
        } catch (error) {
          console.warn(`Failed to add ${suggestion.name} to whitelist:`, error);
        }
      }
    }

    return {
      added,
      suggestions: suggestions.filter(s => s.confidence < 0.95)
    };
  }

  /**
   * Whitelist ALL dependencies from package.json.
   *
   * @param projectPath - The project whose dependencies are all whitelisted.
   * @returns The number added and any dependency names that failed.
   */
  async whitelistAllDependencies(projectPath: string): Promise<{
    added: number;
    failed: string[];
  }> {
    const suggestions = await this.detectFromPackageJson(projectPath);
    let added = 0;
    const failed: string[] = [];

    // Add ALL dependencies regardless of confidence
    for (const suggestion of suggestions) {
      try {
        await this.addEntry(
          suggestion.name,
          suggestion.type,
          suggestion.reason
        );
        added++;
      } catch (error: unknown) {
        if (!(error instanceof Error) || !error.message.includes('already exists')) {
          failed.push(suggestion.name);
          console.warn(`Failed to add ${suggestion.name} to whitelist:`, error);
        }
      }
    }

    return { added, failed };
  }

  /**
   * Check if a dependency is a known framework library
   */
  private isFrameworkLibrary(dep: string): boolean {
    const frameworks = [
      'react', 'react-dom', 'react-router', 'react-redux',
      'vue', 'vue-router', 'vuex',
      'angular', '@angular/core', '@angular/common',
      'next', 'nextjs', '@next/font',
      'express', 'fastify', 'koa',
      'nestjs', '@nestjs/core',
      'electron',
      '@testing-library/react', 'jest', 'vitest', 'mocha',
      'webpack', 'vite', 'rollup', 'parcel',
      'typescript', '@types/node'
    ];

    return matchesLibrary(dep, frameworks);
  }

  /**
   * Check if a dependency is a common shared/utility library
   */
  private isSharedLibrary(dep: string): boolean {
    const sharedLibs = [
      'lodash', 'underscore', 'ramda',
      'axios', 'node-fetch', 'got', 'ky',
      'moment', 'dayjs', 'date-fns',
      'uuid', 'nanoid', 'shortid',
      'chalk', 'colors', 'ora', 'inquirer',
      'dotenv', 'config', 'yargs', 'commander',
      'joi', 'yup', 'zod', 'ajv',
      'winston', 'pino', 'bunyan', 'debug',
      'prettier', 'eslint', '@typescript-eslint',
      'husky', 'lint-staged',
      'classnames', 'clsx',
      'query-string', 'qs',
      'formik', 'react-hook-form',
      'swr', 'react-query', '@tanstack/react-query',
      'zustand', 'mobx', 'recoil', 'jotai',
      'styled-components', 'emotion', '@emotion/styled',
      'tailwindcss', 'postcss', 'autoprefixer',
      'framer-motion', 'react-spring',
      'd3', 'chart.js', 'recharts',
      'monaco-editor', 'codemirror',
      'markdown-it', 'marked', 'remark'
    ];

    return matchesLibrary(dep, sharedLibs);
  }
}

/**
 * True when `dep` is the library or a subpath / scoped subpath of it.
 */
function matchesLibrary(dep: string, libs: readonly string[]): boolean {
  return libs.some(lib =>
    dep === lib || dep.startsWith(`${lib}/`) || dep.startsWith(`@${lib}/`)
  );
}

// Export singleton instance methods for convenience
export const whitelistService = WhitelistService.getInstance();

export async function getWhitelist(type?: WhitelistType, status?: WhitelistStatus) {
  return whitelistService.getWhitelist(type, status);
}

/**
 * Add a whitelist entry via the singleton service.
 *
 * @param name - The entry name to whitelist.
 * @param type - The whitelist type.
 * @param description - Optional entry description.
 * @param patterns - Optional matching patterns.
 * @returns The created whitelist entry.
 */
export async function addWhitelistEntry(
  name: string,
  type: WhitelistType,
  description?: string,
  patterns?: string[]
) {
  return whitelistService.addEntry(name, type, description, patterns);
}

export async function updateWhitelistStatus(name: string, status: WhitelistStatus) {
  return whitelistService.updateStatus(name, status);
}

export async function detectWhitelistCandidates(projectPath: string) {
  return whitelistService.detectFromPackageJson(projectPath);
}

export async function autoPopulateWhitelist(projectPath: string) {
  return whitelistService.autoPopulateWhitelist(projectPath);
}