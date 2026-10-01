import { Controller, Get, HttpException, NotFoundException, Optional, Query, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { ConnectionsService } from './connections.service';
import { McpOAuthClientService } from './mcp-oauth/mcp-oauth-client.service';
import { mcpOAuthClientSettings } from './mcp-oauth/mcp-oauth-client.settings';

/**
 * Where a service sends the browser back after a sign-in started on
 * Credentials (`ConnectionsService.callbackUrl`), and the document that
 * says who almyty is to an MCP server's sign-in. Every other credential
 * route is on CredentialsController.
 */
@ApiTags('Credentials')
@Controller('credentials')
export class CredentialSignInController {
  constructor(
    private readonly connections: ConnectionsService,
    private readonly configService: ConfigService,
    @Optional() private readonly mcpOAuth?: McpOAuthClientService,
  ) {}

  /**
   * The almyty client metadata document (CIMD): an MCP server's
   * authorization server that accepts these takes this URL as almyty's
   * client id and reads the name and callback from here, so almyty signs in
   * without registering first. Public by design; it holds no secret.
   * MCP_CLIENT_CIMD_ENABLED=false turns it off.
   */
  @Get('oauth/client-metadata.json')
  @ApiOperation({ summary: 'The almyty client metadata document, for signing in to MCP servers' })
  clientMetadata(@Req() req: Request, @Res() res: Response) {
    const settings = mcpOAuthClientSettings();
    if (!settings.cimdEnabled || !this.mcpOAuth) throw new NotFoundException();
    const requestBase = `${req.protocol}://${req.get('host')}`;
    const apiBase = this.connections.apiBase(requestBase);
    const doc = this.mcpOAuth.clientMetadataDocument(apiBase, this.connections.callbackUrl(requestBase), this.configService.get<string>('FRONTEND_URL') ?? null);
    res.setHeader('Cache-Control', `public, max-age=${settings.cimdMaxAgeSeconds}`);
    return res.status(200).json(doc);
  }

  /**
   * Browser leg of a sign-in. Unauthenticated by design: the service sends
   * the user here, the state is the credential. Redirects to the
   * dashboard's Credentials page when FRONTEND_URL is set, else answers
   * JSON.
   */
  @Get('oauth/callback')
  @ApiOperation({ summary: 'Where a service sends the browser back after a sign-in' })
  async callback(@Query() query: Record<string, string>, @Res() res: Response) {
    const frontend = (this.configService.get<string>('FRONTEND_URL') || '').replace(/\/$/, '');
    try {
      const connection = await this.connections.handleCallback(query);
      if (frontend) return res.redirect(302, `${frontend}/credentials?connection=${encodeURIComponent(connection.id)}&status=${encodeURIComponent(connection.health.status)}`);
      return res.status(200).json({ success: true, data: connection, message: 'Credential added' });
    } catch (e: any) {
      const body = e instanceof HttpException ? e.getResponse() : { message: String(e?.message ?? e) };
      const status = e instanceof HttpException ? e.getStatus() : 500;
      const detail = typeof body === 'object' && body ? (body as any) : { message: String(body) };
      if (frontend) {
        const params = new URLSearchParams({ status: 'error', code: detail.code ?? 'CONNECT_FAILED', message: String(detail.message ?? '') });
        if (detail.connection?.id) params.set('connection', detail.connection.id);
        return res.redirect(302, `${frontend}/credentials?${params.toString()}`);
      }
      return res.status(status).json({ success: false, ...detail });
    }
  }
}
