import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Every place an app answers on starts its runs under the app's policy.
 *
 * The per-run cost cap, the spend cap and the visitor-memory mark were
 * each once applied on one place and missing on the others: the web chat
 * set visitorMemory and nothing else, the widget and the channels set
 * neither, and A2A had no per-caller limit at all. A new startRun call on
 * a place that forgets `withPlace`, or a place that forgets to ask about
 * the spend cap, compiles and passes every unit spec. This reads the
 * source so it cannot.
 */
const MODULES = join(__dirname, '..', '..');
const read = (path: string) => readFileSync(join(MODULES, path), 'utf8');

/** The argument text of every `.startRun(` call in `source`. */
function startRunCalls(source: string): string[] {
  const calls: string[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf('.startRun(', from);
    if (at < 0) return calls;
    let depth = 0;
    let end = at + '.startRun'.length;
    for (; end < source.length; end++) {
      if (source[end] === '(') depth++;
      if (source[end] === ')' && --depth === 0) break;
    }
    calls.push(source.slice(at, end + 1));
    from = end;
  }
}

const PLACES: Array<{ file: string; admits: RegExp }> = [
  { file: 'gateways/channels/hosted-chat.controller.ts', admits: /this\.places\.admit\(gateway\)/ },
  { file: 'gateways/channels/channel-widget.controller.ts', admits: /this\.places\.admit\(gateway\)/ },
  { file: 'gateways/channels/channel-gateway.service.ts', admits: /this\.places\.reachedFor\(place\)/ },
  { file: 'gateways/unified-gateway-delegation.helper.ts', admits: /this\.places\.admit\(gateway\)/ },
];

describe('app places start runs under the app policy', () => {
  it.each(PLACES.map((p) => p.file))('%s is handed the policy by Nest', (file) => {
    expect(read(file)).toMatch(/private readonly places\?: AppPlacePolicyService/);
  });

  it.each(PLACES.map((p) => [p.file, p.admits] as const))('%s asks about the spend cap before a run', (file, admits) => {
    expect(read(file)).toMatch(admits);
  });

  it.each([
    'gateways/channels/hosted-chat.controller.ts',
    'gateways/channels/channel-gateway.service.ts',
    'a2a/a2a-message.handler.ts',
  ])('every startRun in %s carries the place', (file) => {
    const calls = startRunCalls(read(file));
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toContain('withPlace(place, ');
  });

  it('A2A hands the admitted place to the message handler', () => {
    expect(read('gateways/unified-gateway-delegation.helper.ts')).toMatch(/handleJsonRpc\([^)]*\{[^}]*place,/s);
    const server = read('a2a/a2a-server.service.ts');
    expect(server).toMatch(/handleMessageSend\(gateway, rpcReq\.params, rpcReq\.id, context\?\.place\)/);
    expect(server).toMatch(/handleMessageStream\(gateway, rpcReq\.params, rpcReq\.id, req, res, context\?\.place\)/);
  });

  it('the gateways module provides and exports the policy', () => {
    const source = read('gateways/gateways.module.ts');
    expect(source.match(/^\s+AppPlacePolicyService,$/gm)?.length).toBe(2);
  });
});
