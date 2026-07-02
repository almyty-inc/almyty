import * as crypto from 'crypto';

import { UnifiedGatewayDelegation } from '../unified-gateway-delegation.helper';
import { WhatsAppCloudAdapter } from '../channels/adapters/whatsapp-cloud.adapter';
import { SmsAdapter } from '../channels/adapters/sms.adapter';
import { Gateway, GatewayType } from '../../../entities/gateway.entity';
import { Organization } from '../../../entities/organization.entity';

/**
 * whatsapp_cloud + sms delegation through the unified endpoint.
 * Meta's webhook verification handshake is the one channel GET the
 * endpoint accepts (echo hub.challenge iff verify_token matches);
 * inbound POSTs are signature-verified against the raw body; sms
 * gateways ride the standard Twilio POST path.
 */
describe('UnifiedGatewayDelegation — whatsapp_cloud + sms', () => {
  const APP_SECRET = 'meta-app-secret';
  const VERIFY_TOKEN = 'verify-me';

  let delegation: UnifiedGatewayDelegation;
  let channelGatewayService: {
    getAdapter: jest.Mock;
    handleInboundMessage: jest.Mock;
  };
  let gatewayResolver: { resolveAndAuthenticate: jest.Mock };

  const organization = { id: 'org-1', slug: 'acme' } as Organization;

  const cloudGateway = () =>
    ({
      id: 'gw-wac-1',
      type: GatewayType.WHATSAPP_CLOUD,
      organizationId: 'org-1',
      agentId: 'agent-1',
      isSystem: false,
      configuration: {
        access_token: 'EAAG',
        phone_number_id: 'PNID-1',
        verify_token: VERIFY_TOKEN,
        app_secret: APP_SECRET,
      },
    } as unknown as Gateway);

  const smsGateway = () =>
    ({
      id: 'gw-sms-1',
      type: GatewayType.SMS,
      organizationId: 'org-1',
      agentId: 'agent-1',
      isSystem: false,
      configuration: { twilio_account_sid: 'AC1', twilio_auth_token: 't', phone_number: '+1' },
    } as unknown as Gateway);

  const makeReq = (opts: {
    body?: any;
    rawBody?: string;
    headers?: Record<string, string>;
    method?: string;
    query?: Record<string, string>;
  }) => {
    const raw = opts.rawBody ?? JSON.stringify(opts.body ?? {});
    return {
      method: opts.method ?? 'POST',
      path: '/acme/wa-line',
      headers: opts.headers ?? {},
      query: opts.query ?? {},
      rawBody: Buffer.from(raw),
    } as any;
  };

  const makeRes = () => {
    const res: any = {
      statusCode: 200,
      setHeader: jest.fn(),
      end: jest.fn(),
    };
    res.status = jest.fn().mockImplementation((code: number) => {
      res.statusCode = code;
      return res;
    });
    res.json = jest.fn().mockReturnValue(res);
    res.send = jest.fn().mockReturnValue(res);
    return res;
  };

  beforeEach(() => {
    channelGatewayService = {
      getAdapter: jest.fn((type: string) =>
        type === GatewayType.SMS ? new SmsAdapter() : new WhatsAppCloudAdapter(),
      ),
      handleInboundMessage: jest.fn().mockResolvedValue(undefined),
    };
    gatewayResolver = {
      resolveAndAuthenticate: jest.fn().mockResolvedValue({ auth: null }),
    };

    delegation = new UnifiedGatewayDelegation(
      { findOne: jest.fn() } as any, // agent repo
      {
        createQueryBuilder: jest.fn().mockReturnValue({
          update: jest.fn().mockReturnThis(),
          set: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          execute: jest.fn().mockResolvedValue(undefined),
        }),
      } as any, // gateway repo
      {} as any, // mcp
      {} as any, // almyty mcp
      {} as any, // mcp oauth
      {} as any, // utcp
      gatewayResolver as any,
      {} as any, // a2a server
      {} as any, // a2a agent card
      {} as any, // acp server
      {} as any, // acp discovery
      { get: jest.fn().mockReturnValue(null) } as any, // config
      { check: jest.fn().mockResolvedValue({ limited: false }) } as any, // rate limit
      channelGatewayService as any,
    );
  });

  const handle = (gateway: Gateway, req: any, res: any, body: any) =>
    delegation.handleGatewayRequest(organization, gateway, 'acme', 'wa-line', req, res, body);

  describe('GET verification handshake (hub.challenge)', () => {
    it('echoes hub.challenge when the verify token matches', async () => {
      const req = makeReq({
        method: 'GET',
        query: {
          'hub.mode': 'subscribe',
          'hub.verify_token': VERIFY_TOKEN,
          'hub.challenge': '1158201444',
        },
      });
      const res = makeRes();

      await handle(cloudGateway(), req, res, {});

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.send).toHaveBeenCalledWith('1158201444');
      expect(channelGatewayService.handleInboundMessage).not.toHaveBeenCalled();
    });

    it('rejects a wrong verify token with 403', async () => {
      const req = makeReq({
        method: 'GET',
        query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '1' },
      });
      const res = makeRes();

      await expect(handle(cloudGateway(), req, res, {})).rejects.toMatchObject({ status: 403 });
      expect(res.send).not.toHaveBeenCalled();
    });

    it('does NOT open a GET exception for other channel types', async () => {
      const req = makeReq({ method: 'GET', query: { 'hub.mode': 'subscribe' } });
      const res = makeRes();

      await expect(handle(smsGateway(), req, res, {})).rejects.toMatchObject({ status: 405 });
    });
  });

  describe('inbound POST', () => {
    const inbound = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: 'PNID-1' },
                messages: [{ from: '15551234567', id: 'wamid.1', text: { body: 'hi' } }],
              },
            },
          ],
        },
      ],
    };

    const sign = (raw: string) =>
      'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(raw, 'utf-8').digest('hex');

    it('routes a correctly signed whatsapp_cloud webhook into the pipeline', async () => {
      const raw = JSON.stringify(inbound);
      const req = makeReq({
        body: inbound,
        rawBody: raw,
        headers: { 'x-hub-signature-256': sign(raw) },
      });
      const res = makeRes();

      await handle(cloudGateway(), req, res, inbound);

      expect(channelGatewayService.handleInboundMessage).toHaveBeenCalledTimes(1);
      expect(res.json).toHaveBeenCalledWith({ ok: true });
      expect(gatewayResolver.resolveAndAuthenticate).not.toHaveBeenCalled();
    });

    it('rejects an invalid X-Hub-Signature-256 with 401', async () => {
      const raw = JSON.stringify(inbound);
      const req = makeReq({
        body: inbound,
        rawBody: raw,
        headers: { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) },
      });
      const res = makeRes();

      await expect(handle(cloudGateway(), req, res, inbound)).rejects.toMatchObject({
        status: 401,
      });
      expect(channelGatewayService.handleInboundMessage).not.toHaveBeenCalled();
    });

    it('treats sms gateways as channel webhooks (no almyty API-key auth)', async () => {
      const body = { Body: 'hi', From: '+15551234567', To: '+1' };
      const req = makeReq({ body });
      const res = makeRes();

      await handle(smsGateway(), req, res, body);

      expect(channelGatewayService.handleInboundMessage).toHaveBeenCalledTimes(1);
      expect(res.json).toHaveBeenCalledWith({ ok: true });
      expect(gatewayResolver.resolveAndAuthenticate).not.toHaveBeenCalled();
    });
  });
});
