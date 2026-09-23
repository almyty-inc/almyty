import {
  MAX_ATTACHMENTS,
  MAX_MULTIPART_DEPTH,
  MAX_PARTS_PER_LEVEL,
  parseMimeMessage,
} from '../mime.helper';

/**
 * Bounds on the MIME parser, which runs on unauthenticated input.
 *
 * `POST /channels/email/inbound` carries no almyty credential — the
 * provider cannot attach one — and skips the svix check entirely when
 * RESEND_INBOUND_SIGNING_SECRET is unset, which is the default. It then
 * calls `EmailAdapter.extractRecipients`, which parses the raw MIME to
 * decide which gateway the mail is even for. So every byte here is
 * attacker-chosen and parsed before anything authenticates it.
 */
describe('parseMimeMessage resource bounds', () => {
  /** A message nesting `depth` multiparts, each with its own boundary. */
  const nested = (depth: number): string => {
    let inner = 'Content-Type: text/plain\r\n\r\nthe actual body';
    for (let i = depth; i >= 1; i--) {
      const b = `b${i}`;
      inner = [
        `Content-Type: multipart/mixed; boundary="${b}"`,
        '',
        `--${b}`,
        inner,
        `--${b}--`,
      ].join('\r\n');
    }
    return `From: a@b.c\r\nTo: d@e.f\r\nSubject: s\r\n${inner}`;
  };

  it('parses ordinary nesting to the leaf', () => {
    // multipart/mixed wrapping multipart/alternative wrapping the body
    // is what real mail looks like; the cap must not touch it.
    expect(parseMimeMessage(nested(3)).text).toBe('the actual body');
  });

  it('stops descending past the depth ceiling instead of following forever', () => {
    const parsed = parseMimeMessage(nested(MAX_MULTIPART_DEPTH + 20));
    // Treated as a leaf at the ceiling rather than walked to the bottom:
    // the deep body is not recovered, and nothing hangs or throws.
    expect(parsed.text).not.toBe('the actual body');
    expect(typeof parsed.text).toBe('string');
  });

  it('returns promptly on a deeply nested message', () => {
    // The shape of the original problem: each level re-splits the
    // remaining body into a fresh line array, so unbounded depth is
    // O(size x depth) on the event loop.
    const started = Date.now();
    parseMimeMessage(nested(2000));
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('caps the number of parts it walks at one level', () => {
    const parts = Array.from(
      { length: MAX_PARTS_PER_LEVEL + 50 },
      (_, i) =>
        `--bb\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="f${i}.bin"\r\n\r\nx`,
    ).join('\r\n');
    const raw = `From: a@b.c\r\nContent-Type: multipart/mixed; boundary="bb"\r\n\r\n${parts}\r\n--bb--`;

    expect(parseMimeMessage(raw).attachments.length).toBeLessThanOrEqual(MAX_PARTS_PER_LEVEL);
  });

  it('caps total recorded attachments', () => {
    // Spread across nested levels so the per-level cap alone would not
    // hold it: the attachment array has its own ceiling.
    const leaf = (i: number) =>
      `Content-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="f${i}.bin"\r\n\r\nx`;
    let inner = Array.from({ length: 60 }, (_, i) => `--b9\r\n${leaf(i)}`).join('\r\n');
    inner = `Content-Type: multipart/mixed; boundary="b9"\r\n\r\n${inner}\r\n--b9--`;
    const outerParts = Array.from({ length: 5 }, () => `--b0\r\n${inner}`).join('\r\n');
    const raw = `From: a@b.c\r\nContent-Type: multipart/mixed; boundary="b0"\r\n\r\n${outerParts}\r\n--b0--`;

    expect(parseMimeMessage(raw).attachments.length).toBeLessThanOrEqual(MAX_ATTACHMENTS);
  });
});
