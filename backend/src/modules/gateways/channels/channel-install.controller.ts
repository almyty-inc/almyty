import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Request, Response } from 'express';

import { Gateway, GatewayType } from '../../../entities/gateway.entity';
import { SlackInstallService } from './slack-install.service';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Public (unauthenticated) OAuth install surface for multi-workspace
 * channel gateways. Customers in other Slack workspaces hit these URLs
 * from an "Add to Slack" link — they have no almyty session, so there
 * are no guards here. Security comes from:
 *
 *   - the gateway must exist, be active, and be an installable Slack
 *     channel (client_id + client_secret configured) — 404 otherwise
 *   - the OAuth `state` is a signed, expiring nonce bound to the
 *     gateway id (verified before any code exchange)
 *   - the code exchange itself authenticates against Slack with the
 *     app's client_secret
 */
@Controller('gateways')
@ApiTags('Channel installs')
export class ChannelInstallController {
  constructor(
    @InjectRepository(Gateway)
    private readonly gatewayRepository: Repository<Gateway>,
    private readonly slackInstallService: SlackInstallService,
  ) {}

  private async findInstallableSlackGateway(id: string): Promise<Gateway> {
    const gateway = await this.gatewayRepository.findOne({ where: { id } });
    if (
      !gateway ||
      gateway.type !== GatewayType.SLACK ||
      !gateway.isActive() ||
      !this.slackInstallService.isInstallable(gateway)
    ) {
      // Single 404 for all failure modes — don't leak whether an id
      // exists as a different gateway type on this unauthenticated path.
      throw new NotFoundException('Installable Slack gateway not found');
    }
    return gateway;
  }

  private requestBase(req: Request): string {
    return `${req.protocol}://${req.get('host')}`;
  }

  @Get(':id/install/slack')
  @ApiOperation({ summary: 'Start the Slack OAuth install flow (302 to Slack authorize)' })
  async installSlack(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const gateway = await this.findInstallableSlackGateway(id);
    const url = this.slackInstallService.buildAuthorizeUrl(gateway, this.requestBase(req));
    return res.redirect(302, url);
  }

  @Get(':id/install/slack/callback')
  @ApiOperation({ summary: 'Slack OAuth callback — exchanges the code and stores the installation' })
  async installSlackCallback(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const gateway = await this.findInstallableSlackGateway(id);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');

    // User clicked "Cancel" on Slack's consent screen.
    if (error) {
      return res
        .status(400)
        .send(this.page('Installation cancelled', `Slack reported: ${escapeHtml(error)}`));
    }

    try {
      const installation = await this.slackInstallService.handleCallback(
        gateway,
        code,
        state,
        this.requestBase(req),
      );
      const teamName = installation.metadata?.teamName || installation.externalTenantId;
      return res
        .status(200)
        .send(
          this.page(
            'Installation complete',
            `${escapeHtml(gateway.name)} is now installed in the ${escapeHtml(String(teamName))} Slack workspace. You can close this window.`,
          ),
        );
    } catch (err: any) {
      return res
        .status(400)
        .send(this.page('Installation failed', escapeHtml(err?.message || 'Unknown error')));
    }
  }

  /** Minimal self-contained result page (no assets, no scripts). */
  private page(title: string, body: string): string {
    return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>almyty — ${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0b0b0f;color:#e4e4e7}main{max-width:26rem;padding:2rem;text-align:center}h1{font-size:1.25rem}p{color:#a1a1aa;font-size:.9rem}</style>
</head>
<body><main><h1>${escapeHtml(title)}</h1><p>${body}</p></main></body>
</html>`;
  }
}
