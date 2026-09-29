import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  Req,
  Res,
  Header,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Request, Response } from 'express';

import { Public } from '../../../src/common/decorators/public.decorator';
import { AuthService } from '../../../src/modules/auth/auth.service';
import { SsoService, SsoUserProfile } from './sso.service';
import { SsoConfigService } from './sso-config.service';
import { ParkedSamlSignIn, PendingSamlSignIn, SamlSignInStore } from './saml-sign-in.store';
import {
  publicBaseUrl,
  ssoSuccessRedirect,
  SSO_ACCESS_TOKEN_COOKIE_OPTIONS,
  SSO_SAML_STATE_COOKIE,
  SSO_STATE_COOKIE,
  SSO_STATE_COOKIE_OPTIONS,
} from './sso.util';

interface PendingDashboardSignIn extends PendingSamlSignIn {
  organizationId: string;
}

interface ParkedDashboardSignIn extends ParkedSamlSignIn {
  organizationId: string;
  profile: SsoUserProfile;
}

/** Keeps dashboard sign-ins apart from hosted-chat ones in SamlSignInStore. */
const SCOPE = 'sso';

const SIGN_IN_EXPIRED = 'Sign-in session expired or did not match. Start again.';

/**
 * SP-initiated SAML + OIDC login (T4.1). These endpoints are `@Public` (the
 * user is not yet authenticated) but still gated by the `sso` entitlement, so
 * the whole flow is inert in the community build.
 *
 * On a verified assertion we issue the app's normal JWT httpOnly cookie via
 * AuthService — the exact same cookie password login sets — and redirect to the
 * frontend. No new session mechanism is introduced.
 *
 * SAML is SP-initiated only and goes through the relay-state hand-off in
 * SamlSignInStore (shared with hosted-chat visitors): login stores the
 * AuthnRequest ID under a relay state that the browser also holds in a
 * cookie; the assertion consumer accepts only a response to that request,
 * addressed to this ACS, and parks the identity; the session is issued on
 * the follow-up GET, in the browser holding the cookie. An IdP-initiated
 * (unsolicited) response, or one captured and posted into someone else's
 * browser, signs nobody in.
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
    private readonly signIns: SamlSignInStore,
  ) {}

  /**
   * The session names the organization whose IdP vouched for the person
   * and reaches only that one: an org owner controls its IdP, and must not
   * be able to sign their way into the person's other organizations or
   * account settings. See src/modules/auth/sso-session.ts.
   */
  private async issueSession(res: Response, user: any, orgId: string): Promise<void> {
    const tokens = await this.authService.generateTokens(user, { ssoOrganizationId: orgId });
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
    const acsUrl = SsoService.samlCallbackUrl(publicBaseUrl(req), orgId);
    const relayState = SamlSignInStore.newRelayState();
    const { url, requestId } = await this.ssoService.startSamlRequest(orgId, acsUrl, relayState);
    const pending: PendingDashboardSignIn = { organizationId: orgId, requestId, acsUrl };
    if (!(await this.signIns.remember(SCOPE, relayState, pending))) {
      throw new ServiceUnavailableException('Single sign-on is temporarily unavailable. Try again shortly.');
    }
    res.cookie(SSO_SAML_STATE_COOKIE, relayState, SSO_STATE_COOKIE_OPTIONS);
    return res.redirect(url);
  }

  @Post(':orgId/saml/callback')
  @ApiOperation({ summary: 'SAML assertion consumer service (ACS); accepts only responses to our own requests' })
  async samlCallback(
    @Param('orgId') orgId: string,
    @Body() body: { SAMLResponse?: unknown; RelayState?: unknown },
    @Res() res: Response,
  ) {
    const relayState = typeof body?.RelayState === 'string' ? body.RelayState : '';
    const samlResponse = typeof body?.SAMLResponse === 'string' ? body.SAMLResponse : '';
    const pending = await this.signIns.takePending<PendingDashboardSignIn>(SCOPE, relayState);
    if (!pending || pending.organizationId !== orgId || !samlResponse) {
      throw new UnauthorizedException(SIGN_IN_EXPIRED);
    }
    const profile = await this.ssoService.resolveSamlLogin(orgId, samlResponse, pending.acsUrl, pending.requestId);

    const handoff = await this.signIns.park<ParkedDashboardSignIn>(SCOPE, { relayState, organizationId: orgId, profile });
    if (!handoff) {
      throw new ServiceUnavailableException('Single sign-on is temporarily unavailable. Try again shortly.');
    }
    // Relative, so it resolves against wherever the ACS is served: the
    // completion sits next to it, on the host that set the state cookie.
    return res.redirect(303, `complete?handoff=${handoff}`);
  }

  @Get(':orgId/saml/complete')
  @ApiOperation({ summary: 'Finish a SAML login in the browser that started it' })
  async samlComplete(
    @Param('orgId') orgId: string,
    @Query('handoff') handoff: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const record = await this.signIns.takeHandoff<ParkedDashboardSignIn>(
      SCOPE,
      handoff,
      (req as any).cookies?.[SSO_SAML_STATE_COOKIE],
    );
    if (!record || record.organizationId !== orgId) {
      throw new UnauthorizedException(SIGN_IN_EXPIRED);
    }
    res.clearCookie(SSO_SAML_STATE_COOKIE, { path: '/' });
    const user = await this.ssoService.completeSsoLogin(orgId, record.profile, 'saml');
    await this.issueSession(res, user, orgId);
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
    const saml = this.ssoService.buildSaml(config, SsoService.samlCallbackUrl(publicBaseUrl(req), orgId));
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
    await this.issueSession(res, user, orgId);
    return res.redirect(ssoSuccessRedirect());
  }
}
