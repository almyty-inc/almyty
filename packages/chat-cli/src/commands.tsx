import type { RunnerSummary } from '@almyty/client';

// ── Slash command resolution ────────────────────────────────────

export const SLASH_COMMANDS = [
  'agents', 'tools', 'runners', 'code', 'code-stop', 'esc', 'help', 'clear', 'quit',
] as const;

export const ALIASES: Record<string, string> = {
  agent: 'agents', ag: 'agents', switch: 'agents', sw: 'agents',
  tool: 'tools', t: 'tools',
  runner: 'runners',
  stop: 'code-stop',
  detach: 'esc',
  h: 'help', '?': 'help',
  cls: 'clear', c: 'clear',
  exit: 'quit', q: 'quit',
};

export const COMMAND_DESCS: Record<string, string> = {
  agents: 'browse and switch agents',
  tools: 'show available tools',
  runners: 'list your runners + coding CLIs',
  code: 'run a coding task on a runner',
  'code-stop': 'stop the active coding session',
  esc: 'leave coding mode (session keeps running)',
  help: 'show commands',
  clear: 'clear conversation',
  quit: 'exit',
};

export function resolveSlash(input: string): string | null {
  const name = input.toLowerCase();
  if ((SLASH_COMMANDS as readonly string[]).includes(name)) return name;
  if (ALIASES[name]) return ALIASES[name];
  const prefixed = SLASH_COMMANDS.filter(c => c.startsWith(name));
  if (prefixed.length === 1) return prefixed[0];
  return null;
}

export function getSuggestion(partial: string): string {
  if (!partial.startsWith('/') || partial.includes(' ')) return '';
  const p = partial.slice(1).toLowerCase();
  if (!p) return '';
  const match = SLASH_COMMANDS.find(c => c.startsWith(p) && c !== p);
  return match ? `/${match}` : '';
}

// ── Coding-mode input routing ───────────────────────────────────

export type InputRoute = 'command' | 'coding' | 'chat';

/**
 * Where a submitted line goes: slash commands are always commands; when a
 * coding session is active, everything else routes to the session's stdin;
 * otherwise it's a normal chat message.
 */
export function classifyInput(value: string, codingActive: boolean): InputRoute {
  if (value.trim().startsWith('/')) return 'command';
  return codingActive ? 'coding' : 'chat';
}

// ── /code target selection ──────────────────────────────────────

/** Runner states that can accept a coding dispatch. */
const DISPATCHABLE_STATES = new Set(['online', 'busy']);

export interface CodeChoice {
  runnerId: string;
  runnerName: string;
  agentId: string;
  agentName: string;
}

/**
 * Expand online runners x detected coding CLIs into a flat choice list for
 * the selector. Offline/stale runners and runners without any detected
 * coding CLI are excluded.
 */
export function buildCodeChoices(runners: RunnerSummary[]): CodeChoice[] {
  const choices: CodeChoice[] = [];
  for (const runner of runners) {
    if (!DISPATCHABLE_STATES.has(runner.state ?? '')) continue;
    for (const agent of runner.codingAgents ?? []) {
      choices.push({
        runnerId: runner.id,
        runnerName: runner.name,
        agentId: agent.id,
        agentName: agent.displayName || agent.id,
      });
    }
  }
  return choices;
}