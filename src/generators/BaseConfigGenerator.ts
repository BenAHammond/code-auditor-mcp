/**
 * Base Configuration Generator
 * Abstract class for all AI tool config generators
 */

import { DEFAULT_SERVER_URL, DEFAULT_API_KEY } from '../constants.js';

export interface ConfigOutput {
  filename: string;
  content: string;
  additionalFiles?: AdditionalFile[];
  instructions: string;
}

export interface AdditionalFile {
  filename: string;
  content: string;
}

export abstract class BaseConfigGenerator {
  protected serverUrl: string;

  constructor(serverUrl: string = DEFAULT_SERVER_URL) {
    this.serverUrl = serverUrl;
  }

  /**
   * Generate the configuration for the specific tool
   */
  abstract generateConfig(): ConfigOutput;

  /**
   * Get the default filename for this tool's configuration
   */
  abstract getFilename(): string;

  /**
   * Get setup instructions for this tool
   */
  abstract getInstructions(): string;

  /**
   * Format an object as pretty-printed JSON
   */
  protected formatJson(obj: any, indent: number = 2): string {
    return JSON.stringify(obj, null, indent);
  }

  /**
   * Convert a JSON object to YAML format
   */
  protected formatYaml(obj: any, indent: number = 0): string {
    let yaml = '';
    const spaces = ' '.repeat(indent);
    
    for (const [key, value] of Object.entries(obj)) {
      if (value === null || value === undefined) {
        yaml += `${spaces}${key}: null\n`;
      } else if (typeof value === 'object' && !Array.isArray(value)) {
        yaml += `${spaces}${key}:\n${this.formatYaml(value, indent + 2)}`;
      } else if (Array.isArray(value)) {
        yaml += `${spaces}${key}:\n`;
        value.forEach(item => {
          if (typeof item === 'object') {
            yaml += `${spaces}- \n${this.formatYaml(item, indent + 4)}`;
          } else {
            yaml += `${spaces}- ${item}\n`;
          }
        });
      } else if (typeof value === 'string' && value.includes('\n')) {
        // Multi-line string
        yaml += `${spaces}${key}: |\n`;
        value.split('\n').forEach(line => {
          yaml += `${spaces}  ${line}\n`;
        });
      } else {
        yaml += `${spaces}${key}: ${value}\n`;
      }
    }
    
    return yaml;
  }

  /**
   * Get the tool name (for display purposes)
   */
  abstract getToolName(): string;

  /**
   * Check if this tool requires authentication
   */
  requiresAuth(): boolean {
    return true;
  }

  /**
   * Get the default API key for this tool
   */
  getDefaultApiKey(): string {
    return DEFAULT_API_KEY;
  }
}