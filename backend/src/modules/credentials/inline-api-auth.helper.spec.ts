import { CredentialType } from '../../entities/credential.entity';
import { hasInlineApiSecret, inlineApiAuthView, splitInlineApiAuth } from './inline-api-auth.helper';

describe('inline API auth helper', () => {
  it('detects a secret in every inline shape and none in a reference-only config', () => {
    expect(hasInlineApiSecret({ type: 'bearer', config: { token: 't' } })).toBe(true);
    expect(hasInlineApiSecret({ type: 'basic', config: { username: 'u', password: 'p' } })).toBe(true);
    expect(hasInlineApiSecret({ type: 'api_key', config: { headerName: 'X-Key', value: 'v' } })).toBe(true);
    expect(hasInlineApiSecret({ type: 'oauth2', config: { accessToken: 'a' } })).toBe(true);
    expect(hasInlineApiSecret({ type: 'api_key', config: { headerName: 'X-Key', credentialId: 'c-1' } })).toBe(false);
    expect(hasInlineApiSecret({ type: 'none', config: {} })).toBe(false);
    expect(hasInlineApiSecret(null)).toBe(false);
  });

  it('splits api_key (any spelling) into an API_KEY row with keyName/keyLocation and a public remainder', () => {
    const split = splitInlineApiAuth({ type: 'api_key', config: { parameter: 'api-key', apiKey: 'v1', location: 'query', note: 'n' } })!;
    expect(split.credentialType).toBe(CredentialType.API_KEY);
    expect(split.secretConfig).toEqual({ apiKey: 'v1' });
    expect(split.publicConfig).toEqual({ parameter: 'api-key', location: 'query', note: 'n' });
    expect(split.keyName).toBe('api-key');
    expect(split.keyLocation).toBe('query');
  });

  it('splits bearer, basic and oauth2', () => {
    expect(splitInlineApiAuth({ type: 'bearer', config: { token: 't' } })).toMatchObject({ credentialType: CredentialType.BEARER_TOKEN, secretConfig: { token: 't' }, publicConfig: {} });
    expect(splitInlineApiAuth({ type: 'basic', config: { username: 'u', password: 'p' } })).toMatchObject({ credentialType: CredentialType.BASIC_AUTH, secretConfig: { username: 'u', password: 'p' } });
    expect(splitInlineApiAuth({ type: 'oauth2', config: { accessToken: 'a', client_secret: 's', tokenUrl: 'https://x' } })).toMatchObject({
      credentialType: CredentialType.OAUTH2, secretConfig: { accessToken: 'a', clientSecret: 's' }, publicConfig: { tokenUrl: 'https://x' },
    });
    expect(splitInlineApiAuth({ type: 'bearer', config: { credentialId: 'c-1' } })).toBeNull();
  });

  it('rebuilds the inline shape the request builders read from a resolved config', () => {
    expect(inlineApiAuthView({ type: 'api_key', config: { headerName: 'X-Key', credentialId: 'c' } }, { apiKey: 'v' }))
      .toEqual({ type: 'api_key', config: { headerName: 'X-Key', value: 'v', apiKey: 'v', name: 'X-Key', location: 'header' } });
    expect(inlineApiAuthView({ type: 'bearer', config: { credentialId: 'c' } }, { token: 't' })).toEqual({ type: 'bearer', config: { token: 't' } });
    expect(inlineApiAuthView({ type: 'basic', config: { credentialId: 'c' } }, { username: 'u', password: 'p' })).toEqual({ type: 'basic', config: { username: 'u', password: 'p' } });
    expect(inlineApiAuthView({ type: 'oauth2', config: { credentialId: 'c' } }, { accessToken: 'a' })).toEqual({ type: 'oauth2', config: { accessToken: 'a' } });
  });
});
