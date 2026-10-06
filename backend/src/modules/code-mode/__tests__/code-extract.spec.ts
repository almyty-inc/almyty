import { buildExtract, parseJsonAnswer } from '../code-extract';

describe('extract()', () => {
  it('reads JSON from a bare answer, a fenced one, or one with prose around it', () => {
    expect(parseJsonAnswer('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonAnswer('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonAnswer('```\n[1,2]\n```')).toEqual([1, 2]);
    expect(parseJsonAnswer('Here it is: {"a":2} hope that helps')).toEqual({ a: 2 });
    expect(() => parseJsonAnswer('no json here')).toThrow(/did not answer with JSON/);
  });

  it('stays linear on long whitespace inside a fence', () => {
    const started = Date.now();
    expect(() => parseJsonAnswer('```' + ' '.repeat(200_000) + 'x')).toThrow();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('returns a value that matches the schema, charged, or throws', async () => {
    const chat = jest.fn(async () => ({ message: { content: '```json\n{"n": 3}\n```' }, cost: 0.01, usage: { totalTokens: 42 } }));
    const extract = buildExtract({ chat, settings: { maxInputChars: 10, maxTokens: 50 } });
    await expect(extract('three pets', { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] })).resolves.toEqual({ value: { n: 3 }, cost: 0.01, tokens: 42 });
    expect((chat.mock.calls[0] as any[])[1]).toMatchObject({ routing: { objective: 'cheapest' }, maxTokens: 50 });
    await expect(extract('x', { type: 'object', required: ['missing'] })).rejects.toThrow(/does not match the schema/);
  });
});
