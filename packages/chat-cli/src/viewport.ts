/**
 * How much of the transcript fits on screen.
 *
 * ink redraws its whole tree, so a transcript taller than the terminal
 * garbles the frame instead of scrolling it. The fix is to draw only
 * what fits and say how much is above. Pure arithmetic, kept out of the
 * components so it can be tested at any terminal size — including the
 * 40-column window nobody remembers to try.
 */

/** Narrowest width worth laying out for. */
export const MIN_COLUMNS = 40;

/** Fewest transcript rows to draw, even on a very short terminal. */
export const MIN_ROWS = 5;

export function columns(stdoutColumns?: number): number {
  return Math.max(stdoutColumns && stdoutColumns > 0 ? stdoutColumns : 80, MIN_COLUMNS);
}

/**
 * Rows left for the transcript once the header, prompt and status bar
 * have taken theirs.
 */
export function usableRows(stdoutRows: number | undefined, chromeRows: number): number {
  const total = stdoutRows && stdoutRows > 0 ? stdoutRows : 24;
  return Math.max(total - chromeRows, MIN_ROWS);
}

/**
 * Code points that take two terminal columns: the East Asian Wide and
 * Fullwidth ranges, plus the emoji blocks terminals render double-width.
 */
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals, Kangxi, CJK symbols
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana, Katakana, Hangul, CJK compatibility
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK extension A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified ideographs
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) || // emoji, pictographs
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK extension B and later
  );
}

/**
 * How many terminal columns a string occupies.
 *
 * `String.length` counts UTF-16 units, which is not width. A CJK
 * character is one unit and two columns; an emoji is two units and two
 * columns; a combining mark or a zero-width joiner is a unit and no
 * columns. Measuring by length made a Japanese or Chinese transcript
 * estimate half its real height, so the window packed twice what fits
 * and ink drew a frame taller than the terminal — the garbling the rest
 * of this module exists to prevent.
 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    // Zero-width: combining marks, joiners, variation selectors.
    if (
      cp === 0x200b || cp === 0x200d || cp === 0xfeff ||
      (cp >= 0x0300 && cp <= 0x036f) ||
      (cp >= 0x1ab0 && cp <= 0x1aff) ||
      (cp >= 0x20d0 && cp <= 0x20f0) ||
      (cp >= 0xfe00 && cp <= 0xfe0f)
    ) {
      continue;
    }
    width += isWide(cp) ? 2 : 1;
  }
  return width;
}

/**
 * Rows one message will occupy at this width.
 *
 * Counts the wrap, not the characters: a 300-character paragraph is
 * four rows at 80 columns and eight at 40.
 */
export function estimateLines(text: string, cols: number): number {
  const textWidth = Math.max(cols - 10, 20);
  const lines = text.split('\n');
  let total = 1; // the margin every message carries
  for (const line of lines) {
    total += Math.max(1, Math.ceil(Math.max(displayWidth(line), 1) / textWidth));
  }
  return total;
}

export interface WindowSelection {
  startIdx: number;
  endIdx: number;
  hiddenBefore: number;
  hiddenAfter: number;
}

/**
 * The slice of messages to draw.
 *
 * Walks backwards from the end so the newest message is always visible:
 * a transcript that scrolls away from the answer you just asked for is
 * worse than one that hides the beginning. The newest message is kept
 * even when it alone is taller than the window, because dropping it
 * would leave an empty screen.
 */
export function selectWindow(
  messages: Array<{ text: string }>,
  options: { rows: number; cols: number; reservedRows?: number; scrollOffset?: number },
): WindowSelection {
  const scrollOffset = Math.max(0, Math.min(options.scrollOffset ?? 0, messages.length));
  const available = Math.max(options.rows - (options.reservedRows ?? 0), MIN_ROWS);
  const endIdx = Math.max(0, messages.length - scrollOffset);

  let used = 0;
  let startIdx = endIdx;

  for (let i = endIdx - 1; i >= 0; i--) {
    const cost = estimateLines(messages[i].text, options.cols);
    // The last message always goes in; anything earlier has to fit.
    if (used + cost > available && i < endIdx - 1) break;
    used += cost;
    startIdx = i;
  }

  return {
    startIdx,
    endIdx,
    hiddenBefore: startIdx,
    hiddenAfter: messages.length - endIdx,
  };
}
