import { Logger } from '@nestjs/common';
import { ChannelWebhookRegistrar } from '../channel-webhook-registrar.service';
import { Gateway, GatewayStatus, GatewayType } from '../../../../entities/gateway.entity';
import { installFetchMock, parseSentForm } from '../adapters/__tests__/test-helpers';

/**
 * Platform webhook auto-registration on deploy. All platform HTTP is
 * mocked; assertions cover the exact URLs called (telegram setWebhook/
 * deleteWebhook, twilio number lookup + SmsUrl update), the computed
 * public URL (<PUBLIC_API_URL>/<orgSlug><endpoint>), the skip path
 * when PUBLIC_API_URL is missing, and the outcome recording on the
 * gateway row + channel-event log.
 */
describe('ChannelWebhookRegistrar', () => {
  const PUBLIC_API_URL = 'https://api.almyty.example';

  let registrar: ChannelWebhookRegistrar;
  let gatewayRepository: { update: jest.Mock };
  let organizationRepository: { findOne: jest.Mock };
  let eventRepository: { create: jest.Mock; save: jest.Mock };
  let configService: { get: jest.Mock };
  let fetchMock: ReturnType<typeof installFetchMock>;

  const makeGateway = (over: Partial<Gateway> = {}): Gateway =>
    ({
      id: 'gw-1',
      type: GatewayType.TELEGRAM,
      status: GatewayStatus.ACTIVE,
      organizationId: 'org-1',
      endpoint: '/support-bot',
      configuration: { bot_token: 'tg-token' },
      metadata: null,
      ...over,
    } as unknown as Gateway);

  beforeEach(() => {
    gatewayRepository = { update: jest.fn().mockResolvedValue(undefined) };
    organizationRepository = {
      findOne: jest.fn().mockResolvedValue({ id: 'org-1', slug: 'acme' }),
    };
    eventRepository = {
      create: jest.fn((e) => e),
      save: jest.fn().mockResolvedValue(undefined),
    };
    configService = { get: jest.fn().mockReturnValue(PUBLIC_API_URL) };
    registrar = new ChannelWebhookRegistrar(
      gatewayRepository as any,
      organizationRepository as any,
      eventRepository as any,
      configService as any,
    );
    fetchMock = installFetchMock();
  });
  afterEach(() => fetchMock.restore());

  describe('telegram', () => {
    it('calls setWebhook with the public unified-endpoint URL on deploy', async () => {
      fetchMock.setNextResponse({ json: { ok: true } });
      await registrar.sync(makeGateway());

      expect(fetchMock.calls).toHaveLength(1);
      // Telegram has no payload signature, so registration also mints a
      // secret_token that Telegram echoes back on every update. Without
      // it the adapter refuses inbound, so the two must be set together.
      const url = new URL(fetchMock.calls[0].url);
      expect(url.origin + url.pathname).toBe('https://api.telegram.org/bottg-token/setWebhook');
      expect(url.searchParams.get('url')).toBe('https://api.almyty.example/acme/support-bot');
      const secretToken = url.searchParams.get('secret_token');
      expect(secretToken).toMatch(/^[0-9a-f]{64}$/);

      // Persisted only after Telegram accepted it, so we never end up
      // checking a token Telegram is not sending.
      const persisted = gatewayRepository.update.mock.calls
        .map((call: any[]) => call[1]?.configuration)
        .find((configuration: any) => configuration?.webhook_secret_token);
      expect(persisted?.webhook_secret_token).toBe(secretToken);

      // Outcome recorded on the gateway row...
      // persistConfig now also writes the secret token, so the metadata
      // update is no longer guaranteed to be the first call.
      const meta = gatewayRepository.update.mock.calls
        .map((call: any[]) => call[1]?.metadata?.webhookRegistration)
        .find(Boolean);
      expect(meta.status).toBe('registered');
      expect(meta.url).toBe('https://api.almyty.example/acme/support-bot');
      // ...and in the channel-event log.
      expect(eventRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          gatewayId: 'gw-1',
          direction: 'outbound',
          status: 'processed',
          payload: expect.objectContaining({ kind: 'webhook_registration', action: 'register' }),
        }),
      );
    });

    it('calls deleteWebhook when the gateway is deactivated', async () => {
      fetchMock.setNextResponse({ json: { ok: true } });
      await registrar.sync(makeGateway({ status: GatewayStatus.INACTIVE }));

      expect(fetchMock.calls).toHaveLength(1);
      expect(fetchMock.calls[0].url).toBe('https://api.telegram.org/bottg-token/deleteWebhook');
      // persistConfig now also writes the secret token, so the metadata
      // update is no longer guaranteed to be the first call.
      const meta = gatewayRepository.update.mock.calls
        .map((call: any[]) => call[1]?.metadata?.webhookRegistration)
        .find(Boolean);
      expect(meta.status).toBe('unregistered');
    });

    it('calls deleteWebhook on remove() (gateway deleted) without touching the row', async () => {
      fetchMock.setNextResponse({ json: { ok: true } });
      await registrar.remove(makeGateway());

      expect(fetchMock.calls[0].url).toContain('/deleteWebhook');
      expect(gatewayRepository.update).not.toHaveBeenCalled();
    });

    it('records a failure when telegram rejects the webhook', async () => {
      fetchMock.setNextResponse({ json: { ok: false, description: 'bad webhook url' } });
      await registrar.sync(makeGateway());

      // persistConfig now also writes the secret token, so the metadata
      // update is no longer guaranteed to be the first call.
      const meta = gatewayRepository.update.mock.calls
        .map((call: any[]) => call[1]?.metadata?.webhookRegistration)
        .find(Boolean);
      expect(meta.status).toBe('failed');
      expect(meta.error).toContain('bad webhook url');
      expect(eventRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'failed' }),
      );
    });
  });

  describe('twilio (whatsapp + sms)', () => {
    const twilioGateway = (type: GatewayType) =>
      makeGateway({
        type,
        endpoint: '/sms-line',
        configuration: {
          twilio_account_sid: 'AC_TEST',
          twilio_auth_token: 'auth',
          phone_number: '+15559999999',
        },
      } as Partial<Gateway>);

    beforeEach(() => {
      // First call: number lookup; second: webhook update.
      fetchMock.setNextResponse({ json: { incoming_phone_numbers: [{ sid: 'PN123' }] } });
    });

    it.each([[GatewayType.SMS], [GatewayType.WHATSAPP]])(
      'looks up the %s number and points SmsUrl at the public URL',
      async (type) => {
        await registrar.sync(twilioGateway(type));

        expect(fetchMock.calls[0].url).toBe(
          'https://api.twilio.com/2010-04-01/Accounts/AC_TEST/IncomingPhoneNumbers.json?PhoneNumber=%2B15559999999',
        );
        expect(fetchMock.calls[1].url).toBe(
          'https://api.twilio.com/2010-04-01/Accounts/AC_TEST/IncomingPhoneNumbers/PN123.json',
        );
        const form = parseSentForm(fetchMock.calls[1]);
        expect(form.SmsUrl).toBe('https://api.almyty.example/acme/sms-line');
        expect(form.SmsMethod).toBe('POST');
      },
    );

    it('persists the registered URL as configuration.webhook_url (signature verification)', async () => {
      await registrar.sync(twilioGateway(GatewayType.SMS));

      const configUpdate = gatewayRepository.update.mock.calls.find(
        (c) => c[1].configuration,
      );
      expect(configUpdate[1].configuration.webhook_url).toBe(
        'https://api.almyty.example/acme/sms-line',
      );
    });

    it('clears SmsUrl on deactivate', async () => {
      await registrar.sync(
        { ...twilioGateway(GatewayType.SMS), status: GatewayStatus.INACTIVE } as Gateway,
      );
      const form = parseSentForm(fetchMock.calls[1]);
      expect(form.SmsUrl).toBe('');
    });

    it('records a failure when the number is not on the account', async () => {
      fetchMock.setNextResponse({ json: { incoming_phone_numbers: [] } });
      await registrar.sync(twilioGateway(GatewayType.SMS));

      // persistConfig now also writes the secret token, so the metadata
      // update is no longer guaranteed to be the first call.
      const meta = gatewayRepository.update.mock.calls
        .map((call: any[]) => call[1]?.metadata?.webhookRegistration)
        .find(Boolean);
      expect(meta.status).toBe('failed');
      expect(meta.error).toContain('not found');
    });
  });

  /**
   * Sendblue documents its webhooks as an account API
   * (https://docs.sendblue.com/api/resources/webhooks/methods/create/,
   * .../list/, .../delete/): GET/POST/DELETE /api/account/webhooks with
   * the two key headers. Faked here per method, with the documented
   * answers.
   */
  describe('sendblue (imessage)', () => {
    const SECRET = 'sb-webhook-secret-0001';
    const API_SECRET = 'sb-api-secret-key-xyz';
    const sendblueGateway = (over: Partial<Gateway> = {}) =>
      makeGateway({
        type: GatewayType.IMESSAGE_SENDBLUE,
        endpoint: '/channels/ch-imsg',
        configuration: {
          api_key_id: 'sb-key-id',
          api_secret_key: API_SECRET,
          phone_number: '+15122164639',
          signing_secret: SECRET,
        },
        ...over,
      } as Partial<Gateway>);

    let calls: Array<{ method: string; url: string; headers: any; body: any }>;
    let registered: string[];
    let refuse: { method: string; status: number; body: any } | null;

    beforeEach(() => {
      calls = [];
      registered = [];
      refuse = null;
      (globalThis as any).fetch = jest.fn(async (url: string, init: any = {}) => {
        const method = init.method ?? 'GET';
        const body = init.body ? JSON.parse(init.body) : undefined;
        calls.push({ method, url, headers: init.headers, body });
        const json = (status: number, payload: any) => ({ ok: status < 300, status, json: async () => payload });
        if (refuse && refuse.method === method) return json(refuse.status, refuse.body);
        if (method === 'GET') return json(200, { status: 'OK', webhooks: { receive: registered.map((u) => ({ url: u, secret: 'old' })), outbound: [] } });
        if (method === 'POST') {
          registered.push(...body.webhooks.map((w: any) => (typeof w === 'string' ? w : w.url)));
          return json(200, { message: 'Webhooks added successfully', status: 'OK' });
        }
        if (method === 'DELETE') {
          registered = registered.filter((u) => !body.webhooks.includes(u));
          return json(200, { message: 'Webhooks deleted successfully', status: 'OK' });
        }
        return json(405, {});
      });
    });

    const lastRegistration = () =>
      gatewayRepository.update.mock.calls
        .map((call: any[]) => call[1]?.metadata?.webhookRegistration)
        .filter(Boolean)
        .pop();

    it('is registrable; LoopMessage is not (it documents no webhook API)', () => {
      expect(ChannelWebhookRegistrar.isRegistrable(GatewayType.IMESSAGE_SENDBLUE)).toBe(true);
      expect(ChannelWebhookRegistrar.isRegistrable(GatewayType.IMESSAGE_LOOPMESSAGE)).toBe(false);
    });

    it('on publish, adds a receive webhook with the channel secret, scoped to its line', async () => {
      await registrar.sync(sendblueGateway());

      expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
        'GET https://api.sendblue.co/api/account/webhooks',
        'POST https://api.sendblue.co/api/account/webhooks',
      ]);
      expect(calls[1].headers).toMatchObject({ 'sb-api-key-id': 'sb-key-id', 'sb-api-secret-key': API_SECRET });
      expect(calls[1].body).toEqual({
        webhooks: [{ url: 'https://api.almyty.example/acme/channels/ch-imsg', secret: SECRET, sendblue_numbers: ['+15122164639'] }],
        type: 'receive',
      });
      expect(lastRegistration()).toMatchObject({ action: 'register', status: 'registered', url: 'https://api.almyty.example/acme/channels/ch-imsg', error: null });
    });

    it('republishing replaces the webhook rather than adding a second one (Sendblue appends)', async () => {
      await registrar.sync(sendblueGateway());
      await registrar.sync(sendblueGateway());

      expect(calls.map((c) => c.method)).toEqual(['GET', 'POST', 'GET', 'DELETE', 'POST']);
      expect(calls[3].body).toEqual({ webhooks: ['https://api.almyty.example/acme/channels/ch-imsg'], type: 'receive' });
      expect(registered).toEqual(['https://api.almyty.example/acme/channels/ch-imsg']);
    });

    it('on unpublish, deletes the webhook it registered', async () => {
      await registrar.sync(sendblueGateway());
      const url = lastRegistration().url;
      calls.length = 0;

      await registrar.sync(sendblueGateway({ status: GatewayStatus.INACTIVE, metadata: { webhookRegistration: { status: 'registered', url } } } as any));

      expect(calls.map((c) => c.method)).toEqual(['GET', 'DELETE']);
      expect(calls[1].body).toEqual({ webhooks: [url], type: 'receive' });
      expect(registered).toEqual([]);
      expect(lastRegistration()).toMatchObject({ action: 'unregister', status: 'unregistered' });
    });

    it('on delete, deletes the webhook without writing to the row being deleted', async () => {
      registered = ['https://api.almyty.example/acme/channels/ch-imsg'];
      await registrar.remove(sendblueGateway());

      expect(calls.map((c) => c.method)).toEqual(['GET', 'DELETE']);
      expect(registered).toEqual([]);
      expect(gatewayRepository.update).not.toHaveBeenCalled();
    });

    it('records Sendblue\'s refusal on the gateway, where the channel page reads it, and never a secret', async () => {
      refuse = { method: 'POST', status: 401, body: { status: 'ERROR', message: 'Invalid API credentials' } };
      const logged: string[] = [];
      const spies = (['log', 'warn', 'error'] as const).map((level) =>
        jest.spyOn(Logger.prototype, level).mockImplementation((...args: any[]) => {
          logged.push(args.map(String).join(' '));
        }),
      );

      await expect(registrar.sync(sendblueGateway())).resolves.toBeUndefined();

      const meta = lastRegistration();
      expect(meta.status).toBe('failed');
      expect(meta.error).toBe('Sendblue refused adding the webhook: Invalid API credentials');
      expect(eventRepository.save).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', errorMessage: meta.error }));
      const everything = JSON.stringify([logged, gatewayRepository.update.mock.calls, eventRepository.save.mock.calls]);
      expect(everything).not.toContain(SECRET);
      expect(everything).not.toContain(API_SECRET);
      spies.forEach((spy) => spy.mockRestore());
    });

    it('fails without calling out when the keys, the line or the webhook secret are missing', async () => {
      await registrar.sync(sendblueGateway({ configuration: { api_key_id: 'k', api_secret_key: API_SECRET, phone_number: '+15122164639' } } as any));
      expect(calls).toHaveLength(0);
      expect(lastRegistration()).toMatchObject({ status: 'failed', error: 'api_key_id, api_secret_key, phone_number and signing_secret are required' });
    });
  });

  describe('skip + scope semantics', () => {
    it('skips with a warning when PUBLIC_API_URL is not configured', async () => {
      configService.get.mockReturnValue(undefined);
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      await registrar.sync(makeGateway());

      expect(fetchMock.calls).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('PUBLIC_API_URL'));
      // persistConfig now also writes the secret token, so the metadata
      // update is no longer guaranteed to be the first call.
      const meta = gatewayRepository.update.mock.calls
        .map((call: any[]) => call[1]?.metadata?.webhookRegistration)
        .find(Boolean);
      expect(meta.status).toBe('skipped');
      warnSpy.mockRestore();
    });

    it('ignores channel types without a registration API (slack, discord, widget)', async () => {
      await registrar.sync(makeGateway({ type: GatewayType.SLACK } as Partial<Gateway>));
      await registrar.sync(makeGateway({ type: GatewayType.DISCORD } as Partial<Gateway>));
      await registrar.sync(makeGateway({ type: GatewayType.CHAT_WIDGET } as Partial<Gateway>));
      expect(fetchMock.calls).toHaveLength(0);
      expect(gatewayRepository.update).not.toHaveBeenCalled();
    });

    it('never throws, even when the platform call blows up', async () => {
      (globalThis as any).fetch = jest.fn().mockRejectedValue(new Error('network down'));
      await expect(registrar.sync(makeGateway())).resolves.toBeUndefined();
      // persistConfig now also writes the secret token, so the metadata
      // update is no longer guaranteed to be the first call.
      const meta = gatewayRepository.update.mock.calls
        .map((call: any[]) => call[1]?.metadata?.webhookRegistration)
        .find(Boolean);
      expect(meta.status).toBe('failed');
    });
  });
});
