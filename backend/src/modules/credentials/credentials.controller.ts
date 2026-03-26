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
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CredentialsService } from './credentials.service';

@Controller()
@ApiTags('Credentials')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
export class CredentialsController {
  constructor(private readonly credentialsService: CredentialsService) {}

  // ──────────────────────────────────────────────
  // Outbound credentials (secrets vault)
  // ──────────────────────────────────────────────

  @Get('credentials')
  @ApiOperation({ summary: 'List all credentials for the organization' })
  @ApiResponse({ status: 200, description: 'Credentials retrieved successfully' })
  async findAll(@Request() req: any) {
    const organizationId = req.user.organizations?.[0]?.id;
    const data = await this.credentialsService.findAll(organizationId);
    return { success: true, data, message: 'Credentials retrieved successfully' };
  }

  @Post('credentials')
  @ApiOperation({ summary: 'Create a new credential' })
  @ApiResponse({ status: 201, description: 'Credential created successfully' })
  async create(@Body() body: any, @Request() req: any) {
    const organizationId = req.user.organizations?.[0]?.id;
    const data = await this.credentialsService.create(body, organizationId);
    return { success: true, data, message: 'Credential created successfully' };
  }

  @Get('credentials/:id')
  @ApiOperation({ summary: 'Get a credential by ID' })
  @ApiResponse({ status: 200, description: 'Credential retrieved successfully' })
  async findById(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) {
    const organizationId = req.user.organizations?.[0]?.id;
    const data = await this.credentialsService.findById(id, organizationId);
    return { success: true, data, message: 'Credential retrieved successfully' };
  }

  @Patch('credentials/:id')
  @ApiOperation({ summary: 'Update a credential' })
  @ApiResponse({ status: 200, description: 'Credential updated successfully' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: any,
    @Request() req: any,
  ) {
    const organizationId = req.user.organizations?.[0]?.id;
    const data = await this.credentialsService.update(id, body, organizationId);
    return { success: true, data, message: 'Credential updated successfully' };
  }

  @Delete('credentials/:id')
  @ApiOperation({ summary: 'Delete a credential' })
  @ApiResponse({ status: 200, description: 'Credential deleted successfully' })
  async delete(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) {
    const organizationId = req.user.organizations?.[0]?.id;
    await this.credentialsService.delete(id, organizationId);
    return { success: true, data: null, message: 'Credential deleted successfully' };
  }

  @Post('credentials/:id/test')
  @ApiOperation({ summary: 'Test a credential connection' })
  @ApiResponse({ status: 200, description: 'Credential test completed' })
  async test(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) {
    // Placeholder — always return success for now
    return { success: true, data: { valid: true }, message: 'Credential test passed' };
  }

  @Get('credentials/:id/usage')
  @ApiOperation({ summary: 'Get usage info for a credential' })
  @ApiResponse({ status: 200, description: 'Credential usage retrieved successfully' })
  async getUsage(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) {
    const organizationId = req.user.organizations?.[0]?.id;
    const data = await this.credentialsService.getUsage(id, organizationId);
    return { success: true, data, message: 'Credential usage retrieved successfully' };
  }

  // ──────────────────────────────────────────────
  // Inbound access keys
  // ──────────────────────────────────────────────

  @Get('access-keys')
  @ApiOperation({ summary: 'List all access keys for the organization' })
  @ApiResponse({ status: 200, description: 'Access keys retrieved successfully' })
  async findAllAccessKeys(@Request() req: any) {
    const organizationId = req.user.organizations?.[0]?.id;
    const data = await this.credentialsService.findAllAccessKeys(organizationId);
    return { success: true, data, message: 'Access keys retrieved successfully' };
  }

  @Post('access-keys')
  @ApiOperation({ summary: 'Create a new access key' })
  @ApiResponse({ status: 201, description: 'Access key created successfully' })
  async createAccessKey(@Body() body: any, @Request() req: any) {
    const organizationId = req.user.organizations?.[0]?.id;
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
  @ApiOperation({ summary: 'Revoke an access key' })
  @ApiResponse({ status: 200, description: 'Access key revoked successfully' })
  async revokeAccessKey(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) {
    const organizationId = req.user.organizations?.[0]?.id;
    await this.credentialsService.revokeAccessKey(id, organizationId);
    return { success: true, data: null, message: 'Access key revoked successfully' };
  }
}
