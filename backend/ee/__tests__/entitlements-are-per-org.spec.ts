import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const EE = join(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * Whether a feature is paid for is a question about an organization.
 *
 * Every other part of licensing knows this: billing mints a token per
 * org, EntitlementGuard resolves per org, and /licensing/entitlements
 * answers for the requesting org. Four hooks instead asked
 * LicenseService -- the process-global singleton, which reads a token
 * from the environment and is community without one. The deployed API
 * sets only the license SIGNING key, so those four returned false for
 * every entitlement forever: a paying org could open the settings
 * screen, configure the feature, be told it saved, and get nothing at
 * run time. Custom roles granted nothing, approval policies governed
 * nothing, compliance plugins never ran, audit events never streamed.
 *
 * A hook holds an organizationId in its hand, so there is no reason for
 * one to consult the global.
 */
describe('EE entitlement checks are per organization', () => {
  const hooks = walk(EE).filter(f => f.endsWith('.hook.ts'));

  it('finds the hooks, so this guard cannot pass by matching nothing', () => {
    expect(hooks.length).toBeGreaterThanOrEqual(4);
  });

  it('has no hook asking the process-global LicenseService', () => {
    const offenders = hooks
      .filter(f => /\bthis\.\w*[Ll]icense\w*\.has\s*\(/.test(stripComments(readFileSync(f, 'utf8'))))
      .map(f => f.slice(EE.length + 1));

    expect(offenders).toEqual([]);
  });

  it('has no hook importing LicenseService at all', () => {
    const offenders = hooks
      .filter(f => /import \{[^}]*\bLicenseService\b/.test(stripComments(readFileSync(f, 'utf8'))))
      .map(f => f.slice(EE.length + 1));

    expect(offenders).toEqual([]);
  });
});
