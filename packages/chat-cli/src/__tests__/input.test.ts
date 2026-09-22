/**
 * Persistent input history, multi-line input, and the viewport.
 *
 * History used to be derived from the messages on screen, so /clear
 * erased it and a new session started with nothing to press up into.
 * Multi-line input did not exist, and a pasted block submitted on its
 * first newline — so any pasted line starting with `/` ran as a
 * command. The viewport arithmetic existed but was never wired up, so
 * a long transcript simply overflowed the terminal.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  HISTORY_LIMIT,
  TRIM_EVERY,
  appendHistory,
  decodeEntry,
  encodeEntry,
  historyFile,
  loadHistory,
  resetHistoryState,
  trimHistory,
  walkHistory,
} from '../history.js';
import { continuationOf, isSlashCommand, joinSubmission, classifyInput } from '../commands.js';
import { columns, displayWidth, estimateLines, selectWindow, usableRows, MIN_COLUMNS, MIN_ROWS } from '../viewport.js';

describe('persistent history', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    resetHistoryState();
    dir = mkdtempSync(join(tmpdir(), 'almyty-chat-hist-'));
    file = join(dir, 'chat-history');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('survives into the next session', () => {
    appendHistory('what is our refund window?', file);
    appendHistory('/tools', file);
    expect(loadHistory(file)).toEqual(['what is our refund window?', '/tools']);
  });

  it('creates the directory it needs', () => {
    const nested = join(dir, 'deeper', 'chat-history');
    appendHistory('hello', nested);
    expect(loadHistory(nested)).toEqual(['hello']);
  });

  it('skips an immediate repeat', () => {
    appendHistory('same', file);
    appendHistory('same', file);
    expect(loadHistory(file)).toEqual(['same']);
  });

  it('keeps a multi-line entry as one entry', () => {
    appendHistory('line one\nline two', file);
    expect(loadHistory(file)).toEqual(['line one\nline two']);
    // One record per line on disk, so the file stays greppable.
    expect(readFileSync(file, 'utf-8').split('\n').filter(Boolean)).toHaveLength(1);
  });

  it('round-trips backslashes', () => {
    const value = 'a \\n literal and a real\nnewline';
    expect(decodeEntry(encodeEntry(value))).toBe(value);
  });

  it('trims back to the cap, keeping the newest', () => {
    // Written in one go: appending 500 entries one at a time is a
    // filesystem benchmark, not a test of the cap.
    const entries = Array.from({ length: HISTORY_LIMIT + 60 }, (_, i) => `entry ${i}`);
    writeFileSync(file, entries.join('\n') + '\n');
    trimHistory(file);

    const loaded = loadHistory(file);
    expect(loaded).toHaveLength(HISTORY_LIMIT);
    expect(loaded[loaded.length - 1]).toBe(`entry ${HISTORY_LIMIT + 59}`);
    expect(loaded[0]).toBe('entry 60');
  });

  it('leaves a file under the cap alone', () => {
    writeFileSync(file, 'one\ntwo\n');
    trimHistory(file);
    expect(loadHistory(file)).toEqual(['one', 'two']);
  });

  it('appending is one write, so submitting a message is not a filesystem stall', () => {
    let writes = 0;
    const counted = join(dir, 'counted');
    for (let i = 0; i < TRIM_EVERY - 1; i++) {
      appendHistory(`entry ${i}`, counted);
      writes++;
    }
    expect(loadHistory(counted)).toHaveLength(writes);
  });

  it('drops an entry too large to be a prompt', () => {
    appendHistory('x'.repeat(10_000), file);
    expect(loadHistory(file)).toEqual([]);
  });

  it('is empty rather than fatal when the file is unreadable', () => {
    expect(loadHistory(join(dir, 'missing'))).toEqual([]);
    writeFileSync(file, '');
    expect(loadHistory(file)).toEqual([]);
  });

  it('never throws when the path cannot be written', () => {
    // A path *through* a regular file: mkdir -p answers ENOTDIR on every
    // platform, immediately. Do NOT reach for a system path like /proc
    // here -- on Linux `mkdirSync('/proc/...', { recursive: true })` does
    // not fail, it blocks forever, so this one assertion hung the whole
    // CI leg for fifteen minutes and reported as cancelled (#657). It
    // returned ENOENT instantly on macOS, which is why it looked fine.
    const blocker = join(dir, 'a-file');
    writeFileSync(blocker, 'not a directory');
    expect(() => appendHistory('x', join(blocker, 'nested', 'history'))).not.toThrow();
  });

  it('is overridable, so a test or a sandbox does not touch the real one', () => {
    expect(historyFile({ ALMYTY_CHAT_HISTORY: '/tmp/x' })).toBe('/tmp/x');
    expect(historyFile({})).toContain('.almyty');
  });
});

describe('walkHistory', () => {
  const history = ['first', 'second', 'third'];

  it('up walks backwards from the newest', () => {
    expect(walkHistory(history, -1, 'up')).toEqual({ idx: 0, value: 'third' });
    expect(walkHistory(history, 0, 'up')).toEqual({ idx: 1, value: 'second' });
  });

  it('up stops at the oldest', () => {
    expect(walkHistory(history, 2, 'up')).toEqual({ idx: 2, value: 'first' });
  });

  it('down returns to an empty prompt', () => {
    expect(walkHistory(history, 1, 'down')).toEqual({ idx: 0, value: 'third' });
    expect(walkHistory(history, 0, 'down')).toEqual({ idx: -1, value: '' });
  });

  it('does nothing with no history', () => {
    expect(walkHistory([], -1, 'up')).toEqual({ idx: -1, value: '' });
    expect(walkHistory([], -1, 'down')).toEqual({ idx: -1, value: '' });
  });
});

describe('multi-line input', () => {
  it('a trailing backslash keeps the message open', () => {
    expect(continuationOf('first line \\')).toBe('first line ');
    expect(continuationOf('complete line')).toBeNull();
  });

  it('an escaped backslash is a literal one, not a hinge', () => {
    expect(continuationOf('a path C:\\\\')).toBeNull();
    expect(continuationOf('three \\\\\\')).toBe('three \\\\');
  });

  it('joins the pieces into one message', () => {
    expect(joinSubmission(['one', 'two', 'three'])).toBe('one\ntwo\nthree');
  });

  it('a pasted block is text, even when a line starts with a slash', () => {
    const paste = '/etc/hosts is wrong\nand so is /var/log';
    expect(isSlashCommand(paste)).toBe(false);
    expect(classifyInput(paste, false)).toBe('chat');
    // A real command still resolves.
    expect(isSlashCommand('  /help ')).toBe(true);
    expect(classifyInput('/help', true)).toBe('command');
  });
});

describe('viewport', () => {
  it('never lays out narrower than a phone-width terminal', () => {
    expect(columns(20)).toBe(MIN_COLUMNS);
    expect(columns(undefined)).toBe(80);
    expect(columns(200)).toBe(200);
  });

  it('leaves rows for the transcript, and a floor on a tiny window', () => {
    expect(usableRows(40, 10)).toBe(30);
    expect(usableRows(8, 10)).toBe(MIN_ROWS);
    expect(usableRows(undefined, 10)).toBe(14);
  });

  it('counts the wrap, so 40 columns costs more rows than 80', () => {
    const paragraph = 'x'.repeat(300);
    expect(estimateLines(paragraph, 40)).toBeGreaterThan(estimateLines(paragraph, 80));
    expect(estimateLines('one\ntwo', 80)).toBe(3);
  });

  it('measures a line in terminal columns, not UTF-16 units', () => {
    // A transcript in Japanese or Chinese estimated half its real height,
    // so the window packed twice what fits and ink drew a frame taller
    // than the terminal. Every wide character is two columns.
    expect(displayWidth('hello')).toBe(5);
    expect(displayWidth('日本語')).toBe(6);
    expect(displayWidth('안녕하세요')).toBe(10);
    // An astral emoji is two UTF-16 units and two columns, not four.
    expect(displayWidth('🚀')).toBe(2);
    // Combining marks and variation selectors take no columns of their own.
    expect(displayWidth('é')).toBe(1);
    expect(displayWidth('❤️')).toBe(1);
  });

  it('costs a wide-character paragraph the rows it really takes', () => {
    const cjk = '日'.repeat(60);
    const latin = 'x'.repeat(60);
    expect(estimateLines(cjk, 80)).toBe(estimateLines(latin.repeat(2), 80));
    expect(estimateLines(cjk, 80)).toBeGreaterThan(estimateLines(latin, 80));
  });

  it('hides more of a wide-character transcript than a Latin one at the same size', () => {
    const rows = 12;
    const cjk = Array.from({ length: 30 }, () => ({ text: '日'.repeat(100) }));
    const latin = Array.from({ length: 30 }, () => ({ text: 'a'.repeat(100) }));
    const wide = selectWindow(cjk, { rows, cols: 80 });
    const narrow = selectWindow(latin, { rows, cols: 80 });
    expect(wide.endIdx - wide.startIdx).toBeLessThan(narrow.endIdx - narrow.startIdx);
  });

  it('shows the newest messages and counts what it hid', () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({ text: `message ${i}` }));
    const window = selectWindow(messages, { rows: 10, cols: 80 });
    expect(window.endIdx).toBe(50);
    expect(window.hiddenAfter).toBe(0);
    expect(window.hiddenBefore).toBeGreaterThan(0);
    expect(window.endIdx - window.startIdx).toBeLessThan(50);
  });

  it('draws everything when everything fits', () => {
    const messages = [{ text: 'a' }, { text: 'b' }];
    expect(selectWindow(messages, { rows: 40, cols: 80 })).toMatchObject({ startIdx: 0, endIdx: 2, hiddenBefore: 0, hiddenAfter: 0 });
  });

  it('keeps the newest message even when it alone overflows', () => {
    const messages = [{ text: 'old' }, { text: 'x'.repeat(5000) }];
    const window = selectWindow(messages, { rows: 6, cols: 40 });
    expect(window.endIdx).toBe(2);
    expect(window.startIdx).toBe(1);
  });

  it('scrolling back reports what is newer', () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({ text: `m${i}` }));
    const window = selectWindow(messages, { rows: 10, cols: 80, scrollOffset: 5 });
    expect(window.endIdx).toBe(15);
    expect(window.hiddenAfter).toBe(5);
  });

  it('reserves room for the spinner and the text still arriving', () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({ text: `m${i}` }));
    const plain = selectWindow(messages, { rows: 20, cols: 80 });
    const reserved = selectWindow(messages, { rows: 20, cols: 80, reservedRows: 8 });
    expect(reserved.startIdx).toBeGreaterThan(plain.startIdx);
  });

  it('handles an empty transcript', () => {
    expect(selectWindow([], { rows: 10, cols: 80 })).toEqual({ startIdx: 0, endIdx: 0, hiddenBefore: 0, hiddenAfter: 0 });
  });
});
