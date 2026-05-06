import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';

import { OAuthAuthorizationCode } from '../../../entities/oauth-authorization-code.entity';
import { OAuthAccessToken } from '../../../entities/oauth-access-token.entity';
import { OAuthClient } from '../../../entities/oauth-client.entity';
import { hashValue, verifyClientAuth } from './mcp-oauth-helpers.helper';

const ACCESS_TOKEN_LIFETIME_SECONDS = 3600;
const REFRESH_TOKEN_LIFETIME_SECONDS = 30 * 24 * 3600;

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export interface TokenValidationResult {
  valid: boolean;
  clientId?: string;
  userId?: string;
  gatewayId?: string;
  organizationId?: string;
  scope?: string;
}

/**
 * Token-management half of McpOAuthService:
 *   exchangeCode (authorization_code grant)
 *   refreshToken (refresh_token grant)
 *   validateAccessToken (used by request-time auth)
 *   revokeToken (RFC 7009)
 *   generateTokenPair (internal)
 *
 * Split out so the main service can stay focused on
 * metadata + dynamic client registration + authorization-code
 * issuance.
 */
@Injectable()
export class McpOAuthTokensHelper {
  private readonly logger = new Logger(McpOAuthTokensHelper.name);

  constructor(
    @InjectRepository(OAuthClient)
    private readonly oauthClientRepository: Repository<OAuthClient>,
    @InjectRepository(OAuthAuthorizationCode)
    private readonly oauthCodeRepository: Repository<OAuthAuthorizationCode>,
    @InjectRepository(OAuthAccessToken)
    private readonly oauthTokenRepository: Repository<OAuthAccessToken>,
  ) {}

  async exchangeCode(
    codeValue: string,
    clientId: string,
    codeVerifier: string,
    redirectUri: string,
    gatewayId: string,
    clientSecret?: string,
  ): Promise<TokenResponse> {
    const client = await this.oauthClientRepository.findOne({
      where: { clientId, gatewayId, isActive: true },
    });
    if (!client) {
      throw new UnauthorizedException('Invalid client');
    }
    verifyClientAuth(client, clientSecret);

    const codeHash = hashValue(codeValue);

    const authCode = await this.oauthCodeRepository.findOne({
      where: { codeHash, clientId, gatewayId },
    });

    if (!authCode) {
      throw new UnauthorizedException('Invalid authorization code');
    }

    if (authCode.isUsed) {
      this.logger.warn(
        `Authorization code replay detected for client ${clientId} — revoking issued tokens for this user+gateway`,
      );
      try {
        await this.oauthTokenRepository.update(
          {
            clientId: authCode.clientId,
            userId: authCode.userId,
            gatewayId: authCode.gatewayId,
            isRevoked: false,
          },
          { isRevoked: true },
        );
      } catch (err: any) {
        this.logger.error(`Failed to revoke tokens on replay detection: ${err.message}`);
      }
      throw new UnauthorizedException('Authorization code has already been used');
    }

    if (new Date() > authCode.expiresAt) {
      throw new UnauthorizedException('Authorization code has expired');
    }

    if (authCode.redirectUri !== redirectUri) {
      throw new BadRequestException('redirect_uri mismatch');
    }

    const computedChallenge = crypto
      .createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');

    if (computedChallenge !== authCode.codeChallenge) {
      throw new UnauthorizedException('PKCE verification failed');
    }

    const claim = await this.oauthCodeRepository.update(
      { id: authCode.id, isUsed: false },
      { isUsed: true },
    );
    if (claim.affected !== 1) {
      this.logger.warn(`Lost race on authorization code consumption for client ${clientId}`);
      throw new UnauthorizedException('Authorization code has already been used');
    }

    const tokens = await this.generateTokenPair(
      authCode.clientId,
      authCode.gatewayId,
      authCode.organizationId,
      authCode.userId,
      authCode.scope,
      redirectUri,
    );

    this.logger.log(`Token exchanged for client ${clientId}`);
    return tokens;
  }

  async refreshToken(
    refreshTokenValue: string,
    clientId: string,
    gatewayId: string,
    clientSecret?: string,
  ): Promise<TokenResponse> {
    const client = await this.oauthClientRepository.findOne({
      where: { clientId, gatewayId, isActive: true },
    });
    if (!client) {
      throw new UnauthorizedException('Invalid client');
    }
    verifyClientAuth(client, clientSecret);

    const tokenHash = hashValue(refreshTokenValue);

    const existingToken = await this.oauthTokenRepository.findOne({
      where: { tokenHash, clientId, gatewayId, tokenType: 'refresh' },
    });

    if (!existingToken) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (existingToken.isRevoked) {
      this.logger.warn(
        `Revoked refresh token reuse detected for client ${clientId} — revoking entire token lineage for this user+gateway`,
      );
      try {
        await this.oauthTokenRepository.update(
          {
            clientId: existingToken.clientId,
            userId: existingToken.userId,
            gatewayId: existingToken.gatewayId,
            isRevoked: false,
          },
          { isRevoked: true },
        );
      } catch (err: any) {
        this.logger.error(`Failed to revoke lineage on reuse detection: ${err.message}`);
      }
      throw new UnauthorizedException('Refresh token has been revoked');
    }

    if (new Date() > existingToken.expiresAt) {
      throw new UnauthorizedException('Refresh token has expired');
    }

    const claim = await this.oauthTokenRepository.update(
      { id: existingToken.id, isRevoked: false },
      { isRevoked: true },
    );
    if (claim.affected !== 1) {
      this.logger.warn(`Lost race on refresh token rotation for client ${clientId}`);
      throw new UnauthorizedException('Refresh token has been revoked');
    }

    const tokens = await this.generateTokenPair(
      existingToken.clientId,
      existingToken.gatewayId,
      existingToken.organizationId,
      existingToken.userId,
      existingToken.scope,
      existingToken.resource ?? undefined,
      existingToken.id,
    );

    this.logger.log(`Token refreshed for client ${clientId}`);
    return tokens;
  }

  async validateAccessToken(tokenValue: string): Promise<TokenValidationResult> {
    const tokenHash = hashValue(tokenValue);

    const token = await this.oauthTokenRepository.findOne({
      where: { tokenHash, tokenType: 'access' },
    });

    if (!token) return { valid: false };
    if (token.isRevoked) return { valid: false };
    if (new Date() > token.expiresAt) return { valid: false };

    return {
      valid: true,
      clientId: token.clientId,
      userId: token.userId,
      gatewayId: token.gatewayId,
      organizationId: token.organizationId,
      scope: token.scope,
    };
  }

  async revokeToken(
    tokenValue: string,
    clientId: string,
    gatewayId: string,
    clientSecret?: string,
  ): Promise<void> {
    const client = await this.oauthClientRepository.findOne({
      where: { clientId, gatewayId, isActive: true },
    });
    if (!client) {
      return;
    }
    verifyClientAuth(client, clientSecret);

    const tokenHash = hashValue(tokenValue);

    const token = await this.oauthTokenRepository.findOne({
      where: { tokenHash, clientId, gatewayId },
    });

    if (!token) {
      return;
    }

    token.isRevoked = true;
    await this.oauthTokenRepository.save(token);

    if (token.tokenType === 'refresh') {
      await this.oauthTokenRepository.update(
        {
          clientId: token.clientId,
          userId: token.userId,
          gatewayId: token.gatewayId,
          tokenType: 'access',
          isRevoked: false,
        },
        { isRevoked: true },
      );

      this.logger.log(
        `Refresh token and associated access tokens revoked for client ${clientId}`,
      );
    } else {
      this.logger.log(`Access token revoked for client ${clientId}`);
    }
  }

  async generateTokenPair(
    clientId: string,
    gatewayId: string,
    organizationId: string,
    userId: string,
    scope: string,
    resource?: string,
    parentRefreshTokenId?: string,
  ): Promise<TokenResponse> {
    const rawAccessToken = `almyty_at_${crypto.randomBytes(48).toString('base64url')}`;
    const rawRefreshToken = `almyty_rt_${crypto.randomBytes(48).toString('base64url')}`;

    const accessTokenHash = hashValue(rawAccessToken);
    const refreshTokenHash = hashValue(rawRefreshToken);

    const now = new Date();
    const accessExpiresAt = new Date(now.getTime() + ACCESS_TOKEN_LIFETIME_SECONDS * 1000);
    const refreshExpiresAt = new Date(now.getTime() + REFRESH_TOKEN_LIFETIME_SECONDS * 1000);

    const accessTokenEntity = this.oauthTokenRepository.create({
      tokenHash: accessTokenHash,
      tokenType: 'access',
      clientId,
      userId,
      gatewayId,
      organizationId,
      scope,
      resource: resource ?? null,
      expiresAt: accessExpiresAt,
      isRevoked: false,
      parentTokenId: parentRefreshTokenId ?? null,
    });

    const refreshTokenEntity = this.oauthTokenRepository.create({
      tokenHash: refreshTokenHash,
      tokenType: 'refresh',
      clientId,
      userId,
      gatewayId,
      organizationId,
      scope,
      resource: resource ?? null,
      expiresAt: refreshExpiresAt,
      isRevoked: false,
      parentTokenId: parentRefreshTokenId ?? null,
    });

    await this.oauthTokenRepository.save([accessTokenEntity, refreshTokenEntity]);

    return {
      access_token: rawAccessToken,
      token_type: 'bearer',
      expires_in: ACCESS_TOKEN_LIFETIME_SECONDS,
      refresh_token: rawRefreshToken,
      scope,
    };
  }
}
