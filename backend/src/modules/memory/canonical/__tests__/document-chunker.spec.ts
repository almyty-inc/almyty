import { chunkText } from '../document-chunker.service';
import { LIMITS } from '../canonical.constants';

describe('chunkText', () => {
  it('returns empty array for empty input', () => {
    expect(chunkText('', 400)).toEqual([]);
    expect(chunkText('   \n\n  ', 400)).toEqual([]);
  });

  it('keeps a small document as a single chunk', () => {
    const small = 'one paragraph.\n\nanother short paragraph.';
    const chunks = chunkText(small, 400);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('one paragraph');
    expect(chunks[0]).toContain('another short paragraph');
  });

  it('splits at paragraph boundaries to stay under the byte budget', () => {
    // 400 tokens × 4 chars/token = 1600 byte budget per chunk.
    const para = (n: number) => `Paragraph ${n}: ${'x'.repeat(800)}.`;
    const text = [para(1), para(2), para(3), para(4)].join('\n\n');
    const chunks = chunkText(text, 400);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      // Allow some slack for the overlap-prefix that gets prepended.
      expect(Buffer.byteLength(c, 'utf8')).toBeLessThanOrEqual(LIMITS.CHUNK_HARD_CAP_BYTES);
    }
  });

  it('force-splits a single oversized paragraph on sentence boundaries', () => {
    const sentence = 'This is a long sentence. '.repeat(100); // ~2500 chars
    const chunks = chunkText(sentence, 100); // 400-byte budget
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should respect the budget after sentence-split.
    for (const c of chunks) {
      expect(Buffer.byteLength(c, 'utf8')).toBeLessThanOrEqual(LIMITS.CHUNK_HARD_CAP_BYTES);
    }
  });

  it('applies an overlap prefix from chunk i-1 to chunk i', () => {
    const text = ['alpha beta gamma', 'delta epsilon zeta', 'eta theta iota']
      .map((p) => p.repeat(80))
      .join('\n\n');
    const chunks = chunkText(text, 50); // small budget → multiple chunks
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].startsWith('…')).toBe(true);
    }
  });
});
