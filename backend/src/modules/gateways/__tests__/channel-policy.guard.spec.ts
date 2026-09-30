import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Every channel that answers visitors starts its runs under the policy its
 * agent (with the channel's overrides) sets.
 *
 * The per-run cost cap, the spend cap and the visitor-memory mark were
 * each once applied on one surface and missing on the others: the web chat
 * set visitorMemory and nothing else, the widget and the messaging channels
 * set neither, and A2A had no per-caller limit at all. A new startRun call
 * that forgets `withChannelPolicy`, or a channel that forgets to ask about
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

const CHANNELS: Array<{ file: string; admits: RegExp }> = [
  { file: 'gateways/channels/hosted-chat.controller.ts', admits: /this\.channelPolicy\.admit\(gateway\)/ },
  { file: 'gateways/channels/channel-widget.controller.ts', admits: /this\.channelPolicy\.admit\(gateway\)/ },
  { file: 'gateways/channels/channel-gateway.service.ts', admits: /this\.channelPolicy\.reachedFor\(policy\)/ },
  { file: 'gateways/unified-gateway-delegation.helper.ts', admits: /this\.channelPolicy\.admit\(gateway\)/ },
];

describe('channels start runs under their agent policy', () => {
  it.each(CHANNELS.map((p) => p.file))('%s is handed the policy by Nest', (file) => {
    expect(read(file)).toMatch(/private readonly channelPolicy\?: ChannelPolicyService/);
  });

  it.each(CHANNELS.map((p) => [p.file, p.admits] as const))('%s asks about the spend cap before a run', (file, admits) => {
    expect(read(file)).toMatch(admits);
  });

  it.each([
    'gateways/channels/hosted-chat.controller.ts',
    'gateways/channels/channel-gateway.service.ts',
    'a2a/a2a-message.handler.ts',
  ])('every startRun in %s carries the channel policy', (file) => {
    const calls = startRunCalls(read(file));
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toContain('withChannelPolicy(policy, ');
  });

  it('A2A hands the admitted policy to the message handler', () => {
    expect(read('gateways/unified-gateway-delegation.helper.ts')).toMatch(/handleJsonRpc\([^)]*\{[^}]*policy,/s);
    const server = read('a2a/a2a-server.service.ts');
    expect(server).toMatch(/handleMessageSend\(gateway, rpcReq\.params, rpcReq\.id, context\?\.policy\)/);
    expect(server).toMatch(/handleMessageStream\(gateway, rpcReq\.params, rpcReq\.id, req, res, context\?\.policy\)/);
  });

  it('the gateways module provides and exports the policy', () => {
    const source = read('gateways/gateways.module.ts');
    expect(source.match(/^\s+ChannelPolicyService,$/gm)?.length).toBe(2);
  });
});
