import * as crypto from 'crypto';
import { HttpException } from '@nestjs/common';

import { UnifiedGatewayDelegation } from '../unified-gateway-delegation.helper';
import { SlackAdapter } from '../channels/adapters/slack.adapter';
import { Gateway, GatewayType } from '../../../entities/gateway.entity';
import { Organization } from '../../../entities/organization.entity';

/**
 * Channel-webhook delegation through the unified endpoint
 * (/:orgSlug/:resourceSlug). Platform webhooks (Slack events here)
 * must reach the same verify -> normalize -> dispatch pipeline as the
 * channel layer, with the raw body preserved for signature checks,
 * and must NOT be forced through almyty API-key auth. Non-channel
 * gateway types keep their existing behavior.
 */
describe('UnifiedGatewayDelegation — channel webhooks', () => {
  const SIGNING_SECRET = 'test-signing-secret';

  let delegation: UnifiedGatewayDelegation;
  let channelGatewayService: {
    getAdapter: jest.Mock;
    handleInboundMessage: jest.Mock;
  };
  let gatewayResolver: { resolveAndAuthenticate: jest.Mock };
  let mcpService: { handleJsonRpc: jest.Mock };
  let gatewayRepository: any;

  const organization = { id: 'org-1', slug: 'acme' } as Organization;

  const slackGateway = () =>
    ({
      id: 'gw-slack-1',
      type: GatewayType.SLACK,
      organizationId: 'org-1',
      agentId: 'agent-1',
      isSystem: false,
      configuration: { signing_secret: SIGNING_SECRET, bot_token: 'xoxb-1' },
    } as unknown as Gateway);

  const mcpGateway = () =>
    ({
      id: 'gw-mcp-1',
      type: GatewayType.MCP,
      organizationId: 'org-1',
      isSystem: false,
      configuration: {},
    } as unknown as Gateway);

  const sign = (raw: string, timestamp: string) =>
    'v0=' + crypto.createHmac('sha256', SIGNING_SECRET).update(`v0:${timestamp}:${raw}`).digest('hex');

  const makeReq = (opts: {
    body?: any;
    rawBody?: string;
    headers?: Record<string, string>;
    method?: string;
    path?: string;
  }) => {
    const raw = opts.rawBody ?? JSON.stringify(opts.body ?? {});
    return {
      method: opts.method ?? 'POST',
      path: opts.path ?? '/acme/slack-bot',
      headers: opts.headers ?? {},
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
    return res;
  };

  beforeEach(() => {
    gatewayRepository = {
      createQueryBuilder: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue(undefined),
      }),
    };
    channelGatewayService = {
      getAdapter: jest.fn().mockReturnValue(new SlackAdapter()),
      handleInboundMessage: jest.fn().mockResolvedValue(undefined),
    };
    gatewayResolver = {
      resolveAndAuthenticate: jest.fn().mockResolvedValue({ auth: { userId: 'u-1' } }),
    };
    mcpService = { handleJsonRpc: jest.fn().mockResolvedValue({ jsonrpc: '2.0', result: {} }) };

    delegation = new UnifiedGatewayDelegation(
      { findOne: jest.fn() } as any, // agent repo
      gatewayRepository, // gateway repo
      mcpService as any,
      { handleJsonRpc: jest.fn() } as any, // almyty mcp
      { validateAccessToken: jest.fn() } as any, // mcp oauth
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
    delegation.handleGatewayRequest(organization, gateway, 'acme', 'slack-bot', req, res, body);

  it('routes a signed slack event into the channel inbound pipeline', async () => {
    const body = {
      type: 'event_callback',
      event: { type: 'message', text: 'hi', user: 'U1', channel: 'C1', ts: '1.2' },
    };
    const raw = JSON.stringify(body);
    const ts = '1720000000';
    const req = makeReq({
      body,
      rawBody: raw,
      headers: { 'x-slack-request-timestamp': ts, 'x-slack-signature': sign(raw, ts) },
    });
    const res = makeRes();

    await handle(slackGateway(), req, res, body);

    expect(channelGatewayService.handleInboundMessage).toHaveBeenCalledTimes(1);
    const [gwArg, bodyArg, headersArg, rawArg] =
      channelGatewayService.handleInboundMessage.mock.calls[0];
    expect(gwArg.id).toBe('gw-slack-1');
    expect(bodyArg).toEqual(body);
    expect(headersArg['x-slack-signature']).toBe(sign(raw, ts));
    expect(rawArg).toBe(raw);

    expect(res.json).toHaveBeenCalledWith({ ok: true });
    // Platform webhooks are authenticated by signature, not API keys.
    expect(gatewayResolver.resolveAndAuthenticate).not.toHaveBeenCalled();
  });

  it('verifies the signature against the raw body bytes, not a re-serialization', async () => {
    // Raw wire bytes with whitespace — JSON.stringify(parsed) would differ,
    // so verification only passes if the raw body is used.
    const raw = '{ "type": "event_callback",  "event": { "text": "spaced", "user": "U1" } }';
    const body = JSON.parse(raw);
    const ts = '1720000001';
    const req = makeReq({
      body,
      rawBody: raw,
      headers: { 'x-slack-request-timestamp': ts, 'x-slack-signature': sign(raw, ts) },
    });
    const res = makeRes();

    await handle(slackGateway(), req, res, body);

    expect(channelGatewayService.handleInboundMessage).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it('rejects an invalid signature with 401 and never reaches the pipeline', async () => {
    const body = { type: 'event_callback', event: { text: 'forged' } };
    const raw = JSON.stringify(body);
    const ts = '1720000002';
    const req = makeReq({
      body,
      rawBody: raw,
      headers: {
        'x-slack-request-timestamp': ts,
        'x-slack-signature': 'v0=' + '0'.repeat(64),
      },
    });
    const res = makeRes();

    await expect(handle(slackGateway(), req, res, body)).rejects.toMatchObject({
      status: 401,
    });
    expect(channelGatewayService.handleInboundMessage).not.toHaveBeenCalled();
  });

  it('rejects a request missing signature headers', async () => {
    const body = { type: 'event_callback', event: { text: 'no sig' } };
    const req = makeReq({ body });
    const res = makeRes();

    await expect(handle(slackGateway(), req, res, body)).rejects.toBeInstanceOf(HttpException);
    expect(channelGatewayService.handleInboundMessage).not.toHaveBeenCalled();
  });

  it('answers the slack url_verification handshake synchronously', async () => {
    const body = { type: 'url_verification', challenge: 'challenge-token-42' };
    const raw = JSON.stringify(body);
    const ts = '1720000003';
    const req = makeReq({
      body,
      rawBody: raw,
      headers: { 'x-slack-request-timestamp': ts, 'x-slack-signature': sign(raw, ts) },
    });
    const res = makeRes();

    await handle(slackGateway(), req, res, body);

    expect(res.json).toHaveBeenCalledWith({ challenge: 'challenge-token-42' });
    expect(channelGatewayService.handleInboundMessage).not.toHaveBeenCalled();
  });

  it('rejects non-POST methods on channel gateways', async () => {
    const req = makeReq({ body: {}, method: 'GET' });
    const res = makeRes();

    await expect(handle(slackGateway(), req, res, {})).rejects.toMatchObject({ status: 405 });
    expect(channelGatewayService.handleInboundMessage).not.toHaveBeenCalled();
  });

  it('leaves non-channel gateways on the existing auth + protocol path', async () => {
    const body = { jsonrpc: '2.0', method: 'tools/list', id: 1 };
    const req = makeReq({ body });
    const res = makeRes();

    await handle(mcpGateway(), req, res, body);

    expect(gatewayResolver.resolveAndAuthenticate).toHaveBeenCalledTimes(1);
    expect(mcpService.handleJsonRpc).toHaveBeenCalledWith(body, 'org-1', null, 'gw-mcp-1');
    expect(channelGatewayService.getAdapter).not.toHaveBeenCalled();
    expect(channelGatewayService.handleInboundMessage).not.toHaveBeenCalled();
  });
});
