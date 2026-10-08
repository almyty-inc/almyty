import { Controller, Get, Post, Param, Req, Res, Body, UnauthorizedException, ParseUUIDPipe } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CompanySigninService, companySetting } from '../../gateways/company-signin.service';
import { McpOAuthService } from '../services/mcp-oauth.service';
const escape = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
@Controller('company-signin')
@Throttle({ default: { limit: 20, ttl: 60000 } })
export class CompanySigninController {
  constructor(private readonly company: CompanySigninService, private readonly oauth: McpOAuthService) {}
  @Get(':gatewayId/start')
  async start(@Param('gatewayId', ParseUUIDPipe) id: string, @Req() req: any, @Res() res: any) { return res.redirect(302, await this.company.begin(id, req, res)); }
  @Get(':gatewayId/callback')
  async callback(@Param('gatewayId', ParseUUIDPipe) id: string, @Req() req: any, @Res() res: any) {
    res.setHeader('Cache-Control', 'no-store');
    const result = await this.company.finish(id, req);
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (!result.oauth) {
      const token = await this.company.issue(id, result.grant);
      return res.type('html').send(`<!doctype html><title>Signed in</title><h1>Signed in to ${escape(result.gateway.name)}</h1><p>Use this token as the Bearer token for this endpoint. It expires in ${Math.ceil(companySetting('COMPANY_SIGNIN_TOKEN_TTL_MS', 3600000) / 60000)} minutes.</p><pre>${escape(token)}</pre>`);
    }
    const ticket = await this.company.consent(id, result);
    return res.type('html').send(`<!doctype html><title>Authorize access</title><h1>Allow ${escape(result.oauth.clientName || result.oauth.clientId)} to use ${escape(result.gateway.name)}?</h1><p>Requested permissions: ${escape(result.oauth.scope)}</p><form method="post" action="${escape(CompanySigninService.metadata(id).redirectUri.replace(/\/callback$/, '/approve'))}"><input type="hidden" name="ticket" value="${escape(ticket)}"><button name="decision" value="allow">Allow</button><button name="decision" value="deny">Deny</button></form>`);
  }
  @Post(':gatewayId/approve')
  async approve(@Param('gatewayId', ParseUUIDPipe) id: string, @Body() body: any, @Req() req: any, @Res() res: any) {
    if (typeof body?.ticket !== 'string' || body.ticket.length > 128) throw new UnauthorizedException('Consent expired');
    const result = await this.company.takeConsent(id, body.ticket, req);
    const params = result.oauth;
    if (!params) throw new UnauthorizedException('Consent expired');
    const redirect = new URL(params.redirectUri);
    if (body.decision !== 'allow') redirect.searchParams.set('error', 'access_denied');
    else {
      const code = await this.oauth.createAuthorizationCode(params.clientId, null, id, result.gateway.organizationId, { ...params, companyGrant: result.grant });
      redirect.searchParams.set('code', code);
    }
    if (params.state) redirect.searchParams.set('state', params.state);
    return res.redirect(302, redirect.href);
  }
}
