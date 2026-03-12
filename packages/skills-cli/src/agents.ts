/**
 * Agent directory detection and mapping.
 *
 * Detects which AI coding agents are present in the current project
 * by looking for their config directories. Skills are installed into
 * agent-specific skill directories.
 */

import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

export interface AgentTarget {
  name: string;
  configDir: string;
  skillsDir: string;
}

/**
 * Known agent configurations.
 * Maps agent name → { config directory to detect, skills directory to write to }
 */
const AGENT_CONFIGS: Array<{
  name: string;
  detectDirs: string[];
  skillsDir: string;
}> = [
  {
    name: 'Claude Code',
    detectDirs: ['.claude'],
    skillsDir: '.claude/skills',
  },
  {
    name: 'Cursor',
    detectDirs: ['.cursor', '.cursorrc'],
    skillsDir: '.agents/skills',
  },
  {
    name: 'GitHub Copilot',
    detectDirs: ['.github/copilot'],
    skillsDir: '.agents/skills',
  },
  {
    name: 'Windsurf',
    detectDirs: ['.windsurf'],
    skillsDir: '.windsurf/skills',
  },
  {
    name: 'Codex',
    detectDirs: ['.codex'],
    skillsDir: '.agents/skills',
  },
];

/**
 * Detect which AI agents are configured in the given project directory.
 */
export function detectAgents(projectDir: string): AgentTarget[] {
  const agents: AgentTarget[] = [];
  const seenSkillsDirs = new Set<string>();

  for (const config of AGENT_CONFIGS) {
    const detected = config.detectDirs.some(dir =>
      existsSync(join(projectDir, dir))
    );

    if (detected) {
      const fullSkillsDir = join(projectDir, config.skillsDir);
      // Avoid duplicates when multiple agents share the same skills dir
      if (!seenSkillsDirs.has(fullSkillsDir)) {
        seenSkillsDirs.add(fullSkillsDir);
        agents.push({
          name: config.name,
          configDir: config.detectDirs[0],
          skillsDir: fullSkillsDir,
        });
      }
    }
  }

  return agents;
}

/**
 * If no agents are detected, return all possible targets with
 * a preference for .claude/skills/ and .agents/skills/.
 */
export function getDefaultTargets(projectDir: string): AgentTarget[] {
  return [
    {
      name: 'Claude Code',
      configDir: '.claude',
      skillsDir: join(projectDir, '.claude/skills'),
    },
    {
      name: 'Generic Agents',
      configDir: '.agents',
      skillsDir: join(projectDir, '.agents/skills'),
    },
  ];
}

/**
 * Ensure a skills directory exists.
 */
export function ensureSkillsDir(skillsDir: string): void {
  mkdirSync(skillsDir, { recursive: true });
}
