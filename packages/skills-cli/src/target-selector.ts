/**
 * Target selection for the install path.
 *
 * Two scopes:
 *   - **project**: writes to `<cwd>/.<agent>/skills/` so the skill
 *     is part of this checkout. Detected by an `.x/` config dir in
 *     `projectDir`.
 *   - **home**: writes to `~/.<agent>/skills/`, shared across every
 *     project the user opens with that agent. Detected by an `.x/`
 *     config dir in `$HOME`.
 *
 * Order of precedence (highest first):
 *   1. CLI `--path` — explicit custom dir(s); detection ignored.
 *   2. CLI `--all`                — every PROJECT-detected agent + universal
 *      CLI `--all --global`       — every PROJECT-detected + every HOME-detected
 *      CLI `--global` (alone)     — every HOME-detected agent
 *   3. CLI `--agent foo`          — the named agent at whichever scope it's
 *      detected in (project preferred); home if `--global` is set.
 *      `--agent '*'` / `--agent all` — every known agent dir at project scope
 *      regardless of detection.
 *   4. `.almytyrc` skillsDir / agents whitelist.
 *   5. Interactive picker (TTY) — multi-select listing every detected
 *      agent in both scopes plus a "custom path…" option.
 *   6. Non-TTY fallback — project-detected + universal, or defaults.
 */
import { resolve, join } from 'path';
import { homedir } from 'os';
import {
  AGENT_CONFIGS,
  AgentTarget,
  detectAgents,
  detectHomeAgents,
  getDefaultTargets,
} from './agents.js';
import type { AlmytyConfig } from './config.js';

export interface SelectionInput {
  projectDir: string;
  config: AlmytyConfig;
  /** `--agent <name>` (repeatable, comma/space split, supports `*` / `all`). */
  agentFlag?: string | string[];
  /** `--path <dir>` (repeatable, comma split). */
  pathFlag?: string | string[];
  /** `--all`: every project-detected agent + universal. */
  all?: boolean;
  /** `--yes` / `-y`: skip the interactive picker. */
  yes?: boolean;
  /** `--global` / `-G`: include / prefer home-scope installs. */
  global?: boolean;
  /** Override $HOME (test seam). */
  home?: string;
}

function toList(v: string | string[] | undefined): string[] {
  if (!v) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr
    .flatMap((s) => s.split(/[,\s]+/))
    .map((s) => s.trim())
    .filter(Boolean);
}

function customPathTarget(projectDir: string, p: string): AgentTarget {
  const abs = resolve(projectDir, p);
  return {
    name: `custom (${p})`,
    configDir: p,
    skillsDir: abs,
    scope: 'custom',
  };
}

function projectAgentTarget(projectDir: string, name: string): AgentTarget | null {
  const cfg = AGENT_CONFIGS.find((c) => c.name === name);
  if (!cfg) return null;
  return {
    name: cfg.name,
    configDir: cfg.detectDirs[0],
    skillsDir: join(projectDir, cfg.skillsDir),
    scope: 'project',
  };
}

function homeAgentTarget(home: string, name: string): AgentTarget | null {
  const cfg = AGENT_CONFIGS.find((c) => c.name === name);
  if (!cfg) return null;
  return {
    name: cfg.name,
    configDir: cfg.detectDirs[0],
    skillsDir: join(home, cfg.skillsDir),
    scope: 'home',
  };
}

function universalTarget(projectDir: string): AgentTarget {
  return {
    name: 'Universal (.agents/skills)',
    configDir: '.agents',
    skillsDir: join(projectDir, '.agents/skills'),
    scope: 'project',
  };
}

function dedupeBySkillsDir(targets: AgentTarget[]): AgentTarget[] {
  const seen = new Set<string>();
  const out: AgentTarget[] = [];
  for (const t of targets) {
    if (seen.has(t.skillsDir)) continue;
    seen.add(t.skillsDir);
    out.push(t);
  }
  return out;
}

function matchAgentName(filter: string, candidate: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[\s-]/g, '');
  return norm(candidate).includes(norm(filter));
}

/**
 * Resolve targets for non-interactive paths. Returns null when the
 * caller must fall through to the interactive picker (TTY + no
 * resolving flag/config).
 */
export function selectInstallTargetsAuto(
  input: SelectionInput,
): AgentTarget[] | null {
  const { projectDir, config, all, yes, global } = input;
  const home = input.home ?? homedir();
  const agentFlag = toList(input.agentFlag);
  const pathFlag = toList(input.pathFlag);

  // 1. Explicit `--path` wins outright. Detection ignored.
  if (pathFlag.length > 0) {
    return dedupeBySkillsDir(
      pathFlag.map((p) => customPathTarget(projectDir, p)),
    );
  }

  // 2. Bulk install via `--all` and/or `--global`. Only fires when
  //    no `--agent` filter is set — otherwise `--global` is a
  //    *modifier* on the agent-by-name resolution below, not a
  //    standalone "every home-detected" command.
  if ((all || global) && agentFlag.length === 0) {
    const projectDetected = all ? detectAgents(projectDir) : [];
    const homeDetected = global ? detectHomeAgents(home) : [];
    const universal = all ? [universalTarget(projectDir)] : [];
    const combined = [...projectDetected, ...homeDetected, ...universal];
    if (combined.length === 0) {
      throw new Error(
        global && !all
          ? 'No agents detected at home scope (~/.<agent>/). Run `npx @almyty/skills install` interactively or pass `--agent <name>`.'
          : 'No agents detected in this project. Try --agent <name> or --path <dir>.',
      );
    }
    return dedupeBySkillsDir(combined);
  }

  // 3. `--agent foo,bar`. Wildcard expands to every known agent at
  //    project scope. Otherwise: prefer project scope when detected,
  //    else fall through to home scope when detected, else
  //    project-scope at the default path (the agent's not installed
  //    anywhere yet; the user is opting in by name).
  if (agentFlag.length > 0) {
    if (agentFlag.some((f) => f === '*' || f.toLowerCase() === 'all')) {
      const everyKnown = AGENT_CONFIGS
        .map((c) => projectAgentTarget(projectDir, c.name)!)
        .filter(Boolean);
      return dedupeBySkillsDir([...everyKnown, universalTarget(projectDir)]);
    }

    const projectDetectedNames = new Set(
      detectAgents(projectDir).map((a) => a.name),
    );
    const homeDetectedNames = new Set(
      detectHomeAgents(home).map((a) => a.name),
    );

    const targets: AgentTarget[] = [];
    const unmatched: string[] = [];
    for (const filter of agentFlag) {
      const cfg = AGENT_CONFIGS.find((c) => matchAgentName(filter, c.name));
      if (!cfg) {
        unmatched.push(filter);
        continue;
      }
      // Pick the right scope. With `--global` always take home if
      // available; otherwise prefer project, fall through to home.
      if (global && homeDetectedNames.has(cfg.name)) {
        targets.push(homeAgentTarget(home, cfg.name)!);
      } else if (projectDetectedNames.has(cfg.name)) {
        targets.push(projectAgentTarget(projectDir, cfg.name)!);
      } else if (homeDetectedNames.has(cfg.name)) {
        targets.push(homeAgentTarget(home, cfg.name)!);
      } else {
        // Not detected anywhere — install at project scope by name
        // request. The agent picks it up next time it scans.
        targets.push(projectAgentTarget(projectDir, cfg.name)!);
      }
    }

    if (unmatched.length > 0) {
      throw new Error(
        `No known agents matched --agent ${unmatched.join(',')}. ` +
          `Run with --help to see supported names.`,
      );
    }
    return dedupeBySkillsDir([...targets, universalTarget(projectDir)]);
  }

  // 4. Project `.almytyrc` skillsDir override.
  if (config.skillsDir) {
    return [
      {
        name: 'custom (.almytyrc)',
        configDir: config.skillsDir,
        skillsDir: resolve(projectDir, config.skillsDir),
        scope: 'custom',
      },
    ];
  }

  // 5. Project `.almytyrc` agents whitelist (project-scope only).
  if (config.agents && config.agents.length > 0) {
    const matched: AgentTarget[] = [];
    for (const filter of config.agents) {
      const cfg = AGENT_CONFIGS.find((c) => matchAgentName(filter, c.name));
      if (cfg) matched.push(projectAgentTarget(projectDir, cfg.name)!);
    }
    if (matched.length > 0) {
      return dedupeBySkillsDir([...matched, universalTarget(projectDir)]);
    }
  }

  // 6. `--yes` / non-TTY: pick a sensible default WITHOUT prompting.
  //    Project-detected + universal first; if nothing project-side,
  //    show home-detected as a hint (the user probably wants the
  //    interactive picker for this; here we just return defaults
  //    so scripted use doesn't hang).
  if (yes || !process.stdin.isTTY) {
    const projectDetected = detectAgents(projectDir);
    if (projectDetected.length > 0) {
      return dedupeBySkillsDir([
        ...projectDetected,
        universalTarget(projectDir),
      ]);
    }
    return dedupeBySkillsDir([
      ...getDefaultTargets(projectDir),
      universalTarget(projectDir),
    ]);
  }

  // Interactive picker required.
  return null;
}

/**
 * Drive the multi-select picker. Lists every detected agent at
 * BOTH scopes, with detection scope shown as a hint, plus a custom
 * path option. Returns the chosen targets.
 */
export async function selectInstallTargetsInteractive(
  input: SelectionInput,
): Promise<AgentTarget[]> {
  const { projectDir } = input;
  const home = input.home ?? homedir();
  const clack = await import('@clack/prompts');

  const projectDetected = detectAgents(projectDir);
  const homeDetected = detectHomeAgents(home);

  // Build options: project entries first (preferred), then home,
  // then known-but-not-detected as a separate group, then universal,
  // then custom-path. We use synthetic value tokens so we can
  // resolve back to AgentTargets after the multiselect returns.
  const seen = new Set<string>();
  const options: { value: string; label: string; hint?: string }[] = [];

  for (const a of projectDetected) {
    options.push({
      value: `project:${a.name}`,
      label: `${a.name}  (project)`,
      hint: a.skillsDir.replace(projectDir, '.'),
    });
    seen.add(`${a.scope}:${a.name}`);
  }
  for (const a of homeDetected) {
    if (seen.has(`project:${a.name}`)) {
      // Same agent also detected locally — already shown above; the
      // user can still install both scopes by adding the home line
      // here, so keep it.
    }
    options.push({
      value: `home:${a.name}`,
      label: `${a.name}  (home)`,
      hint: a.skillsDir.replace(home, '~'),
    });
  }

  options.push({
    value: '__universal__',
    label: 'Universal (.agents/skills)',
    hint: 'cross-client convention; project scope',
  });

  // List the agents that are recognized but not detected anywhere
  // so users can opt in by checkbox without retyping the name.
  const detectedNames = new Set(
    [...projectDetected, ...homeDetected].map((a) => a.name),
  );
  for (const cfg of AGENT_CONFIGS) {
    if (detectedNames.has(cfg.name)) continue;
    options.push({
      value: `project:${cfg.name}`,
      label: `${cfg.name}`,
      hint: `not detected — would create ${cfg.skillsDir}`,
    });
  }

  options.push({
    value: '__custom__',
    label: 'Custom path…',
    hint: 'enter a directory after this prompt',
  });

  const initialValues = projectDetected.map((a) => `project:${a.name}`);
  if (initialValues.length === 0) initialValues.push('__universal__');

  const picked = await clack.multiselect({
    message: 'Where should the skills be installed?',
    options,
    initialValues,
    required: true,
  });

  if (clack.isCancel(picked)) {
    clack.cancel('Install cancelled.');
    process.exit(0);
  }

  const values = picked as string[];
  const targets: AgentTarget[] = [];

  for (const v of values) {
    if (v === '__universal__') {
      targets.push(universalTarget(projectDir));
      continue;
    }
    if (v === '__custom__') {
      const path = await clack.text({
        message: 'Custom skills directory path:',
        placeholder: 'e.g. .my-agent/skills',
        validate: (s) => (s && s.trim() ? undefined : 'Required'),
      });
      if (clack.isCancel(path)) {
        clack.cancel('Install cancelled.');
        process.exit(0);
      }
      targets.push(customPathTarget(projectDir, String(path).trim()));
      continue;
    }
    const [scope, name] = v.split(':') as ['project' | 'home', string];
    const t = scope === 'home'
      ? homeAgentTarget(home, name)
      : projectAgentTarget(projectDir, name);
    if (t) targets.push(t);
  }

  return dedupeBySkillsDir(targets);
}
