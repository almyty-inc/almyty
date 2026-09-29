import { ChannelType, VisitorAuthMode } from '../../../entities/agent-channel.entity';
import { GatewayType } from '../../../entities/gateway.entity';
import {
  GATEWAY_TYPE_FOR_CHANNEL,
  REQUIRED_CREDENTIALS,
  channelTypeForGatewayType,
  checkPublish,
  endpointFor,
  gatewayConfigurationFor,
  gatewayNameFor,
  missingCredentials,
  rateLimitFor,
  servesOverGateway,
} from '../channel-publish';

const slackCreds = { bot_token: 'xoxb-1', signing_secret: 's3cret' };
const autonomous = { mode: 'autonomous', visibility: 'org' };

describe('GATEWAY_TYPE_FOR_CHANNEL', () => {
  it('maps every channel type, so none is silently unpublishable', () => {
    for (const type of Object.values(ChannelType)) expect(GATEWAY_TYPE_FOR_CHANNEL).toHaveProperty(type);
  });

  it('serves the web chat as a hosted chat, the widget as a chat widget, and A2A as A2A', () => {
    expect(GATEWAY_TYPE_FOR_CHANNEL[ChannelType.WEB]).toBe(GatewayType.HOSTED_CHAT);
    expect(GATEWAY_TYPE_FOR_CHANNEL[ChannelType.WIDGET]).toBe(GatewayType.CHAT_WIDGET);
    expect(GATEWAY_TYPE_FOR_CHANNEL[ChannelType.A2A]).toBe(GatewayType.A2A);
  });

  it('has nothing to stand up for the downloads', () => {
    for (const type of [ChannelType.TUI, ChannelType.DESKTOP, ChannelType.BINARY]) expect(servesOverGateway(type)).toBe(false);
  });

  it('serves every messaging platform over a gateway, and maps back', () => {
    for (const type of [ChannelType.SLACK, ChannelType.DISCORD, ChannelType.TELEGRAM, ChannelType.WHATSAPP, ChannelType.EMAIL, ChannelType.IRC]) {
      expect(servesOverGateway(type)).toBe(true);
      expect(channelTypeForGatewayType(GATEWAY_TYPE_FOR_CHANNEL[type]!)).toBe(type);
    }
    expect(channelTypeForGatewayType(GatewayType.MCP)).toBeNull();
  });
});

describe('REQUIRED_CREDENTIALS', () => {
  it('names a requirement for every channel type', () => {
    for (const type of Object.values(ChannelType)) expect(REQUIRED_CREDENTIALS).toHaveProperty(type);
  });

  it('asks nothing of the channels we host ourselves', () => {
    for (const type of [ChannelType.WEB, ChannelType.WIDGET, ChannelType.A2A, ChannelType.TUI]) {
      expect(REQUIRED_CREDENTIALS[type]).toEqual([]);
    }
  });

  it('matches what the Slack adapter actually reads', () => {
    expect(REQUIRED_CREDENTIALS[ChannelType.SLACK]).toEqual(['bot_token', 'signing_secret']);
  });
});

describe('missingCredentials', () => {
  it('lists what is absent, treating a blank string as missing', () => {
    expect(missingCredentials(ChannelType.SLACK, { bot_token: 'xoxb-1' })).toEqual(['signing_secret']);
    expect(missingCredentials(ChannelType.TELEGRAM, { bot_token: '   ' })).toEqual(['bot_token']);
    expect(missingCredentials(ChannelType.SLACK, null)).toEqual(['bot_token', 'signing_secret']);
    expect(missingCredentials(ChannelType.SLACK, slackCreds)).toEqual([]);
  });

  it('counts a key the channel credential holds as present', () => {
    expect(missingCredentials(ChannelType.SLACK, { credentialId: 'c-1', credentialKeys: ['bot_token', 'signing_secret'] })).toEqual([]);
  });

  it('takes the Slack app client id and secret in place of a bot token, for Add to Slack only', () => {
    expect(missingCredentials(ChannelType.SLACK, { client_id: '123.456', signing_secret: 's', credentialKeys: ['client_secret'] })).toEqual([]);
    expect(missingCredentials(ChannelType.SLACK, { client_id: '123.456', signing_secret: 's' })).toEqual(['bot_token']);
    expect(missingCredentials(ChannelType.DISCORD, { client_id: '1', client_secret: 'x' })).toEqual(['bot_token']);
  });
});

describe('checkPublish', () => {
  it('lets a conversational agent go live', () => {
    expect(checkPublish(ChannelType.SLACK, autonomous).ok).toBe(true);
    expect(checkPublish(ChannelType.WIDGET, autonomous).ok).toBe(true);
    expect(checkPublish(ChannelType.A2A, autonomous).ok).toBe(true);
  });

  it('refuses a workflow agent, which the runtime rejects at the first message', () => {
    for (const type of [ChannelType.SLACK, ChannelType.A2A, ChannelType.WEB]) {
      expect(checkPublish(type, { mode: 'workflow' }).refusals.map((r) => r.code)).toEqual(['AGENT_NOT_CONVERSATIONAL']);
    }
  });

  it('refuses an agent private to its owner', () => {
    expect(checkPublish(ChannelType.WEB, { mode: 'autonomous', visibility: 'private' }).refusals.map((r) => r.code)).toEqual([
      'AGENT_PRIVATE',
    ]);
  });

  it('refuses a download, which has nothing to publish, without asking about the agent', () => {
    expect(checkPublish(ChannelType.TUI, { mode: 'workflow' }).refusals.map((r) => r.code)).toEqual(['NOT_SERVED']);
  });
});

describe('endpointFor and gatewayNameFor', () => {
  it('addresses a channel by its own id, so two channels never collide', () => {
    expect(endpointFor({ id: 'c-1' })).toBe('/channels/c-1');
    expect(endpointFor({ id: 'c-1' })).not.toBe(endpointFor({ id: 'c-2' }));
  });

  it('names the gateway after the agent and the channel type', () => {
    expect(gatewayNameFor('Support agent', ChannelType.SLACK)).toBe('Support agent (slack)');
  });
});

describe('rateLimitFor', () => {
  it('carries the limits onto the gateway as per-visitor and per-address ceilings, never one shared bucket', () => {
    const limit = rateLimitFor({ perUserRateLimit: 120, perIpRateLimit: 60 });
    expect(limit).toEqual({ enabled: false, perVisitorPerHour: 120, perIpPerHour: 60 });
    expect(limit).not.toHaveProperty('requestsPerHour');
  });

  it('sets only the ceilings there are, and nothing without limits', () => {
    expect(rateLimitFor({ perUserRateLimit: 600 })).toEqual({ enabled: false, perVisitorPerHour: 600 });
    expect(rateLimitFor({})).toEqual({ enabled: false });
  });

  it('keeps a surface ceiling for messaging channels and A2A, and shares the widget per visitor like the web chat', () => {
    const limits = { perUserRateLimit: 10, perIpRateLimit: 90 };
    expect(rateLimitFor(limits, ChannelType.SLACK)).toEqual({
      enabled: true,
      requestsPerHour: 90,
      requestsPerMinute: 2,
      perVisitorPerHour: 10,
      perIpPerHour: 90,
    });
    expect(rateLimitFor(limits, ChannelType.A2A)).toMatchObject({ enabled: true, requestsPerHour: 90 });
    expect(rateLimitFor(limits, ChannelType.WIDGET)).toEqual(rateLimitFor(limits, ChannelType.WEB));
  });
});

describe('gatewayConfigurationFor', () => {
  const channel = (over: any = {}) => ({ id: 'c-1', type: ChannelType.SLACK, slug: null, configuration: slackCreds, ...over });

  it('keeps the platform settings and records the channel and who may use it', () => {
    expect(gatewayConfigurationFor(channel(), VisitorAuthMode.PUBLIC_LINK)).toEqual({
      ...slackCreds,
      authMode: 'public_link',
      channelId: 'c-1',
    });
  });

  it('keeps branding and download-only settings off the gateway', () => {
    const config = gatewayConfigurationFor(
      channel({ configuration: { ...slackCreds, branding: { appName: 'stale' }, capabilities: { shell: true }, bundleId: 'x.y' } }),
      VisitorAuthMode.PUBLIC_LINK,
    );
    expect(config.branding).toBeUndefined();
    expect(config.capabilities).toBeUndefined();
    expect(config.bundleId).toBeUndefined();
  });

  it('gives the web chat the address block it is looked up by, and nothing else one', () => {
    const web = gatewayConfigurationFor(channel({ type: ChannelType.WEB, slug: 'acme-support', configuration: {} }), VisitorAuthMode.EMAIL_OTP);
    expect(web.hostedChat).toEqual({ slug: 'acme-support', authMode: 'email_otp' });
    expect(gatewayConfigurationFor(channel(), VisitorAuthMode.PUBLIC_LINK).hostedChat).toBeUndefined();
  });
});
