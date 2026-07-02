import { BadRequestException } from '@nestjs/common';

import { SlackInstallService, SLACK_INSTALL_SCOPES } from '../slack-install.service';
import { Gateway, GatewayType } from '../../../../entities/gateway.entity';
import { encryptField } from '../../../../common/security/field-crypto';
import { installFetchMock, parseSentForm } from '../adapters/__tests__/test-helpers';

/**
 * Slack OAuth install flow: signed-state minting/verification, the
 * authorize redirect URL, and the oauth.v2.access exchange (mocked —
 * no network) that persists an installation.
 */
describe('SlackInstallService', () => {
  let configGet: jest.Mock;
  let installations: { upsert: jest.Mock };
  let service: SlackInstallService;

  const gw = (configuration: Record<string, any> = {}): Gateway =>
    ({
      id: '11111111-2222-3333-4444-555555555555',
      name: 'Support Bot',
      type: GatewayType.SLACK,
      organizationId: 'org-1',
      configuration,
    } as unknown as Gateway);

  const installableGw = () =>
    gw({ client_id: '123.456', client_secret: encryptField('shh-secret') });

  beforeEach(() => {
    configGet = jest.fn((key: string) =>
      key === 'PUBLIC_API_URL' ? 'https://api.example.com' : undefined,
    );
    installations = {
      upsert: jest.fn(async (gateway: Gateway, input: any) => ({
        id: 'inst-1',
        gatewayId: gateway.id,
        externalTenantId: input.externalTenantId,
        status: 'active',
        metadata: input.metadata,
      })),
    };
    service = new SlackInstallService({ get: configGet } as any, installations as any);
  });

  describe('state signing', () => {
    it('round-trips a freshly minted state for the same gateway', () => {
      const state = service.createState('gw-1');
      expect(service.verifyState(state, 'gw-1')).toBe(true);
    });

    it('rejects a state minted for a different gateway', () => {
      const state = service.createState('gw-1');
      expect(service.verifyState(state, 'gw-2')).toBe(false);
    });

    it('rejects an expired state', () => {
      const past = Date.now() - 60 * 60 * 1000; // minted an hour ago
      const state = service.createState('gw-1', past);
      expect(service.verifyState(state, 'gw-1')).toBe(false);
    });

    it('rejects a tampered payload', () => {
      const state = service.createState('gw-1');
      const [payload, sig] = [state.slice(0, state.lastIndexOf('.')), state.slice(state.lastIndexOf('.') + 1)];
      const forged = Buffer.from(JSON.stringify({ g: 'gw-1', e: Date.now() + 10 ** 9, n: 'x' })).toString('base64url');
      expect(service.verifyState(`${forged}.${sig}`, 'gw-1')).toBe(false);
      expect(payload.length).toBeGreaterThan(0);
    });

    it('rejects garbage', () => {
      expect(service.verifyState('', 'gw-1')).toBe(false);
      expect(service.verifyState('no-dot-here', 'gw-1')).toBe(false);
      expect(service.verifyState('a.b', 'gw-1')).toBe(false);
    });
  });

  describe('buildAuthorizeUrl', () => {
    it('points at slack oauth v2 authorize with the bot scopes, state, and callback redirect', () => {
      const gateway = installableGw();
      const url = new URL(service.buildAuthorizeUrl(gateway));

      expect(url.origin + url.pathname).toBe('https://slack.com/oauth/v2/authorize');
      expect(url.searchParams.get('client_id')).toBe('123.456');
      expect(url.searchParams.get('scope')).toBe(SLACK_INSTALL_SCOPES);
      expect(url.searchParams.get('redirect_uri')).toBe(
        `https://api.example.com/gateways/${gateway.id}/install/slack/callback`,
      );
      expect(service.verifyState(url.searchParams.get('state') || '', gateway.id)).toBe(true);
    });

    it('throws 400 when client credentials are not configured', () => {
      expect(() => service.buildAuthorizeUrl(gw({}))).toThrow(BadRequestException);
    });
  });

  describe('isInstallable', () => {
    it('requires slack type plus client_id and client_secret', () => {
      expect(service.isInstallable(installableGw())).toBe(true);
      expect(service.isInstallable(gw({ client_id: 'x' }))).toBe(false);
      expect(service.isInstallable(gw({}))).toBe(false);
      const notSlack = { ...installableGw(), type: GatewayType.TELEGRAM } as Gateway;
      expect(service.isInstallable(notSlack)).toBe(false);
    });
  });

  describe('handleCallback', () => {
    let fetchMock: ReturnType<typeof installFetchMock>;
    beforeEach(() => {
      fetchMock = installFetchMock();
    });
    afterEach(() => fetchMock.restore());

    it('exchanges the code with the decrypted client secret and stores the installation', async () => {
      const gateway = installableGw();
      const state = service.createState(gateway.id);
      fetchMock.setNextResponse({
        json: {
          ok: true,
          access_token: 'xoxb-workspace-token',
          bot_user_id: 'U42',
          app_id: 'A99',
          scope: SLACK_INSTALL_SCOPES,
          team: { id: 'T777', name: 'Customer Co' },
        },
      });

      const installation = await service.handleCallback(gateway, 'the-code', state);

      expect(fetchMock.calls[0].url).toBe('https://slack.com/api/oauth.v2.access');
      const form = parseSentForm(fetchMock.calls[0]);
      expect(form.code).toBe('the-code');
      expect(form.client_id).toBe('123.456');
      expect(form.client_secret).toBe('shh-secret'); // decrypted for the exchange
      expect(form.redirect_uri).toBe(
        `https://api.example.com/gateways/${gateway.id}/install/slack/callback`,
      );

      expect(installations.upsert).toHaveBeenCalledWith(gateway, {
        externalTenantId: 'T777',
        credentials: { bot_token: 'xoxb-workspace-token' },
        metadata: {
          teamName: 'Customer Co',
          botUserId: 'U42',
          appId: 'A99',
          scope: SLACK_INSTALL_SCOPES,
        },
      });
      expect(installation.externalTenantId).toBe('T777');
    });

    it('rejects an invalid state before any code exchange happens', async () => {
      const gateway = installableGw();
      await expect(service.handleCallback(gateway, 'code', 'bogus.state')).rejects.toThrow(
        /Invalid or expired state/,
      );
      expect(fetchMock.calls.length).toBe(0);
      expect(installations.upsert).not.toHaveBeenCalled();
    });

    it('rejects a missing code', async () => {
      const gateway = installableGw();
      const state = service.createState(gateway.id);
      await expect(service.handleCallback(gateway, '', state)).rejects.toThrow(/Missing code/);
    });

    it('surfaces a slack error response without storing anything', async () => {
      const gateway = installableGw();
      const state = service.createState(gateway.id);
      fetchMock.setNextResponse({ json: { ok: false, error: 'invalid_code' } });

      await expect(service.handleCallback(gateway, 'bad', state)).rejects.toThrow(/invalid_code/);
      expect(installations.upsert).not.toHaveBeenCalled();
    });
  });
});
