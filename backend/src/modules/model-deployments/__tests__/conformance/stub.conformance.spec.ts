import { StubAdapter } from '../../adapters/stub.adapter';
import { runConformance } from './conformance.suite';

runConformance('stub', {
  adapter: () => new StubAdapter(),
  credentials: { token: 'valid' },
  badCredentials: { token: 'expired' },
  tinyVersion: { id: 'v1', name: 'qwen3-0.6b', registryUri: 's3://registry/qwen3-0.6b@abc', base: 'qwen3-0.6b', quantizations: [], manifestSha: 'sha' },
  providerConfig: { token: 'valid', simulate: 'none' },
  unsupportedArchitectureVersion: { id: 'v2', name: 'mamba', registryUri: 's3://registry/mamba@def', base: 'mamba-2.8b', quantizations: [], manifestSha: 'sha' },
  quotaExceededConfig: { token: 'valid', simulate: 'quota_exceeded' },
  vanish: (adapter, ref) => (adapter as StubAdapter).vanish(ref.id),
  chat: async () => 'hello from the stub',
});
