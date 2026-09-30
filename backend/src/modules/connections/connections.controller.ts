import { Controller, Get, HttpException, Query, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { ConnectionsService } from './connections.service';

/**
 * Where a service sends the browser back after a sign-in started on
 * Credentials (`ConnectionsService.callbackUrl`). Every other credential
 * route is on CredentialsController.
 */
@ApiTags('Credentials')
@Controller('credentials')
export class CredentialSignInController {
  constructor(private readonly connections: ConnectionsService, private readonly configService: ConfigService) {}

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
