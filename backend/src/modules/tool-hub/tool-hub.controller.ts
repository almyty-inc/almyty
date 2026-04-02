import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ToolHubService } from './tool-hub.service';

@Controller('tool-hub')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ToolHubController {
  constructor(private readonly toolHubService: ToolHubService) {}

  @Get('templates')
  @Roles('member', 'admin', 'owner')
  async listTemplates(
    @Request() req,
    @Query('category') category?: string,
    @Query('provider') provider?: string,
    @Query('search') search?: string,
    @Query('page') page = 1,
    @Query('limit') limit = 20,
  ) {
    try {
      const orgId = req.user.currentOrganizationId || req.user.organizations?.[0]?.id;
      const result = await this.toolHubService.listTemplates(
        {
          category,
          provider,
          search,
          page: parseInt(page.toString()),
          limit: parseInt(limit.toString()),
        },
        orgId,
      );
      return { success: true, data: result, message: 'Templates retrieved successfully' };
    } catch (error) {
      throw new HttpException(
        { success: false, message: error.message, error: 'TEMPLATES_LIST_FAILED' },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('providers')
  @Roles('member', 'admin', 'owner')
  async getProviders(@Request() req) {
    try {
      const orgId = req.user.currentOrganizationId || req.user.organizations?.[0]?.id;
      const providers = await this.toolHubService.getProviders(orgId);
      return { success: true, data: providers, message: 'Providers retrieved successfully' };
    } catch (error) {
      throw new HttpException(
        { success: false, message: error.message, error: 'PROVIDERS_LIST_FAILED' },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('categories')
  @Roles('member', 'admin', 'owner')
  async getCategories() {
    try {
      const categories = await this.toolHubService.getCategories();
      return { success: true, data: categories, message: 'Categories retrieved successfully' };
    } catch (error) {
      throw new HttpException(
        { success: false, message: error.message, error: 'CATEGORIES_LIST_FAILED' },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('templates/:id')
  @Roles('member', 'admin', 'owner')
  async getTemplate(@Param('id') id: string) {
    try {
      const template = await this.toolHubService.getTemplate(id);
      return { success: true, data: template, message: 'Template retrieved successfully' };
    } catch (error) {
      throw new HttpException(
        { success: false, message: error.message, error: 'TEMPLATE_NOT_FOUND' },
        error.status || HttpStatus.NOT_FOUND,
      );
    }
  }

  @Post('templates/:id/install')
  @Roles('member', 'admin', 'owner')
  async installTemplate(
    @Param('id') id: string,
    @Body() body: { existingApiId?: string; credentialId?: string },
    @Request() req,
  ) {
    try {
      const orgId = req.user.currentOrganizationId || req.user.organizations?.[0]?.id;
      if (!orgId) {
        throw new HttpException(
          { success: false, message: 'No organization found' },
          HttpStatus.BAD_REQUEST,
        );
      }
      const userId = req.user.id || req.user.sub;
      const result = await this.toolHubService.installTemplate(id, orgId, userId, body);
      return { success: true, data: result, message: 'Template installed successfully' };
    } catch (error) {
      throw new HttpException(
        { success: false, message: error.message, error: 'TEMPLATE_INSTALL_FAILED' },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('providers/:provider/install')
  @Roles('member', 'admin', 'owner')
  async installProviderTemplates(
    @Param('provider') provider: string,
    @Body() body: { existingApiId?: string; credentialId?: string },
    @Request() req,
  ) {
    try {
      const orgId = req.user.currentOrganizationId || req.user.organizations?.[0]?.id;
      if (!orgId) {
        throw new HttpException(
          { success: false, message: 'No organization found' },
          HttpStatus.BAD_REQUEST,
        );
      }
      const userId = req.user.id || req.user.sub;
      const result = await this.toolHubService.installProviderTemplates(provider, orgId, userId, body);
      return { success: true, data: result, message: 'Provider templates installed successfully' };
    } catch (error) {
      throw new HttpException(
        { success: false, message: error.message, error: 'PROVIDER_INSTALL_FAILED' },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }
}
