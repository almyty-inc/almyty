import { readFileSync } from 'fs';
import { join } from 'path';

import { RunnerCapabilityPublisher } from './runner-capability.publisher';

/**
 * The parameters the backend publishes for a runner method are the ones
 * the daemon reads.
 *
 * shell.exec was published with `command` and `cwd` while the daemon's
 * handler read `cmd` and never looked at `cwd`: every call through the
 * published tool failed with "cmd is required", and both sides' tests
 * were green because each tested its own half. This reads the daemon's
 * handler as text and requires every published property to be read off
 * the params there.
 */
const REPO = join(__dirname, '..', '..', '..', '..');
const HANDLERS = readFileSync(join(REPO, 'packages/runner/src/handlers.ts'), 'utf8');

/** The body of the handler the daemon's dispatch switch routes `method` to. */
function handlerBody(method: string): string {
  const route = new RegExp(`case '${method.replace('.', '\\.')}': return ok\\(await (\\w+)\\(`).exec(HANDLERS);
  if (!route) throw new Error(`the daemon routes no handler for ${method}`);
  const start = HANDLERS.indexOf(`async function ${route[1]}(`);
  if (start < 0) throw new Error(`handler ${route[1]} not found`);
  const next = HANDLERS.indexOf('\nasync function ', start + 1);
  const nextSync = HANDLERS.indexOf('\nfunction ', start + 1);
  const end = Math.min(...[next, nextSync].filter((i) => i > 0), HANDLERS.length);
  return HANDLERS.slice(start, end);
}

describe('published runner tools match what the daemon reads', () => {
  const capabilities = (RunnerCapabilityPublisher as any).CAPABILITIES as Array<{
    method: string;
    parameters: { properties?: Record<string, unknown> };
  }>;
  const withParams = capabilities.filter((c) => Object.keys(c.parameters.properties ?? {}).length > 0);

  it('has published methods with parameters to check', () => {
    expect(withParams.map((c) => c.method)).toContain('shell.exec');
  });

  it.each(withParams.map((c) => [c.method, Object.keys(c.parameters.properties ?? {})] as const))(
    '%s: the daemon reads every published parameter',
    (method, properties) => {
      const body = handlerBody(method);
      for (const property of properties) {
        expect({ property, read: new RegExp(`\\bp\\.${property}\\b`).test(body) }).toEqual({ property, read: true });
      }
    },
  );
});
