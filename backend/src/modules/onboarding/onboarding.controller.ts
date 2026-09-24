import {
  Controller,
  Get,
  Patch,
  Body,
  Param,
  Request,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { OnboardingService } from './onboarding.service';
import { PatchOnboardingDto } from './dto/onboarding.dto';

@Controller('organizations')
@ApiTags('Onboarding')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
export class OnboardingController {
  constructor(
    private readonly onboardingService: OnboardingService,
  ) {}

  @Get(':organizationId/onboarding')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Get onboarding checklist state (computed from entity state)' })
  @ApiResponse({ status: 200, description: 'Onboarding state retrieved successfully' })
  async getOnboarding(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Request() req: any,
  ) {
    const data = await this.onboardingService.getState(organizationId, req.user.id);
    return { success: true, data, message: 'Onboarding state retrieved successfully' };
  }

  @Patch(':organizationId/onboarding')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Update per-user onboarding preferences (dismiss the guide card, close or restore page intros)' })
  @ApiResponse({ status: 200, description: 'Onboarding preferences updated successfully' })
  async patchOnboarding(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() body: PatchOnboardingDto,
    @Request() req: any,
  ) {
    if (typeof body.dismissed === 'boolean') {
      await this.onboardingService.setDismissed(req.user.id, body.dismissed);
    }
    if (body.resetIntros === true) {
      await this.onboardingService.resetIntros(req.user.id);
    }
    if (body.dismissIntro) {
      await this.onboardingService.dismissIntro(req.user.id, body.dismissIntro);
    }
    const data = await this.onboardingService.getState(organizationId, req.user.id);
    return { success: true, data, message: 'Onboarding preferences updated successfully' };
  }
}
