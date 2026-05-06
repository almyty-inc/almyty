import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Request,
  BadRequestException,
  UseGuards,
} from '@nestjs/common';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CredentialService, CreateCredentialDto, UpdateCredentialDto } from './credential.service';

@Controller('apis')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ApisCredentialsController {
  constructor(private readonly credentialService: CredentialService) {}

  @Post(':id/credentials')
  @Roles('admin', 'owner')
  async createCredential(
    @Request() req: any,
    @Param('id') apiId: string,
    @Body() dto: CreateCredentialDto,
  ) {
    const orgId = req.user.currentOrganizationId;
    if (!orgId) throw new BadRequestException('Organization context required');
    const result = await this.credentialService.createCredential(apiId, orgId, dto);
    return { success: true, data: result, message: 'Credential created successfully' };
  }

  @Get(':id/credentials')
  @Roles('member', 'admin', 'owner')
  async getCredentials(@Request() req: any, @Param('id') apiId: string) {
    const orgId = req.user.currentOrganizationId;
    if (!orgId) throw new BadRequestException('Organization context required');
    const result = await this.credentialService.getCredentials(apiId, orgId);
    return { success: true, data: result, message: 'Credentials retrieved successfully' };
  }

  @Put(':id/credentials/:credentialId')
  @Roles('admin', 'owner')
  async updateCredential(
    @Request() req: any,
    @Param('credentialId') credentialId: string,
    @Body() dto: UpdateCredentialDto,
  ) {
    const orgId = req.user.currentOrganizationId;
    if (!orgId) throw new BadRequestException('Organization context required');
    const result = await this.credentialService.updateCredential(credentialId, orgId, dto);
    return { success: true, data: result, message: 'Credential updated successfully' };
  }

  @Delete(':id/credentials/:credentialId')
  @Roles('admin', 'owner')
  async deleteCredential(
    @Request() req: any,
    @Param('credentialId') credentialId: string,
  ) {
    const orgId = req.user.currentOrganizationId;
    if (!orgId) throw new BadRequestException('Organization context required');
    await this.credentialService.deleteCredential(credentialId, orgId);
    return { success: true, data: null, message: 'Credential deleted successfully' };
  }

  @Post(':id/credentials/:credentialId/test')
  @Roles('admin', 'owner')
  async testCredential(
    @Request() req: any,
    @Param('credentialId') credentialId: string,
  ) {
    const orgId = req.user.currentOrganizationId;
    if (!orgId) throw new BadRequestException('Organization context required');
    const result = await this.credentialService.testCredential(credentialId, orgId);
    return { success: true, data: result, message: 'Credential test completed successfully' };
  }
}
