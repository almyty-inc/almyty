import * as crypto from 'crypto';
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ChannelEmailInboundController } from '../channel-email-inbound.controller';
import { Gateway, GatewayStatus, GatewayType } from '../../../../entities/gateway.entity';

/**
 * Global inbound-email fallback route (POST /channels/email/inbound).
 * Providers like Resend only support one account-level inbound webhook,
 * so this route maps recipient address -> gateway across orgs. Covers
 * the svix signature gate (RESEND_INBOUND_SIGNING_SECRET), recipient
 * resolution, dispatch into the channel pipeline, and the 404 for
 * unknown recipients. No real HTTP anywhere.
 */
describe('ChannelEmailInboundController', () => {
  const SECRET_BYTES = Buffer.from('global-inbound-test-secret');
  const SECRET = `whsec_${SECRET_BYTES.toString('base64')}`;

  let controller: ChannelEmailInboundController;
  let channelGatewayService: { handleInboundMessage: jest.Mock };
  let emailProvisioning: { resolveGatewayByRecipient: jest.Mock };
  let configService: { get: jest.Mock };

  const gateway = {
    id: 'gw-1',
    type: GatewayType.EMAIL,
    status: GatewayStatus.ACTIVE,
    organizationId: 'org-1',
    configuration: { inbound_address: 'support-bot@inbound.almyty.example' },
  } as unknown as Gateway;

  const eventBody = {
    type: 'email.received',
    data: {
      from: 'alice@example.com',
      to: ['support-bot@inbound.almyty.example'],
      subject: 'help me',
      text: 'plain body',
      headers: [{ name: 'Message-ID', value: '<m1@example.com>' }],
    },
  };

  const signedRequest = (body: any, tamper = false) => {
    const rawBody = JSON.stringify(body);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = crypto
      .createHmac('sha256', SECRET_BYTES)
      .update(`msg_1.${timestamp}.${rawBody}`)
      .digest('base64');
    return {
      headers: {
        'svix-id': 'msg_1',
        'svix-timestamp': timestamp,
        'svix-signature': `v1,${tamper ? signature.replace(/^./, 'X') : signature}`,
        'content-type': 'application/json',
      },
      rawBody: Buffer.from(rawBody),
    } as any;
  };

  beforeEach(() => {
    channelGatewayService = { handleInboundMessage: jest.fn().mockResolvedValue(undefined) };
    emailProvisioning = { resolveGatewayByRecipient: jest.fn().mockResolvedValue(gateway) };
    configService = { get: jest.fn().mockReturnValue(SECRET) };
    controller = new ChannelEmailInboundController(
      channelGatewayService as any,
      emailProvisioning as any,
      configService as any,
    );
  });

  it('verifies the svix signature, resolves the gateway by recipient and dispatches the message', async () => {
    const req = signedRequest(eventBody);
    const result = await controller.inbound(req, eventBody);

    expect(result).toEqual({ ok: true });
    expect(emailProvisioning.resolveGatewayByRecipient).toHaveBeenCalledWith([
      'support-bot@inbound.almyty.example',
    ]);
    expect(channelGatewayService.handleInboundMessage).toHaveBeenCalledWith(
      gateway,
      eventBody,
      expect.objectContaining({ 'svix-id': 'msg_1' }),
      JSON.stringify(eventBody),
    );
  });

  it('rejects an invalid svix signature with 401 and does not dispatch', async () => {
    const req = signedRequest(eventBody, /* tamper */ true);
    await expect(controller.inbound(req, eventBody)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(channelGatewayService.handleInboundMessage).not.toHaveBeenCalled();
    expect(emailProvisioning.resolveGatewayByRecipient).not.toHaveBeenCalled();
  });

  it('rejects when svix headers are missing while a secret is configured', async () => {
    const req = { headers: { 'content-type': 'application/json' }, rawBody: Buffer.from(JSON.stringify(eventBody)) } as any;
    await expect(controller.inbound(req, eventBody)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('accepts unsigned deliveries when RESEND_INBOUND_SIGNING_SECRET is not set', async () => {
    configService.get.mockReturnValue(undefined);
    const req = { headers: {}, rawBody: Buffer.from(JSON.stringify(eventBody)) } as any;
    const result = await controller.inbound(req, eventBody);
    expect(result).toEqual({ ok: true });
    expect(channelGatewayService.handleInboundMessage).toHaveBeenCalled();
  });

  it('404s when no gateway owns the recipient address', async () => {
    emailProvisioning.resolveGatewayByRecipient.mockResolvedValue(null);
    const req = signedRequest(eventBody);
    await expect(controller.inbound(req, eventBody)).rejects.toBeInstanceOf(NotFoundException);
    expect(channelGatewayService.handleInboundMessage).not.toHaveBeenCalled();
  });

  it('404s when the payload has no resolvable recipient at all', async () => {
    const body = { type: 'email.received', data: { from: 'a@b', text: 'x' } };
    const req = signedRequest(body);
    await expect(controller.inbound(req, body)).rejects.toBeInstanceOf(NotFoundException);
    expect(emailProvisioning.resolveGatewayByRecipient).not.toHaveBeenCalled();
  });

  it('still returns 200 when async processing fails after dispatch', async () => {
    channelGatewayService.handleInboundMessage.mockRejectedValue(new Error('boom'));
    const req = signedRequest(eventBody);
    await expect(controller.inbound(req, eventBody)).resolves.toEqual({ ok: true });
  });
});
