/**
 * Installer — code-audit install subcommand logic.
 *
 * Copies the skill folder to agent-specific paths and optionally wires hooks.
 * Phase 0 live-docs verification (2026-07-19):
 *   - Cursor: project-only skills, ~/.cursor/skills/ does NOT exist
 *   - Codex: both ~/.codex/skills/ (user) and .codex/skills/ (project)
 *   - Cursor afterFileEdit is advisory only (cannot block retroactively)
 *   - Codex PostToolUse is blocking (exit 2 replaces tool result)
 */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Source: the repo's skill folder (shipped in the npm package at dist/../plugin/skills/code-auditor)
const SKILL_SOURCE = join(__dirname, '..', 'plugin', 'skills', 'code-auditor');

// Version recorded in the copied skill folder for idempotent updates
const PACKAGE_JSON_PATH = join(__dirname, '..', 'package.json');

interface AgentInfo {
  name: string;
  displayName: string;
  userPath: string | null; // null = user scope not supported
  projectPath: string;
  hooksAvailable: boolean;
  hookType: 'blocking' | 'advisory' | 'none';
}

const AGENTS: AgentInfo[] = [
  {
    name: 'claude',
    displayName: 'Claude Code',
    userPath: join(homedir(), '.claude', 'skills'),
    projectPath: '.claude/skills',
    hooksAvailable: true,
    hookType: 'blocking',
  },
  {
    name: 'cursor',
    displayName: 'Cursor',
    userPath: null, // Cursor skills are project-only (verified 2026-07-19)
    projectPath: '.cursor/skills',
    hooksAvailable: true,
    hookType: 'advisory',
  },
  {
    name: 'codex',
    displayName: 'Codex',
    userPath: join(homedir(), '.codex', 'skills'),
    projectPath: '.codex/skills',
    hooksAvailable: true,
    hookType: 'blocking',
  },
  {
    name: 'gemini',
    displayName: 'Gemini CLI',
    userPath: join(homedir(), '.gemini', 'skills'),
    projectPath: '.gemini/skills',
    hooksAvailable: false,
    hookType: 'none',
  },
  {
    name: 'agents',
    displayName: 'Other SKILL.md agents',
    userPath: join(homedir(), '.agents', 'skills'),
    projectPath: '.agents/skills',
    hooksAvailable: false,
    hookType: 'none',
  },
];

export interface InstallOptions {
  agent: string;        // claude | cursor | codex | gemini | agents | all
  scope: 'user' | 'project';
  hooks: boolean;       // offer hook wiring (default true; --no-hooks to skip)
  list: boolean;        // print support matrix and exit
}

export interface InstallResult {
  agent: string;
  displayName: string;
  skillPath: string;
  installed: boolean;
  hooksWired: boolean;
  skipped: boolean;
  skipReason?: string;
}

/**
 * Main entry point for `code-audit install`.
 */
export async function runInstall(options: InstallOptions): Promise<void> {
  if (options.list) {
    await printMatrix();
    return;
  }

  const agentsToInstall = options.agent === 'all'
    ? AGENTS
    : AGENTS.filter(a => a.name === options.agent);

  if (agentsToInstall.length === 0) {
    console.error(chalk.red(`Unknown agent: "${options.agent}". Use --list to see available agents.`));
    process.exit(1);
  }

  // Verify source skill folder exists
  try {
    await fs.access(join(SKILL_SOURCE, 'SKILL.md'));
  } catch {
    console.error(chalk.red(`Skill source not found at ${SKILL_SOURCE}. Is the package installed correctly?`));
    process.exit(1);
  }

  const results: InstallResult[] = [];
  const packageVersion = await getPackageVersion();

  for (const agent of agentsToInstall) {
    const result = await installForAgent(agent, options.scope, options.hooks, packageVersion);
    results.push(result);
  }

  // Print summary
  console.log(chalk.blue('\n── Install summary ──'));
  for (const r of results) {
    if (r.skipped) {
      console.log(`  ${chalk.yellow('⊘')} ${r.displayName}: ${chalk.dim(r.skipReason)}`);
    } else {
      const parts: string[] = [`${chalk.green('✓')} ${r.displayName}: skill → ${r.skillPath}`];
      if (r.hooksWired) parts.push('hooks wired');
      console.log(`  ${parts.join(', ')}`);
    }
  }
  console.log('');
}

/**
 * Print the support matrix (--list).
 */
async function printMatrix(): Promise<void> {
  const packageVersion = await getPackageVersion();
  console.log(chalk.blue('\ncode-audit install — Support Matrix'));
  console.log(chalk.gray(`Version: ${packageVersion}`));
  console.log(chalk.gray(`Source: ${SKILL_SOURCE}`));
  console.log(chalk.gray('Verified against docs: 2026-07-19\n'));

  // Header
  console.log(
    `${chalk.bold('Agent'.padEnd(18))} ${chalk.bold('Skill (user)'.padEnd(42))} ${chalk.bold('Skill (project)'.padEnd(22))} ${chalk.bold('Hooks'.padEnd(14))} ${chalk.bold('Installed')}`
  );
  console.log(chalk.gray('─'.repeat(105)));

  for (const agent of AGENTS) {
    const userPath = agent.userPath
      ? join(agent.userPath, 'code-auditor')
      : chalk.dim('(project-only)');
    const projectPath = join(agent.projectPath, 'code-auditor');
    const hookInfo = agent.hooksAvailable
      ? `yes (${agent.hookType})`
      : 'no';

    // Check if installed
    const projectFull = resolve(process.cwd(), agent.projectPath, 'code-auditor');
    let installed = 'no';
    try {
      await fs.access(join(projectFull, 'SKILL.md'));
      installed = chalk.green('yes (project)');
    } catch {
      if (agent.userPath) {
        try {
          await fs.access(join(agent.userPath, 'code-auditor', 'SKILL.md'));
          installed = chalk.green('yes (user)');
        } catch {
          installed = chalk.red('no');
        }
      } else {
        installed = chalk.red('no');
      }
    }

    console.log(
      `${agent.displayName.padEnd(18)} ${String(userPath).padEnd(42)} ${String(projectPath).padEnd(22)} ${hookInfo.padEnd(14)} ${installed}`
    );
  }
  console.log('');
}

/**
 * Install the skill for one agent.
 */
async function installForAgent(
  agent: AgentInfo,
  scope: 'user' | 'project',
  offerHooks: boolean,
  version: string,
): Promise<InstallResult> {
  const result: InstallResult = {
    agent: agent.name,
    displayName: agent.displayName,
    skillPath: '',
    installed: false,
    hooksWired: false,
    skipped: false,
  };

  // Determine the target path
  let targetParent: string | null = null;

  if (scope === 'user') {
    if (!agent.userPath) {
      result.skipped = true;
      result.skipReason = `${agent.displayName} does not support user-scope skills (project-only). Use --scope project.`;
      console.log(chalk.yellow(`⊘ ${agent.displayName}: user-scope not supported. Skills are project-only. Use --scope project.`));
      return result;
    }
    targetParent = agent.userPath;
  } else {
    targetParent = resolve(process.cwd(), agent.projectPath);
  }

  const targetDir = join(targetParent, 'code-auditor');

  // Check if the parent tool directory exists (for --agent all, skip if tool not present)
  if (scope === 'user' && agent.userPath) {
    try {
      await fs.access(agent.userPath);
    } catch {
      result.skipped = true;
      result.skipReason = `Parent directory ${agent.userPath} does not exist (${agent.displayName} not installed?).`;
      console.log(chalk.yellow(`⊘ ${agent.displayName}: ${agent.userPath} not found — skipping (tool not installed?).`));
      return result;
    }
  }

  // Create the target directory
  await fs.mkdir(targetDir, { recursive: true });

  // Copy skill files
  const skillFiles = ['SKILL.md', 'SKILL-SEARCH.md', 'SKILL-RULE-KINDS.md'];
  for (const file of skillFiles) {
    const src = join(SKILL_SOURCE, file);
    try {
      await fs.copyFile(src, join(targetDir, file));
    } catch (err) {
      // Source file missing — skip (non-fatal: SKILL.md is required, companions are optional)
      if (file === 'SKILL.md') throw err;
    }
  }

  // Write version marker
  await fs.writeFile(join(targetDir, '.code-auditor-version'), `${version}\n`);

  result.skillPath = targetDir;
  result.installed = true;
  console.log(chalk.green(`✓ ${agent.displayName}: skill installed to ${targetDir}`));

  // Hook wiring (only for agents with hook support, and only with confirmation)
  if (offerHooks && agent.hooksAvailable) {
    const wired = await offerHookWiring(agent, scope);
    result.hooksWired = wired;
  }

  return result;
}

/**
 * Offer to wire hooks for an agent. Shows the exact JSON and requires confirmation.
 * Returns true if hooks were wired, false if user declined.
 */
async function offerHookWiring(agent: AgentInfo, scope: 'user' | 'project'): Promise<boolean> {
  const hookConfig = getHookConfig(agent, scope);
  if (!hookConfig) return false;

  const { configFile, json } = hookConfig;

  // In non-interactive mode (--hooks or --no-hooks flag), we already got the answer
  // For simplicity in CLI mode, always show the proposed change and ask via inquirer
  console.log(chalk.cyan(`\n  Hook wiring for ${agent.displayName}:`));
  console.log(chalk.gray(`  File: ${configFile}`));
  console.log(chalk.gray(`  Will add:`));
  console.log(chalk.dim(`  ${JSON.stringify(json, null, 2).replace(/\n/g, '\n  ')}`));

  // Use inquirer for confirmation
  try {
    const inquirer = (await import('inquirer')).default;
    const { confirmed } = await inquirer.prompt({
      type: 'confirm',
      name: 'confirmed',
      message: `  Write this hook config to ${basename(configFile)}?`,
      default: false,
    } as any);

    if (!confirmed) {
      console.log(chalk.yellow(`  ⊘ Hook wiring skipped for ${agent.displayName}`));
      return false;
    }

    // Ensure directory exists
    await fs.mkdir(dirname(configFile), { recursive: true });

    // Check if config already exists; merge if so
    let existing: any = {};
    try {
      const raw = await fs.readFile(configFile, 'utf-8');
      existing = JSON.parse(raw);
    } catch {
      // File doesn't exist or is invalid — start fresh
    }

    // Merge the hook entry
    const merged = deepMerge(existing, json);
    await fs.writeFile(configFile, JSON.stringify(merged, null, 2) + '\n');
    console.log(chalk.green(`  ✓ Hook wired for ${agent.displayName}`));
    return true;
  } catch {
    // inquirer not available or user aborted — skip hook wiring
    console.log(chalk.yellow(`  ⊘ Hook wiring skipped for ${agent.displayName} (non-interactive). Use --hooks to force.`));
    return false;
  }
}

/**
 * Get the hook config snippet for a given agent.
 */
function getHookConfig(agent: AgentInfo, scope: 'user' | 'project'): { configFile: string; json: any } | null {
  switch (agent.name) {
    case 'claude': {
      const configDir = scope === 'user'
        ? join(homedir(), '.claude')
        : resolve(process.cwd(), '.claude');
      // Claude Code uses plugin.json, not per-project hooks.json
      // For --agent claude, we tell the user to use the plugin instead
      console.log(chalk.yellow(`  ⊘ Claude Code uses the code-auditor plugin for hooks, not direct hook wiring.`));
      console.log(chalk.gray(`    Use: claude plugin install code-auditor`));
      return null;
    }

    case 'cursor': {
      const configFile = scope === 'user'
        ? join(homedir(), '.cursor', 'hooks.json')
        : resolve(process.cwd(), '.cursor', 'hooks.json');
      return {
        configFile,
        json: {
          hooks: {
            afterFileEdit: [
              {
                command: 'npx -y code-auditor-mcp code-audit cursor-hook',
              },
            ],
          },
        },
      };
    }

    case 'codex': {
      const configFile = scope === 'user'
        ? join(homedir(), '.codex', 'hooks.json')
        : resolve(process.cwd(), '.codex', 'hooks.json');
      return {
        configFile,
        json: {
          hooks: {
            PostToolUse: [
              {
                matcher: 'apply_patch',
                hooks: [
                  {
                    type: 'command',
                    command: 'npx -y code-auditor-mcp code-audit codex-hook',
                  },
                ],
              },
            ],
          },
        },
      };
    }

    default:
      return null;
  }
}

/**
 * Deep merge two objects. b's values take precedence over a's.
 */
function deepMerge(a: any, b: any): any {
  if (typeof a !== 'object' || a === null || Array.isArray(a)) return b ?? a;
  if (typeof b !== 'object' || b === null || Array.isArray(b)) return b;
  const result = { ...a };
  for (const key of Object.keys(b)) {
    result[key] = deepMerge(a[key], b[key]);
  }
  return result;
}

/**
 * Get the package version from package.json.
 */
async function getPackageVersion(): Promise<string> {
  try {
    const raw = await fs.readFile(PACKAGE_JSON_PATH, 'utf-8');
    return JSON.parse(raw).version || 'unknown';
  } catch {
    return 'unknown';
  }
}
