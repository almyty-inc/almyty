import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  Request,
  ParseUUIDPipe,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CredentialsService } from './credentials.service';

@Controller()
@ApiTags('Credentials')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
export class CredentialsController {
  constructor(private readonly credentialsService: CredentialsService) {}

  // Extract the caller's current org and reject multi-org users who
  // didn't send an X-Organization-Id header. Previously this controller
  // silently read `req.user.organizations?.[0]?.id`, meaning a user in
  // two orgs would always operate on the alphabetically-first org —
  // including reading/writing AES-encrypted credential blobs — without
  // any indication that the requested org was ignored.
  private requireOrg(req: any): string {
    const organizationId = req.user?.currentOrganizationId;
    if (!organizationId) {
      throw new HttpException(
        {
          success: false,
          message:
            'Organization context required. Multi-org users must send the X-Organization-Id header.',
          error: 'NO_ORGANIZATION',
        },
        HttpStatus.BAD_REQUEST,
      );
    }
    return organizationId;
  }

  // ──────────────────────────────────────────────
  // Outbound credentials (secrets vault)
  // ──────────────────────────────────────────────

  @Get('credentials')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'List all credentials for the organization' })
  @ApiResponse({ status: 200, description: 'Credentials retrieved successfully' })
  async findAll(@Request() req: any) {
    const organizationId = this.requireOrg(req);
    const data = await this.credentialsService.findAll({ id: req.user.id }, organizationId);
    return { success: true, data, message: 'Credentials retrieved successfully' };
  }

  @Post('credentials')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Create a new credential' })
  @ApiResponse({ status: 201, description: 'Credential created successfully' })
  async create(@Body() body: any, @Request() req: any) {
    const organizationId = this.requireOrg(req);
    const data = await this.credentialsService.create(body, organizationId, req.user.id);
    return { success: true, data, message: 'Credential created successfully' };
  }

  @Get('credentials/:id')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Get a credential by ID' })
  @ApiResponse({ status: 200, description: 'Credential retrieved successfully' })
  async findById(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) {
    const organizationId = this.requireOrg(req);
    const data = await this.credentialsService.findById(id, organizationId);
    return { success: true, data, message: 'Credential retrieved successfully' };
  }

  @Patch('credentials/:id')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Update a credential' })
  @ApiResponse({ status: 200, description: 'Credential updated successfully' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: any,
    @Request() req: any,
  ) {
    const organizationId = this.requireOrg(req);
    const data = await this.credentialsService.update(id, body, organizationId, req.user.id);
    return { success: true, data, message: 'Credential updated successfully' };
  }

  @Delete('credentials/:id')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Delete a credential' })
  @ApiResponse({ status: 200, description: 'Credential deleted successfully' })
  async delete(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) {
    const organizationId = this.requireOrg(req);
    await this.credentialsService.delete(id, organizationId, req.user.id);
    return { success: true, data: null, message: 'Credential deleted successfully' };
  }

  @Post('credentials/:id/test')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Test a credential connection' })
  @ApiResponse({ status: 200, description: 'Credential test completed' })
  async test(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) {
    // Verify the credential exists in the caller's org before reporting.
    // Without this the endpoint would return success for any UUID,
    // acting as a membership oracle for other orgs' credential ids.
    const organizationId = this.requireOrg(req);
    await this.credentialsService.findById(id, organizationId);
    return { success: true, data: { valid: true }, message: 'Credential test passed' };
  }

  @Get('credentials/:id/usage')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Get usage info for a credential' })
  @ApiResponse({ status: 200, description: 'Credential usage retrieved successfully' })
  async getUsage(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) {
    const organizationId = this.requireOrg(req);
    const data = await this.credentialsService.getUsage(id, organizationId);
    return { success: true, data, message: 'Credential usage retrieved successfully' };
  }

  // ──────────────────────────────────────────────
  // Inbound access keys
  // ──────────────────────────────────────────────

  @Get('access-keys')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'List all access keys for the organization' })
  @ApiResponse({ status: 200, description: 'Access keys retrieved successfully' })
  async findAllAccessKeys(@Request() req: any) {
    const organizationId = this.requireOrg(req);
    const data = await this.credentialsService.findAllAccessKeys(organizationId);
    return { success: true, data, message: 'Access keys retrieved successfully' };
  }

  @Post('access-keys')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Create a new access key' })
  @ApiResponse({ status: 201, description: 'Access key created successfully' })
  async createAccessKey(@Body() body: any, @Request() req: any) {
    const organizationId = this.requireOrg(req);
    const userId = req.user.id;
    const { key, plainTextKey } = await this.credentialsService.createAccessKey(
      body,
      organizationId,
      userId,
    );
    return {
      success: true,
      data: { ...key, plainTextKey },
      message: 'Access key created successfully. Store the key securely — it will not be shown again.',
    };
  }

  @Delete('access-keys/:id')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Revoke an access key' })
  @ApiResponse({ status: 200, description: 'Access key revoked successfully' })
  async revokeAccessKey(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) {
    const organizationId = this.requireOrg(req);
    await this.credentialsService.revokeAccessKey(id, organizationId);
    return { success: true, data: null, message: 'Access key revoked successfully' };
  }
}
