import { readFileSync } from 'fs';
import { join } from 'path';

import { a2aCallerCandidates, emptyFootprint } from '../app-visitor-data.service';
import { AppPlace, withA2ACaller } from '../app-place-policy.service';

/**
 * One scope for a person's data on an app, however it is reached.
 *
 * The web chat's "delete my data", the widget's, and an owner answering a
 * data request for someone on a messaging channel or A2A all erase
 * through AppVisitorDataService. Before it, each self-service path kept
 * its own list of tables, and neither reached the memories or files a
 * visitor's runs wrote. A new path that deletes rows by hand, or a service
 * that loses its injected copy, compiles and passes every unit spec; this
 * reads the source so it cannot.
 */
const MODULES = join(__dirname, '..', '..');
const read = (path: string) => readFileSync(join(MODULES, path), 'utf8');

/** The body of `method` in `source`: from its signature to the next member. */
function methodBody(source: string, method: string): string {
  const start = source.search(new RegExp(`\\n  (?:private |public )?async ${method}\\(`));
  expect(start).toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const next = rest.slice(1).search(/\n  (?:private |public |async |\/\*\*|[a-zA-Z]+\()/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

describe('a person on an app has one data scope', () => {
  it('the gateways module provides and exports the service, with the storage behind files', () => {
    const source = read('gateways/gateways.module.ts');
    expect(source.match(/^\s+AppVisitorDataService,$/gm)?.length).toBe(2);
    expect(source).toMatch(/^\s+FilesModule,$/m);
  });

  it.each([
    ['gateways/channels/hosted-chat.service.ts', ['deleteVisitor']],
    ['gateways/channels/channel-gateway.service.ts', ['deleteWidgetThread', 'exportWidgetThread']],
  ] as const)('%s reaches a visitor through the shared scope', (file, methods) => {
    const source = read(file);
    expect(source).toMatch(/@Optional\(\)\s+private readonly visitorData\?: AppVisitorDataService/);
    for (const method of methods) {
      const body = methodBody(source, method);
      expect(body).toMatch(/this\.visitorDataService\(\)/);
      // No table of its own: every delete goes through erase().
      expect(body).not.toMatch(/Repository\.delete\(|\.delete\(\{/);
    }
  });

  it('the shared scope removes the stored object behind each file, with Nest injecting the storage', () => {
    const source = read('gateways/app-visitor-data.service.ts');
    expect(source).toMatch(/@Optional\(\) private readonly storage\?: StorageService/);
    expect(methodBody(source, 'erase')).toMatch(/this\.storage\.delete\(file\.storageKey\)/);
  });

  it('an owner answers a data request from the apps module, by POST only', () => {
    expect(read('agent-apps/agent-apps.module.ts')).toMatch(/^\s+AppVisitorRequestsService,$/m);
    const controller = read('agent-apps/agent-apps.controller.ts');
    // The person's identifier travels in a body, never in a URL an access
    // log keeps.
    expect(controller).not.toMatch(/@(Get|Delete)\([^)]*visitor-data/);
    for (const path of ['lookup', 'export', 'erase']) expect(controller).toContain(`@Post(':slug/visitor-data/${path}')`);
  });

  it('A2A files each run under the caller credential it came in with', () => {
    expect(read('gateways/unified-gateway-delegation.helper.ts')).toMatch(
      /withA2ACaller\(await this\.places\.admit\(gateway\), gateway\.id, a2aCallerId\(auth\)\)/,
    );
  });
});

describe('finding an A2A caller', () => {
  it('matches a bare id against every credential kind, and a stamped one as written', () => {
    expect(a2aCallerCandidates('abc')).toEqual(['key:abc', 'oauth:abc', 'jwt:abc', 'user:abc']);
    expect(a2aCallerCandidates(' oauth:client-9 ')).toEqual(['oauth:client-9']);
    expect(a2aCallerCandidates('   ')).toEqual([]);
  });

  it('stamps the caller and the gateway on the run metadata, keeping the place marks', () => {
    const place = {
      app: null,
      privacy: {} as any,
      runOptions: { appId: 'app-1', gatewayId: 'gw-1', metadata: { appVisitor: true, visitorMemory: false, appId: 'app-1' } },
    } as AppPlace;
    expect(withA2ACaller(place, 'gw-1', 'key:k1').runOptions.metadata).toEqual({
      appVisitor: true,
      visitorMemory: false,
      appId: 'app-1',
      gatewayId: 'gw-1',
      a2aCaller: 'key:k1',
    });
    expect(withA2ACaller(place, 'gw-1', null).runOptions.metadata).not.toHaveProperty('a2aCaller');
    // The place it came from is not changed.
    expect(place.runOptions.metadata).not.toHaveProperty('gatewayId');
  });

  it('an empty footprint names its place and nothing else', () => {
    expect(emptyFootprint({ id: 'gw-1', organizationId: 'org-1' })).toEqual({
      organizationId: 'org-1',
      gatewayIds: ['gw-1'],
      endUserIds: [],
      runIds: [],
      conversationIds: [],
      widgetThreads: [],
    });
  });
});
