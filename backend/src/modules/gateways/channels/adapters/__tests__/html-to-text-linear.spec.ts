import { htmlToText, parseMimeMessage } from '../mime.helper';

/**
 * htmlToText runs on inbound mail before the gateway it is for is known,
 * so on bytes anyone can send. The regex version was quadratic in four
 * places; 100 KB of `<` held the event loop for eight seconds. This pins
 * the replacement to the same output and to linear time.
 */

/** The implementation it replaced, kept as the reference for its output. */
function regexHtmlToText(html: string): string {
  let s = String(html);
  s = s.replace(/<(script|style)[\s\S]*?<\/\1\s*>/gi, '');
  s = s.replace(/<br\s*\/?\s*>/gi, '\n');
  s = s.replace(/<\/(p|div|tr|li|h[1-6]|blockquote|pre|table)\s*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, d) => {
      try {
        return String.fromCodePoint(parseInt(d, 10));
      } catch {
        return '';
      }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      try {
        return String.fromCodePoint(parseInt(h, 16));
      } catch {
        return '';
      }
    })
    .replace(/&amp;/gi, '&');
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

describe('htmlToText', () => {
  const PIECES = [
    '<', '>', '<script>', '</script>', '<SCRIPT >', '</Script >', '<style>', '</style>', '<br>', '<br />',
    '<BR/>', '</p>', '</div >', '<p>', 'text', ' ', '\t', '\n', '&amp;', '&lt;', '&#65;', '&#x42;', '<>', '<a href="x">',
  ];

  const random = (seed: number, length: number): string => {
    let x = seed;
    let out = '';
    for (let i = 0; i < length; i++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      out += PIECES[x % PIECES.length];
    }
    return out;
  };

  it('gives the regex version’s output on every generated document', () => {
    for (let seed = 1; seed <= 3000; seed++) {
      const html = random(seed, seed % 30);
      expect(htmlToText(html)).toBe(regexHtmlToText(html));
    }
  });

  it('reads an ordinary HTML mail body', () => {
    expect(
      htmlToText('<html><style>p{color:red}</style><p>Hello&nbsp;there</p>  \n<br/>Thanks<script>x()</script></html>'),
    ).toBe('Hello there\n\nThanks');
  });

  it.each([
    ['unclosed <', '<'.repeat(200_000)],
    ['unclosed <script', '<script'.repeat(30_000)],
    ['a long run of spaces', ' '.repeat(200_000) + 'x'],
    ['<br then spaces', '<br' + ' '.repeat(200_000)],
    ['unclosed <br', '<br'.repeat(70_000)],
  ])('stays linear on %s', (_label, html) => {
    const started = Date.now();
    htmlToText(html);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('keeps an HTML-only inbound mail fast end to end', () => {
    const raw = ['From: a@example.com', 'To: b@example.com', 'Content-Type: text/html', '', '<'.repeat(200_000)].join('\r\n');
    const started = Date.now();
    parseMimeMessage(raw);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
