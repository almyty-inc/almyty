import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-custom';
import { Request } from 'express';
import { AuthService } from '../auth.service';
import * as crypto from 'crypto';
import {
  effectiveMemberships,
  hasEffectiveMembership,
} from '../../../common/authorization/membership';

@Injectable()
export class ApiKeyStrategy extends PassportStrategy(Strategy, 'api-key') {
  constructor(private authService: AuthService) {
    super();
  }

  async validate(request: Request): Promise<any> {
    // Check for API key in headers or query params
    const apiKey = this.extractApiKey(request);
    
    if (!apiKey) {
      throw new UnauthorizedException('API key is required');
    }

    // Hash the API key
    const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
    
    // Validate the API key
    const validApiKey = await this.authService.validateApiKey(keyHash);
    
    if (!validApiKey) {
      throw new UnauthorizedException('Invalid API key');
    }

    // Build the same user shape that JwtStrategy returns so guards
    // and request handlers work identically regardless of whether
    // auth was via JWT or API key.
    const user = validApiKey.user;

    // Set the active organization. API keys are scoped to an org,
    // so we always use the key's org. Honour X-Organization-Id
    // only if it matches (prevents confusion, not a security gate).
    const headerOrgId = (request.headers?.['x-organization-id'] as string) || undefined;
    if (headerOrgId && headerOrgId !== validApiKey.organizationId) {
      throw new UnauthorizedException('API key is not scoped to the requested organization');
    }
    const keyOrgId = validApiKey.organizationId || validApiKey.organization?.id;

    // Defence in depth: the key's org has to still be one this user
    // belongs to. createApiKey refuses to stamp a foreign org on a new
    // key, and this covers the rest -- a key minted before that check
    // existed, and the ordinary case of somebody being removed from an
    // organization while holding a key scoped to it. Without it, a key
    // outlives the membership that justified it.
    if (keyOrgId) {
      if (!hasEffectiveMembership(user.organizationMemberships, keyOrgId)) {
        throw new UnauthorizedException('API key is not valid for that organization');
      }
    }

    (user as any).currentOrganizationId = keyOrgId;

    // Attach org list (matches JwtStrategy shape).
    (user as any).organizations = user.organizationMemberships
      ? effectiveMemberships(user.organizationMemberships).map((m: any) => ({
          id: m.organizationId || m.organization?.id,
          name: m.organization?.name,
          role: m.role,
        }))
      : [{ id: validApiKey.organizationId, name: validApiKey.organization?.name }];

    return user;
  }

  private extractApiKey(request: Request): string | null {
    // Check Authorization header (Bearer token format).
    const authHeader = request.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      if (token.startsWith('almyty_')) {
        return token;
      }
    }

    // Check X-API-Key header
    const apiKeyHeader = request.headers['x-api-key'] as string;
    if (apiKeyHeader) {
      return apiKeyHeader;
    }

    // Check query parameter
    const apiKeyQuery = request.query.api_key as string;
    if (apiKeyQuery) {
      return apiKeyQuery;
    }

    return null;
  }
}