import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { detectAgents, getDefaultTargets, type AgentTarget, filterAgents } from './agents.js';

export interface AlmytyConfig {
  skillsDir?: string;
  agents?: string[];
  url?: string;
  interval?: number;
}

export function loadConfig(projectDir?: string): AlmytyConfig {
  const envDir = process.env.APIFAI_SKILLS_DIR;
  if (envDir) {
    return { skillsDir: envDir };
  }

  const cwd = projectDir || process.cwd();
  const projectRc = join(cwd, '.almytyrc');
  if (existsSync(projectRc)) {
    return parseRcFile(projectRc);
  }

  const homeRc = join(homedir(), '.almytyrc');
  if (existsSync(homeRc)) {
    return parseRcFile(homeRc);
  }

  return {};
}

function parseRcFile(path: string): AlmytyConfig {
  try {
    const data = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(data);
    return {
      skillsDir: parsed.skillsDir,
      agents: parsed.agents,
      url: parsed.url,
      interval: parsed.interval,
    };
  } catch {
    return {};
  }
}

export function resolveTargets(projectDir: string, config: AlmytyConfig): AgentTarget[] {
  if (config.skillsDir) {
    return [{
      name: 'custom',
      configDir: config.skillsDir,
      skillsDir: resolve(config.skillsDir),
    }];
  }

  let targets = detectAgents(projectDir);
  if (targets.length === 0) {
    targets = getDefaultTargets(projectDir);
  }

  if (config.agents) {
    targets = filterAgents(targets, config.agents);
  }

  return targets;
}
