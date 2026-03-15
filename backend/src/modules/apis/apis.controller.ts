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

    return this.apisService.findAllByOrganization(orgId, {
      type,
      status,
      page: parseInt(page.toString()),
      limit: parseInt(limit.toString()),
    });
  }

  @Get(':id')
  async findOne(@Request() req, @Param('id') id: string) {
    const api = await this.apisService.findOne(id);
    
    if (!api) {
      throw new NotFoundException('API not found');
    }

    if (api.organizationId !== req.user.currentOrganizationId) {
      throw new ForbiddenException('Access denied');
    }

    return api;
  }

  @Post()
  async create(@Request() req, @Body() createApiDto: CreateApiDto) {
    if (!req.user.currentOrganizationId) {
      throw new BadRequestException('Organization context required');
    }

    return this.apisService.create({
      ...createApiDto,
      organizationId: req.user.currentOrganizationId,
    });
  }

  @Put(':id')
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

    return this.apisService.update(id, updateApiDto);
  }

  @Delete(':id')
  async remove(@Request() req, @Param('id') id: string) {
    const api = await this.apisService.findOne(id);
    
    if (!api) {
      throw new NotFoundException('API not found');
    }

    if (api.organizationId !== req.user.currentOrganizationId) {
      throw new ForbiddenException('Access denied');
    }

    return this.apisService.remove(id);
  }

  @Post(':id/import-schema')
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
      jobId: job.id,
      status: 'processing',
      message: 'Schema import started in background',
    };
  }

  @Get(':id/import-status/:jobId')
  async getImportStatus(@Param('id') id: string, @Param('jobId') jobId: string) {
    const job = await this.schemaImportQueue.getJob(jobId);

    if (!job) {
      throw new NotFoundException('Job not found');
    }

    const state = await job.getState();
    const progress = job.progress();

    if (state === 'completed') {
      return {
        status: 'completed',
        progress: 100,
        result: job.returnvalue,
      };
    } else if (state === 'failed') {
      return {
        status: 'failed',
        progress: 0,
        error: job.failedReason,
      };
    } else {
      return {
        status: 'processing',
        progress,
      };
    }
  }

  @Post(':id/generate-tools')
  async generateTools(@Request() req, @Param('id') id: string) {
    const api = await this.apisService.findOne(id);
    
    if (!api) {
      throw new NotFoundException('API not found');
    }

    if (api.organizationId !== req.user.currentOrganizationId) {
      throw new ForbiddenException('Access denied');
    }

    return this.apisService.generateToolsFromApi(id);
  }

  @Get(':id/operations')
  async getOperations(@Request() req, @Param('id') id: string) {
    const api = await this.apisService.findOne(id);
    
    if (!api) {
      throw new NotFoundException('API not found');
    }

    if (api.organizationId !== req.user.currentOrganizationId) {
      throw new ForbiddenException('Access denied');
    }

    return this.apisService.getApiOperations(id);
  }

  @Get(':id/resources')
  async getResources(@Request() req, @Param('id') id: string) {
    const api = await this.apisService.findOne(id);
    
    if (!api) {
      throw new NotFoundException('API not found');
    }

    if (api.organizationId !== req.user.currentOrganizationId) {
      throw new ForbiddenException('Access denied');
    }

    return this.apisService.getApiResources(id);
  }

  @Post(':id/test-connection')
  async testConnection(@Request() req, @Param('id') id: string) {
    const api = await this.apisService.findOne(id);
    
    if (!api) {
      throw new NotFoundException('API not found');
    }

    if (api.organizationId !== req.user.currentOrganizationId) {
      throw new ForbiddenException('Access denied');
    }

    return this.apisService.testApiConnection(id);
  }

  @Get(':id/schemas')
  async getSchemas(@Request() req, @Param('id') id: string) {
    const api = await this.apisService.findOne(id);
    
    if (!api) {
      throw new NotFoundException('API not found');
    }

    if (api.organizationId !== req.user.currentOrganizationId) {
      throw new ForbiddenException('Access denied');
    }

    return this.apisService.getApiSchemas(id);
  }

  @Put(':id/status')
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

    return this.apisService.updateStatus(id, status);
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
    return this.credentialService.createCredential(apiId, orgId, dto);
  }

  @Get(':id/credentials')
  @Roles('member', 'admin', 'owner')
  async getCredentials(@Request() req, @Param('id') apiId: string) {
    const orgId = req.user.currentOrganizationId;
    if (!orgId) throw new BadRequestException('Organization context required');
    return this.credentialService.getCredentials(apiId, orgId);
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
    return this.credentialService.updateCredential(credentialId, orgId, dto);
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
    return { success: true, message: 'Credential deleted' };
  }

  @Post(':id/credentials/:credentialId/test')
  @Roles('admin', 'owner')
  async testCredential(
    @Request() req,
    @Param('credentialId') credentialId: string,
  ) {
    const orgId = req.user.currentOrganizationId;
    if (!orgId) throw new BadRequestException('Organization context required');
    return this.credentialService.testCredential(credentialId, orgId);
  }
}