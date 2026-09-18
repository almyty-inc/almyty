import type { RunnerSummary } from '@almyty/client';

// ── Slash command resolution ────────────────────────────────────

export const SLASH_COMMANDS = [
  'agents', 'model', 'tools', 'cost', 'trace', 'resume', 'new',
  'runners', 'code', 'code-stop', 'esc', 'help', 'clear', 'quit',
] as const;

export const ALIASES: Record<string, string> = {
  agent: 'agents', ag: 'agents', switch: 'agents', sw: 'agents',
  tool: 'tools', t: 'tools',
  usage: 'cost', spend: 'cost',
  steps: 'trace', last: 'trace',
  reset: 'new',
  // `r` predates /resume and kept meaning runners; /res resolves resume.
  runner: 'runners', r: 'runners',
  stop: 'code-stop',
  detach: 'esc',
  h: 'help', '?': 'help',
  cls: 'clear', c: 'clear',
  exit: 'quit', q: 'quit',
};

export const COMMAND_DESCS: Record<string, string> = {
  agents: 'browse and switch agents',
  model: 'show the model and routing policy in use',
  tools: 'show available tools',
  cost: 'show tokens and spend for this session',
  trace: "show the last run's steps",
  resume: 'print the command that resumes this conversation',
  new: 'start a fresh conversation with the same agent',
  runners: 'list your runners + coding CLIs',
  code: 'run a coding task on a runner',
  'code-stop': 'stop the active coding session',
  esc: 'leave coding mode (session keeps running)',
  help: 'show commands',
  clear: 'clear the transcript on screen',
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

// ── Multi-line input ────────────────────────────────────────────

/**
 * Whether a submitted line asks to keep typing.
 *
 * A single-line prompt still has to accept a paragraph, so a trailing
 * backslash continues onto the next line the way a shell does. Returns
 * the text without the continuation marker, or null when the line is
 * complete.
 */
export function continuationOf(value: string): string | null {
  if (!/\\$/.test(value)) return null;
  // An escaped backslash at the end is a literal one, not a hinge.
  const trailing = value.length - value.replace(/\\+$/, '').length;
  if (trailing % 2 === 0) return null;
  return value.slice(0, -1);
}

/**
 * A pasted block, as one message.
 *
 * A multi-line paste used to submit on its first newline and hand the
 * rest to the prompt a line at a time — so a pasted stack trace became
 * a dozen messages, and any line of it starting with `/` ran as a
 * command. Newlines inside a submitted value are content.
 */
export function joinSubmission(lines: string[]): string {
  return lines.join('\n').replace(/\s+$/, '');
}

/** Whether a submission should be read as a slash command. */
export function isSlashCommand(value: string): boolean {
  const trimmed = value.trim();
  // Only a single-line submission can be a command: a pasted block that
  // happens to begin with a slash is text.
  return trimmed.startsWith('/') && !trimmed.includes('\n');
}

// ── Coding-mode input routing ───────────────────────────────────

export type InputRoute = 'command' | 'coding' | 'chat';

/**
 * Where a submitted line goes: slash commands are always commands; when a
 * coding session is active, everything else routes to the session's stdin;
 * otherwise it's a normal chat message.
 */
export function classifyInput(value: string, codingActive: boolean): InputRoute {
  if (isSlashCommand(value)) return 'command';
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