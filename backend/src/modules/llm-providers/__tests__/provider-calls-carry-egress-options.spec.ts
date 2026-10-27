import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Every vendor call carries the provider's own egress posture.
 *
 * The Anthropic and Gemini paths called callLlmProviderHttp(config) with
 * no options, so a host the organization had allowlisted (an Anthropic
 * compatible gateway on the company network, say) listed its models on
 * connect, and then every chat to it was refused with "Blocked hostname".
 * The OpenAI path passed llmCallOptionsFor(provider) and worked. This
 * reads the provider sources so a new call site cannot leave it out.
 */
describe('vendor calls pass the provider egress options', () => {
  const dir = join(__dirname, '..', 'providers');
  const files = readdirSync(dir).filter((f) => f.endsWith('.provider.ts'));

  it.each(files)('%s', (file) => {
    const source = readFileSync(join(dir, file), 'utf8');
    const calls = [...source.matchAll(/callLlmProviderHttp(?:Stream)?\(([^;]*?)\)(?=[;,\n)])/g)].map((m) => m[0]);
    for (const call of calls) {
      expect(call).toMatch(/llmCallOptionsFor\(/);
    }
  });

  it('found the provider files', () => {
    expect(files).toEqual(expect.arrayContaining(['anthropic.provider.ts', 'google.provider.ts', 'openai.provider.ts']));
  });
});
