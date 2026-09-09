import { GatewayType } from '../../../entities/gateway.entity';
import { channelConnectorKey } from '../../gateways/channels/channel-credential.service';
import { CHANNEL_SECRET_CONFIG_KEYS, LEGACY_CHANNEL_CONFIG_KEY_MAP } from '../../gateways/channels/channel-config.helper';
import { ConnectionValidationService } from '../connection-validation.service';
import { BUILTIN_CONNECTORS, CHANNEL_CONNECTORS } from '../connector-catalog';
import { schemaViolations, secretFieldsOf, validateConnectorDefinition } from '../connector-schema';
import { ConnectorDefinition, REDIRECT_METHODS } from '../connector.types';
import { FixtureRoute, fakeConfig, fixtureHttp } from './test-support';

/**
 * The chat-channel connectors: a Slack, Discord or Telegram token is
 * connected through the same connect sheet as every other third party,
 * and lands in the credential store spelled exactly the way the channel
 * adapter reads it.
 */

/** The config keys each adapter under gateways/channels/adapters actually reads. */
const ADAPTER_FIELDS: Record<string, string[]> = {
  [GatewayType.SLACK]: ['bot_token', 'signing_secret'],
  [GatewayType.DISCORD]: ['bot_token'],
  [GatewayType.TELEGRAM]: ['bot_token', 'webhook_secret_token'],
  [GatewayType.WHATSAPP]: ['twilio_account_sid', 'twilio_auth_token', 'phone_number'],
  [GatewayType.SMS]: ['twilio_account_sid', 'twilio_auth_token', 'phone_number'],
  [GatewayType.WHATSAPP_CLOUD]: ['phone_number_id', 'access_token', 'app_secret', 'verify_token'],
  [GatewayType.MICROSOFT_TEAMS]: ['bot_id', 'bot_password', 'service_url'],
  [GatewayType.GOOGLE_CHAT]: ['webhook_url', 'verification_token'],
  [GatewayType.SIGNAL]: ['api_url', 'phone_number', 'inbound_token'],
  [GatewayType.MATRIX]: ['homeserver_url', 'access_token', 'room_id', 'inbound_token'],
  [GatewayType.IRC]: ['webhook_url', 'bridge_token', 'inbound_token', 'channel', 'nick'],
  [GatewayType.EMAIL]: ['resend_api_key', 'reply_from', 'inbound_address', 'resend_inbound_signing_secret'],
  [GatewayType.WEBHOOK]: ['callback_url', 'secret'],
};

/** Fields a form may carry that no adapter reads: they steer the probe, not the transport. */
const PROBE_ONLY_FIELDS: Record<string, string[]> = {
  [GatewayType.MICROSOFT_TEAMS]: ['tenant_id'],
};

const byType = (type: string): ConnectorDefinition =>
  CHANNEL_CONNECTORS.find((c) => c.key === channelConnectorKey(type))!;

function probe(connector: ConnectorDefinition, config: Record<string, any>, routes: FixtureRoute[]) {
  const http = fixtureHttp(routes);
  const service = new ConnectionValidationService(fakeConfig(), http.http);
  return { run: () => service.validate(connector, config, { organizationId: 'org-1' }), http };
}

describe('chat channel connectors: catalog shape', () => {
  it('covers every credential-bearing channel type, keyed the way ChannelCredentialService tags a managed row', () => {
    expect(CHANNEL_CONNECTORS.map((c) => c.key).sort()).toEqual(Object.keys(ADAPTER_FIELDS).map(channelConnectorKey).sort());
    for (const type of Object.keys(ADAPTER_FIELDS)) {
      expect(byType(type)).toBeDefined();
      // The key must survive the connector key rule; `_` is not in its alphabet.
      expect(channelConnectorKey(type)).toMatch(/^[a-z0-9][a-z0-9-]{1,63}$/);
    }
    for (const c of CHANNEL_CONNECTORS) expect(BUILTIN_CONNECTORS).toContain(c);
  });

  it.each(CHANNEL_CONNECTORS.map((c) => [c.key, c] as const))('%s is well formed: kind channel, a method with a schema, a validation', (_key, connector) => {
    expect(validateConnectorDefinition(connector)).toEqual([]);
    expect(connector.kind).toBe('channel');
    expect(connector.connect.length).toBeGreaterThan(0);
    expect(connector.validation).toBeDefined();
    const forms = connector.connect.filter((m) => !REDIRECT_METHODS.includes(m.type));
    expect(forms.length).toBeGreaterThan(0);
    for (const form of forms) {
      expect(form.schema).toBeDefined();
      expect(form.schema!.required?.length).toBeGreaterThan(0);
    }
  });

  it('spells every form field the way the adapter reads it, and marks every secret secret', () => {
    for (const [type, fields] of Object.entries(ADAPTER_FIELDS)) {
      const connector = byType(type);
      const allowed = new Set([...fields, ...(PROBE_ONLY_FIELDS[type] ?? [])]);
      for (const method of connector.connect) {
        if (!method.schema) continue;
        for (const name of Object.keys(method.schema.properties)) {
          expect({ type, name, known: allowed.has(name) }).toEqual({ type, name, known: true });
          // No camelCase spelling may leak into the catalog: the read path
          // only normalizes legacy rows, it must not have to fix new ones.
          expect(LEGACY_CHANNEL_CONFIG_KEY_MAP[name]).toBeUndefined();
        }
        for (const secret of secretFieldsOf(method.schema)) {
          expect(CHANNEL_SECRET_CONFIG_KEYS).toContain(secret);
        }
      }
    }
  });

  it('never marks a plain handle secret: phone numbers, ids and URLs stay readable', () => {
    const plain = [
      [GatewayType.WHATSAPP, 'phone_number'], [GatewayType.SMS, 'phone_number'],
      [GatewayType.WHATSAPP_CLOUD, 'phone_number_id'], [GatewayType.MICROSOFT_TEAMS, 'bot_id'],
      [GatewayType.MATRIX, 'homeserver_url'], [GatewayType.SIGNAL, 'api_url'],
      [GatewayType.EMAIL, 'reply_from'], [GatewayType.WEBHOOK, 'callback_url'],
    ] as const;
    for (const [type, field] of plain) {
      const method = byType(type).connect.find((m) => m.schema?.properties[field])!;
      expect(secretFieldsOf(method.schema)).not.toContain(field);
    }
    // ... and every credential IS secret.
    expect(secretFieldsOf(byType(GatewayType.SLACK).connect[1].schema)).toEqual(['bot_token', 'signing_secret']);
    expect(secretFieldsOf(byType(GatewayType.WHATSAPP).connect[0].schema)).toEqual(['twilio_auth_token']);
    expect(secretFieldsOf(byType(GatewayType.MICROSOFT_TEAMS).connect[0].schema)).toEqual(['bot_password']);
  });

  it('points every connector at a page where the credential is made, or says there is none', () => {
    for (const connector of CHANNEL_CONNECTORS) {
      const url = connector.keyPageUrl;
      if (url === null) {
        // Self-hosted bridges: the credential is yours, there is no vendor page.
        expect([channelConnectorKey(GatewayType.SIGNAL), channelConnectorKey(GatewayType.MATRIX), channelConnectorKey(GatewayType.IRC), channelConnectorKey(GatewayType.WEBHOOK)]).toContain(connector.key);
      } else {
        expect(url).toMatch(/^https:\/\//);
      }
      if (connector.docsUrl !== null) expect(connector.docsUrl).toMatch(/^https:\/\//);
    }
  });

  it('ranks the Slack app install first and keeps the pasted-token form as the fallback', () => {
    const slack = byType(GatewayType.SLACK);
    expect(slack.connect[0]).toMatchObject({
      type: 'oauth2_code',
      secretField: 'bot_token',
      oauth: {
        authorizeUrl: 'https://slack.com/oauth/v2/authorize',
        tokenUrl: 'https://slack.com/api/oauth.v2.access',
        clientId: 'platform',
        tokenField: 'access_token',
      },
    });
    // Slack takes its scopes comma separated on the authorize URL.
    expect(slack.connect[0].oauth!.scopes).toEqual(['chat:write,app_mentions:read,im:history']);
    expect(slack.scopesNeeded).toEqual(['chat:write', 'app_mentions:read', 'im:history']);
    expect(slack.connect[1].type).toBe('api_key');
    expect(schemaViolations({ bot_token: 'xoxb-real-token' }, slack.connect[1].schema)).toEqual([]);
    expect(schemaViolations({ bot_token: 'nope' }, slack.connect[1].schema)).toEqual(['bot_token has an unexpected format']);
  });
});

describe('chat channel probes', () => {
  it('Slack auth.test: a 200 carrying ok:false is a rejected token, not a pass', async () => {
    const route = (body: unknown, status = 200): FixtureRoute => ({ method: 'POST', url: 'https://slack.com/api/auth.test', handle: () => ({ status, body }) });

    const good = probe(byType(GatewayType.SLACK), { bot_token: 'xoxb-good' }, [route({ ok: true, team: 'Northwind AI', user: 'almyty', team_id: 'T1' })]);
    await expect(good.run()).resolves.toMatchObject({ ok: true, status: 'valid', accountLabel: 'Northwind AI' });
    expect((good.http.calls[0].init.headers as Record<string, string>)['Authorization']).toBe('Bearer xoxb-good');

    const bad = probe(byType(GatewayType.SLACK), { bot_token: 'xoxb-revoked' }, [route({ ok: false, error: 'invalid_auth' })]);
    const result = await bad.run();
    expect(result).toMatchObject({ ok: false, status: 'failed' });
    expect(result.error).toContain('invalid_auth');
    expect(JSON.stringify(result)).not.toContain('xoxb-revoked');
  });

  it('Discord users/@me: the bot token goes in Authorization: Bot <token>, the username is the label', async () => {
    const url = 'https://discord.com/api/v10/users/@me';
    const good = probe(byType(GatewayType.DISCORD), { bot_token: 'disc-good' }, [{ url, handle: () => ({ status: 200, body: { id: '1', username: 'almyty-bot' } }) }]);
    await expect(good.run()).resolves.toMatchObject({ ok: true, accountLabel: 'almyty-bot' });
    expect((good.http.calls[0].init.headers as Record<string, string>)['Authorization']).toBe('Bot disc-good');

    const bad = probe(byType(GatewayType.DISCORD), { bot_token: 'disc-bad' }, [{ url, handle: () => ({ status: 401, body: { message: '401: Unauthorized', code: 0 } }) }]);
    await expect(bad.run()).resolves.toMatchObject({ ok: false, status: 'failed', error: expect.stringContaining('401') });
  });

  it('Telegram getMe: the token is a path segment and the User sits under result', async () => {
    const good = probe(byType(GatewayType.TELEGRAM), { bot_token: '12345:AAG-good-token-value' }, [
      { url: 'https://api.telegram.org/', handle: () => ({ status: 200, body: { ok: true, result: { id: 12345, is_bot: true, first_name: 'almyty', username: 'almyty_bot' } } }) },
    ]);
    await expect(good.run()).resolves.toMatchObject({ ok: true, accountLabel: 'almyty_bot' });
    expect(good.http.calls[0].url).toBe('https://api.telegram.org/bot12345:AAG-good-token-value/getMe');
    // No Authorization header: Telegram authenticates by path.
    expect((good.http.calls[0].init.headers as Record<string, string>)['Authorization']).toBeUndefined();

    const bad = probe(byType(GatewayType.TELEGRAM), { bot_token: '1:wrong' }, [
      { url: 'https://api.telegram.org/', handle: () => ({ status: 401, body: { ok: false, error_code: 401, description: 'Unauthorized' } }) },
    ]);
    await expect(bad.run()).resolves.toMatchObject({ ok: false, status: 'failed', error: expect.stringContaining('401') });
  });

  it('Twilio accounts fetch: basic auth of SID and auth token, friendly name as the label, shared by WhatsApp and SMS', async () => {
    const config = { twilio_account_sid: 'AC' + 'a'.repeat(32), twilio_auth_token: 'twilio-secret-token', phone_number: 'whatsapp:+15550001111' };
    for (const type of [GatewayType.WHATSAPP, GatewayType.SMS]) {
      const good = probe(byType(type), config, [
        { url: 'https://api.twilio.com/2010-04-01/Accounts/', handle: () => ({ status: 200, body: { friendly_name: 'Northwind AI', status: 'active' } }) },
      ]);
      await expect(good.run()).resolves.toMatchObject({ ok: true, accountLabel: 'Northwind AI' });
      expect(good.http.calls[0].url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${config.twilio_account_sid}.json`);
      const auth = String((good.http.calls[0].init.headers as Record<string, string>)['Authorization']);
      expect(Buffer.from(auth.replace('Basic ', ''), 'base64').toString()).toBe(`${config.twilio_account_sid}:${config.twilio_auth_token}`);
    }
    const bad = probe(byType(GatewayType.WHATSAPP), config, [
      { url: 'https://api.twilio.com/', handle: () => ({ status: 401, body: { code: 20003, message: 'Authenticate' } }) },
    ]);
    const result = await bad.run();
    expect(result).toMatchObject({ ok: false, status: 'failed' });
    expect(JSON.stringify(result)).not.toContain('twilio-secret-token');
  });

  it('WhatsApp Cloud: the phone number id is the path, the access token the bearer, the display number the label', async () => {
    const config = { phone_number_id: '109876543210', access_token: 'EAAG-good' };
    const good = probe(byType(GatewayType.WHATSAPP_CLOUD), config, [
      { url: 'https://graph.facebook.com/', handle: () => ({ status: 200, body: { id: '109876543210', display_phone_number: '+1 555-000-1111', verified_name: 'Northwind AI' } }) },
    ]);
    await expect(good.run()).resolves.toMatchObject({ ok: true, accountLabel: '+1 555-000-1111' });
    expect(good.http.calls[0].url).toBe('https://graph.facebook.com/v23.0/109876543210');
    expect((good.http.calls[0].init.headers as Record<string, string>)['Authorization']).toBe('Bearer EAAG-good');

    const bad = probe(byType(GatewayType.WHATSAPP_CLOUD), config, [
      { url: 'https://graph.facebook.com/', handle: () => ({ status: 401, body: { error: { message: 'Invalid OAuth access token', code: 190 } } }) },
    ]);
    await expect(bad.run()).resolves.toMatchObject({ ok: false, status: 'failed', error: expect.stringContaining('Invalid OAuth access token') });
  });

  it('Resend: the API key is the bearer and the reply address is the label the response cannot give', async () => {
    const good = probe(byType(GatewayType.EMAIL), { resend_api_key: 're_good_key', reply_from: 'agent@northwind.example' }, [
      { url: 'https://api.resend.com/api-keys', handle: () => ({ status: 200, body: { object: 'list', has_more: false, data: [{ id: 'k1', name: 'almyty' }] } }) },
    ]);
    await expect(good.run()).resolves.toMatchObject({ ok: true, accountLabel: 'agent@northwind.example' });
    expect((good.http.calls[0].init.headers as Record<string, string>)['Authorization']).toBe('Bearer re_good_key');

    const bad = probe(byType(GatewayType.EMAIL), { resend_api_key: 're_bad_key' }, [
      { url: 'https://api.resend.com/api-keys', handle: () => ({ status: 401, body: { name: 'validation_error', message: 'API key is invalid' } }) },
    ]);
    const result = await bad.run();
    expect(result).toMatchObject({ ok: false, status: 'failed' });
    expect(JSON.stringify(result)).not.toContain('re_bad_key');
  });

  it('Matrix whoami: the homeserver is interpolated and user_id is the label', async () => {
    const good = probe(byType(GatewayType.MATRIX), { homeserver_url: 'https://matrix.example.org', access_token: 'syt_good_token' }, [
      { url: 'https://matrix.example.org/', handle: () => ({ status: 200, body: { user_id: '@almyty:example.org', device_id: 'ABC' } }) },
    ]);
    await expect(good.run()).resolves.toMatchObject({ ok: true, accountLabel: '@almyty:example.org' });
    expect(good.http.calls[0].url).toBe('https://matrix.example.org/_matrix/client/v3/account/whoami');
    expect((good.http.calls[0].init.headers as Record<string, string>)['Authorization']).toBe('Bearer syt_good_token');

    const bad = probe(byType(GatewayType.MATRIX), { homeserver_url: 'https://matrix.example.org', access_token: 'syt_stale' }, [
      { url: 'https://matrix.example.org/', handle: () => ({ status: 401, body: { errcode: 'M_UNKNOWN_TOKEN', error: 'Invalid access token' } }) },
    ]);
    await expect(bad.run()).resolves.toMatchObject({ ok: false, status: 'failed', error: expect.stringContaining('M_UNKNOWN_TOKEN') });
  });

  it('Microsoft Teams: the Bot Framework client-credentials exchange, reading bot_id and bot_password', async () => {
    const tokenUrl = 'https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token';
    const config = { bot_id: 'app-id-1', bot_password: 'bot-password-secret', tenant_id: 'botframework.com' };
    const good = probe(byType(GatewayType.MICROSOFT_TEAMS), config, [
      { method: 'POST', url: tokenUrl, handle: () => ({ status: 200, body: { token_type: 'Bearer', expires_in: 3600, access_token: 'jwt' } }) },
    ]);
    await expect(good.run()).resolves.toMatchObject({ ok: true, status: 'valid', accountLabel: 'app-id-1@botframework.com', scopesGranted: ['https://api.botframework.com/.default'] });
    const sent = new URLSearchParams(String(good.http.calls[0].init.body));
    expect(Object.fromEntries(sent)).toEqual({
      grant_type: 'client_credentials',
      client_id: 'app-id-1',
      client_secret: 'bot-password-secret',
      scope: 'https://api.botframework.com/.default',
    });

    const bad = probe(byType(GatewayType.MICROSOFT_TEAMS), { ...config, tenant_id: 'contoso.onmicrosoft.com' }, [
      { method: 'POST', url: 'https://login.microsoftonline.com/contoso.onmicrosoft.com/', handle: () => ({ status: 401, body: { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.' } }) },
    ]);
    const result = await bad.run();
    expect(result).toMatchObject({ ok: false, status: 'failed', error: expect.stringContaining('AADSTS7000215') });
    expect(JSON.stringify(result)).not.toContain('bot-password-secret');
  });
});

describe('chat channels with no cheap probe', () => {
  it('Google Chat checks the incoming webhook shape and never uses the URL as the label: it carries the token', async () => {
    const connector = byType(GatewayType.GOOGLE_CHAT);
    const url = 'https://chat.googleapis.com/v1/spaces/AAAA/messages?key=k&token=tok';
    const ok = await probe(connector, { webhook_url: url, verification_token: 'vt' }, []).run();
    expect(ok).toMatchObject({ ok: true, status: 'valid' });
    expect(ok.accountLabel).toBe('Google Chat');
    expect(JSON.stringify(ok)).not.toContain('token=tok');

    const wrongHost = await probe(connector, { webhook_url: 'https://hooks.example.com/x' }, []).run();
    expect(wrongHost).toMatchObject({ ok: false, error: expect.stringContaining('webhook_url') });
  });

  it('Signal, IRC and the outbound webhook check shape only, since the endpoint is the operator own bridge', async () => {
    const signal = await probe(byType(GatewayType.SIGNAL), { api_url: 'https://signal.example.com', phone_number: '+15550001111', inbound_token: 't' }, []).run();
    expect(signal).toMatchObject({ ok: true, status: 'valid', accountLabel: '+15550001111' });
    expect(await probe(byType(GatewayType.SIGNAL), { api_url: 'https://signal.example.com', phone_number: 'not-a-number' }, []).run()).toMatchObject({ ok: false });

    const irc = await probe(byType(GatewayType.IRC), { webhook_url: 'https://bridge.example.com/out', nick: 'almyty', channel: '#ops' }, []).run();
    expect(irc).toMatchObject({ ok: true, accountLabel: 'almyty' });

    const hook = await probe(byType(GatewayType.WEBHOOK), { callback_url: 'https://hooks.example.com/almyty', secret: 'a'.repeat(24) }, []).run();
    expect(hook).toMatchObject({ ok: true, accountLabel: 'https://hooks.example.com/almyty' });
    // The SSRF guard still applies to a URL a user types.
    expect(await probe(byType(GatewayType.WEBHOOK), { callback_url: 'http://127.0.0.1:9000/x', secret: 'a'.repeat(24) }, []).run()).toMatchObject({ ok: false });
  });

  it('no probe reaches the network for a format-only channel', async () => {
    const { run, http } = probe(byType(GatewayType.IRC), { webhook_url: 'https://bridge.example.com/out' }, []);
    await run();
    expect(http.calls).toHaveLength(0);
  });
});
