/**
 * Input history that survives the session.
 *
 * History used to be derived from the messages on screen, so it emptied
 * on /clear and every new session started with nothing to press up
 * into. It is kept in a file next to the credentials instead, one entry
 * per line, oldest first.
 *
 * Nothing the agent says is written here — only what the user typed —
 * and slash commands are kept because re-running one is the common case.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** How many lines are kept. Beyond this the oldest are dropped. */
export const HISTORY_LIMIT = 500;

/** Longest line kept, so a pasted file cannot bloat the file. */
export const HISTORY_MAX_LINE = 4000;

export function historyFile(env: Record<string, string | undefined> = process.env): string {
  if (env.ALMYTY_CHAT_HISTORY) return env.ALMYTY_CHAT_HISTORY;
  return join(homedir(), '.almyty', 'chat-history');
}

/** Newlines are the record separator, so they are escaped on the way in. */
export function encodeEntry(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

export function decodeEntry(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '\\' && i + 1 < value.length) {
      const next = value[i + 1];
      if (next === 'n') { out += '\n'; i++; continue; }
      if (next === '\\') { out += '\\'; i++; continue; }
    }
    out += value[i];
  }
  return out;
}

/**
 * How many appends go by before the file is trimmed.
 *
 * Trimming reads and rewrites the whole file, so doing it on every
 * message put two extra filesystem round-trips in front of every turn.
 * The file is allowed to run a little over the limit between trims.
 */
export const TRIM_EVERY = 50;

/** Last entry written per file, so a repeat costs no read. */
const lastAppended = new Map<string, string>();
const appendsSinceTrim = new Map<string, number>();

/** Forget the in-process memo. Tests use this; nothing else needs it. */
export function resetHistoryState(): void {
  lastAppended.clear();
  appendsSinceTrim.clear();
}

/** Oldest first. Never throws: no history is a worse day, not a crash. */
export function loadHistory(file = historyFile()): string[] {
  try {
    return readFileSync(file, 'utf-8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map(decodeEntry);
  } catch {
    return [];
  }
}

/** Cut the file back to the newest HISTORY_LIMIT entries. */
export function trimHistory(file = historyFile()): void {
  try {
    const entries = loadHistory(file);
    if (entries.length <= HISTORY_LIMIT) return;
    writeFileSync(file, entries.slice(entries.length - HISTORY_LIMIT).map(encodeEntry).join('\n') + '\n', 'utf-8');
  } catch {
    /* a history file we cannot rewrite is not worth failing a turn over */
  }
}

/**
 * Append one entry, skipping a repeat of the line before it.
 *
 * One filesystem write on the common path: this runs on the keystroke
 * that submits a message, so it is not the place for a read, a mkdir
 * and a rewrite.
 */
export function appendHistory(entry: string, file = historyFile()): void {
  const value = entry.trim();
  if (!value || value.length > HISTORY_MAX_LINE) return;
  if (lastAppended.get(file) === value) return;

  try {
    const line = encodeEntry(value) + '\n';
    try {
      appendFileSync(file, line, 'utf-8');
    } catch (err) {
      if ((err as { code?: string })?.code !== 'ENOENT') throw err;
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, line, 'utf-8');
    }
    lastAppended.set(file, value);

    const count = (appendsSinceTrim.get(file) ?? 0) + 1;
    if (count >= TRIM_EVERY) {
      appendsSinceTrim.set(file, 0);
      trimHistory(file);
    } else {
      appendsSinceTrim.set(file, count);
    }
  } catch {
    /* history is a convenience, never a reason to fail a turn */
  }
}

/**
 * Where up/down land, given how far back the cursor already is.
 *
 * `idx` is -1 for "at the live prompt" and counts backwards from the
 * newest entry. Returns the new index and the text to show.
 */
export function walkHistory(
  history: string[],
  idx: number,
  direction: 'up' | 'down',
): { idx: number; value: string } {
  if (direction === 'up') {
    if (!history.length) return { idx, value: '' };
    const next = Math.min(idx + 1, history.length - 1);
    return { idx: next, value: history[history.length - 1 - next] };
  }
  if (idx > 0) {
    const next = idx - 1;
    return { idx: next, value: history[history.length - 1 - next] };
  }
  if (idx === 0) return { idx: -1, value: '' };
  return { idx, value: '' };
}
