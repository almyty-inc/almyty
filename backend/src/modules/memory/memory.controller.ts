import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query,
  UseGuards, Request, ParseUUIDPipe, HttpStatus, HttpException, Logger,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { MemoryService } from './memory.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { MemoryType, MemoryScope } from '../../entities/memory.entity';

@Controller('memories')
@ApiTags('Memories')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
export class MemoryController {
  private readonly logger = new Logger(MemoryController.name);

  constructor(private readonly memoryService: MemoryService) {}

  private getOrgId(req: any): string {
    const organizationId = req.user.currentOrganizationId || req.user.organizations?.[0]?.id;
    if (!organizationId) {
      throw new HttpException(
        { success: false, message: 'No organization found', error: 'NO_ORGANIZATION' },
        HttpStatus.BAD_REQUEST,
      );
    }
    return organizationId;
  }

  @Get()
  @Roles('viewer', 'member', 'admin', 'owner')
  async findAll(
    @Query() query: {
      type?: MemoryType;
      scope?: MemoryScope;
      agentId?: string;
      tags?: string;
      search?: string;
      page?: string;
      limit?: string;
    },
    @Request() req: any,
  ) {
    try {
      const organizationId = this.getOrgId(req);
      const result = await this.memoryService.findAll({
        organizationId,
        type: query.type,
        scope: query.scope,
        agentId: query.agentId,
        tags: query.tags ? query.tags.split(',') : undefined,
        search: query.search,
        page: query.page ? parseInt(query.page) : 1,
        limit: query.limit ? parseInt(query.limit) : 50,
      });
      return { success: true, data: result.data, pagination: { total: result.total, page: result.page, limit: result.limit, totalPages: result.totalPages } };
    } catch (error) {
      throw new HttpException({ success: false, message: error.message, error: 'MEMORIES_FETCH_FAILED' }, error.status || HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post()
  @Roles('member', 'admin', 'owner')
  async create(@Body() body: {
    content: string;
    type: MemoryType;
    scope?: MemoryScope;
    agentIds?: string[];
    tags?: string[];
    source?: { type: string; id?: string; name?: string };
    metadata?: Record<string, any>;
  }, @Request() req: any) {
    try {
      const organizationId = this.getOrgId(req);
      const userId = req.user.sub || req.user.id;
      const memory = await this.memoryService.create(organizationId, body, userId);
      return { success: true, data: memory, message: 'Memory created successfully' };
    } catch (error) {
      throw new HttpException({ success: false, message: error.message, error: 'MEMORY_CREATE_FAILED' }, error.status || HttpStatus.BAD_REQUEST);
    }
  }

  @Get('tags')
  @Roles('viewer', 'member', 'admin', 'owner')
  async getTags(@Request() req: any) {
    try {
      const organizationId = this.getOrgId(req);
      const tags = await this.memoryService.getTags(organizationId);
      return { success: true, data: tags };
    } catch (error) {
      throw new HttpException({ success: false, message: error.message, error: 'TAGS_FETCH_FAILED' }, error.status || HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post('search')
  @Roles('viewer', 'member', 'admin', 'owner')
  async search(@Body() body: {
    query: string;
    agentId?: string;
    limit?: number;
    scope?: MemoryScope;
    type?: MemoryType;
  }, @Request() req: any) {
    try {
      const organizationId = this.getOrgId(req);
      const results = await this.memoryService.search(organizationId, body.query, {
        agentId: body.agentId,
        limit: body.limit,
        scope: body.scope,
        type: body.type,
      });
      return { success: true, data: results };
    } catch (error) {
      throw new HttpException({ success: false, message: error.message, error: 'MEMORY_SEARCH_FAILED' }, error.status || HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post('bulk')
  @Roles('admin', 'owner')
  async bulkCreate(@Body() body: {
    items: Array<{
      content: string;
      type: MemoryType;
      scope?: MemoryScope;
      agentIds?: string[];
      tags?: string[];
    }>;
  }, @Request() req: any) {
    try {
      const organizationId = this.getOrgId(req);
      const userId = req.user.sub || req.user.id;
      const memories = await this.memoryService.bulkCreate(organizationId, body.items, userId);
      return { success: true, data: memories, message: `${memories.length} memories created` };
    } catch (error) {
      throw new HttpException({ success: false, message: error.message, error: 'BULK_CREATE_FAILED' }, error.status || HttpStatus.BAD_REQUEST);
    }
  }

  @Get(':id')
  @Roles('viewer', 'member', 'admin', 'owner')
  async findById(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) {
    try {
      const organizationId = this.getOrgId(req);
      const memory = await this.memoryService.findById(id, organizationId);
      return { success: true, data: memory };
    } catch (error) {
      throw new HttpException({ success: false, message: error.message, error: 'MEMORY_FETCH_FAILED' }, error.status || HttpStatus.NOT_FOUND);
    }
  }

  @Patch(':id')
  @Roles('member', 'admin', 'owner')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() body: Partial<{
    content: string;
    type: MemoryType;
    scope: MemoryScope;
    agentIds: string[];
    tags: string[];
    isActive: boolean;
    metadata: Record<string, any>;
  }>, @Request() req: any) {
    try {
      const organizationId = this.getOrgId(req);
      const memory = await this.memoryService.update(id, organizationId, body);
      return { success: true, data: memory, message: 'Memory updated successfully' };
    } catch (error) {
      throw new HttpException({ success: false, message: error.message, error: 'MEMORY_UPDATE_FAILED' }, error.status || HttpStatus.BAD_REQUEST);
    }
  }

  @Delete(':id')
  @Roles('member', 'admin', 'owner')
  async remove(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) {
    try {
      const organizationId = this.getOrgId(req);
      await this.memoryService.remove(id, organizationId);
      return { success: true, message: 'Memory deleted successfully' };
    } catch (error) {
      throw new HttpException({ success: false, message: error.message, error: 'MEMORY_DELETE_FAILED' }, error.status || HttpStatus.BAD_REQUEST);
    }
  }
}
