import { describe, it, expect } from 'vitest';
import { LineReader } from '../line-reader.js';

function collect() {
  const lines: string[] = [];
  return { lines, reader: new LineReader((l) => lines.push(l)) };
}

describe('LineReader', () => {
  it('buffers a frame split across chunks', () => {
    const { lines, reader } = collect();
    reader.push('{"id"');
    reader.push(':1}');
    expect(lines).toEqual([]); // no newline yet -> nothing emitted
    reader.push('\n');
    expect(lines).toEqual(['{"id":1}']);
  });

  it('emits multiple frames from one chunk', () => {
    const { lines, reader } = collect();
    reader.push('{"a":1}\n{"b":2}\n{"c":3}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it('tolerates \\r\\n and skips blank keep-alive lines', () => {
    const { lines, reader } = collect();
    reader.push('{"a":1}\r\n\r\n{"b":2}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('holds a trailing partial frame until terminated, then flushRemainder yields it', () => {
    const { lines, reader } = collect();
    reader.push('{"done":1}\n{"partial"');
    expect(lines).toEqual(['{"done":1}']);
    expect(reader.flushRemainder()).toBe('{"partial"');
    expect(reader.flushRemainder()).toBe(''); // drained
  });

  it('accepts Buffer chunks', () => {
    const { lines, reader } = collect();
    reader.push(Buffer.from('{"x":1}\n', 'utf8'));
    expect(lines).toEqual(['{"x":1}']);
  });
});
