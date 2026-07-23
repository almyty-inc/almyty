import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
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
import { SampleWorkspaceService } from './sample-workspace.service';
import { PatchOnboardingDto } from './dto/onboarding.dto';

@Controller('organizations')
@ApiTags('Onboarding')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
export class OnboardingController {
  constructor(
    private readonly onboardingService: OnboardingService,
    private readonly sampleWorkspaceService: SampleWorkspaceService,
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
  @ApiOperation({ summary: 'Update per-user onboarding preferences (dismiss card)' })
  @ApiResponse({ status: 200, description: 'Onboarding preferences updated successfully' })
  async patchOnboarding(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() body: PatchOnboardingDto,
    @Request() req: any,
  ) {
    if (typeof body.dismissed === 'boolean') {
      await this.onboardingService.setDismissed(req.user.id, body.dismissed);
    }
    const data = await this.onboardingService.getState(organizationId, req.user.id);
    return { success: true, data, message: 'Onboarding preferences updated successfully' };
  }

  @Post(':organizationId/sample-workspace')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Seed the idempotent Petstore sample workspace' })
  @ApiResponse({ status: 201, description: 'Sample workspace ready' })
  async seedSampleWorkspace(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Request() req: any,
  ) {
    const data = await this.sampleWorkspaceService.seed(organizationId, req.user.id);
    return { success: true, data, message: 'Sample workspace ready' };
  }

  @Delete(':organizationId/sample-workspace')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Delete the Petstore sample workspace and all its entities' })
  @ApiResponse({ status: 200, description: 'Sample workspace removed' })
  async deleteSampleWorkspace(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Request() req: any,
  ) {
    await this.sampleWorkspaceService.remove(organizationId, req.user.id);
    return { success: true, data: null, message: 'Sample workspace removed' };
  }
}
