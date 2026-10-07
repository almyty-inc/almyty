/**
 * A conversation's title, from the first thing the person said: its first
 * line with text, spaces collapsed, cut at a word near 80 characters. A
 * message with no text (only files, say) gives none, and the list shows
 * its own fallback.
 */
export const CONVERSATION_TITLE_MAX = 80;

export function conversationTitle(input: unknown): string | null {
  const said =
    typeof input === 'string'
      ? input
      : input && typeof input === 'object' && typeof (input as { message?: unknown }).message === 'string'
        ? (input as { message: string }).message
        : '';
  const line = said
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  if (line.length <= CONVERSATION_TITLE_MAX) return line;
  const cut = line.slice(0, CONVERSATION_TITLE_MAX - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space >= CONVERSATION_TITLE_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
