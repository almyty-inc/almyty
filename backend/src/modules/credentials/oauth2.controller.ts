import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Res,
  UseGuards,
  Request,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { OAuth2Service, OAuth2Preset } from './oauth2.service';

@Controller('credentials/oauth2')
@ApiTags('OAuth2')
export class OAuth2Controller {
  private readonly logger = new Logger(OAuth2Controller.name);

  constructor(private readonly oauth2Service: OAuth2Service) {}

  @Get('presets')
  async getPresets() {
    const data: Record<string, OAuth2Preset> = this.oauth2Service.getPresets();
    return { success: true, data };
  }

  @Post('authorize')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('member', 'admin', 'owner')
  async authorize(@Body() body: any, @Request() req: any) {
    try {
      const organizationId =
        req.user.currentOrganizationId || req.user.organizations?.[0]?.id;
      const result = await this.oauth2Service.generateAuthorizationUrl({
        ...body,
        organizationId,
        userId: req.user.sub || req.user.id,
      });
      return { success: true, data: result };
    } catch (error: any) {
      throw new HttpException(
        { success: false, message: error.message },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('callback')
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ) {
    try {
      const result = await this.oauth2Service.handleCallback(code, state);
      // Redirect to frontend with success
      const frontendUrl =
        process.env.FRONTEND_URL || 'https://app.staging.almyty.com';
      res.redirect(
        `${frontendUrl}/credentials?oauth=success&credentialId=${result.credentialId}`,
      );
    } catch (error: any) {
      this.logger.error(`OAuth2 callback failed: ${error.message}`);
      const frontendUrl =
        process.env.FRONTEND_URL || 'https://app.staging.almyty.com';
      res.redirect(
        `${frontendUrl}/credentials?oauth=error&message=${encodeURIComponent(error.message)}`,
      );
    }
  }

  @Post('client-credentials')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('member', 'admin', 'owner')
  async clientCredentials(@Body() body: any, @Request() req: any) {
    try {
      const organizationId =
        req.user.currentOrganizationId || req.user.organizations?.[0]?.id;
      const result = await this.oauth2Service.clientCredentialsGrant({
        ...body,
        organizationId,
      });
      return { success: true, data: result };
    } catch (error: any) {
      throw new HttpException(
        { success: false, message: error.message },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }
}
