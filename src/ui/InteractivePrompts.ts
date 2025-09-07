/**
 * Interactive Prompts
 * User interface for tool selection and confirmations
 */

import inquirer from 'inquirer';
import chalk from 'chalk';

export interface ToolChoice {
  name: string;
  value: string;
  checked?: boolean;
  disabled?: boolean;
}

export class InteractivePrompts {
  /**
   * Prompt user to select AI tools to configure
   */
  async selectTools(): Promise<string[]> {
    const choices: ToolChoice[] = [
      { name: chalk.cyan('Cursor'), value: 'cursor', checked: false },
      { name: chalk.green('Continue'), value: 'continue', checked: false },
      { name: chalk.blue('GitHub Copilot'), value: 'copilot', checked: false },
      { name: chalk.yellow('AWS Q Developer'), value: 'awsq', checked: false },
      { name: chalk.magenta('Codeium/Windsurf'), value: 'codeium', checked: false },
      { name: chalk.cyan('Claude Desktop'), value: 'claude', checked: false },
      { name: chalk.green('VS Code MCP'), value: 'vscode', checked: false },
      { name: chalk.blue('JetBrains IDEs'), value: 'jetbrains', checked: false },
      { name: chalk.yellow('Cline'), value: 'cline', checked: false },
      { name: chalk.magenta('Aider'), value: 'aider', checked: false },
      { name: chalk.bold.white('─────────────────'), value: '', disabled: true },
      { name: chalk.bold.green('✓ All Tools'), value: 'all', checked: false }
    ];

    const { tools } = await inquirer.prompt([
      {
        type: 'checkbox',
        name: 'tools',
        message: 'Select AI tools to configure:',
        choices,
        pageSize: 15,
        validate: (answer) => {
          if (answer.length === 0) {
            return 'Please select at least one tool';
          }
          return true;
        }
      }
    ]);

    // If 'all' is selected, return all tool values except 'all' itself
    if (tools.includes('all')) {
      return choices
        .filter(c => c.value && c.value !== 'all' && c.value !== '')
        .map(c => c.value);
    }

    return tools.filter((t: string) => t !== '');
  }

  /**
   * Confirm overwriting existing files
   */
  async confirmOverwrite(files: string[]): Promise<boolean> {
    if (files.length === 0) {
      return true;
    }

    console.log(chalk.yellow('\nThe following files already exist:'));
    files.forEach(file => {
      console.log(chalk.gray(`  • ${file}`));
    });

    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: 'Do you want to overwrite these files?',
        default: false
      }
    ]);

    return confirm;
  }

  /**
   * Select output directory
   */
  async selectOutputDirectory(defaultDir: string = '.'): Promise<string> {
    const { outputDir } = await inquirer.prompt([
      {
        type: 'input',
        name: 'outputDir',
        message: 'Output directory for configuration files:',
        default: defaultDir,
        validate: (input) => {
          if (!input.trim()) {
            return 'Output directory cannot be empty';
          }
          return true;
        }
      }
    ]);

    return outputDir;
  }

  /**
   * Confirm server URL
   */
  async confirmServerUrl(defaultUrl: string): Promise<string> {
    const { serverUrl } = await inquirer.prompt([
      {
        type: 'input',
        name: 'serverUrl',
        message: 'MCP server URL:',
        default: defaultUrl,
        validate: (input) => {
          try {
            new URL(input);
            return true;
          } catch {
            return 'Please enter a valid URL';
          }
        }
      }
    ]);

    return serverUrl;
  }

  /**
   * Select server mode
   */
  async selectServerMode(): Promise<'mcp' | 'rest' | 'both'> {
    const { mode } = await inquirer.prompt([
      {
        type: 'list',
        name: 'mode',
        message: 'How do you want to start the server?',
        choices: [
          { name: 'MCP Mode (stdio)', value: 'mcp' },
          { name: 'REST API Mode', value: 'rest' },
          { name: 'Both (recommended)', value: 'both' }
        ],
        default: 'both'
      }
    ]);

    return mode;
  }

  /**
   * Display success message with next steps
   */
  displaySuccess(generatedFiles: string[]): void {
    console.log(chalk.green('\n✓ Configuration files generated successfully!\n'));
    console.log(chalk.bold('Generated files:'));
    generatedFiles.forEach(file => {
      console.log(chalk.gray(`  • ${file}`));
    });
    
    console.log(chalk.bold('\nNext steps:'));
    console.log(chalk.gray('  1. Start the server: ') + chalk.cyan('npm run start:rest'));
    console.log(chalk.gray('  2. Follow the instructions in each configuration file'));
    console.log(chalk.gray('  3. Test connections: ') + chalk.cyan('code-auditor test <tool>'));
  }
}