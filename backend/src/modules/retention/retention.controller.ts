import {
  Controller,
  Get,
  Put,
  Body,
  Param,
  Request,
  UseGuards,
  UsePipes,
  ValidationPipe,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RetentionService } from './retention.service';
import { UpdateRetentionPolicyDto } from './dto/update-retention-policy.dto';

// Mounted under /organizations so the RolesGuard can verify membership +
// role for the org in `:organizationId` (same convention as the other
// org-scoped controllers).
@Controller('organizations')
@ApiTags('Retention')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
export class RetentionController {
  constructor(private readonly retentionService: RetentionService) {}

  @Get(':organizationId/retention')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Get the organization data-retention policy' })
  @ApiResponse({ status: 200, description: 'Retention policy retrieved successfully' })
  async getRetentionPolicy(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
  ) {
    const data = await this.retentionService.getPolicy(organizationId);
    return { success: true, data, message: 'Retention policy retrieved successfully' };
  }

  @Put(':organizationId/retention')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Create or update the organization data-retention policy' })
  @ApiResponse({ status: 200, description: 'Retention policy updated successfully' })
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  async updateRetentionPolicy(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() dto: UpdateRetentionPolicyDto,
    @Request() req: any,
  ) {
    const data = await this.retentionService.upsertPolicy(organizationId, dto, req.user?.id);
    return { success: true, data, message: 'Retention policy updated successfully' };
  }
}
