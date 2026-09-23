import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Source-reading guard for the per-address rate limit on the two
 * anonymous LLM surfaces.
 *
 * A behavioural test cannot carry this. `trustedClientIp` can be
 * perfectly correct and fully unit-tested while a controller quietly
 * goes on computing its own address from `x-forwarded-for.split(',')[0]`
 * — the helper exists, nothing calls it, and every behavioural
 * assertion still passes because they exercise the helper rather than
 * the route. What has to hold is a property of the call site, so the
 * call site is what these read.
 *
 * Why it matters: both surfaces accept an unauthenticated POST that
 * starts an agent run on the tenant's own provider keys. The per-address
 * bucket is the only limit whose key the caller does not choose — the
 * hosted-chat visitor id comes from a cookie they can drop, and the
 * widget's comes straight out of the request body. If the address is
 * forgeable too, nothing is left.
 */
describe('public chat surfaces derive the client address from a trusted hop', () => {
  const channels = join(__dirname, '..');
  const read = (file: string) => readFileSync(join(channels, file), 'utf8');

  const SURFACES = ['hosted-chat.controller.ts', 'channel-widget.controller.ts'] as const;

  /**
   * The exact shape of the defect: taking the leftmost X-Forwarded-For
   * entry, which is the one hop in that header the caller writes.
   */
  const LEFTMOST_HOP = /x-forwarded-for[\s\S]{0,400}?\.split\(\s*','\s*\)\s*\[\s*0\s*\]/;

  it.each(SURFACES)('%s does not read the leftmost X-Forwarded-For hop', (file) => {
    expect(read(file)).not.toMatch(LEFTMOST_HOP);
  });

  it.each(SURFACES)('%s routes its address through trustedClientIp', (file) => {
    const source = read(file);
    expect(source).toContain("from '../../../common/security/client-ip'");
    expect(source).toMatch(/trustedClientIp\s*\(/);
  });

  it('feeds that address into the rate limiter, not just into a log line', () => {
    // The helper being imported proves nothing on its own; what has to
    // be true is that the value reaching `clientHash` is the derived
    // one. Both surfaces hash it on the way in.
    for (const file of SURFACES) {
      const source = read(file);
      expect(source).toMatch(/clientHash:\s*HostedChatService\.hashClient\(/);
    }
    // The widget hashes the derived address inline at the call.
    expect(read('channel-widget.controller.ts')).toMatch(
      /clientHash:\s*HostedChatService\.hashClient\(\s*trustedClientIp\(/,
    );
    // Hosted chat goes through its own clientIp(), which must itself be
    // the helper rather than a second hand-rolled parse.
    expect(read('hosted-chat.controller.ts')).toMatch(
      /private clientIp\([\s\S]{0,200}?return trustedClientIp\(/,
    );
  });

  it('checks the visitor ceiling on the route that starts a run', () => {
    // The limiter is only a control where it is called. Both POST
    // handlers must consult it before reaching the agent runtime.
    for (const file of SURFACES) {
      expect(read(file)).toMatch(/gatewayRateLimit\.checkVisitor\(/);
    }
  });
});
