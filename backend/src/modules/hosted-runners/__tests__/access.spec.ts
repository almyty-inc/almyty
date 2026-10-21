import { readFileSync } from 'fs';
import { join } from 'path';

import { HOSTED_RUNNER_ACCESS } from '../adapters/kubernetes/access';
import { buildHostedRunnerObjects } from '../adapters/kubernetes/manifests';
import { LAYOUT, provisionRequest } from './fixtures';

/**
 * The kubernetes connection check reports a token that cannot provision
 * by asking the cluster about HOSTED_RUNNER_ACCESS. That list is only true
 * while it covers what the adapter sends, so it is read against the
 * adapter here.
 */
describe('hosted runner access reviews cover what the adapter does', () => {
  const has = (kind: string, verb: string, subresource?: string) =>
    HOSTED_RUNNER_ACCESS.some((a) => a.kind === kind && a.verb === verb && a.subresource === subresource);

  it('asks create and patch for every kind provisioning applies, and the Secret rotate writes', () => {
    const kinds = new Set([...buildHostedRunnerObjects(provisionRequest(), LAYOUT).map((o) => o.kind), 'Secret']);
    for (const kind of kinds) {
      expect({ kind, create: has(kind, 'create'), patch: has(kind, 'patch') }).toEqual({ kind, create: true, patch: true });
    }
  });

  it('asks for every delete, read, scale and list the adapter makes', () => {
    const adapter = readFileSync(join(__dirname, '..', 'adapters', 'kubernetes.adapter.ts'), 'utf8');
    const deleted = [...adapter.matchAll(/\.delete\('(\w+)'/g)].map((m) => m[1]);
    expect(deleted.length).toBeGreaterThan(0);
    for (const kind of deleted) expect({ kind, delete: has(kind, 'delete') }).toEqual({ kind, delete: true });
    const read = [...adapter.matchAll(/\.get\('(\w+)'/g)].map((m) => m[1]);
    for (const kind of read) expect({ kind, get: has(kind, 'get') }).toEqual({ kind, get: true });
    if (/scaleDeployment\(/.test(adapter)) expect(has('Deployment', 'patch', 'scale')).toBe(true);
    if (/listPods\(/.test(adapter)) expect(has('Pod', 'list')).toBe(true);
  });
});
