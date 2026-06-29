/**
 * Newline-delimited frame reader. Downstream stdout arrives in arbitrary
 * chunks; a frame may span chunks or several frames may share one chunk.
 * NEVER JSON.parse a raw chunk — buffer until '\n'.
 */
export class LineReader {
  private buf = '';

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: string | Buffer): void {
    this.buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      // Tolerate \r\n and skip blank keep-alive lines.
      const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
      if (trimmed.length > 0) this.onLine(trimmed);
    }
  }

  /** Any trailing bytes with no terminating newline (e.g. at EOF). */
  flushRemainder(): string {
    const rem = this.buf;
    this.buf = '';
    return rem;
  }
}
