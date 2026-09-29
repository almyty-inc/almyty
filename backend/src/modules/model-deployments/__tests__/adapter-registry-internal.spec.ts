import { AdapterRegistry, listsInternalAdapters } from '../adapters/adapter.registry';
import { ModalAdapter } from '../adapters/modal.adapter';
import { StubAdapter } from '../adapters/stub.adapter';

/**
 * The stub is a test double. GET /model-adapters is a list users pick
 * from, so it only carries the stub on a dev or test install, or when
 * MODEL_STUB_ADAPTER=true asks for it. It still deploys by key.
 */
describe('AdapterRegistry: internal adapters', () => {
  const registry = new AdapterRegistry();
  registry.register(new ModalAdapter());
  registry.register(new StubAdapter({ architectures: 'any' }));

  it('leaves the stub out of the list on a production install', () => {
    const keys = registry.describe({ NODE_ENV: 'production' }).map((a) => a.key);
    expect(keys).toContain('modal');
    expect(keys).not.toContain('stub');
  });

  it('leaves the stub out when NODE_ENV is unset', () => {
    expect(registry.describe({}).map((a) => a.key)).not.toContain('stub');
  });

  it('lists the stub on a dev or test install, or when asked for', () => {
    expect(registry.describe({ NODE_ENV: 'development' }).map((a) => a.key)).toContain('stub');
    expect(registry.describe({ NODE_ENV: 'test' }).map((a) => a.key)).toContain('stub');
    expect(registry.describe({ NODE_ENV: 'production', MODEL_STUB_ADAPTER: 'true' }).map((a) => a.key)).toContain('stub');
  });

  it('still resolves the stub by key for a deploy', () => {
    expect(registry.require('stub').key).toBe('stub');
  });

  it('listsInternalAdapters reads NODE_ENV and MODEL_STUB_ADAPTER only', () => {
    expect(listsInternalAdapters({ NODE_ENV: 'staging' })).toBe(false);
    expect(listsInternalAdapters({ NODE_ENV: 'production', MODEL_STUB_ADAPTER: 'false' })).toBe(false);
  });
});