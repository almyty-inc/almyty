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
    total += Math.max(1, Math.ceil(Math.max(line.length, 1) / textWidth));
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
