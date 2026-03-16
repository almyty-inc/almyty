import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  Req,
  Res,
  HttpException,
  HttpStatus,
  Logger,
  Header,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Gateway, GatewayStatus } from '../../../entities/gateway.entity';
import { Organization } from '../../../entities/organization.entity';
import { McpOAuthService } from '../services/mcp-oauth.service';

/**
 * MCP OAuth 2.1 Controller
 *
 * Implements the OAuth 2.1 authorization flow for MCP gateways as specified
 * in the MCP authorization spec. All endpoints are scoped to a specific
 * org + gateway via /:orgSlug/:gatewaySlug path segments.
 *
 * Route registration: NestJS resolves explicit routes before catch-all (*),
 * so these routes take priority over the GatewayMcpController @All('*').
 */
@Controller('mcp')
export class McpOAuthController {
  private readonly logger = new Logger(McpOAuthController.name);

  constructor(
    @InjectRepository(Gateway)
    private readonly gatewayRepository: Repository<Gateway>,
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    private readonly mcpOAuthService: McpOAuthService,
  ) {}

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Resolve organization by slug, name-based slug, or UUID — without
   * requiring authentication. This mirrors GatewayResolverService.resolveOrganization
   * but lives here to avoid pulling in the auth pipeline.
   */
  private async resolveOrg(orgSlug: string): Promise<Organization> {
    const isUUID =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        orgSlug,
      );

    if (isUUID) {
      const org = await this.organizationRepository.findOne({
        where: { id: orgSlug },
      });
      if (!org) {
        throw new HttpException(
          `Organization not found: ${orgSlug}`,
          HttpStatus.NOT_FOUND,
        );
      }
      return org;
    }

    // Try exact slug column first
    let org = await this.organizationRepository.findOne({
      where: { slug: orgSlug },
    });

    // Fallback: derive slug from name (lowercased, spaces → hyphens)
    if (!org) {
      const allOrgs = await this.organizationRepository.find();
      org = allOrgs.find(
        (o) => o.name?.toLowerCase().replace(/\s+/g, '-') === orgSlug,
      );
    }

    if (!org) {
      throw new HttpException(
        `Organization not found: ${orgSlug}`,
        HttpStatus.NOT_FOUND,
      );
    }
    return org;
  }

  /**
   * Resolve an active gateway by its endpoint slug within an organization.
   * The gatewaySlug is expected to match the gateway endpoint (e.g. "my-gateway"
   * maps to endpoint "/my-gateway").
   */
  private async resolveGateway(
    organizationId: string,
    gatewaySlug: string,
  ): Promise<Gateway> {
    const endpoint = gatewaySlug.startsWith('/')
      ? gatewaySlug
      : `/${gatewaySlug}`;

    const gateway = await this.gatewayRepository.findOne({
      where: {
        endpoint,
        organizationId,
        status: GatewayStatus.ACTIVE,
      },
      relations: ['organization'],
    });

    if (!gateway) {
      throw new HttpException(
        `Gateway not found: ${gatewaySlug}`,
        HttpStatus.NOT_FOUND,
      );
    }
    return gateway;
  }

  /**
   * Resolve both org and gateway from URL slugs. Convenience wrapper used by
   * every endpoint in this controller.
   */
  private async resolveOrgAndGateway(
    orgSlug: string,
    gatewaySlug: string,
  ): Promise<{ organization: Organization; gateway: Gateway }> {
    const organization = await this.resolveOrg(orgSlug);
    const gateway = await this.resolveGateway(organization.id, gatewaySlug);
    return { organization, gateway };
  }

  private getBaseUrl(): string {
    return process.env.BASE_URL || 'http://localhost:4000';
  }

  private getFrontendUrl(): string {
    return process.env.FRONTEND_URL || 'http://localhost:3002';
  }

  // ---------------------------------------------------------------------------
  // 1. Authorization Server Metadata (RFC 8414)
  // GET /:orgSlug/:gatewaySlug/.well-known/oauth-authorization-server
  // ---------------------------------------------------------------------------
  @Get(':orgSlug/:gatewaySlug/.well-known/oauth-authorization-server')
  @Header('Content-Type', 'application/json')
  async getAuthorizationServerMetadata(
    @Param('orgSlug') orgSlug: string,
    @Param('gatewaySlug') gatewaySlug: string,
  ) {
    const { gateway } = await this.resolveOrgAndGateway(orgSlug, gatewaySlug);
    const base = this.getBaseUrl();
    const prefix = `${base}/mcp/${orgSlug}/${gatewaySlug}`;

    this.logger.log(
      `OAuth metadata request: org=${orgSlug}, gateway=${gateway.name}`,
    );

    return {
      issuer: prefix,
      authorization_endpoint: `${prefix}/authorize`,
      token_endpoint: `${prefix}/token`,
      registration_endpoint: `${prefix}/register`,
      revocation_endpoint: `${prefix}/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: [
        'none',
        'client_secret_post',
      ],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['mcp:tools', 'mcp:resources', 'mcp:prompts', 'mcp:*'],
      service_documentation: `${base}/docs`,
    };
  }

  // ---------------------------------------------------------------------------
  // 2. Protected Resource Metadata (RFC 9728)
  // GET /:orgSlug/:gatewaySlug/.well-known/oauth-protected-resource
  // ---------------------------------------------------------------------------
  @Get(':orgSlug/:gatewaySlug/.well-known/oauth-protected-resource')
  @Header('Content-Type', 'application/json')
  async getProtectedResourceMetadata(
    @Param('orgSlug') orgSlug: string,
    @Param('gatewaySlug') gatewaySlug: string,
  ) {
    const { gateway } = await this.resolveOrgAndGateway(orgSlug, gatewaySlug);
    const base = this.getBaseUrl();
    const prefix = `${base}/mcp/${orgSlug}/${gatewaySlug}`;

    this.logger.log(
      `OAuth protected resource metadata: org=${orgSlug}, gateway=${gateway.name}`,
    );

    return {
      resource: prefix,
      authorization_servers: [prefix],
      scopes_supported: ['mcp:tools', 'mcp:resources', 'mcp:prompts', 'mcp:*'],
      bearer_methods_supported: ['header'],
      resource_name: gateway.name,
      resource_documentation: `${base}/docs`,
    };
  }

  // ---------------------------------------------------------------------------
  // 3. Authorization Endpoint
  // GET /:orgSlug/:gatewaySlug/authorize
  // ---------------------------------------------------------------------------
  @Get(':orgSlug/:gatewaySlug/authorize')
  @Header('Cache-Control', 'no-store')
  async authorize(
    @Param('orgSlug') orgSlug: string,
    @Param('gatewaySlug') gatewaySlug: string,
    @Query('response_type') responseType: string,
    @Query('client_id') clientId: string,
    @Query('redirect_uri') redirectUri: string,
    @Query('code_challenge') codeChallenge: string,
    @Query('code_challenge_method') codeChallengeMethod: string,
    @Query('scope') scope: string,
    @Query('state') state: string,
    @Query('resource') resource: string,
    @Req() req: any,
    @Res() res: Response,
  ) {
    const { organization, gateway } = await this.resolveOrgAndGateway(orgSlug, gatewaySlug);

    this.logger.log(
      `OAuth authorize: org=${orgSlug}, gateway=${gateway.name}, client=${clientId}`,
    );

    // --- Validate required parameters ---
    if (!responseType || !clientId || !redirectUri || !codeChallenge || !codeChallengeMethod) {
      throw new HttpException(
        {
          error: 'invalid_request',
          error_description:
            'Missing required parameters: response_type, client_id, redirect_uri, code_challenge, code_challenge_method',
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    if (responseType !== 'code') {
      throw new HttpException(
        {
          error: 'unsupported_response_type',
          error_description: 'Only response_type=code is supported (OAuth 2.1)',
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    if (codeChallengeMethod !== 'S256') {
      throw new HttpException(
        {
          error: 'invalid_request',
          error_description:
            'Only code_challenge_method=S256 is supported (OAuth 2.1 requires PKCE with S256)',
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    // --- Check if user is authenticated (JWT cookie or Bearer token) ---
    const user = req.user;

    if (!user) {
      // Redirect to frontend login page with a return URL back to this authorize endpoint
      const currentUrl = `${this.getBaseUrl()}/mcp/${orgSlug}/${gatewaySlug}/authorize?${new URLSearchParams({
        response_type: responseType,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge: codeChallenge,
        code_challenge_method: codeChallengeMethod,
        ...(scope ? { scope } : {}),
        ...(state ? { state } : {}),
        ...(resource ? { resource } : {}),
      }).toString()}`;

      const loginUrl = `${this.getFrontendUrl()}/login?returnTo=${encodeURIComponent(currentUrl)}`;
      return res.redirect(302, loginUrl);
    }

    // --- User is authenticated — auto-consent for now ---
    // TODO: Add consent screen UI in the future
    const authorizationCode = await this.generateAuthorizationCode({
      organizationId: organization.id,
      gatewayId: gateway.id,
      userId: user.id,
      clientId,
      redirectUri,
      codeChallenge,
      codeChallengeMethod,
      scope: scope || 'mcp:*',
    });

    // Redirect back to client with the authorization code
    const redirectUrl = new URL(redirectUri);
    redirectUrl.searchParams.set('code', authorizationCode);
    if (state) {
      redirectUrl.searchParams.set('state', state);
    }

    return res.redirect(302, redirectUrl.toString());
  }

  // ---------------------------------------------------------------------------
  // 4. Token Endpoint
  // POST /:orgSlug/:gatewaySlug/token
  // ---------------------------------------------------------------------------
  @Post(':orgSlug/:gatewaySlug/token')
  @Header('Content-Type', 'application/json')
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  async token(
    @Param('orgSlug') orgSlug: string,
    @Param('gatewaySlug') gatewaySlug: string,
    @Body() body: any,
  ) {
    const { gateway } = await this.resolveOrgAndGateway(orgSlug, gatewaySlug);

    const grantType = body.grant_type;
    const clientId = body.client_id;

    this.logger.log(
      `OAuth token: org=${orgSlug}, gateway=${gateway.name}, grant_type=${grantType}, client=${clientId}`,
    );

    if (!grantType) {
      throw new HttpException(
        {
          error: 'invalid_request',
          error_description: 'grant_type is required',
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    if (grantType === 'authorization_code') {
      const { code, redirect_uri, code_verifier } = body;

      if (!code || !redirect_uri || !code_verifier || !clientId) {
        throw new HttpException(
          {
            error: 'invalid_request',
            error_description:
              'Missing required parameters: code, redirect_uri, code_verifier, client_id',
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      return this.exchangeCode({
        gatewayId: gateway.id,
        code,
        redirectUri: redirect_uri,
        codeVerifier: code_verifier,
        clientId,
      });
    }

    if (grantType === 'refresh_token') {
      const { refresh_token } = body;

      if (!refresh_token || !clientId) {
        throw new HttpException(
          {
            error: 'invalid_request',
            error_description:
              'Missing required parameters: refresh_token, client_id',
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      return this.refreshToken({
        gatewayId: gateway.id,
        refreshToken: refresh_token,
        clientId,
      });
    }

    throw new HttpException(
      {
        error: 'unsupported_grant_type',
        error_description:
          'Only authorization_code and refresh_token grant types are supported',
      },
      HttpStatus.BAD_REQUEST,
    );
  }

  // ---------------------------------------------------------------------------
  // 5. Dynamic Client Registration (RFC 7591)
  // POST /:orgSlug/:gatewaySlug/register
  // ---------------------------------------------------------------------------
  @Post(':orgSlug/:gatewaySlug/register')
  @Header('Content-Type', 'application/json')
  async register(
    @Param('orgSlug') orgSlug: string,
    @Param('gatewaySlug') gatewaySlug: string,
    @Body()
    body: {
      client_name: string;
      redirect_uris: string[];
      grant_types?: string[];
      response_types?: string[];
      token_endpoint_auth_method?: string;
      client_uri?: string;
    },
    @Res() res: Response,
  ) {
    const { organization, gateway } = await this.resolveOrgAndGateway(orgSlug, gatewaySlug);

    this.logger.log(
      `OAuth client registration: org=${orgSlug}, gateway=${gateway.name}, client_name=${body.client_name}`,
    );

    if (!body.client_name || !body.redirect_uris?.length) {
      throw new HttpException(
        {
          error: 'invalid_client_metadata',
          error_description: 'client_name and redirect_uris are required',
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    // Validate redirect URIs
    for (const uri of body.redirect_uris) {
      try {
        const parsed = new URL(uri);
        // OAuth 2.1: redirect_uri MUST use https except for localhost
        if (
          parsed.protocol !== 'https:' &&
          parsed.hostname !== 'localhost' &&
          parsed.hostname !== '127.0.0.1' &&
          parsed.hostname !== '[::1]'
        ) {
          throw new HttpException(
            {
              error: 'invalid_client_metadata',
              error_description: `redirect_uri must use HTTPS (except for localhost): ${uri}`,
            },
            HttpStatus.BAD_REQUEST,
          );
        }
      } catch (e) {
        if (e instanceof HttpException) throw e;
        throw new HttpException(
          {
            error: 'invalid_client_metadata',
            error_description: `Invalid redirect_uri: ${uri}`,
          },
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    const clientMetadata = await this.registerClient({
      organizationId: organization.id,
      gatewayId: gateway.id,
      clientName: body.client_name,
      redirectUris: body.redirect_uris,
      grantTypes: body.grant_types || ['authorization_code', 'refresh_token'],
      responseTypes: body.response_types || ['code'],
      tokenEndpointAuthMethod:
        body.token_endpoint_auth_method || 'none',
      clientUri: body.client_uri,
    });

    return res.status(HttpStatus.CREATED).json(clientMetadata);
  }

  // ---------------------------------------------------------------------------
  // 6. Token Revocation (RFC 7009)
  // POST /:orgSlug/:gatewaySlug/revoke
  // ---------------------------------------------------------------------------
  @Post(':orgSlug/:gatewaySlug/revoke')
  async revoke(
    @Param('orgSlug') orgSlug: string,
    @Param('gatewaySlug') gatewaySlug: string,
    @Body()
    body: {
      token: string;
      token_type_hint?: string;
      client_id: string;
    },
    @Res() res: Response,
  ) {
    const { gateway } = await this.resolveOrgAndGateway(orgSlug, gatewaySlug);

    this.logger.log(
      `OAuth revoke: org=${orgSlug}, gateway=${gateway.name}, hint=${body.token_type_hint || 'none'}`,
    );

    if (!body.token || !body.client_id) {
      // RFC 7009: always return 200, even for invalid requests
      return res.status(HttpStatus.OK).json({});
    }

    try {
      await this.revokeToken({
        gatewayId: gateway.id,
        token: body.token,
        tokenTypeHint: body.token_type_hint,
        clientId: body.client_id,
      });
    } catch {
      // RFC 7009: The authorization server responds with HTTP status code 200
      // for both successful and unsuccessful revocation requests
    }

    return res.status(HttpStatus.OK).json({});
  }

  // ---------------------------------------------------------------------------
  // Delegations to McpOAuthService
  // ---------------------------------------------------------------------------

  private async generateAuthorizationCode(params: {
    organizationId: string;
    gatewayId: string;
    userId: string;
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    scope: string;
  }): Promise<string> {
    return this.mcpOAuthService.createAuthorizationCode(
      params.clientId,
      params.userId,
      params.gatewayId,
      params.organizationId,
      {
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        codeChallengeMethod: params.codeChallengeMethod,
        scope: params.scope,
      },
    );
  }

  private async exchangeCode(params: {
    gatewayId: string;
    code: string;
    redirectUri: string;
    codeVerifier: string;
    clientId: string;
  }) {
    return this.mcpOAuthService.exchangeCode(
      params.code,
      params.clientId,
      params.codeVerifier,
      params.redirectUri,
    );
  }

  private async refreshToken(params: {
    gatewayId: string;
    refreshToken: string;
    clientId: string;
  }) {
    return this.mcpOAuthService.refreshToken(
      params.refreshToken,
      params.clientId,
    );
  }

  private async registerClient(params: {
    organizationId: string;
    gatewayId: string;
    clientName: string;
    redirectUris: string[];
    grantTypes: string[];
    responseTypes: string[];
    tokenEndpointAuthMethod: string;
    clientUri?: string;
  }) {
    return this.mcpOAuthService.registerClient(
      params.gatewayId,
      params.organizationId,
      {
        client_name: params.clientName,
        redirect_uris: params.redirectUris,
        grant_types: params.grantTypes,
        response_types: params.responseTypes,
        token_endpoint_auth_method: params.tokenEndpointAuthMethod,
      },
    );
  }

  private async revokeToken(params: {
    gatewayId: string;
    token: string;
    tokenTypeHint?: string;
    clientId: string;
  }): Promise<void> {
    await this.mcpOAuthService.revokeToken(params.token, params.clientId);
  }
}
