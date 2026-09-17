import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  Req,
  Res,
  UseGuards,
  Header,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Request, Response } from 'express';

import { Public } from '../../../src/common/decorators/public.decorator';
import { EntitlementGuard } from '../../../src/modules/licensing/guards/entitlement.guard';
import { RequiresEntitlement } from '../../../src/modules/licensing/decorators/requires-entitlement.decorator';
import { EE_ENTITLEMENTS } from '../../../src/modules/licensing/license.constants';
import { AuthService } from '../../../src/modules/auth/auth.service';
import { SsoService } from './sso.service';
import { SsoConfigService } from './sso-config.service';
import {
  publicBaseUrl,
  ssoSuccessRedirect,
  SSO_ACCESS_TOKEN_COOKIE_OPTIONS,
  SSO_STATE_COOKIE,
  SSO_STATE_COOKIE_OPTIONS,
} from './sso.util';

/**
 * SP-initiated SAML + OIDC login (T4.1). These endpoints are `@Public` (the
 * user is not yet authenticated) but still gated by the `sso` entitlement, so
 * the whole flow is inert in the community build.
 *
 * On a verified assertion we issue the app's normal JWT httpOnly cookie via
 * AuthService — the exact same cookie password login sets — and redirect to the
 * frontend. No new session mechanism is introduced.
 */
@ApiTags('SSO')
@Controller('sso')
// No EntitlementGuard here: @Public() means JwtAuthGuard attaches no
// user, so the guard has no organization to resolve and falls back to
// the deployment-global license — community — and answers 402 to every
// paying customer's login. The check lives in
// SsoConfigService.getDecrypted, which every route below passes through
// and which knows the org from the URL.
@Public()
export class SsoController {
  constructor(
    private readonly ssoService: SsoService,
    private readonly authService: AuthService,
    private readonly configService: SsoConfigService,
  ) {}

  private async issueSession(res: Response, user: any): Promise<void> {
    const tokens = await this.authService.generateTokens(user);
    res.cookie('access_token', tokens.accessToken, SSO_ACCESS_TOKEN_COOKIE_OPTIONS);
  }

  // ── SAML ────────────────────────────────────────────────────────────

  @Get(':orgId/saml/login')
  @ApiOperation({ summary: 'SP-initiated SAML login — redirect to the IdP' })
  async samlLogin(
    @Param('orgId') orgId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const url = await this.ssoService.getSamlLoginUrl(orgId, publicBaseUrl(req));
    return res.redirect(url);
  }

  @Post(':orgId/saml/callback')
  @ApiOperation({ summary: 'SAML assertion consumer service (ACS)' })
  async samlCallback(
    @Param('orgId') orgId: string,
    @Body('SAMLResponse') samlResponse: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const user = await this.ssoService.handleSamlCallback(
      orgId,
      samlResponse,
      publicBaseUrl(req),
    );
    await this.issueSession(res, user);
    return res.redirect(ssoSuccessRedirect());
  }

  @Get(':orgId/saml/metadata')
  @Header('Content-Type', 'application/xml')
  @ApiOperation({ summary: 'SP SAML metadata for this organization' })
  async samlMetadata(
    @Param('orgId') orgId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const config = await this.configService.getDecrypted(orgId);
    if (!config) {
      return res.status(404).send('<error>SSO not configured</error>');
    }
    const saml = this.ssoService.buildSaml(
      config,
      `${publicBaseUrl(req)}/sso/${orgId}/saml/callback`,
    );
    return res.send(saml.generateServiceProviderMetadata(null));
  }

  // ── OIDC ────────────────────────────────────────────────────────────

  @Get(':orgId/oidc/login')
  @ApiOperation({ summary: 'SP-initiated OIDC login — redirect to the IdP' })
  async oidcLogin(
    @Param('orgId') orgId: string,
    @Res() res: Response,
  ) {
    const { url, state } = await this.ssoService.getOidcLoginUrl(orgId);
    res.cookie(SSO_STATE_COOKIE, state, SSO_STATE_COOKIE_OPTIONS);
    return res.redirect(url);
  }

  @Get(':orgId/oidc/callback')
  @ApiOperation({ summary: 'OIDC redirect callback' })
  async oidcCallback(
    @Param('orgId') orgId: string,
    @Query() query: Record<string, string>,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const expectedState = (req as any).cookies?.[SSO_STATE_COOKIE];
    const user = await this.ssoService.handleOidcCallback(
      orgId,
      query,
      expectedState,
    );
    res.clearCookie(SSO_STATE_COOKIE, { path: '/' });
    await this.issueSession(res, user);
    return res.redirect(ssoSuccessRedirect());
  }
}
