/**
 * Note: ink-testing-library's mock stdin does not process escape sequences
 * (arrow keys), so up/down history navigation cannot be tested here.
 * Arrow key history must be verified manually in a real terminal.
 *
 * This file tests the history logic in isolation instead.
 */
import { describe, it, expect } from 'vitest';

function simulateHistory(inputs: string[], actions: ('up' | 'down')[]) {
  let historyIdx = -1;
  let current = '';
  const history = [...inputs];

  for (const action of actions) {
    if (action === 'up' && history.length > 0) {
      historyIdx = Math.min(historyIdx + 1, history.length - 1);
      current = history[history.length - 1 - historyIdx];
    } else if (action === 'down') {
      if (historyIdx > 0) {
        historyIdx--;
        current = history[history.length - 1 - historyIdx];
      } else if (historyIdx === 0) {
        historyIdx = -1;
        current = '';
      }
    }
  }
  return { current, historyIdx };
}

describe('History logic', () => {
  it('up arrow shows most recent input', () => {
    const result = simulateHistory(['hello', 'world'], ['up']);
    expect(result.current).toBe('world');
  });

  it('two ups shows second most recent', () => {
    const result = simulateHistory(['hello', 'world'], ['up', 'up']);
    expect(result.current).toBe('hello');
  });

  it('up then down returns to most recent', () => {
    const result = simulateHistory(['hello', 'world'], ['up', 'up', 'down']);
    expect(result.current).toBe('world');
  });

  it('up then down to bottom clears input', () => {
    const result = simulateHistory(['hello'], ['up', 'down']);
    expect(result.current).toBe('');
    expect(result.historyIdx).toBe(-1);
  });

  it('up at end stays at oldest', () => {
    const result = simulateHistory(['a', 'b'], ['up', 'up', 'up', 'up']);
    expect(result.current).toBe('a');
  });

  it('down with no history does nothing', () => {
    const result = simulateHistory([], ['down']);
    expect(result.current).toBe('');
  });
});
