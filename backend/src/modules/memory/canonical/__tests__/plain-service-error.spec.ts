import { plainServiceError } from '../plain-service-error';

/**
 * A memory service's answer, as a page shows it: one plain sentence naming
 * the service and what to do; never the raw JSON or status line.
 */
describe('plainServiceError', () => {
  it.each([
    ['mem0', '{"detail":"Invalid API key. You can find your API key on https://app.mem0.ai/dashboard/api-keys."}', 'Mem0 refused the key. Check it at app.mem0.ai.'],
    ['mem0', 'provider rejected the credential (401: {"detail":"Invalid API key."})', 'Mem0 refused the key. Check it at app.mem0.ai.'],
    ['zep', 'provider rejected the credential (401: unauthorized)', 'Zep refused the key. Check it at app.getzep.com.'],
    ['supermemory', '429 Too Many Requests', 'Supermemory is over its usage limit. Try again later, or check the plan at console.supermemory.ai.'],
    ['anthropic-memory-tool', 'fetch failed: ECONNREFUSED', 'Claude memory tool could not be reached. Try again in a few minutes.'],
    ['zep', '502 Bad Gateway', 'Zep had a problem on its side. Try again later.'],
    ['mem0', 'something odd', 'Mem0 did not accept the request. Check the account under Credentials.'],
  ])('%s: %s', (service, raw, plain) => {
    expect(plainServiceError(service, raw)).toBe(plain);
  });

  it('never repeats the raw answer', () => {
    const out = plainServiceError('mem0', '{"detail":"Invalid API key. token=abc123"}');
    expect(out).not.toMatch(/[{}"]|abc123|detail/);
  });
});
