/**
 * Agent directory detection and mapping.
 *
 * Detects which AI coding agents are present in the current project
 * by looking for their config directories. Skills are installed into
 * agent-specific skill directories.
 *
 * Agent list aligned with https://github.com/vercel-labs/skills
 */

import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

export interface AgentTarget {
  name: string;
  configDir: string;
  skillsDir: string;
}

/**
 * Known agent configurations (30+ agents).
 * Aligned with Vercel's skills CLI.
 * See: https://github.com/vercel-labs/skills/blob/main/src/agents.ts
 */
const AGENT_CONFIGS: Array<{
  name: string;
  detectDirs: string[];
  skillsDir: string;
}> = [
  // --- Major agents ---
  { name: 'Claude Code', detectDirs: ['.claude'], skillsDir: '.claude/skills' },
  { name: 'Cursor', detectDirs: ['.cursor', '.cursorrc'], skillsDir: '.agents/skills' },
  { name: 'GitHub Copilot', detectDirs: ['.github/copilot'], skillsDir: '.agents/skills' },
  { name: 'Windsurf', detectDirs: ['.windsurf'], skillsDir: '.windsurf/skills' },
  { name: 'Codex', detectDirs: ['.codex'], skillsDir: '.agents/skills' },
  // --- Additional agents ---
  { name: 'Amp', detectDirs: ['.amp'], skillsDir: '.agents/skills' },
  { name: 'Augment', detectDirs: ['.augment'], skillsDir: '.augment/skills' },
  { name: 'Cline', detectDirs: ['.cline'], skillsDir: '.agents/skills' },
  { name: 'CodeBuddy', detectDirs: ['.codebuddy'], skillsDir: '.codebuddy/skills' },
  { name: 'Command Code', detectDirs: ['.commandcode'], skillsDir: '.commandcode/skills' },
  { name: 'Continue', detectDirs: ['.continue'], skillsDir: '.continue/skills' },
  { name: 'Cortex', detectDirs: ['.cortex'], skillsDir: '.cortex/skills' },
  { name: 'Droid (Factory)', detectDirs: ['.factory'], skillsDir: '.factory/skills' },
  { name: 'Gemini CLI', detectDirs: ['.gemini'], skillsDir: '.agents/skills' },
  { name: 'Goose', detectDirs: ['.goose'], skillsDir: '.goose/skills' },
  { name: 'Junie', detectDirs: ['.junie'], skillsDir: '.junie/skills' },
  { name: 'Kilo Code', detectDirs: ['.kilocode'], skillsDir: '.kilocode/skills' },
  { name: 'Kiro CLI', detectDirs: ['.kiro'], skillsDir: '.kiro/skills' },
  { name: 'Kode', detectDirs: ['.kode'], skillsDir: '.kode/skills' },
  { name: 'MCPJam', detectDirs: ['.mcpjam'], skillsDir: '.mcpjam/skills' },
  { name: 'Mistral Vibe', detectDirs: ['.vibe'], skillsDir: '.vibe/skills' },
  { name: 'Mux', detectDirs: ['.mux'], skillsDir: '.mux/skills' },
  { name: 'OpenCode', detectDirs: ['.opencode'], skillsDir: '.agents/skills' },
  { name: 'OpenHands', detectDirs: ['.openhands'], skillsDir: '.openhands/skills' },
  { name: 'Pi', detectDirs: ['.pi'], skillsDir: '.pi/skills' },
  { name: 'Qoder', detectDirs: ['.qoder'], skillsDir: '.qoder/skills' },
  { name: 'Qwen Code', detectDirs: ['.qwen'], skillsDir: '.qwen/skills' },
  { name: 'Roo Code', detectDirs: ['.roo'], skillsDir: '.roo/skills' },
  { name: 'Trae', detectDirs: ['.trae'], skillsDir: '.trae/skills' },
  { name: 'Zencoder', detectDirs: ['.zencoder'], skillsDir: '.zencoder/skills' },
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
 * If no agents are detected, return defaults:
 * - .claude/skills/ (Claude Code native)
 * - .agents/skills/ (cross-client standard per agentskills.io spec)
 */
export function getDefaultTargets(projectDir: string): AgentTarget[] {
  return [
    {
      name: 'Claude Code',
      configDir: '.claude',
      skillsDir: join(projectDir, '.claude/skills'),
    },
    {
      name: 'Universal (.agents/skills)',
      configDir: '.agents',
      skillsDir: join(projectDir, '.agents/skills'),
    },
  ];
}

/**
 * Get ALL detected targets plus cross-client .agents/skills/.
 * Used by watch/daemon mode to ensure maximum coverage.
 */
export function getAllTargets(projectDir: string): AgentTarget[] {
  const detected = detectAgents(projectDir);
  const seenDirs = new Set(detected.map(a => a.skillsDir));

  // Always include cross-client .agents/skills/ if not already covered
  const universalDir = join(projectDir, '.agents/skills');
  if (!seenDirs.has(universalDir)) {
    detected.push({
      name: 'Universal (.agents/skills)',
      configDir: '.agents',
      skillsDir: universalDir,
    });
  }

  return detected;
}

/**
 * Filter agents by name (case-insensitive partial match).
 */
export function filterAgents(agents: AgentTarget[], filter: string[]): AgentTarget[] {
  const normalized = filter.map(f => f.toLowerCase());
  return agents.filter(a => normalized.some(f => a.name.toLowerCase().includes(f)));
}

/**
 * Ensure a skills directory exists.
 */
export function ensureSkillsDir(skillsDir: string): void {
  mkdirSync(skillsDir, { recursive: true });
}
