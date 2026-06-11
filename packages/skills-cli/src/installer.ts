/**
 * Skill installer — writes SKILL.md files to agent directories.
 *
 * Naming: the skill's own name is used directly for both the
 * directory and the SKILL.md frontmatter `name:` field. We used to
 * prefix `almyty-` to flag installs as ours; that turned the agent-
 * visible label into `$almyty-open-meteo-weather-get-v1-forecast`,
 * which is noisy and uninformative. Identification for `remove`
 * and `installed` now reads the `metadata.author: almyty` line
 * already present in every SKILL.md we generate.
 */

import { writeFileSync, mkdirSync, existsSync, readdirSync, rmSync, readFileSync } from 'fs';
import { join, resolve, sep } from 'path';
import type { SkillFile } from './client.js';
import type { AgentTarget } from './agents.js';

/** Legacy prefix from <=v1.0.9 — older installs still use this dir
 *  name. Kept here so `remove`/`installed` continue to find them. */
const LEGACY_SKILL_PREFIX = 'almyty-';

/** Marker line we expect inside every SKILL.md frontmatter we wrote. */
const ALMYTY_MARKER = /^\s*author:\s*almyty\s*$/m;

/**
 * Skill names come from the backend/gateway and are used to build
 * filesystem paths under skillsDir. A malicious or compromised gateway
 * could return `name: "../../../.ssh/authorized_keys"` and have the
 * installer write — or, via the legacy-dir cleanup, recursively delete —
 * arbitrary files on the user's machine (and the daemon/watch modes do
 * this automatically on a timer). Restrict names to a single safe path
 * segment.
 */
const SAFE_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isSafeSkillName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    SAFE_SKILL_NAME.test(name)
  );
}

/** Defence in depth: assert a built path stays inside skillsDir. */
function isInside(baseDir: string, candidate: string): boolean {
  const base = resolve(baseDir);
  const target = resolve(candidate);
  return target === base || target.startsWith(base + sep);
}

export interface InstallResult {
  agent: string;
  skillsDir: string;
  installed: number;
  files: string[];
}

/**
 * Strip the legacy `name: almyty-<x>` line in the SKILL.md frontmatter
 * to `name: <x>` so the agent-visible identifier is the skill's own
 * slug. Backend currently writes the prefixed form; once that's
 * cleaned up upstream this becomes a no-op.
 */
function rewriteNameInFrontmatter(content: string): string {
  return content.replace(/^name:\s*almyty-/m, 'name: ');
}

/**
 * Read SKILL.md and decide whether it was installed by this CLI
 * (or its predecessor). Two signals: the legacy `almyty-` directory
 * prefix, OR the `metadata.author: almyty` line in the frontmatter.
 */
function isAlmytyInstall(skillsDir: string, dirName: string): boolean {
  if (dirName.startsWith(LEGACY_SKILL_PREFIX)) return true;
  const skillFile = join(skillsDir, dirName, 'SKILL.md');
  if (!existsSync(skillFile)) return false;
  try {
    return ALMYTY_MARKER.test(readFileSync(skillFile, 'utf-8'));
  } catch {
    return false;
  }
}

/**
 * Install skill files into an agent's skills directory.
 * Each skill lives at `<skillsDir>/<skill-name>/SKILL.md`.
 */
export function installSkills(
  skills: SkillFile[],
  target: AgentTarget,
): InstallResult {
  const files: string[] = [];

  mkdirSync(target.skillsDir, { recursive: true });

  for (const skill of skills) {
    // Reject backend-supplied names that aren't a single safe path
    // segment — skip rather than throw so one bad entry can't break the
    // whole install (e.g. in daemon/watch mode).
    if (!isSafeSkillName(skill.name)) {
      console.warn(`Skipping skill with unsafe name: ${JSON.stringify(skill.name)}`);
      continue;
    }

    const dirName = skill.name;
    const skillDir = join(target.skillsDir, dirName);
    const skillFile = join(skillDir, 'SKILL.md');

    // Cleanup: if a previous install used the `almyty-<name>` dir
    // shape, remove it before writing the new shape so the agent
    // doesn't see two copies of the same skill.
    const legacyDir = join(target.skillsDir, `${LEGACY_SKILL_PREFIX}${skill.name}`);
    // Containment guard (defence in depth) before any write/delete.
    if (!isInside(target.skillsDir, skillDir) || !isInside(target.skillsDir, legacyDir)) {
      console.warn(`Skipping skill whose path escapes the skills directory: ${skill.name}`);
      continue;
    }
    if (legacyDir !== skillDir && existsSync(legacyDir)) {
      rmSync(legacyDir, { recursive: true, force: true });
    }

    mkdirSync(skillDir, { recursive: true });
    writeFileSync(skillFile, rewriteNameInFrontmatter(skill.content), 'utf-8');
    files.push(skillFile);
  }

  return {
    agent: target.name,
    skillsDir: target.skillsDir,
    installed: skills.length,
    files,
  };
}

/** Remove every almyty-installed skill from an agent's skills directory. */
export function removeSkills(target: AgentTarget): number {
  if (!existsSync(target.skillsDir)) return 0;

  const entries = readdirSync(target.skillsDir, { withFileTypes: true });
  let removed = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!isAlmytyInstall(target.skillsDir, entry.name)) continue;
    rmSync(join(target.skillsDir, entry.name), { recursive: true, force: true });
    removed++;
  }

  return removed;
}

/** List almyty-installed skills in an agent's skills directory. */
export function listInstalledSkills(target: AgentTarget): string[] {
  if (!existsSync(target.skillsDir)) return [];

  const entries = readdirSync(target.skillsDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && isAlmytyInstall(target.skillsDir, e.name))
    .map((e) => e.name.replace(LEGACY_SKILL_PREFIX, ''));
}
