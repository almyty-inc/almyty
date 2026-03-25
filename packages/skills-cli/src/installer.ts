/**
 * Skill installer — writes SKILL.md files to agent directories.
 */

import { writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'fs';
import { join, basename } from 'path';
import type { SkillFile } from './client.js';
import type { AgentTarget } from './agents.js';

const SKILL_PREFIX = 'almyty-';

export interface InstallResult {
  agent: string;
  skillsDir: string;
  installed: number;
  files: string[];
}

/**
 * Install skill files into an agent's skills directory.
 * Each skill gets its own directory: <skillsDir>/almyty-<name>/SKILL.md
 */
export function installSkills(
  skills: SkillFile[],
  target: AgentTarget,
): InstallResult {
  const files: string[] = [];

  mkdirSync(target.skillsDir, { recursive: true });

  for (const skill of skills) {
    const dirName = `${SKILL_PREFIX}${skill.name}`;
    const skillDir = join(target.skillsDir, dirName);
    const skillFile = join(skillDir, 'SKILL.md');

    mkdirSync(skillDir, { recursive: true });
    writeFileSync(skillFile, skill.content, 'utf-8');
    files.push(skillFile);
  }

  return {
    agent: target.name,
    skillsDir: target.skillsDir,
    installed: skills.length,
    files,
  };
}

/**
 * Remove all almyty-installed skills from an agent's skills directory.
 */
export function removeSkills(target: AgentTarget): number {
  if (!existsSync(target.skillsDir)) return 0;

  const entries = readdirSync(target.skillsDir, { withFileTypes: true });
  let removed = 0;

  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith(SKILL_PREFIX)) {
      rmSync(join(target.skillsDir, entry.name), { recursive: true, force: true });
      removed++;
    }
  }

  return removed;
}

/**
 * List installed almyty skills in an agent's skills directory.
 */
export function listInstalledSkills(target: AgentTarget): string[] {
  if (!existsSync(target.skillsDir)) return [];

  const entries = readdirSync(target.skillsDir, { withFileTypes: true });
  return entries
    .filter(e => e.isDirectory() && e.name.startsWith(SKILL_PREFIX))
    .map(e => e.name.replace(SKILL_PREFIX, ''));
}
