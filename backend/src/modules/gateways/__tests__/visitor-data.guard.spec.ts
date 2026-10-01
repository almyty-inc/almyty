import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * One visitor-data scope, wired everywhere a person's data is read or erased.
 *
 * The web chat's "Delete everything about me", the widget's "Delete my
 * chat" and an owner's data request each used to erase their own list of
 * tables, and the lists drifted: one forgot the memories, another the
 * files. They now all go through VisitorDataService. A service that is
 * handed it as an @Optional() would compile, pass every unit spec, and
 * erase nothing in production if Nest ever skipped it; a new erasure path
 * that deletes rows by hand would drift again. This reads the source so
 * neither can happen quietly.
 */
const MODULES = join(__dirname, '..', '..');
const read = (path: string) => readFileSync(join(MODULES, path), 'utf8');

/** The body of `name(` in `source`, braces balanced, from its first `{`. */
function methodBody(source: string, name: string): string {
  const at = source.search(new RegExp(`\\n\\s+async ${name}\\(`));
  if (at < 0) throw new Error(`${name} not found`);
  const open = source.indexOf('{', source.indexOf(')', at));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1);
  }
  throw new Error(`${name} has no end`);
}

describe('the visitor-data scope is wired, not optional', () => {
  it.each([
    ['gateways/channels/hosted-chat.service.ts', /\n(\s*\/\/[^\n]*\n)*\s*private readonly visitorData\?: VisitorDataService,/],
    ['gateways/channels/channel-gateway.service.ts', /\n(\s*\/\/[^\n]*\n)*\s*private readonly visitorData\?: VisitorDataService,/],
    ['agent-channels/agent-channels.controller.ts', /\n(\s*\/\/[^\n]*\n)*\s*private readonly visitorRequests\?: VisitorDataRequestsService,/],
  ])('%s is handed it by Nest, never as @Optional()', (file, param) => {
    const source = read(file);
    const match = source.match(param);
    expect(match).not.toBeNull();
    // The line before the parameter (comments skipped) is not a bare decorator.
    const before = source.slice(0, match!.index).trimEnd().split('\n').pop() ?? '';
    expect(before.trim()).not.toMatch(/^@Optional\(\)$/);
    expect(match![0]).not.toContain('@Optional()');
  });

  it('is provided and exported by the gateways module, and the owner path by the agent channels module', () => {
    const gateways = read('gateways/gateways.module.ts');
    expect(gateways.match(/^\s+VisitorDataService,$/gm)?.length).toBe(2);
    expect(read('agent-channels/agent-channels.module.ts')).toMatch(/^\s+VisitorDataRequestsService,$/m);
  });

  it.each([
    ['gateways/channels/hosted-chat.service.ts', 'deleteVisitor'],
    ['gateways/channels/hosted-chat.service.ts', 'deleteConversation'],
    ['gateways/channels/channel-gateway.service.ts', 'deleteWidgetThread'],
    ['agent-channels/visitor-data-requests.service.ts', 'erase'],
  ])('%s %s erases through the shared scope, not by hand', (file, method) => {
    const body = methodBody(read(file), method);
    expect(body).toMatch(/\.erase\(/);
    expect(body).not.toMatch(/Repository\.delete\(|\.delete\(\{|createQueryBuilder\(\)\s*\.delete/);
  });

  it('every self-service and owner erasure writes its audit row in the erasure transaction', () => {
    for (const [file, method] of [
      ['gateways/channels/hosted-chat.service.ts', 'deleteVisitor'],
      ['gateways/channels/channel-gateway.service.ts', 'deleteWidgetThread'],
      ['agent-channels/visitor-data-requests.service.ts', 'erase'],
    ]) {
      const body = methodBody(read(file), method);
      expect(body).toContain('logInTransaction(');
      expect(body).toContain('AuditAction.VISITOR_DATA_ERASE');
    }
  });

  it('an A2A run is filed under the caller who started it, so their data can be found', () => {
    expect(read('gateways/unified-gateway-delegation.helper.ts')).toMatch(
      /withA2ACaller\(await this\.channelPolicy\.admit\(gateway\), gateway\.id, a2aCallerId\(auth\)\)/,
    );
  });

  it('an outside memory remembers the run that saved it', () => {
    expect(read('agents/agent-memory.keeper.ts')).toMatch(/memoryAccounts\.put\([\s\S]{0,200}runId: run\.id/);
    expect(read('memory/canonical/memory-accounts.service.ts')).toMatch(/runId: opts\.runId \?\? null/);
  });
});
