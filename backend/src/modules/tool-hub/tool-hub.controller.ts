import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  ParseUUIDPipe,
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
import { PublishToolTemplateDto, UpdateToolTemplateDto } from './dto/tool-hub.dto';

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
      const orgId = req.user.currentOrganizationId;
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
      const orgId = req.user.currentOrganizationId;
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
  async getCategories(@Request() req) {
    try {
      // Thread the caller's current org through so the service can
      // apply the same public-or-own-org visibility rule getProviders
      // already uses. Without it, private templates from other
      // tenants would leak their category distribution.
      const orgId = req.user?.currentOrganizationId;
      const categories = await this.toolHubService.getCategories(orgId);
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
  async getTemplate(@Param('id') id: string, @Request() req) {
    try {
      const orgId = req.user.currentOrganizationId;
      const template = await this.toolHubService.getTemplate(id, orgId);
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
      const orgId = req.user.currentOrganizationId;
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
      const orgId = req.user.currentOrganizationId;
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

  /**
   * Publish one of the caller's tools as a template.
   *
   * The organization is read from the request, never from the body, and
   * the service stamps it on the row. There is no route on this
   * controller -- or anywhere else -- that creates, edits or deletes a
   * template with `organizationId IS NULL`, so an org member cannot
   * publish into the public catalog every tenant reads.
   */
  @Post('templates')
  @Roles('member', 'admin', 'owner')
  async publishTemplate(@Body() dto: PublishToolTemplateDto, @Request() req) {
    try {
      const orgId = req.user.currentOrganizationId;
      if (!orgId) {
        throw new HttpException(
          { success: false, message: 'No organization found' },
          HttpStatus.BAD_REQUEST,
        );
      }
      const userId = req.user.id || req.user.sub;
      const template = await this.toolHubService.publishTool(orgId, userId, dto);
      return { success: true, data: template, message: 'Tool published to the hub' };
    } catch (error) {
      throw new HttpException(
        { success: false, message: error.message, error: 'TEMPLATE_PUBLISH_FAILED' },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Patch('templates/:id')
  @Roles('member', 'admin', 'owner')
  async updateTemplate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateToolTemplateDto,
    @Request() req,
  ) {
    try {
      const orgId = req.user.currentOrganizationId;
      if (!orgId) {
        throw new HttpException(
          { success: false, message: 'No organization found' },
          HttpStatus.BAD_REQUEST,
        );
      }
      const userId = req.user.id || req.user.sub;
      const template = await this.toolHubService.updateTemplate(id, orgId, userId, dto);
      return { success: true, data: template, message: 'Template updated' };
    } catch (error) {
      throw new HttpException(
        { success: false, message: error.message, error: 'TEMPLATE_UPDATE_FAILED' },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  /** Retract a template this organization published. */
  @Delete('templates/:id')
  @Roles('admin', 'owner')
  async deleteTemplate(@Param('id', ParseUUIDPipe) id: string, @Request() req) {
    try {
      const orgId = req.user.currentOrganizationId;
      if (!orgId) {
        throw new HttpException(
          { success: false, message: 'No organization found' },
          HttpStatus.BAD_REQUEST,
        );
      }
      const userId = req.user.id || req.user.sub;
      await this.toolHubService.deleteTemplate(id, orgId, userId);
      return { success: true, data: { id }, message: 'Template retracted' };
    } catch (error) {
      throw new HttpException(
        { success: false, message: error.message, error: 'TEMPLATE_DELETE_FAILED' },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }
}
