import * as fs from 'fs';
import * as path from 'path';

/**
 * Every authenticated dashboard route that names a gateway by id goes
 * through the gateway read rule (gatewayReadableBy: private to its owner
 * only, team to its team and org owners/admins). The rule sits in one
 * place, PrivateGatewayGuard; a controller that serves `:gatewayId` without
 * it hands a team's gateway -- its tools, skill bundle, CLI, SDK, auth
 * configs -- to every member of the organization.
 *
 * Source-reading on purpose: a new controller is exactly the thing no
 * behavioural spec knows to exercise.
 */
const BACKEND = path.resolve(__dirname, '../../../..');
const ROUTE = /@(Get|Post|Put|Patch|Delete|All)\(\s*['"`]([^'"`]*)['"`]/g;

/**
 * Controllers allowed to skip the guard, with the reason, and a string
 * their source must contain so the reason stays true.
 */
const EXEMPT: Record<string, { reason: string; mustContain: string }> = {
  'ee/modules/sso/hosted-chat-sso-settings.controller.ts': {
    reason: 'loads the gateway with GatewaysService.findManageable, which applies the read rule (404) before the manage rule',
    mustContain: 'this.gateways.findManageable(',
  },
};

function controllers(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) controllers(full, out);
    else if (entry.name.endsWith('.controller.ts')) out.push(full);
  }
  return out;
}

function gatewayIdRoutes(): Array<{ file: string; source: string; routes: string[] }> {
  const found: Array<{ file: string; source: string; routes: string[] }> = [];
  for (const root of ['src', 'ee']) {
    const dir = path.join(BACKEND, root);
    if (!fs.existsSync(dir)) continue;
    for (const file of controllers(dir)) {
      const source = fs.readFileSync(file, 'utf8');
      const controllerPath = /@Controller\(\s*['"`]([^'"`]*)['"`]/.exec(source)?.[1] ?? '';
      const routes: string[] = [];
      for (const m of source.matchAll(ROUTE)) {
        const route = m[2];
        // `:gatewayId` anywhere, and `:id` on the gateways controllers,
        // where it is the gateway (PrivateGatewayGuard reads either).
        if (/:gatewayId\b/.test(route) || (controllerPath === 'gateways' && /^:id\b/.test(route))) {
          routes.push(`${m[1]} ${controllerPath}/${route}`);
        }
      }
      if (routes.length) found.push({ file: path.relative(BACKEND, file), source, routes });
    }
  }
  return found;
}

describe('every dashboard route that names a gateway by id applies the gateway read rule', () => {
  const found = gatewayIdRoutes();

  it('finds the routes it is about', () => {
    const all = found.flatMap((f) => f.routes);
    for (const route of [
      'Get gateways/:gatewayId',
      'Get gateways/:gatewayId/skills',
      'Get gateways/:gatewayId/skills/individual',
      'Post gateways/:gatewayId/skills/:toolId/execute',
      'Get gateways/:gatewayId/cli-bundle',
      'Get gateways/:gatewayId/sdk',
    ]) {
      expect(all).toContain(route);
    }
  });

  it.each(found.map((f) => [f.file, f] as const))('%s', (file, { source }) => {
    if (EXEMPT[file]) {
      expect(source).toContain(EXEMPT[file].mustContain);
      return;
    }
    // Public surfaces (the chat widget, the Slack install redirect) are
    // not authenticated dashboard routes and are held to their own rules.
    if (!source.includes('JwtAuthGuard')) return;
    const guards = [...source.matchAll(/@UseGuards\(([^)]*)\)/g)].map((m) => m[1]);
    expect(guards.some((g) => /\bPrivateGatewayGuard\b/.test(g))).toBe(true);
  });

  it('the guard decides with the shared read rule', () => {
    const guard = fs.readFileSync(path.join(BACKEND, 'src/modules/gateways/private-gateway.guard.ts'), 'utf8');
    expect(guard).toMatch(/gatewayReadableBy\(this\.accessPolicy, row, /);
    // teamId and organizationId are what the team rule reads.
    expect(guard).toMatch(/select: \{[^}]*organizationId: true[^}]*teamId: true/);
  });
});
