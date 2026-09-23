import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * EU AI Act Art. 50: the disclosure is applied centrally, and no
 * adapter can route around it.
 *
 * `applyAiDisclosure` prefixes the first outbound message of a
 * conversation. What makes that a control rather than a convention is
 * that it sits in `listenForCompletionAndRespond` — the one place that
 * turns a finished run into a reply — and produces the text BEFORE
 * `formatOutbound`. Every adapter therefore receives text that already
 * carries the line; none of them is ever handed the raw run output, so
 * there is nothing for an adapter to opt out of.
 *
 * That property is structural, so a behavioural test on one adapter
 * would not hold it: it would pass just as happily if a second reply
 * path grew somewhere else and skipped the call. These assertions are
 * about where the call is, and about no adapter reaching around it.
 */
describe('AI disclosure cannot be bypassed per adapter', () => {
  const channels = join(__dirname, '..');
  const service = readFileSync(join(channels, 'channel-gateway.service.ts'), 'utf8');

  it('applies the disclosure exactly once, in the shared dispatch path', () => {
    // More than one call site means more than one policy.
    const callSites = service.match(/this\.applyAiDisclosure\(/g) ?? [];
    expect(callSites).toHaveLength(1);
  });

  it('applies it before the adapter formats or sends anything', () => {
    // Order is the whole mechanism: formatOutbound must receive the
    // disclosed text, not the raw output.
    const applyAt = service.indexOf('this.applyAiDisclosure(');
    const formatAt = service.indexOf('adapter.formatOutbound(', applyAt);
    const sendAt = service.indexOf('adapter.sendResponse(', applyAt);

    expect(applyAt).toBeGreaterThan(-1);
    expect(formatAt).toBeGreaterThan(applyAt);
    expect(sendAt).toBeGreaterThan(applyAt);
  });

  it('hands the adapter the disclosed text rather than the raw run output', () => {
    expect(service).toMatch(
      /const responseText = await this\.applyAiDisclosure\([\s\S]{0,200}?adapter\.formatOutbound\(\{\s*text:\s*responseText\s*\}\)/,
    );
  });

  it('gives no adapter a disclosure decision of its own', () => {
    // An adapter that read the setting would be an adapter that could
    // decide not to honour it. None may mention it at all.
    const dir = join(channels, 'adapters');
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => /aiDisclosure|AI_DISCLOSURE/.test(readFileSync(join(dir, f), 'utf8')));

    expect(offenders).toEqual([]);
  });
});
