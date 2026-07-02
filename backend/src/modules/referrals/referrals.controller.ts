import {
  BadRequestException,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Query,
  Request,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Public } from '../../common/decorators/public.decorator';
import { ReferralsService } from './referrals.service';
import { REFERRAL_COOKIE, REFERRAL_COOKIE_MAX_AGE_MS, clientIpOf } from './referrals.constants';

@ApiTags('Referrals')
@Controller('referrals')
export class ReferralsController {
  constructor(private readonly referralsService: ReferralsService) {}

  private userId(req: any): string {
    return req.user.id || req.user.sub;
  }

  private orgId(req: any): string {
    const organizationId = req.user.currentOrganizationId;
    if (!organizationId) {
      throw new HttpException(
        { success: false, message: 'No organization found', error: 'NO_ORGANIZATION' },
        HttpStatus.BAD_REQUEST,
      );
    }
    return organizationId;
  }

  @Get('code')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create-or-get the caller referral code + share link' })
  async getCode(@Request() req: any) {
    const code = await this.referralsService.getOrCreateCode(
      this.userId(req),
      this.orgId(req),
      clientIpOf(req),
    );
    return {
      success: true,
      data: { code: code.code, link: this.referralsService.buildShareLink(code.code) },
    };
  }

  @Get('stats')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Referral stats for the caller (own referrals only)' })
  async getStats(@Request() req: any) {
    return { success: true, data: await this.referralsService.getStats(this.userId(req)) };
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List the caller referrals (own referrals only)' })
  async list(@Request() req: any) {
    return { success: true, data: await this.referralsService.listReferrals(this.userId(req)) };
  }

  /**
   * Attribution entry point for `<FRONTEND_URL>/r/<code>` links. Sets the
   * 30-day attribution cookie on the API origin (so it rides along with the
   * register API call) and 302s to the register page. With `?format=json`
   * it returns JSON instead — used by the register page for `?ref=` links.
   *
   * Per-IP throttled: this is an unauthenticated write-ish surface.
   */
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60 * 60 * 1000 } })
  @Get('attribute/:code')
  @ApiParam({ name: 'code', description: 'Referral code' })
  @ApiOperation({ summary: 'Set the referral attribution cookie and redirect to register' })
  async attribute(
    @Param('code') rawCode: string,
    @Query('format') format: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const wantsJson = format === 'json';
    if (!rawCode || rawCode.length > 32 || !/^[a-zA-Z0-9]+$/.test(rawCode)) {
      if (wantsJson) throw new BadRequestException('Invalid referral code');
      return this.redirectToRegister(res);
    }

    const code = await this.referralsService.findActiveCode(rawCode);
    if (code) {
      res.cookie(REFERRAL_COOKIE, code.code, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: REFERRAL_COOKIE_MAX_AGE_MS,
      });
    }

    if (wantsJson) {
      return { success: true, data: { attributed: !!code } };
    }
    return this.redirectToRegister(res);
  }

  private redirectToRegister(res: Response) {
    const base = (process.env.FRONTEND_URL || 'http://localhost:3002').replace(/\/+$/, '');
    res.redirect(HttpStatus.FOUND, `${base}/auth/register`);
    return undefined;
  }
}
