import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  UseGuards,
  Request,
  ParseUUIDPipe,
  ValidationPipe,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { McpSourcesService } from './mcp-sources.service';
import { McpClientError } from './mcp-client.service';
import { CreateMcpSourceDto } from './dto/mcp-sources.dto';

@Controller('organizations/:organizationId/mcp-sources')
@ApiTags('MCP Sources')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
export class McpSourcesController {
  constructor(private readonly mcpSourcesService: McpSourcesService) {}

  @Post()
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Register an external MCP server and run initial tool discovery' })
  @ApiResponse({ status: 201, description: 'MCP source created' })
  async create(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body(ValidationPipe) dto: CreateMcpSourceDto,
    @Request() req: any,
  ) {
    try {
      const result = await this.mcpSourcesService.create(dto, organizationId, req.user?.id);
      return {
        success: true,
        data: result,
        message: result.syncError
          ? `MCP source created, but initial sync failed: ${result.syncError}`
          : `MCP source created; ${result.sync?.total ?? 0} tools discovered`,
      };
    } catch (error) {
      throw this.mapError(error, 'MCP_SOURCE_CREATION_FAILED');
    }
  }

  @Get()
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'List MCP sources for the organization' })
  async findAll(@Param('organizationId', ParseUUIDPipe) organizationId: string) {
    const sources = await this.mcpSourcesService.findAll(organizationId);
    return { success: true, data: sources };
  }

  @Get(':id')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Get one MCP source' })
  async findOne(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const source = await this.mcpSourcesService.findOne(id, organizationId);
    return { success: true, data: source };
  }

  @Post(':id/sync')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Re-run tool discovery against the MCP server' })
  @ApiResponse({ status: 200, description: 'Sync completed' })
  async sync(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    try {
      const summary = await this.mcpSourcesService.sync(id, organizationId);
      return { success: true, data: summary, message: 'MCP source synced' };
    } catch (error) {
      throw this.mapError(error, 'MCP_SOURCE_SYNC_FAILED');
    }
  }

  @Delete(':id')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Delete an MCP source and all tools discovered from it' })
  async remove(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const result = await this.mcpSourcesService.remove(id, organizationId);
    return {
      success: true,
      data: result,
      message: `MCP source deleted (${result.removedTools} tools removed)`,
    };
  }

  /**
   * Remote/transport failures surface as 502 (upstream problem, not
   * ours); blocked URLs as 400. HttpExceptions pass through untouched.
   */
  private mapError(error: any, fallbackCode: string): HttpException {
    if (error instanceof HttpException) return error;
    if (error instanceof McpClientError) {
      const status =
        error.code === 'MCP_URL_BLOCKED' ? HttpStatus.BAD_REQUEST : HttpStatus.BAD_GATEWAY;
      return new HttpException(
        { success: false, message: error.message, error: error.code },
        status,
      );
    }
    return new HttpException(
      { success: false, message: error?.message ?? 'Unexpected error', error: fallbackCode },
      HttpStatus.BAD_REQUEST,
    );
  }
}
