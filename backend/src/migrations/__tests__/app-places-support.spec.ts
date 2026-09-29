import { GatewayType } from '../../entities/gateway.entity';
import { AppAuthMode, DistributionTarget, appSlugError, defaultLimitsFor } from '../support/app-places/app-model';
import { appSlugFromName, newAppFields, placeConfigurationFrom, targetForGatewayType } from '../support/app-places/new-app';

/**
 * The pieces an app was made from, frozen with the migrations that build
 * one (EveryChatSurfaceHasAnApp, EveryWidgetAndA2aHasAnApp).
 */
describe('new app', () => {
  describe('newAppFields', () => {
    it('fills what the caller left out the way a new app starts', () => {
      expect(newAppFields('org-1', { name: 'Support', slug: ' Support ' })).toEqual({
        organizationId: 'org-1',
        name: 'Support',
        slug: 'support',
        description: null,
        agentIds: [],
        branding: {},
        authMode: AppAuthMode.PUBLIC_LINK,
        capabilities: {},
        limits: defaultLimitsFor(AppAuthMode.PUBLIC_LINK),
        privacy: null,
        isActive: true,
      });
      expect(newAppFields('org-1', { name: 'S', slug: 'sso-app', authMode: AppAuthMode.SSO }).limits).toEqual(
        defaultLimitsFor(AppAuthMode.SSO),
      );
    });
  });

  describe('appSlugFromName', () => {
    const none = () => false;

    it.each([
      ['Support Bot', 'support-bot'],
      ['  Ünïcode   Agent!! ', 'unicode-agent'],
      ['AI', 'ai-app'],
      ['api', 'api-app'],
      ['', 'agent-app'],
      ['---', 'agent-app'],
      ['x'.repeat(80), 'x'.repeat(50)],
    ])('%j -> %s', (name, slug) => {
      expect(appSlugFromName(name, none)).toBe(slug);
      expect(appSlugError(slug)).toBeNull();
    });

    it('never returns a slug that is taken', () => {
      const taken = new Set(['support', 'support-2']);
      expect(appSlugFromName('Support', (s) => taken.has(s))).toBe('support-3');
    });
  });

  describe('targetForGatewayType', () => {
    it('maps each app surface to its place, and anything else to none', () => {
      expect(targetForGatewayType(GatewayType.HOSTED_CHAT)).toBe(DistributionTarget.WEB);
      expect(targetForGatewayType(GatewayType.SLACK)).toBe(DistributionTarget.SLACK);
      expect(targetForGatewayType(GatewayType.MICROSOFT_TEAMS)).toBe(DistributionTarget.MICROSOFT_TEAMS);
      expect(targetForGatewayType(GatewayType.CHAT_WIDGET)).toBe(DistributionTarget.WIDGET);
      expect(targetForGatewayType(GatewayType.A2A)).toBe(DistributionTarget.A2A);
      expect(targetForGatewayType(GatewayType.TOOLS)).toBeNull();
      expect(targetForGatewayType(GatewayType.ACP)).toBeNull();
    });
  });

  describe('placeConfigurationFrom', () => {
    it('carries the connection reference and the non-secret settings, never a secret value', () => {
      expect(
        placeConfigurationFrom(DistributionTarget.SMS, {
          credentialId: 'cred-1',
          credentialKeys: ['twilio_auth_token'],
          twilio_auth_token: 'encrypted:gcm:abc',
          twilio_account_sid: 'AC123',
          phone_number: '+15550100',
          aiDisclosure: true,
          appId: 'old',
        }),
      ).toEqual({
        credentialId: 'cred-1',
        credentialKeys: ['twilio_auth_token'],
        twilio_account_sid: 'AC123',
        phone_number: '+15550100',
      });
    });

    it('keeps the Slack app credentials that stand in for a bot token', () => {
      expect(placeConfigurationFrom(DistributionTarget.SLACK, { client_id: '123.456', credentialId: 'c', credentialKeys: ['client_secret'] })).toEqual({
        client_id: '123.456',
        credentialId: 'c',
        credentialKeys: ['client_secret'],
      });
    });

    it('leaves the web chat place empty: its address stays on the gateway', () => {
      expect(placeConfigurationFrom(DistributionTarget.WEB, { hostedChat: { slug: 'acme' }, allowedOrigins: ['x'] })).toEqual({});
      expect(placeConfigurationFrom(DistributionTarget.DISCORD, null)).toEqual({});
    });
  });
});
