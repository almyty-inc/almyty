import { ToolAuthService } from '../services/tool-auth.service';

/**
 * How a standalone HTTP tool's key goes onto the request, once it is read
 * from the credential the tool points at: bearer, API key or basic.
 */
describe('applyInlineToolAuth', () => {
  const service = new ToolAuthService(null as any, null as any, null as any);

  const headersFor = (authConfig: any) => {
    const config: any = {};
    service.applyInlineToolAuth(config, authConfig);
    return config.headers as Record<string, string>;
  };

  it('sends a bearer token', () => {
    expect(headersFor({ type: 'bearer', config: { token: 't0ken' } })).toEqual({
      Authorization: 'Bearer t0ken',
    });
  });

  it('sends an API key under the header it was given', () => {
    expect(headersFor({ type: 'apiKey', config: { key: 'k', headerName: 'X-Custom' } })).toEqual({
      'X-Custom': 'k',
    });
  });

  it('defaults the API key header when none was named', () => {
    expect(headersFor({ type: 'apiKey', config: { key: 'k' } })).toEqual({ 'X-API-Key': 'k' });
  });

  it('sends basic auth', () => {
    const headers = headersFor({ type: 'basic', config: { username: 'ada', password: 'hunter2' } });

    expect(headers.Authorization).toBe(`Basic ${Buffer.from('ada:hunter2').toString('base64')}`);
  });

  it('handles a basic credential with no password rather than sending "undefined"', () => {
    const headers = headersFor({ type: 'basic', config: { username: 'ada' } });

    expect(headers.Authorization).toBe(`Basic ${Buffer.from('ada:').toString('base64')}`);
  });

  it('adds nothing when the tool signs no calls', () => {
    expect(headersFor({ type: 'none' })).toEqual({});
  });
});

/**
 * A tool pointed at a credential (picked or created in the tool form's
 * "pick or create" control) keeps no secret of its own: the key is read
 * from Credentials at call time, as the caller, and sent the way the tool
 * says.
 */
describe('applyToolAuth with a credential', () => {
  const principal = { kind: 'user', userId: 'u1', source: 'session' } as any;
  const options = { organizationId: 'org-1', userId: 'u1', principal } as any;

  const serviceWith = (config: Record<string, any>) => {
    const resolve = jest.fn().mockResolvedValue({ config });
    const service = new ToolAuthService(null as any, null as any, null as any, { resolve } as any);
    return { service, resolve };
  };

  const headersFor = async (service: ToolAuthService, authConfig: any) => {
    const config: any = {};
    await service.applyToolAuth(config, { id: 'tool-1', authConfig } as any, options);
    return config.headers as Record<string, string>;
  };

  it('resolves the credential as the caller, for this tool', async () => {
    const { service, resolve } = serviceWith({ apiKey: 'sk-live' });
    await headersFor(service, { type: 'bearer', config: { credentialId: 'cred-1' } });
    expect(resolve).toHaveBeenCalledWith('org-1', 'cred-1', {
      principal,
      context: { purpose: 'tool_call', resourceType: 'tool', resourceId: 'tool-1' },
    });
  });

  it('sends the key as a bearer token', async () => {
    const { service } = serviceWith({ apiKey: 'sk-live' });
    expect(await headersFor(service, { type: 'bearer', config: { credentialId: 'cred-1' } })).toEqual({ Authorization: 'Bearer sk-live' });
  });

  it('sends the key under the header the tool names', async () => {
    const { service } = serviceWith({ apiKey: 'sk-live' });
    expect(await headersFor(service, { type: 'apiKey', config: { credentialId: 'cred-1', headerName: 'X-Acme-Key' } })).toEqual({ 'X-Acme-Key': 'sk-live' });
  });

  it('sends a username and password', async () => {
    const { service } = serviceWith({ username: 'ada', password: 'hunter2' });
    const headers = await headersFor(service, { type: 'basic', config: { credentialId: 'cred-1' } });
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('ada:hunter2').toString('base64')}`);
  });

  it('fails the call when the credential cannot be used, rather than sending it unsigned', async () => {
    const resolve = jest.fn().mockRejectedValue(new Error('credential not found'));
    const service = new ToolAuthService(null as any, null as any, null as any, { resolve } as any);
    await expect(headersFor(service, { type: 'bearer', config: { credentialId: 'cred-1' } })).rejects.toThrow('credential not found');
  });

  it('renews and sends an OAuth 2.0 sign-in the way a bound credential is sent', async () => {
    const row = { id: 'cred-1', type: 'oauth2' };
    const resolve = jest.fn().mockResolvedValue({ credential: row, config: { accessToken: 'stale' } });
    const repository = { findOne: jest.fn().mockResolvedValue(row) };
    const service = new ToolAuthService(repository as any, null as any, null as any, { resolve } as any);
    const applied = jest.spyOn(service as any, 'applyCredential').mockImplementation(async (config: any) => {
      config.headers = { Authorization: 'Bearer renewed' };
    });
    expect(await headersFor(service, { type: 'bearer', config: { credentialId: 'cred-1' } })).toEqual({ Authorization: 'Bearer renewed' });
    expect(applied).toHaveBeenCalledWith(expect.anything(), row);
  });

  it('sends no key for a tool without a credential, whatever sits beside it', async () => {
    const { service, resolve } = serviceWith({});
    expect(await headersFor(service, { type: 'bearer', config: { token: 't0ken' } })).toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
  });
});
