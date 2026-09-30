import { UnifiedGatewayDelegation } from '../unified-gateway-delegation.helper';
import { IMessageSendblueAdapter } from '../channels/adapters/imessage-sendblue.adapter';
import { IMessageLoopMessageAdapter } from '../channels/adapters/imessage-loopmessage.adapter';
import { Gateway, GatewayType } from '../../../entities/gateway.entity';
import { Organization } from '../../../entities/organization.entity';
import { BY_ID, tableUpdates } from './recording-query-builder';

/**
 * The iMessage relays at the unified endpoint. Neither relay signs its
 * webhooks; each sends a shared value in a header (Sendblue's
 * `sb-signing-secret`, LoopMessage's configured `Authorization`), so
 * that value is the only thing between the public callback URL and an
 * agent run. It is checked before the pipeline sees the body, a wrong or
 * absent one is a 401, and an unconfigured one refuses everything.
 */
describe('UnifiedGatewayDelegation — iMessage relays', () => {
  const SB_SECRET = 'sb-webhook-secret-0001';
  const LOOP_TOKEN = 'loop-webhook-auth-0001';

  let delegation: UnifiedGatewayDelegation;
  let channelGatewayService: { getAdapter: jest.Mock; handleInboundMessage: jest.Mock };
  let gatewayResolver: { resolveAndAuthenticate: jest.Mock };
  let counters: any[];

  const organization = { id: 'org-1', slug: 'acme' } as Organization;

  const gateway = (type: GatewayType, configuration: Record<string, any>) =>
    ({
      id: 'gw-im-1',
      type,
      organizationId: 'org-1',
      agentId: 'agent-1',
      isSystem: false,
      configuration,
    } as unknown as Gateway);

  const sendblue = (configuration: Record<string, any> = { api_key_id: 'k', api_secret_key: 's', phone_number: '+1', signing_secret: SB_SECRET }) =>
    gateway(GatewayType.IMESSAGE_SENDBLUE, configuration);
  const loop = (configuration: Record<string, any> = { api_key: 'k', inbound_token: LOOP_TOKEN }) =>
    gateway(GatewayType.IMESSAGE_LOOPMESSAGE, configuration);

  const sendblueBody = { content: 'hi', from_number: '+19998887777', to_number: '+1', message_handle: 'H1', is_outbound: false };
  const loopBody = { event: 'message_inbound', contact: '+13231112233', text: 'hi', message_id: 'M1', webhook_id: 'W1' };

  const makeReq = (body: any, headers: Record<string, string>, method = 'POST') =>
    ({
      method,
      path: '/acme/imessage',
      headers,
      query: {},
      rawBody: Buffer.from(JSON.stringify(body)),
    }) as any;

  const makeRes = () => {
    const res: any = { statusCode: 200, setHeader: jest.fn(), end: jest.fn() };
    res.status = jest.fn().mockImplementation((code: number) => {
      res.statusCode = code;
      return res;
    });
    res.json = jest.fn().mockReturnValue(res);
    res.send = jest.fn().mockReturnValue(res);
    return res;
  };

  beforeEach(() => {
    counters = [{ id: 'gw-im-1', totalRequests: 0, successfulRequests: 0, lastRequestAt: null }];
    channelGatewayService = {
      getAdapter: jest.fn((type: string) =>
        type === GatewayType.IMESSAGE_SENDBLUE ? new IMessageSendblueAdapter() : new IMessageLoopMessageAdapter(),
      ),
      handleInboundMessage: jest.fn().mockResolvedValue(undefined),
    };
    gatewayResolver = { resolveAndAuthenticate: jest.fn().mockResolvedValue({ auth: null }) };
    delegation = new UnifiedGatewayDelegation(
      { findOne: jest.fn() } as any,
      tableUpdates(counters, BY_ID) as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      gatewayResolver as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { get: jest.fn().mockReturnValue(null) } as any,
      { check: jest.fn().mockResolvedValue({ limited: false }) } as any,
      channelGatewayService as any,
    );
  });

  const handle = (gw: Gateway, req: any, res: any, body: any) =>
    delegation.handleGatewayRequest(organization, gw, 'acme', 'imessage', req, res, body);

  it('serves both relays as channel webhooks, outside almyty API-key auth', () => {
    expect(UnifiedGatewayDelegation.CHANNEL_TYPES.has(GatewayType.IMESSAGE_SENDBLUE)).toBe(true);
    expect(UnifiedGatewayDelegation.CHANNEL_TYPES.has(GatewayType.IMESSAGE_LOOPMESSAGE)).toBe(true);
  });

  it('Sendblue: routes a delivery carrying the webhook secret into the pipeline', async () => {
    const res = makeRes();
    await handle(sendblue(), makeReq(sendblueBody, { 'sb-signing-secret': SB_SECRET }), res, sendblueBody);
    expect(channelGatewayService.handleInboundMessage).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
    expect(gatewayResolver.resolveAndAuthenticate).not.toHaveBeenCalled();
  });

  it('Sendblue: a wrong or missing secret is a 401 and never reaches the pipeline', async () => {
    await expect(handle(sendblue(), makeReq(sendblueBody, { 'sb-signing-secret': 'nope' }), makeRes(), sendblueBody)).rejects.toMatchObject({ status: 401 });
    await expect(handle(sendblue(), makeReq(sendblueBody, {}), makeRes(), sendblueBody)).rejects.toMatchObject({ status: 401 });
    expect(channelGatewayService.handleInboundMessage).not.toHaveBeenCalled();
    expect(counters[0]).toMatchObject({ totalRequests: 2, successfulRequests: 0 });
  });

  it('Sendblue: with no secret configured every delivery is refused (fail closed)', async () => {
    const unconfigured = sendblue({ api_key_id: 'k', api_secret_key: 's', phone_number: '+1' });
    await expect(handle(unconfigured, makeReq(sendblueBody, { 'sb-signing-secret': '' }), makeRes(), sendblueBody)).rejects.toMatchObject({ status: 401 });
    expect(channelGatewayService.handleInboundMessage).not.toHaveBeenCalled();
  });

  it('LoopMessage: routes a delivery carrying the configured Authorization value into the pipeline', async () => {
    const res = makeRes();
    await handle(loop(), makeReq(loopBody, { authorization: LOOP_TOKEN }), res, loopBody);
    expect(channelGatewayService.handleInboundMessage).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
    expect(gatewayResolver.resolveAndAuthenticate).not.toHaveBeenCalled();
  });

  it('LoopMessage: a wrong value, or none configured, is a 401', async () => {
    await expect(handle(loop(), makeReq(loopBody, { authorization: 'nope' }), makeRes(), loopBody)).rejects.toMatchObject({ status: 401 });
    await expect(handle(loop({ api_key: 'k' }), makeReq(loopBody, { authorization: '' }), makeRes(), loopBody)).rejects.toMatchObject({ status: 401 });
    expect(channelGatewayService.handleInboundMessage).not.toHaveBeenCalled();
  });

  it('refuses anything but a POST', async () => {
    await expect(handle(loop(), makeReq(loopBody, { authorization: LOOP_TOKEN }, 'GET'), makeRes(), loopBody)).rejects.toMatchObject({ status: 405 });
  });
});
