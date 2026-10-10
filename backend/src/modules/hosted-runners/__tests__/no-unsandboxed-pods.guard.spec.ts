import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

import { KubeApiClient } from '../adapters/kubernetes/kube-api.client';
import { buildDeployment } from '../adapters/kubernetes/manifests';
import { LAYOUT, provisionRequest } from './fixtures';

/**
 * No code path runs customer code outside the gVisor sandbox (Frane,
 * 2026-10-08: "never plain runc for customer code").
 *
 * Three locks, each of which fails on its own:
 *   1. Only kubernetes/manifests.ts writes a workload object (a Pod,
 *      Deployment, Job, ...). A second place that builds one would not
 *      go through the sandboxed builder.
 *   2. The only workload builder sets runtimeClassName from
 *      SANDBOX_RUNTIME_CLASS, which is 'gvisor'.
 *   3. The client every adapter write goes through refuses a workload
 *      that is not sandboxed, before any byte leaves (assertSandboxed in
 *      KubeApiClient.apply), so even a builder bug cannot reach a cluster.
 */
const SRC = join(__dirname, '..', '..', '..');
const BUILDER = join('modules', 'hosted-runners', 'adapters', 'kubernetes', 'manifests.ts');

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== 'node_modules' && entry !== '__tests__') sources(full, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

const WORKLOAD_LITERAL = /kind:\s*['"`](Pod|Deployment|ReplicaSet|StatefulSet|DaemonSet|Job|CronJob)['"`]/;

describe('no customer pod runs outside gVisor', () => {
  const files = sources(SRC);

  it('reads the source tree', () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files.map((f) => relative(SRC, f))).toContain(BUILDER);
  });

  it('only the manifest builders write a workload object', () => {
    const writers = files
      .filter((f) => WORKLOAD_LITERAL.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f).split(sep).join('/'));
    expect(writers).toEqual([BUILDER.split(sep).join('/')]);
  });

  it('the builder takes the runtime class from SANDBOX_RUNTIME_CLASS, and that is gvisor', () => {
    const source = readFileSync(join(SRC, BUILDER), 'utf8');
    expect(source).toMatch(/runtimeClassName:\s*SANDBOX_RUNTIME_CLASS/);
    expect(source).not.toMatch(/runtimeClassName:\s*['"`]/);
    const iface = readFileSync(join(SRC, 'modules', 'hosted-runners', 'adapters', 'hosted-runner-adapter.interface.ts'), 'utf8');
    expect(iface).toMatch(/export const SANDBOX_RUNTIME_CLASS = 'gvisor';/);
  });

  it('the client checks every object before it is applied', () => {
    const source = readFileSync(join(SRC, 'modules', 'hosted-runners', 'adapters', 'kubernetes', 'kube-api.client.ts'), 'utf8');
    const apply = source.slice(source.indexOf('async apply('), source.indexOf('async get('));
    expect(apply.indexOf('assertSandboxed(obj)')).toBeGreaterThan(-1);
    expect(apply.indexOf('assertSandboxed(obj)')).toBeLessThan(apply.indexOf('this.request('));
  });

  it('and the client really refuses: an unsandboxed Deployment never reaches the wire', async () => {
    const client = new KubeApiClient({ server: 'https://kube.invalid', token: 't' });
    const send = jest.spyOn(client as any, 'request');
    const deployment = buildDeployment(provisionRequest(), LAYOUT, 1);
    delete deployment.spec.template.spec.runtimeClassName;
    await expect(client.apply(deployment)).rejects.toThrow(/gvisor/);
    expect(send).not.toHaveBeenCalled();
  });

  it('a runner Deployment is only ever built alongside its PodDisruptionBudget, private-range deny and node-identity deny', () => {
    // Outside the builder file nothing calls buildDeployment; inside it, only
    // buildHostedRunnerObjects does, and that checks the set before returning.
    const callers = files
      .filter((f) => relative(SRC, f) !== BUILDER && /\bbuildDeployment\s*\(/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f).split(sep).join('/'));
    expect(callers).toEqual([]);
    const source = readFileSync(join(SRC, BUILDER), 'utf8');
    const objects = source.slice(source.indexOf('export function buildHostedRunnerObjects('), source.indexOf('function sameLabels('));
    // The definition, and the one call inside buildHostedRunnerObjects.
    expect(source.match(/\bbuildDeployment\s*\(/g)).toHaveLength(2);
    expect(objects.match(/\bbuildDeployment\s*\(/g)).toHaveLength(1);
    expect(objects).toMatch(/assertRunnerGuarded\(objects\);\s*return objects;/);
    // The node deny is an entity rule (on Cilium nodes are identities, not CIDRs),
    // written by the policy builder and demanded by the guard.
    const guard = source.slice(source.indexOf('export function assertRunnerGuarded('), source.indexOf('export function podSpecOf('));
    expect(guard).toMatch(/NODE_EGRESS_DENY_ENTITIES\.every\(/);
    const policy = source.slice(source.indexOf('export function buildEgressPolicy('), source.indexOf('export function buildDisruptionBudget('));
    expect(policy).toMatch(/\{ toEntities: \[\.\.\.NODE_EGRESS_DENY_ENTITIES\] \}/);
    const adapter = readFileSync(join(SRC, 'modules', 'hosted-runners', 'adapters', 'kubernetes.adapter.ts'), 'utf8');
    expect(adapter).toMatch(/for \(const obj of buildHostedRunnerObjects\(req, layout\)\) await client\.apply\(obj\);/);
  });

  it('every adapter declares gvisor as its runtime class (the registry refuses one that does not)', () => {
    const { HostedAdapterRegistry } = require('../adapters/adapter.registry');
    const registry = new HostedAdapterRegistry();
    expect(() =>
      registry.register({ key: 'runc-pool', capabilities: () => ({ runtimeClasses: ['runc'], volumeSnapshots: false }) } as any),
    ).toThrow(/gvisor/);
  });
});
