import { Body, Controller, Delete, Get, HttpException, HttpStatus, Param, ParseUUIDPipe, Post, Request, UseGuards, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsArray, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ModelVersionsService } from './model-versions.service';

export class RegisterModelVersionBodyDto {
  @IsString() @MaxLength(255) name: string;
  @IsString() @MaxLength(2000) registryUri: string;
  @IsOptional() @IsString() @MaxLength(255) base?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) quantizations?: string[];
  @IsOptional() @IsObject() lineage?: Record<string, any>;
  @IsOptional() @IsObject() metadata?: Record<string, any>;
}

@ApiTags('Model versions')
@ApiBearerAuth()
@Controller('model-versions')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ModelVersionsController {
  constructor(private readonly versions: ModelVersionsService) {}

  private orgId(req: any): string {
    const organizationId = req.user?.currentOrganizationId;
    if (!organizationId) {
      throw new HttpException({ success: false, message: 'No organization found for user', error: 'NO_ORGANIZATION' }, HttpStatus.BAD_REQUEST);
    }
    return organizationId;
  }

  @Get()
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'List registered model versions' })
  async list(@Request() req: any) {
    return { success: true, data: await this.versions.list(this.orgId(req)) };
  }

  @Post()
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Register a pinned registry URI as a version' })
  async register(@Request() req: any, @Body(ValidationPipe) body: RegisterModelVersionBodyDto) {
    return { success: true, data: await this.versions.register(this.orgId(req), body as any, req.user?.id) };
  }

  @Get(':id')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Version detail with manifest summary' })
  async get(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    return { success: true, data: await this.versions.get(this.orgId(req), id) };
  }

  @Delete(':id')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Remove a version that no live deployment references' })
  async remove(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    await this.versions.remove(this.orgId(req), id, req.user?.id);
    return { success: true };
  }
}
