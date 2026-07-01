import { ChannelGatewayService } from '../channel-gateway.service';
import { Gateway, GatewayType } from '../../../../entities/gateway.entity';
import { ChatWidgetAdapter } from '../adapters/chat-widget.adapter';
import { SlackAdapter } from '../adapters/slack.adapter';
import { DiscordAdapter } from '../adapters/discord.adapter';
import { TelegramAdapter } from '../adapters/telegram.adapter';
import { WhatsAppAdapter } from '../adapters/whatsapp.adapter';
import { EmailAdapter } from '../adapters/email.adapter';
import { WebhookAdapter } from '../adapters/webhook.adapter';
import { GoogleChatAdapter } from '../adapters/google-chat.adapter';
import { MicrosoftTeamsAdapter } from '../adapters/microsoft-teams.adapter';
import { SignalAdapter } from '../adapters/signal.adapter';
import { MatrixAdapter } from '../adapters/matrix.adapter';
import { IrcAdapter } from '../adapters/irc.adapter';
import { installFetchMock } from '../adapters/__tests__/test-helpers';

/**
 * Unit coverage for ChannelGatewayService.testConnection — the per-adapter
 * connectivity probe. Each channel type hits a different platform auth
 * endpoint; here we mock globalThis.fetch and assert the correct endpoint +
 * auth header are used and that the platform response is mapped to the
 * { ok, detail } shape. No network is touched.
 *
 * getAdapter() is exercised indirectly (testConnection resolves the adapter
 * before probing), so this doubles as a registry-completeness check.
 */
describe('ChannelGatewayService.testConnection', () => {
  let service: ChannelGatewayService;
  let fetchMock: ReturnType<typeof installFetchMock>;

  const gw = (type: GatewayType, configuration: Record<string, any>): Gateway =>
    ({ type, configuration } as unknown as Gateway);

  beforeEach(() => {
    // testConnection + getAdapter only use the adapter registry and fetch;
    // repositories and the runtime service are never touched, so nulls are safe.
    service = new ChannelGatewayService(
      null as any,
      null as any,
      null as any,
      null as any,
      new ChatWidgetAdapter(),
      new SlackAdapter(),
      new DiscordAdapter(),
      new TelegramAdapter(),
      new WhatsAppAdapter(),
      new EmailAdapter(),
      new WebhookAdapter(),
      new GoogleChatAdapter(),
      new MicrosoftTeamsAdapter(),
      new SignalAdapter(),
      new MatrixAdapter(),
      new IrcAdapter(),
    );
    fetchMock = installFetchMock();
  });
  afterEach(() => fetchMock.restore());

  describe('adapter registry', () => {
    it('resolves an adapter for every channel GatewayType', () => {
      const channelTypes = [
        GatewayType.SLACK,
        GatewayType.DISCORD,
        GatewayType.TELEGRAM,
        GatewayType.WHATSAPP,
        GatewayType.EMAIL,
        GatewayType.WEBHOOK,
        GatewayType.GOOGLE_CHAT,
        GatewayType.MICROSOFT_TEAMS,
        GatewayType.SIGNAL,
        GatewayType.MATRIX,
        GatewayType.IRC,
        GatewayType.CHAT_WIDGET,
      ];
      for (const t of channelTypes) {
        expect(service.getAdapter(t).type).toBe(t);
      }
    });

    it('throws for an unknown channel type', () => {
      expect(() => service.getAdapter('carrier_pigeon')).toThrow(/No adapter found/);
    });
  });

  describe('slack', () => {
    it('probes auth.test with bearer auth and maps ok=true', async () => {
      fetchMock.setNextResponse({ json: { ok: true, user: 'almytybot' } });
      const res = await service.testConnection(gw(GatewayType.SLACK, { bot_token: 'xoxb-1' }));
      expect(fetchMock.calls[0].url).toBe('https://slack.com/api/auth.test');
      expect(fetchMock.calls[0].init.headers.Authorization).toBe('Bearer xoxb-1');
      expect(res.ok).toBe(true);
      expect(res.detail).toContain('almytybot');
    });

    it('maps a slack error response to ok=false', async () => {
      fetchMock.setNextResponse({ json: { ok: false, error: 'invalid_auth' } });
      const res = await service.testConnection(gw(GatewayType.SLACK, { bot_token: 'bad' }));
      expect(res).toEqual({ ok: false, detail: 'invalid_auth' });
    });

    it('short-circuits without a bot_token (no network)', async () => {
      const res = await service.testConnection(gw(GatewayType.SLACK, {}));
      expect(fetchMock.calls.length).toBe(0);
      expect(res).toEqual({ ok: false, detail: 'bot_token not configured' });
    });
  });

  describe('telegram', () => {
    it('probes getMe and reports the bot username', async () => {
      fetchMock.setNextResponse({ json: { ok: true, result: { username: 'mybot' } } });
      const res = await service.testConnection(gw(GatewayType.TELEGRAM, { bot_token: '123:abc' }));
      expect(fetchMock.calls[0].url).toBe('https://api.telegram.org/bot123:abc/getMe');
      expect(res).toEqual({ ok: true, detail: 'bot @mybot' });
    });
  });

  describe('discord', () => {
    it('probes users/@me with Bot auth', async () => {
      fetchMock.setNextResponse({ ok: true, status: 200, json: { username: 'almyty' } });
      const res = await service.testConnection(gw(GatewayType.DISCORD, { bot_token: 'dt' }));
      expect(fetchMock.calls[0].url).toBe('https://discord.com/api/v10/users/@me');
      expect(fetchMock.calls[0].init.headers.Authorization).toBe('Bot dt');
      expect(res.ok).toBe(true);
      expect(res.detail).toContain('almyty');
    });

    it('maps a non-2xx discord response to ok=false', async () => {
      fetchMock.setNextResponse({ ok: false, status: 401, json: {} });
      const res = await service.testConnection(gw(GatewayType.DISCORD, { bot_token: 'dt' }));
      expect(res).toEqual({ ok: false, detail: 'users/@me 401' });
    });
  });

  describe('whatsapp (twilio)', () => {
    it('probes the twilio account resource with basic auth', async () => {
      fetchMock.setNextResponse({ ok: true, status: 200, json: {} });
      const res = await service.testConnection(
        gw(GatewayType.WHATSAPP, { twilio_account_sid: 'AC1', twilio_auth_token: 'tok' }),
      );
      expect(fetchMock.calls[0].url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC1.json');
      const decoded = Buffer.from(
        fetchMock.calls[0].init.headers.Authorization.replace('Basic ', ''),
        'base64',
      ).toString('utf-8');
      expect(decoded).toBe('AC1:tok');
      expect(res).toEqual({ ok: true, detail: 'twilio creds ok' });
    });

    it('requires both sid and token', async () => {
      const res = await service.testConnection(gw(GatewayType.WHATSAPP, { twilio_account_sid: 'AC1' }));
      expect(fetchMock.calls.length).toBe(0);
      expect(res.ok).toBe(false);
    });
  });

  describe('microsoft teams', () => {
    it('requests a client-credentials token and maps issuance to ok=true', async () => {
      fetchMock.setNextResponse({ json: { access_token: 'tok-123' } });
      const res = await service.testConnection(
        gw(GatewayType.MICROSOFT_TEAMS, { bot_id: 'app', bot_password: 'secret' }),
      );
      expect(fetchMock.calls[0].url).toContain('login.microsoftonline.com');
      expect(res).toEqual({ ok: true, detail: 'access token issued' });
    });

    it('maps a token failure to ok=false', async () => {
      fetchMock.setNextResponse({ json: { error_description: 'invalid client' } });
      const res = await service.testConnection(
        gw(GatewayType.MICROSOFT_TEAMS, { bot_id: 'app', bot_password: 'bad' }),
      );
      expect(res).toEqual({ ok: false, detail: 'invalid client' });
    });
  });

  describe('webhook-family (webhook / google_chat / irc)', () => {
    it('HEAD-probes the configured endpoint and maps <500 to ok=true', async () => {
      fetchMock.setNextResponse({ ok: true, status: 200, json: {} });
      const res = await service.testConnection(
        gw(GatewayType.WEBHOOK, { callback_url: 'https://hook.example/cb' }),
      );
      expect(fetchMock.calls[0].url).toBe('https://hook.example/cb');
      expect(fetchMock.calls[0].init.method).toBe('HEAD');
      expect(res).toEqual({ ok: true, detail: 'HEAD 200' });
    });

    it('reports webhook_url not configured for google_chat with no url', async () => {
      const res = await service.testConnection(gw(GatewayType.GOOGLE_CHAT, {}));
      expect(fetchMock.calls.length).toBe(0);
      expect(res).toEqual({ ok: false, detail: 'webhook_url not configured' });
    });
  });

  describe('signal', () => {
    it('probes the signal-cli /v1/about endpoint', async () => {
      fetchMock.setNextResponse({ ok: true, status: 200, json: {} });
      const res = await service.testConnection(
        gw(GatewayType.SIGNAL, { api_url: 'http://signal-cli:8080', phone_number: '+1' }),
      );
      expect(fetchMock.calls[0].url).toBe('http://signal-cli:8080/v1/about');
      expect(res).toEqual({ ok: true, detail: 'signal-cli reachable' });
    });
  });

  describe('matrix', () => {
    it('probes whoami with bearer auth', async () => {
      fetchMock.setNextResponse({ ok: true, status: 200, json: { user_id: '@bot:hs' } });
      const res = await service.testConnection(
        gw(GatewayType.MATRIX, { homeserver_url: 'https://hs', access_token: 'tok' }),
      );
      expect(fetchMock.calls[0].url).toBe('https://hs/_matrix/client/r0/account/whoami');
      expect(fetchMock.calls[0].init.headers.Authorization).toBe('Bearer tok');
      expect(res.ok).toBe(true);
      expect(res.detail).toContain('@bot:hs');
    });
  });

  describe('email (resend)', () => {
    it('probes the resend domains endpoint with bearer auth', async () => {
      fetchMock.setNextResponse({ ok: true, status: 200, json: {} });
      const res = await service.testConnection(gw(GatewayType.EMAIL, { resend_api_key: 're_1' }));
      expect(fetchMock.calls[0].url).toBe('https://api.resend.com/domains');
      expect(fetchMock.calls[0].init.headers.Authorization).toBe('Bearer re_1');
      expect(res).toEqual({ ok: true, detail: 'resend api key valid' });
    });
  });

  describe('chat_widget', () => {
    it('is always reachable and never touches the network', async () => {
      const res = await service.testConnection(gw(GatewayType.CHAT_WIDGET, {}));
      expect(fetchMock.calls.length).toBe(0);
      expect(res.ok).toBe(true);
      expect(res.detail).toContain('widget');
    });
  });

  describe('fetch failure', () => {
    it('maps a thrown fetch error to ok=false without throwing', async () => {
      (globalThis as any).fetch = jest.fn().mockRejectedValue(new Error('dns fail'));
      const res = await service.testConnection(gw(GatewayType.SLACK, { bot_token: 'x' }));
      expect(res.ok).toBe(false);
      expect(res.detail).toContain('dns fail');
    });
  });
});
