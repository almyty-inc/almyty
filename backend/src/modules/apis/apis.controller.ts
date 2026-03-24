import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ApisService } from './apis.service';
import { CredentialService, CreateCredentialDto, UpdateCredentialDto } from './credential.service';
import { CreateApiDto, UpdateApiDto, ImportSchemaDto } from './dto/api.dto';
import { Api, ApiType, ApiStatus } from '../../entities/api.entity';
import { SchemaParserService } from '../schema-parser/schema-parser.service';

@Controller('apis')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ApisController {
  constructor(
    private readonly apisService: ApisService,
    private readonly credentialService: CredentialService,
    private readonly schemaParserService: SchemaParserService,
    @InjectQueue('schema-import') private readonly schemaImportQueue: Queue,
  ) {}

  @Get()
  @Roles('member', 'admin', 'owner')
  async findAll(
    @Request() req,
    @Query('organizationId') organizationId?: string,
    @Query('type') type?: ApiType,
    @Query('status') status?: ApiStatus,
    @Query('page') page = 1,
    @Query('limit') limit = 10,
  ) {
    const orgId = organizationId || req.user.currentOrganizationId;
    if (!orgId) {
      throw new BadRequestException('Organization ID is required');
    }

    const result = await this.apisService.findAllByOrganization(orgId, {
      type,
      status,
      page: parseInt(page.toString()),
      limit: parseInt(limit.toString()),
    });

    return { success: true, data: result, message: 'APIs retrieved successfully' };
  }

  @Get(':id')
  @Roles('member', 'admin', 'owner')
  async findOne(@Request() req, @Param('id') id: string) {
    const api = await this.apisService.findOne(id);
    
    if (!api) {
      throw new NotFoundException('API not found');
    }

    if (api.organizationId !== req.user.currentOrganizationId) {
      throw new ForbiddenException('Access denied');
    }

    return { success: true, data: api, message: 'API retrieved successfully' };
  }

  @Post()
  @Roles('admin', 'owner')
  async create(@Request() req, @Body() createApiDto: CreateApiDto) {
    if (!req.user.currentOrganizationId) {
      throw new BadRequestException('Organization context required');
    }

    const result = await this.apisService.create({
      ...createApiDto,
      organizationId: req.user.currentOrganizationId,
    });

    return { success: true, data: result, message: 'API created successfully' };
  }

  @Put(':id')
  @Roles('admin', 'owner')
  async update(
    @Request() req,
    @Param('id') id: string,
    @Body() updateApiDto: UpdateApiDto,
  ) {
    const api = await this.apisService.findOne(id);
    
    if (!api) {
      throw new NotFoundException('API not found');
    }

    if (api.organizationId !== req.user.currentOrganizationId) {
      throw new ForbiddenException('Access denied');
    }

    const result = await this.apisService.update(id, updateApiDto);

    return { success: true, data: result, message: 'API updated successfully' };
  }

  @Delete(':id')
  @Roles('admin', 'owner')
  async remove(@Request() req, @Param('id') id: string) {
    const api = await this.apisService.findOne(id);
    
    if (!api) {
      throw new NotFoundException('API not found');
    }

    if (api.organizationId !== req.user.currentOrganizationId) {
      throw new ForbiddenException('Access denied');
    }

    await this.apisService.remove(id);

    return { success: true, data: null, message: 'API deleted successfully' };
  }

  @Post(':id/import-schema')
  @Roles('admin', 'owner')
  @UseInterceptors(FileInterceptor('schema'))
  async importSchema(
    @Request() req,
    @Param('id') id: string,
    @Body() importSchemaDto: ImportSchemaDto,
    @UploadedFile() file?: any,
  ) {
    const api = await this.apisService.findOne(id);

    if (!api) {
      throw new NotFoundException('API not found');
    }

    if (api.organizationId !== req.user.currentOrganizationId) {
      throw new ForbiddenException('Access denied');
    }

    let schemaContent: string;

    if (file) {
      schemaContent = file.buffer.toString('utf-8');
    } else if (importSchemaDto.schemaUrl) {
      schemaContent = await this.apisService.fetchSchemaFromUrl(importSchemaDto.schemaUrl);
    } else if (importSchemaDto.schemaContent) {
      schemaContent = importSchemaDto.schemaContent;
    } else {
      throw new BadRequestException('Schema content, file, or URL is required');
    }

    // Queue the import job instead of processing synchronously
    const job = await this.schemaImportQueue.add('import', {
      apiId: id,
      schemaContent,
      options: {
        fileName: file?.originalname,
        description: importSchemaDto.description,
        generateTools: importSchemaDto.generateTools ?? true,
      },
    });

    // Return immediately with job ID
    return {
      success: true,
      data: {
        jobId: job.id,
        status: 'processing',
      },
      message: 'Schema import started in background',
    };
  }

  @Get(':id/import-status/:jobId')
  @Roles('member', 'admin', 'owner')
  async getImportStatus(@Param('id') id: string, @Param('jobId') jobId: string) {
    const job = await this.schemaImportQueue.getJob(jobId);

    if (!job) {
      throw new NotFoundException('Job not found');
    }

    const state = await job.getState();
    const progress = job.progress();

    if (state === 'completed') {
      return {
        success: true,
        data: {
          status: 'completed',
          progress: 100,
          result: job.returnvalue,
        },
        message: 'Import completed successfully',
      };
    } else if (state === 'failed') {
      return {
        success: true,
        data: {
          status: 'failed',
          progress: 0,
          error: job.failedReason,
        },
        message: 'Import failed',
      };
    } else {
      return {
        success: true,
        data: {
          status: 'processing',
          progress,
        },
        message: 'Import in progress',
      };
    }
  }

  @Post(':id/generate-tools')
  @Roles('admin', 'owner')
  async generateTools(@Request() req, @Param('id') id: string) {
    const api = await this.apisService.findOne(id);
    
    if (!api) {
      throw new NotFoundException('API not found');
    }

    if (api.organizationId !== req.user.currentOrganizationId) {
      throw new ForbiddenException('Access denied');
    }

    const result = await this.apisService.generateToolsFromApi(id);

    return { success: true, data: result, message: 'Tools generated successfully' };
  }

  @Get(':id/operations')
  @Roles('member', 'admin', 'owner')
  async getOperations(@Request() req, @Param('id') id: string) {
    const api = await this.apisService.findOne(id);
    
    if (!api) {
      throw new NotFoundException('API not found');
    }

    if (api.organizationId !== req.user.currentOrganizationId) {
      throw new ForbiddenException('Access denied');
    }

    const result = await this.apisService.getApiOperations(id);

    return { success: true, data: result, message: 'Operations retrieved successfully' };
  }

  @Get(':id/resources')
  @Roles('member', 'admin', 'owner')
  async getResources(@Request() req, @Param('id') id: string) {
    const api = await this.apisService.findOne(id);
    
    if (!api) {
      throw new NotFoundException('API not found');
    }

    if (api.organizationId !== req.user.currentOrganizationId) {
      throw new ForbiddenException('Access denied');
    }

    const result = await this.apisService.getApiResources(id);

    return { success: true, data: result, message: 'Resources retrieved successfully' };
  }

  @Post(':id/test-connection')
  @Roles('admin', 'owner')
  async testConnection(@Request() req, @Param('id') id: string) {
    const api = await this.apisService.findOne(id);
    
    if (!api) {
      throw new NotFoundException('API not found');
    }

    if (api.organizationId !== req.user.currentOrganizationId) {
      throw new ForbiddenException('Access denied');
    }

    const result = await this.apisService.testApiConnection(id);

    return { success: true, data: result, message: 'Connection test completed successfully' };
  }

  @Get(':id/schemas')
  @Roles('member', 'admin', 'owner')
  async getSchemas(@Request() req, @Param('id') id: string) {
    const api = await this.apisService.findOne(id);
    
    if (!api) {
      throw new NotFoundException('API not found');
    }

    if (api.organizationId !== req.user.currentOrganizationId) {
      throw new ForbiddenException('Access denied');
    }

    const result = await this.apisService.getApiSchemas(id);

    return { success: true, data: result, message: 'Schemas retrieved successfully' };
  }

  @Put(':id/status')
  @Roles('admin', 'owner')
  async updateStatus(
    @Request() req,
    @Param('id') id: string,
    @Body('status') status: ApiStatus,
  ) {
    const api = await this.apisService.findOne(id);

    if (!api) {
      throw new NotFoundException('API not found');
    }

    if (api.organizationId !== req.user.currentOrganizationId) {
      throw new ForbiddenException('Access denied');
    }

    const result = await this.apisService.updateStatus(id, status);

    return { success: true, data: result, message: 'API status updated successfully' };
  }

  // ─── Credential Management ──────────────────────────────────────

  @Post(':id/credentials')
  @Roles('admin', 'owner')
  async createCredential(
    @Request() req,
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
  async getCredentials(@Request() req, @Param('id') apiId: string) {
    const orgId = req.user.currentOrganizationId;
    if (!orgId) throw new BadRequestException('Organization context required');
    const result = await this.credentialService.getCredentials(apiId, orgId);

    return { success: true, data: result, message: 'Credentials retrieved successfully' };
  }

  @Put(':id/credentials/:credentialId')
  @Roles('admin', 'owner')
  async updateCredential(
    @Request() req,
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
    @Request() req,
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
    @Request() req,
    @Param('credentialId') credentialId: string,
  ) {
    const orgId = req.user.currentOrganizationId;
    if (!orgId) throw new BadRequestException('Organization context required');
    const result = await this.credentialService.testCredential(credentialId, orgId);

    return { success: true, data: result, message: 'Credential test completed successfully' };
  }
}