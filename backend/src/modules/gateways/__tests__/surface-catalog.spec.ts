import { GatewayType } from '../../../entities/gateway.entity';
import {
  SURFACE_CATALOG,
  getSurface,
  humanFacingSurfaces,
  isHumanFacingSurface,
  inboundAuthStatus,
  canPublishSurface,
  SURFACE_PUBLISH_REFUSED,
} from '../surface-catalog';

describe('surface catalog', () => {
  it('covers every gateway type exactly once', () => {
    const catalogued = SURFACE_CATALOG.map((s) => s.type).sort();
    const declared = Object.values(GatewayType).sort();
    expect(catalogued).toEqual(declared);
  });

  it('gives every unavailable surface a one-line reason and every available one none', () => {
    for (const surface of SURFACE_CATALOG) {
      if (surface.available) {
        expect(surface.unavailableReason).toBeNull();
      } else {
        expect(surface.unavailableReason).toEqual(expect.any(String));
        expect(surface.unavailableReason!.length).toBeGreaterThan(0);
      }
    }
  });

  it('marks the messaging and widget surfaces a person reads as human facing', () => {
    const humanFacing = humanFacingSurfaces().map((s) => s.type);
    expect(humanFacing).toEqual(
      expect.arrayContaining([
        GatewayType.SLACK,
        GatewayType.DISCORD,
        GatewayType.TELEGRAM,
        GatewayType.WHATSAPP,
        GatewayType.WHATSAPP_CLOUD,
        GatewayType.SMS,
        GatewayType.MICROSOFT_TEAMS,
        GatewayType.EMAIL,
        GatewayType.CHAT_WIDGET,
      ]),
    );
    // Protocol surfaces are consumed by a client the operator writes,
    // so the Art. 50 obligation does not sit on our outbound message.
    expect(isHumanFacingSurface(GatewayType.MCP)).toBe(false);
    expect(isHumanFacingSurface(GatewayType.A2A)).toBe(false);
    expect(isHumanFacingSurface(GatewayType.WEBHOOK)).toBe(false);
  });

  it('resolves a surface by type and returns undefined for an unknown one', () => {
    expect(getSurface(GatewayType.SLACK)?.label).toBe('Slack');
    expect(getSurface('carrier-pigeon')).toBeUndefined();
  });

  describe('inboundAuthStatus', () => {
    it('reports verified once every required key is configured', () => {
      expect(inboundAuthStatus(GatewayType.SLACK, { signing_secret: 'shh' })).toEqual({
        verified: true,
        reason: null,
      });
    });

    it('names the missing keys when verification cannot run', () => {
      const status = inboundAuthStatus(GatewayType.SLACK, {});
      expect(status.verified).toBe(false);
      expect(status.reason).toContain('signing_secret');
    });

    it('lists both Twilio keys when neither is set', () => {
      const status = inboundAuthStatus(GatewayType.SMS, {});
      expect(status.verified).toBe(false);
      expect(status.reason).toContain('twilio_auth_token');
      expect(status.reason).toContain('webhook_url');
      expect(status.reason).toContain('are set');
    });

    it('still reports unverified when only the Twilio URL is missing', () => {
      const status = inboundAuthStatus(GatewayType.WHATSAPP, { twilio_auth_token: 't' });
      expect(status.verified).toBe(false);
      expect(status.reason).toContain('webhook_url');
      expect(status.reason).toContain('is set');
    });

    it('treats Teams as verified with no per-gateway configuration', () => {
      expect(inboundAuthStatus(GatewayType.MICROSOFT_TEAMS, {})).toEqual({
        verified: true,
        reason: null,
      });
    });

    it('refuses the bridge and bot platforms until their shared secret is set', () => {
      const cases: Array<[GatewayType, string]> = [
        [GatewayType.TELEGRAM, 'webhook_secret_token'],
        [GatewayType.SIGNAL, 'inbound_token'],
        [GatewayType.MATRIX, 'inbound_token'],
      ];
      for (const [type, key] of cases) {
        // Every one of these used to accept unsigned inbound. They now
        // refuse it, so the reason names the key that unblocks them.
        const status = inboundAuthStatus(type, { bot_token: 'x', access_token: 'x', api_url: 'x' });
        expect(status.verified).toBe(false);
        expect(status.reason).toContain(key);
        expect(status.reason).toMatch(/refused/);
      }
      expect(inboundAuthStatus(GatewayType.TELEGRAM, { webhook_secret_token: 't' }).verified).toBe(
        true,
      );
    });

    it('treats the two by-design-unauthenticated surfaces as verified', () => {
      // The widget is public on purpose and Discord's inbound is an
      // authenticated websocket, not an HTTP endpoint. Neither is a gap.
      expect(inboundAuthStatus(GatewayType.CHAT_WIDGET, {})).toEqual({
        verified: true,
        reason: null,
      });
      expect(inboundAuthStatus(GatewayType.DISCORD, {})).toEqual({
        verified: true,
        reason: null,
      });
    });

    it('blocks publishing a surface whose inbound auth cannot run', () => {
      const refused = canPublishSurface(GatewayType.SLACK, {});
      expect(refused.publishable).toBe(false);
      expect(refused.code).toBe(SURFACE_PUBLISH_REFUSED);
      expect(refused.reason).toContain('signing_secret');

      expect(canPublishSurface(GatewayType.SLACK, { signing_secret: 's' })).toEqual({
        publishable: true,
        code: null,
        reason: null,
      });
    });

    it('rejects an unknown surface type', () => {
      expect(inboundAuthStatus('carrier-pigeon', {})).toEqual({
        verified: false,
        reason: 'Unknown surface type.',
      });
    });

    it('tolerates a null configuration', () => {
      expect(inboundAuthStatus(GatewayType.SLACK, null).verified).toBe(false);
    });
  });
});
