import { HostedProvisionRequest } from '../adapters/hosted-runner-adapter.interface';
import { ClusterLayout } from '../adapters/kubernetes/manifests';
import { DEFAULT_HOSTED_RUNNER_SETTINGS } from '../hosted-runner-settings';

/** The shipped cluster layout. */
export const LAYOUT: ClusterLayout = DEFAULT_HOSTED_RUNNER_SETTINGS.cluster;

/** A value that must never appear outside the runner's Secret. */
/** Fake, low-entropy test values; nothing real. */
export const ENROLLMENT_TOKEN = 'fake-enrollment-token-for-tests';
export const BOUND_SECRET = 'fake-bound-connection-value';

/** A provision request as the processor builds one, for one workspace of one org. */
export function provisionRequest(overrides: Partial<HostedProvisionRequest> = {}): HostedProvisionRequest {
  const small = DEFAULT_HOSTED_RUNNER_SETTINGS.resourceClasses.small;
  const large = DEFAULT_HOSTED_RUNNER_SETTINGS.resourceClasses.large;
  return {
    hostedRunnerId: '11111111-1111-4111-8111-111111111111',
    organizationId: '22222222-2222-4222-8222-222222222222',
    environmentId: '33333333-3333-4333-8333-333333333333',
    environmentVersion: 1,
    workspaceId: '44444444-4444-4444-8444-444444444444',
    runnerId: '55555555-5555-4555-8555-555555555555',
    image: 'almyty/runner-env@sha256:abc',
    resources: { name: 'small', ...small },
    egressHosts: ['github.com', 'registry.npmjs.org', 'api.almyty.com'],
    env: {
      ALMYTY_API_URL: 'https://api.almyty.com',
      ALMYTY_RUNNER_ID: '55555555-5555-4555-8555-555555555555',
      ALMYTY_REPO_URL: 'https://github.com/acme/app',
    },
    secretEnv: { ALMYTY_ENROLLMENT_TOKEN: ENROLLMENT_TOKEN, NPM_TOKEN: BOUND_SECRET },
    quota: { maxConcurrentRunners: 2, maxWorkspaces: 10, podResources: { name: 'large', ...large } },
    providerConfig: {},
    ...overrides,
  };
}
