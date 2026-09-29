import { ToolScriptExecutor } from '../executors/tool-script.executor';

/**
 * A private npm registry's token is a credential: the SDK API names it
 * (`npmRegistry.credentialId`) and the token is read from Credentials when
 * the tool runs, as the caller. The form used to send `token`, which the
 * installer (it reads `authToken`) never saw.
 */
describe('the npm registry an SDK tool installs from', () => {
  const principal = { kind: 'user', userId: 'u1', source: 'session' } as any;
  const options = { organizationId: 'org-1', userId: 'u1', principal } as any;
  const make = (resolve?: jest.Mock) => new ToolScriptExecutor(null as any, null as any, null as any, null as any, null as any, resolve ? ({ resolve } as any) : undefined);

  it('reads the token from the credential it names, as the caller', async () => {
    const resolve = jest.fn().mockResolvedValue({ config: { apiKey: 'npm_secret' } });
    const registry = await make(resolve).registryFor({ url: 'https://npm.acme.dev', scope: '@acme', credentialId: 'cred-9' }, { id: 'tool-1' }, options);
    expect(registry).toEqual({ url: 'https://npm.acme.dev', scope: '@acme', authToken: 'npm_secret' });
    expect(resolve).toHaveBeenCalledWith('org-1', 'cred-9', { principal, context: { purpose: 'npm_registry', resourceType: 'tool', resourceId: 'tool-1' } });
  });

  it('fails the run when the credential cannot be used', async () => {
    const resolve = jest.fn().mockRejectedValue(new Error('credential not found'));
    await expect(make(resolve).registryFor({ url: 'https://npm.acme.dev', credentialId: 'cred-9' }, { id: 'tool-1' }, options)).rejects.toThrow('credential not found');
  });

  it('still installs from an older registry with its token inline', async () => {
    expect(await make().registryFor({ url: 'https://npm.acme.dev', token: 'old' }, { id: 'tool-1' }, options)).toEqual({ url: 'https://npm.acme.dev', authToken: 'old' });
    expect(await make().registryFor({ url: 'https://npm.acme.dev', authToken: 'old2' }, { id: 'tool-1' }, options)).toEqual({ url: 'https://npm.acme.dev', authToken: 'old2' });
  });

  it('is nothing without a registry address', async () => {
    expect(await make().registryFor(null, { id: 'tool-1' }, options)).toBeUndefined();
    expect(await make().registryFor({ scope: '@acme' }, { id: 'tool-1' }, options)).toBeUndefined();
  });
});
