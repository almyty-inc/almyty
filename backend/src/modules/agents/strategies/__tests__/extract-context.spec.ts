import { ExtractedContextInvalid, parseExtractedContext } from '../extract-context';

/**
 * The brief is schema-validated because the step after it acts on the
 * brief instead of the transcripts. A malformed or half-empty brief would
 * send the expensive role in blind while looking like a successful step.
 */
describe('the extraction returns a usable brief or says why not', () => {
  const good = {
    relevantFiles: ['src/a.ts'],
    symbols: ['doThing'],
    callers: ['src/b.ts'],
    tests: ['src/__tests__/a.spec.ts'],
    notes: 'the retry lives in b',
  };

  it('parses a plain JSON answer', () => {
    expect(parseExtractedContext(JSON.stringify(good))).toEqual(good);
  });

  it('parses the same answer wrapped in a fence and prose, because models do that', () => {
    const raw = `Here is what I found:\n\n\`\`\`json\n${JSON.stringify(good)}\n\`\`\`\n\nHope that helps.`;
    expect(parseExtractedContext(raw)).toEqual(good);
  });

  it('keeps an empty array, which means looked and found nothing', () => {
    const empty = { ...good, callers: [] };
    expect(parseExtractedContext(JSON.stringify(empty)).callers).toEqual([]);
  });

  it('refuses a missing key rather than inventing an empty one', () => {
    // The distinction that matters: absent is not the same as empty, and
    // defaulting would look like "nothing relevant was found".
    const { callers, ...withoutCallers } = good;
    try {
      parseExtractedContext(JSON.stringify(withoutCallers));
      throw new Error('should have refused');
    } catch (err) {
      expect(err).toBeInstanceOf(ExtractedContextInvalid);
      expect((err as ExtractedContextInvalid).problems).toContain('callers is missing');
    }
  });

  it('names every problem at once, so one round trip fixes them all', () => {
    const bad = { relevantFiles: 'src/a.ts', symbols: [1, 2], callers: [], tests: [] };
    try {
      parseExtractedContext(JSON.stringify(bad));
      throw new Error('should have refused');
    } catch (err) {
      const problems = (err as ExtractedContextInvalid).problems;
      expect(problems).toEqual(
        expect.arrayContaining([
          'relevantFiles must be an array of strings',
          'symbols must be an array of strings',
          'notes is missing',
        ]),
      );
    }
  });

  it('refuses an empty answer, a non-object and unparseable JSON, each with its reason', () => {
    expect(() => parseExtractedContext('')).toThrow(/returned nothing/);
    expect(() => parseExtractedContext('no json here')).toThrow(/no JSON object/);
    expect(() => parseExtractedContext('[1,2,3]')).toThrow(/no JSON object/);
    expect(() => parseExtractedContext('{ "relevantFiles": [ }')).toThrow(/did not parse/);
  });

  it('keeps the raw answer on the error, so a failure is diagnosable', () => {
    try {
      parseExtractedContext('not json at all');
    } catch (err) {
      expect((err as ExtractedContextInvalid).raw).toBe('not json at all');
    }
  });

  it('handles a brace inside a string without stopping early', () => {
    const tricky = { ...good, notes: 'the handler is `if (x) { retry() }` in b' };
    expect(parseExtractedContext(JSON.stringify(tricky)).notes).toContain('retry()');
  });
});
