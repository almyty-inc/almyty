// ── Slash command resolution ────────────────────────────────────

export const SLASH_COMMANDS = ['agents', 'tools', 'help', 'clear', 'quit'] as const;

export const ALIASES: Record<string, string> = {
  agent: 'agents', ag: 'agents', switch: 'agents', sw: 'agents',
  tool: 'tools', t: 'tools',
  h: 'help', '?': 'help',
  cls: 'clear', c: 'clear',
  exit: 'quit', q: 'quit',
};

export const COMMAND_DESCS: Record<string, string> = {
  agents: 'browse and switch agents',
  tools: 'show available tools',
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
