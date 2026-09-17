import { ToolAuthService } from '../services/tool-auth.service';

/**
 * Inline auth on a standalone HTTP tool.
 *
 * The create-tool dialog offers Bearer, API key and Basic, and this
 * implemented only the first two -- so a tool configured with Basic sent
 * no credentials at all and got back a 401 nothing in the product
 * explained. (The payload never carried authConfig to begin with, which
 * is fixed on the frontend; this covers the half that lives here.)
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

  it('sends basic auth, which the dialog offers and this used to ignore', () => {
    const headers = headersFor({ type: 'basic', config: { username: 'ada', password: 'hunter2' } });

    expect(headers.Authorization).toBe(`Basic ${Buffer.from('ada:hunter2').toString('base64')}`);
  });

  it('handles a basic credential with no password rather than sending "undefined"', () => {
    const headers = headersFor({ type: 'basic', config: { username: 'ada' } });

    expect(headers.Authorization).toBe(`Basic ${Buffer.from('ada:').toString('base64')}`);
  });

  it('adds nothing when the tool has no inline auth', () => {
    expect(headersFor({ type: 'none' })).toEqual({});
  });
});
