import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { SsoConfigService } from '../sso-config.service';
import { OrgLicenseResolver } from '../../../../src/modules/licensing/org-license.resolver';
import { EE_ENTITLEMENTS } from '../../../../src/modules/licensing/license.constants';

/** 402, in the SCIM error shape the client expects. */
class PaymentRequiredException extends HttpException {
  constructor(body: unknown) {
    super(body as any, HttpStatus.PAYMENT_REQUIRED);
  }
}

/**
 * Authenticates SCIM requests with the per-org bearer token. The token is
 * hashed and resolved to an organization via `OrgSsoConfig.scimTokenHash`; the
 * resolved org id is attached to the request as `scimOrgId` for the controller.
 *
 * A missing/unknown token throws 401 with a SCIM-shaped error body, and an
 * organization without the SSO entitlement gets 402 -- checked here, once the
 * token has said which organization this is, rather than by a guard that runs
 * before anything knows.
 */
@Injectable()
export class ScimAuthGuard implements CanActivate {
  constructor(
    private readonly configService: SsoConfigService,
    private readonly licenses: OrgLicenseResolver,
  ) {}

  private async entitled(organizationId: string): Promise<boolean> {
    try {
      return await this.licenses.hasForOrg(organizationId, EE_ENTITLEMENTS.SSO);
    } catch {
      return false;
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const header: string | undefined =
      req.headers?.authorization || req.headers?.Authorization;

    const token = header?.startsWith('Bearer ')
      ? header.slice('Bearer '.length).trim()
      : undefined;

    if (!token) {
      throw new UnauthorizedException(this.scimError('Missing bearer token'));
    }

    const orgId = await this.configService.findOrgByScimToken(token);
    if (!orgId) {
      throw new UnauthorizedException(this.scimError('Invalid SCIM token'));
    }

    // The entitlement check belongs here, not in a guard that runs
    // before this one.
    //
    // The controller was @Public() + @UseGuards(EntitlementGuard, ...),
    // and JwtAuthGuard short-circuits on @Public() without attaching a
    // user -- so EntitlementGuard had no org to resolve and took its
    // global branch, which is community on this deployment. Every
    // Okta/Entra push from a paying customer got 402. Guard order made
    // it worse: the entitlement ran before this guard had read the org
    // off the token.
    if (!(await this.entitled(orgId))) {
      throw new PaymentRequiredException(
        this.scimError(
          'SCIM provisioning is not included in this organization plan',
          HttpStatus.PAYMENT_REQUIRED,
        ),
      );
    }

    req.scimOrgId = orgId;
    return true;
  }

  /**
   * The SCIM envelope carries the status too, so it has to agree with
   * the HTTP one — Okta and Entra parse this body. It was hardcoded to
   * '401', so a 402 told the client two different things at once.
   */
  private scimError(detail: string, status: HttpStatus = HttpStatus.UNAUTHORIZED) {
    return {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
      status: String(status),
      detail,
    };
  }
}
