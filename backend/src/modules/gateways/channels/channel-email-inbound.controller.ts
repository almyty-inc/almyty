import {
  Body,
  Controller,
  HttpCode,
  Logger,
  NotFoundException,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

import { ChannelGatewayService } from './channel-gateway.service';
import { EmailProvisioningService } from './email-provisioning.service';
import { EmailAdapter } from './adapters/email.adapter';
import { verifySvixSignature } from './adapters/svix-signature.helper';

/**
 * Global inbound-email fallback route. Per-gateway deliveries go to
 * the unified endpoint (/:orgSlug/:resourceSlug), but providers like
 * Resend only support ONE account-level inbound webhook for a domain —
 * this route accepts that single firehose and fans deliveries out to
 * the matching gateway by recipient address, across all organizations.
 *
 * Registered in GatewaysModule, which AppModule imports before
 * UnifiedEndpointModule, so the literal /channels/email/inbound path
 * wins over the unified catch-all.
 *
 * Auth: no almyty API key (the provider cannot attach one). When
 * RESEND_INBOUND_SIGNING_SECRET is set, the svix signature on the raw
 * body is required; without it deliveries are accepted as-is (the
 * per-gateway `resend_inbound_signing_secret` still applies inside
 * handleInboundMessage). Unknown recipients 404 so provider dashboards
 * surface the misconfiguration.
 */
@Controller('channels/email')
@ApiTags('Gateway channels')
export class ChannelEmailInboundController {
  private readonly logger = new Logger(ChannelEmailInboundController.name);

  constructor(
    private readonly channelGatewayService: ChannelGatewayService,
    private readonly emailProvisioning: EmailProvisioningService,
    private readonly configService: ConfigService,
  ) {}

  @Post('inbound')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Global inbound email webhook (provider-level, resolves gateway by recipient)',
  })
  async inbound(@Req() req: Request, @Body() body: any) {
    // Flatten express headers to the Record<string, string> shape the
    // helpers expect (multi-value headers are irrelevant here).
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      headers[key] = Array.isArray(value) ? value[0] : ((value as string) ?? '');
    }

    // Svix signs the exact bytes on the wire (captured by main.ts
    // rawBody: true), not a re-serialization.
    const rawBody = (req as any).rawBody
      ? Buffer.from((req as any).rawBody).toString('utf8')
      : JSON.stringify(body ?? {});

    const secret = this.configService.get<string>('RESEND_INBOUND_SIGNING_SECRET');
    if (secret && !verifySvixSignature(rawBody, headers, secret)) {
      throw new UnauthorizedException('Webhook signature verification failed');
    }

    const recipients = EmailAdapter.extractRecipients(body);
    const gateway =
      recipients.length > 0
        ? await this.emailProvisioning.resolveGatewayByRecipient(recipients)
        : null;
    if (!gateway) {
      throw new NotFoundException('No email gateway matches the recipient address');
    }

    // Providers expect a fast 2xx; processing is fire-and-forget
    // (handleInboundMessage logs channel events and bumps counters).
    this.channelGatewayService
      .handleInboundMessage(gateway, body, headers, rawBody)
      .catch((err: any) => {
        this.logger.error(
          `Inbound email processing failed (gateway ${gateway.id}): ${err.message}`,
        );
      });

    return { ok: true };
  }
}
