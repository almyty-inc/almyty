import { isSecretPropertyName, redactVersionSnapshot } from '../version-snapshot-redaction';
import { encryptField } from '../security/field-crypto';

describe('redactVersionSnapshot', () => {
  it('drops secrets by name at any depth, including header maps and arrays', () => {
    const snapshot = {
      name: 'slack gateway',
      configuration: {
        bot_token: 'xoxb-1',
        signingSecret: 's',
        channel: '#general',
        headers: { Authorization: 'Bearer abc', 'X-Api-Key': 'k', Accept: 'application/json' },
      },
      webhooks: { enabled: true, endpoints: [{ url: 'https://hook.test', secret: 'whsec', events: ['a'] }] },
      aws: { accessKeyId: 'AKIA', secretAccessKey: 'wJal', sessionToken: 't', region: 'us-east-1' },
      apiKey: 'sk-1',
      usageApiKey: 'sk-2',
    };
    expect(redactVersionSnapshot(snapshot)).toEqual({
      name: 'slack gateway',
      configuration: { channel: '#general', headers: { Accept: 'application/json' } },
      webhooks: { enabled: true, endpoints: [{ url: 'https://hook.test', events: ['a'] }] },
      aws: { region: 'us-east-1' },
    });
  });

  it('drops ciphertext under any name, because only a secret is ever encrypted', () => {
    const snapshot = { providerConfig: { hfCred: encryptField('hf_live'), repo: 'org/model' } };
    expect(redactVersionSnapshot(snapshot)).toEqual({ providerConfig: { repo: 'org/model' } });
  });

  it('keeps counters and references that only look like secrets', () => {
    for (const name of ['maxTokens', 'tokensPerMinute', 'totalTokensUsed', 'inputTokenCost', 'connectorKey', 'credentialKeys', 'keyName', 'credentialId']) {
      expect(isSecretPropertyName(name)).toBe(false);
    }
    const snapshot = { configuration: { maxTokens: 4096 }, connectorKey: 'channel-slack', credentialKeys: ['bot_token'] };
    expect(redactVersionSnapshot(snapshot)).toEqual(snapshot);
  });

  it('leaves the input untouched', () => {
    const snapshot = { config: { password: 'p' } };
    redactVersionSnapshot(snapshot);
    expect(snapshot.config.password).toBe('p');
  });
});
