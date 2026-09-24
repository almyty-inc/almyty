import { ConnectionValidationService, defaultConnectionsHttp } from '../connection-validation.service';
import { ssrfSafeDispatcher } from '../../../common/security/safe-fetch';
import { dispatcherExempting } from '../../../common/security/exempt-dispatcher';

/**
 * Connector probes ran the SSRF string check and then a bare fetch: the
 * name was never re-checked at connect time, so a public host whose A
 * record answered a private address was probed with the credential
 * attached. The default transport now pins; a private-URL hatch relaxes
 * the pin for the probed host only.
 */
describe('connection probes are pinned', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    (global as any).fetch = fetchMock;
  });

  afterEach(() => {
    (global as any).fetch = realFetch;
    delete process.env.OLLAMA_ALLOW_PRIVATE_URLS;
  });

  it('the default transport pins DNS and never follows a redirect', async () => {
    await defaultConnectionsHttp()('https://api.example.com/v1/me', { method: 'GET' });
    const init = fetchMock.mock.calls[0][1];
    expect(init.dispatcher).toBe(ssrfSafeDispatcher);
    expect(init.redirect).toBe('manual');
  });

  it('an explicitly undefined dispatcher cannot switch the pin off', async () => {
    await defaultConnectionsHttp()('https://api.example.com/', { dispatcher: undefined } as RequestInit);
    expect(fetchMock.mock.calls[0][1].dispatcher).toBe(ssrfSafeDispatcher);
  });

  const service = () =>
    new ConnectionValidationService({ get: (k: string) => process.env[k] } as any, defaultConnectionsHttp());

  const ollamaProbe = {
    key: 'ollama',
    displayName: 'Ollama',
    validation: { kind: 'http', url: '{{baseUrl}}/api/tags', auth: 'bearer', privateUrlsEnv: 'OLLAMA_ALLOW_PRIVATE_URLS' },
  } as any;

  it('a probe with its hatch closed goes out on the pinned dispatcher', async () => {
    await service().validate(ollamaProbe, { baseUrl: 'https://ollama.example.com' }, { organizationId: 'o' });
    expect(fetchMock.mock.calls[0][1].dispatcher).toBe(ssrfSafeDispatcher);
  });

  it('a probe with its hatch open exempts the probed host, not every host', async () => {
    process.env.OLLAMA_ALLOW_PRIVATE_URLS = 'true';
    await service().validate(ollamaProbe, { baseUrl: 'http://ollama.lan:11434' }, { organizationId: 'o' });
    const init = fetchMock.mock.calls[0][1];
    expect(init.dispatcher).toBe(dispatcherExempting('ollama.lan'));
    expect(init.redirect).toBe('manual');
  });
});
