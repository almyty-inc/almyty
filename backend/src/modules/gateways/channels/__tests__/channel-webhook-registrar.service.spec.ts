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
      expect(fetchMock.calls[0].url).toBe(
        `https://api.telegram.org/bottg-token/setWebhook?url=${encodeURIComponent(
          'https://api.almyty.example/acme/support-bot',
        )}`,
      );

      // Outcome recorded on the gateway row...
      const meta = gatewayRepository.update.mock.calls[0][1].metadata.webhookRegistration;
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
      const meta = gatewayRepository.update.mock.calls[0][1].metadata.webhookRegistration;
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

      const meta = gatewayRepository.update.mock.calls[0][1].metadata.webhookRegistration;
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

      const meta = gatewayRepository.update.mock.calls[0][1].metadata.webhookRegistration;
      expect(meta.status).toBe('failed');
      expect(meta.error).toContain('not found');
    });
  });

  describe('skip + scope semantics', () => {
    it('skips with a warning when PUBLIC_API_URL is not configured', async () => {
      configService.get.mockReturnValue(undefined);
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      await registrar.sync(makeGateway());

      expect(fetchMock.calls).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('PUBLIC_API_URL'));
      const meta = gatewayRepository.update.mock.calls[0][1].metadata.webhookRegistration;
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
      const meta = gatewayRepository.update.mock.calls[0][1].metadata.webhookRegistration;
      expect(meta.status).toBe('failed');
    });
  });
});
