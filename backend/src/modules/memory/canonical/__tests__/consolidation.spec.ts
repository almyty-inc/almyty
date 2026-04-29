import { __test__ } from '../consolidation.service';

const { parseFacts, buildConsolidationPrompt } = __test__;

describe('parseFacts', () => {
  it('returns empty for empty input', () => {
    expect(parseFacts('')).toEqual([]);
  });
  it('parses a JSON object with a facts array', () => {
    const out = parseFacts(JSON.stringify({
      facts: [
        { content: 'user prefers dark mode', tags: ['ui'], confidence: 0.9 },
        { content: 'agent should always confirm before deleting' },
      ],
    }));
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ content: 'user prefers dark mode', tags: ['ui'], confidence: 0.9 });
    expect(out[1].content).toContain('confirm before deleting');
  });
  it('strips ```json fences before parsing', () => {
    const wrapped = '```json\n{ "facts": [{ "content": "fenced fact" }] }\n```';
    const out = parseFacts(wrapped);
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe('fenced fact');
  });
  it('drops items with missing or non-string content', () => {
    const out = parseFacts(JSON.stringify({ facts: [
      { content: '' }, { tags: ['x'] }, { content: '  ' }, { content: 'kept' },
    ] }));
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe('kept');
  });
  it('clamps confidence outside [0,1] to undefined', () => {
    const out = parseFacts(JSON.stringify({ facts: [
      { content: 'x', confidence: 1.5 }, { content: 'y', confidence: -0.1 },
    ] }));
    expect(out[0].confidence).toBeUndefined();
    expect(out[1].confidence).toBeUndefined();
  });
  it('returns [] on malformed JSON', () => {
    expect(parseFacts('not json')).toEqual([]);
  });
  it('accepts a bare array fallback (some models output that)', () => {
    const out = parseFacts(JSON.stringify([{ content: 'bare array fact' }]));
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe('bare array fact');
  });
});

describe('buildConsolidationPrompt', () => {
  it('mentions strict JSON output and the confidence range', () => {
    const p = buildConsolidationPrompt('(1) hello\n(2) world');
    expect(p.system).toMatch(/strict JSON/i);
    expect(p.system).toMatch(/confidence/);
    expect(p.user).toContain('(1) hello');
    expect(p.user).toContain('(2) world');
  });
});
