import * as path from 'path';

import { allControllerRoutes } from '../../../../test/controller-routes';
import { EXCLUDED_ROUTES, OPERATIONS, OperationEntry, SECRET_OPERATIONS, TAKES_A_SECRET } from '../management-operations';
import { ManagementOperationsService } from '../management-operations.service';
import { ManagementRouteInvoker, ResolvedRoute } from '../route-invoker.service';
import { isSecretArgumentName, secretArgumentPaths, secretSchemaPaths } from '../secret-arguments';
import { MANAGEMENT_TOOLS } from '../../almyty-mcp.service';

/**
 * No management-MCP path takes a secret as an argument.
 *
 * For every operation, the argument schema get_operation publishes (read
 * from the route's DTOs, exactly as the service builds it) holds no field
 * named like a secret, by the repo's own detectors (the version-snapshot
 * redaction and the tool-hub template sanitizer). A DTO that grows an
 * `apiKey`, a `token` or a `clientSecret` fails here until the field is
 * listed in the operation's `secretFields` (dropped from the schema and
 * refused on call) or the operation moves to SECRET_OPERATIONS.
 *
 * Free-form objects (headers, auth configs) cannot be read from a DTO;
 * those are refused at call time (management-operations.service.spec.ts).
 */
const BACKEND = path.join(__dirname, '..', '..', '..', '..', '..');
const routes = allControllerRoutes();
const files = new Map(routes.map((r) => [r.ref, r.file]));

function resolve(ref: string): { route: ResolvedRoute; service: ManagementOperationsService } {
  const [controllerName] = ref.split('.');
  const cls = require(path.join(BACKEND, files.get(ref)!))[controllerName];
  const modules: any = new Map([['m', { controllers: new Map([[cls, { metatype: cls, instance: {} }]]) }]]);
  const invoker = new ManagementRouteInvoker(modules, {} as any, {} as any);
  return { route: invoker.resolve(ref)!, service: new ManagementOperationsService(invoker, []) };
}

const schemas = new Map<string, { op: OperationEntry; raw: any; published: any }>();
beforeAll(() => {
  for (const op of OPERATIONS) {
    const { route, service } = resolve(op.route);
    schemas.set(op.name, { op, raw: service.inputSchema(route), published: service.inputSchema(route, op.secretFields) });
  }
}, 300_000);

describe('no management-MCP argument is a secret', () => {
  it('names secrets the way the repo redacts them', () => {
    for (const name of ['apiKey', 'api_key', 'X-Api-Key', 'token', 'bearerToken', 'accessToken', 'password', 'currentPassword', 'clientSecret', 'privateKey', 'Authorization', 'secret', 'key']) {
      expect(isSecretArgumentName(name)).toBe(true);
    }
    for (const name of ['maxTokens', 'name', 'keyHeader', 'connectorKey', 'credentialId', 'author', 'tokensPerMinute', 'publicKey']) {
      expect(isSecretArgumentName(name)).toBe(false);
    }
  });

  it('finds a secret at any depth, skipping empty values, allowed names and pass-through input', () => {
    const args = {
      id: 'x',
      body: {
        name: 'n',
        headers: { Authorization: 'Bearer abc', Accept: 'json' },
        authentication: { type: 'api_key', config: { parameter: 'X-Key', apiKey: 'sk-1' } },
        items: [{ token: 't' }],
        password: '',
        clientSecret: null,
        key: 'planner',
        parameters: { pageToken: 'next' },
      },
    };
    expect(secretArgumentPaths(args, { notSecret: ['body.key'], passThrough: ['body.parameters'] }).sort()).toEqual([
      'body.authentication.config.apiKey',
      'body.headers.Authorization',
      'body.items[].token',
    ]);
  });

  it('publishes no secret-named field in any operation\'s arguments', () => {
    const offenders: string[] = [];
    for (const [name, { op, published }] of schemas) {
      for (const p of secretSchemaPaths(published)) if (!op.notSecret?.includes(p)) offenders.push(`${name}: ${p}`);
    }
    // Drop the field (secretFields) or move the operation to
    // SECRET_OPERATIONS in management-operations.ts.
    expect(offenders).toEqual([]);
  });

  it('lists only secret fields the route really takes, and only names that read as secrets', () => {
    const stale: string[] = [];
    for (const [name, { op, raw }] of schemas) {
      const present = new Set(secretSchemaPaths(raw));
      for (const p of op.secretFields ?? []) if (!present.has(p)) stale.push(`${name} secretFields ${p}`);
      for (const p of op.notSecret ?? []) if (!isSecretArgumentName(p.split('.').pop()!)) stale.push(`${name} notSecret ${p}`);
    }
    expect(stale).toEqual([]);
  });

  it('excludes every operation whose purpose is a secret, with the app page instead', () => {
    const names = new Set(OPERATIONS.map((o) => o.name));
    const routesInOps = new Set(OPERATIONS.map((o) => o.route));
    for (const [name, { route, page }] of Object.entries(SECRET_OPERATIONS)) {
      expect(names.has(name)).toBe(false);
      expect(routesInOps.has(route)).toBe(false);
      expect(EXCLUDED_ROUTES[route]).toBe(TAKES_A_SECRET);
      expect(page.startsWith('/')).toBe(true);
    }
    for (const route of ['CredentialsController.create', 'CredentialsController.update', 'CredentialsController.rotate']) {
      expect(EXCLUDED_ROUTES[route]).toBe(TAKES_A_SECRET);
    }
  });

  it('offers no secret-named parameter on any dedicated tool', () => {
    const offenders = MANAGEMENT_TOOLS.flatMap((tool) => secretSchemaPaths(tool.inputSchema as any).map((p) => `${tool.name}: ${p}`));
    expect(offenders).toEqual([]);
  });
});
