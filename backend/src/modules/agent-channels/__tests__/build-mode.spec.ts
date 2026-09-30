import { buildMode, buildProcessingEnabled, buildsRunOnWorker } from '../build-mode';

/**
 * Where builds run. Both modes are supported: in the API pod (default),
 * or on a dedicated worker with the API pods standing down.
 */
describe('buildMode', () => {
  it('defaults to in-api, so a single deployment just builds', () => {
    expect(buildMode({})).toBe('in-api');
    expect(buildMode({ APP_BUILD_MODE: '' })).toBe('in-api');
    expect(buildMode({ APP_BUILD_MODE: 'nonsense' })).toBe('in-api');
  });

  it('reads worker and off', () => {
    expect(buildMode({ APP_BUILD_MODE: 'worker' })).toBe('worker');
    expect(buildMode({ APP_BUILD_MODE: 'off' })).toBe('off');
    expect(buildMode({ APP_BUILD_MODE: 'WORKER' })).toBe('worker');
  });
});

describe('buildProcessingEnabled', () => {
  it('processes in-api and worker, not off', () => {
    // An API pod alongside a worker sets off so it does not grab a job
    // it cannot fully handle.
    expect(buildProcessingEnabled({ APP_BUILD_MODE: 'in-api' })).toBe(true);
    expect(buildProcessingEnabled({ APP_BUILD_MODE: 'worker' })).toBe(true);
    expect(buildProcessingEnabled({ APP_BUILD_MODE: 'off' })).toBe(false);
  });
});

describe('buildsRunOnWorker', () => {
  it('is true whenever this pod is not the one building', () => {
    // In both worker and off, the API pod that answers a capabilities
    // request has no toolchain of its own to probe.
    expect(buildsRunOnWorker({ APP_BUILD_MODE: 'in-api' })).toBe(false);
    expect(buildsRunOnWorker({ APP_BUILD_MODE: 'worker' })).toBe(true);
    expect(buildsRunOnWorker({ APP_BUILD_MODE: 'off' })).toBe(true);
  });
});
