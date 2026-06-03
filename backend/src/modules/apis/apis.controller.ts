import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  Res,
  UseGuards,
  Request,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { Response } from 'express';
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

    const result = await this.apisService.findAllByOrganization({ id: req.user.id }, orgId, {
      type,
      status,
      page: parseInt(page.toString()),
      limit: parseInt(limit.toString()),
    });

    return { success: true, data: result, message: 'APIs retrieved successfully' };
  }

  @Post('http')
  @Roles('member', 'admin', 'owner')
  async createHttpApi(@Body() body: any, @Request() req: any) {
    try {
      const organizationId = req.user.currentOrganizationId;
      if (!organizationId) {
        throw new HttpException({ success: false, message: 'No organization found' }, HttpStatus.BAD_REQUEST);
      }
      const api = await this.apisService.createHttpApi(body, organizationId);
      return { success: true, data: api, message: 'Custom HTTP API created' };
    } catch (error) {
      throw new HttpException(
        { success: false, message: error.message, error: 'HTTP_API_CREATE_FAILED' },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('sdk')
  @Roles('member', 'admin', 'owner')
  async createSdkApi(@Body() body: any, @Request() req: any) {
    try {
      const organizationId = req.user.currentOrganizationId;
      if (!organizationId) {
        throw new HttpException({ success: false, message: 'No organization found' }, HttpStatus.BAD_REQUEST);
      }
      const api = await this.apisService.createSdkApi(body, organizationId);
      return { success: true, data: api, message: 'SDK API created. Installing packages...' };
    } catch (error) {
      throw new HttpException(
        { success: false, message: error.message, error: 'SDK_API_CREATE_FAILED' },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get(':id/sdk-maps')
  @Roles('viewer', 'member', 'admin', 'owner')
  async getSdkMaps(@Param('id') id: string, @Request() req: any) {
    try {
      const orgId = req.user?.currentOrganizationId;
      if (!orgId) throw new BadRequestException('Organization context required');
      const api = await this.apisService.findOne(id, orgId);
      if (!api) throw new NotFoundException('API not found');
      return { success: true, data: api.sdkMaps || {} };
    } catch (error) {
      throw new HttpException(
        { success: false, message: error.message },
        error.status || HttpStatus.NOT_FOUND,
      );
    }
  }

  @Get(':id')
  @Roles('member', 'admin', 'owner')
  async findOne(@Request() req, @Param('id') id: string) {
    const api = await this.apisService.findOne(id, req.user.currentOrganizationId);

    if (!api) {
      throw new NotFoundException('API not found');
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
    }, req.user.id);

    return { success: true, data: result, message: 'API created successfully' };
  }

  @Put(':id')
  @Roles('admin', 'owner')
  async update(
    @Request() req,
    @Param('id') id: string,
    @Body() updateApiDto: UpdateApiDto,
  ) {
    const result = await this.apisService.update(
      id,
      updateApiDto,
      req.user.currentOrganizationId,
      req.user.id,
    );

    return { success: true, data: result, message: 'API updated successfully' };
  }

  @Delete(':id')
  @Roles('admin', 'owner')
  async remove(@Request() req, @Param('id') id: string) {
    await this.apisService.remove(id, req.user.currentOrganizationId, req.user.id);
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
    const orgId = req.user.currentOrganizationId;
    const api = await this.apisService.findOne(id, orgId);

    if (!api) {
      throw new NotFoundException('API not found');
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

    // Validate size BEFORE queueing. Previously the 10 MB cap was enforced
    // by apisService.importSchema, which runs inside the worker — meaning
    // an oversized payload had already been written into Redis as the job
    // body and would only be rejected after pickup. Reject up front so we
    // don't bloat the queue.
    // 100 MB ceiling — covers GitHub's 12 MB REST OpenAPI, AWS-class
    // OpenAPIs in the 30-50 MB range, and large WSDL/proto bundles.
    // The downstream pipeline chunks operations + tool generation,
    // and the worker container is sized at 8 GB memory + 7 GB Node
    // heap to accommodate the parser's transient allocations. If a
    // user wants something even bigger we bump again, but at that
    // point streaming-parse becomes the more honest answer.
    const schemaSizeBytes = Buffer.byteLength(schemaContent, 'utf8');
    const MAX_SCHEMA_BYTES = 100 * 1024 * 1024;
    if (schemaSizeBytes > MAX_SCHEMA_BYTES) {
      throw new BadRequestException(
        `Schema too large: ${(schemaSizeBytes / 1024 / 1024).toFixed(2)}MB ` +
          `(max ${MAX_SCHEMA_BYTES / 1024 / 1024}MB)`,
      );
    }

    // Queue the import job. The organizationId is included so the worker
    // can fail closed if the job is somehow picked up against an api in
    // another org (defence in depth — the api was already org-checked
    // above).
    const job = await this.schemaImportQueue.add(
      'import',
      {
        apiId: id,
        organizationId: api.organizationId,
        schemaContent,
        options: {
          fileName: file?.originalname,
          description: importSchemaDto.description,
          generateTools: importSchemaDto.generateTools ?? true,
        },
      },
      {
        // Bound a runaway parse / generation: the parsers cap input size
        // and have their own internal guards, but a hung downstream tool
        // generation could otherwise hold a worker forever.
        timeout: 5 * 60 * 1000, // 5 minutes
        removeOnComplete: 100,
        removeOnFail: 50,
      },
    );

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
  async getImportStatus(
    @Request() req,
    @Param('id') id: string,
    @Param('jobId') jobId: string,
  ) {
    // Verify the api belongs to the caller's org BEFORE looking up the
    // job. Without this any authenticated user could poll any job by id
    // (state, error message, completed result with full api/schema body)
    // simply by guessing.
    const api = await this.apisService.findOne(id, req.user?.currentOrganizationId);
    if (!api) {
      // NotFound covers both "doesn't exist" and "exists in another org".
      // That's deliberate — we don't want this endpoint to leak api
      // existence across tenants.
      throw new NotFoundException('API not found');
    }

    const job = await this.schemaImportQueue.getJob(jobId);

    if (!job) {
      throw new NotFoundException('Job not found');
    }

    // The job's apiId in its payload must match the path param. A user
    // could otherwise poll a job for a totally different (in-org or
    // cross-org) api by passing their own api id and someone else's job id.
    if (job.data?.apiId !== id) {
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

  /**
   * Server-Sent Events stream for live import progress. Frontend
   * connects after enqueueing an import and gets every progress
   * tick + the final state, no polling required.
   *
   * Auth + cross-tenant guard mirrors getImportStatus exactly:
   * verify the api belongs to the caller's org first, then verify
   * the job's apiId matches. Without those, an authenticated user
   * could subscribe to any job by id.
   */
  @Get(':id/import-status/:jobId/stream')
  @Roles('member', 'admin', 'owner')
  async streamImportStatus(
    @Request() req: any,
    @Param('id') id: string,
    @Param('jobId') jobId: string,
    @Res() res: Response,
  ) {
    const api = await this.apisService.findOne(id, req.user?.currentOrganizationId);
    if (!api) {
      throw new NotFoundException('API not found');
    }

    const job = await this.schemaImportQueue.getJob(jobId);
    if (!job || job.data?.apiId !== id) {
      throw new NotFoundException('Job not found');
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
    res.flushHeaders?.();

    let lastProgress = -1;
    let lastState = '';
    let stopped = false;

    const stop = () => {
      if (stopped) return;
      stopped = true;
      try { res.end(); } catch { /* socket already closed */ }
    };

    const emit = async () => {
      if (stopped) return false;
      const state = await job.getState();
      const progress = job.progress();
      const progressNum = typeof progress === 'number' ? progress : 0;
      if (state !== lastState || progressNum !== lastProgress) {
        const payload: any = { state, progress: progressNum };
        if (state === 'completed') payload.result = job.returnvalue;
        if (state === 'failed') payload.error = job.failedReason;
        res.write(`event: progress\ndata: ${JSON.stringify(payload)}\n\n`);
        lastProgress = progressNum;
        lastState = state;
      }
      if (state === 'completed' || state === 'failed') {
        stop();
        return false;
      }
      return true;
    };

    await emit();
    const interval = setInterval(async () => {
      try {
        const cont = await emit();
        if (!cont) clearInterval(interval);
      } catch (err) {
        clearInterval(interval);
        stop();
      }
    }, 1000);

    // Cap the SSE life at 15 min — anything longer is the host job
    // being stuck and the client should re-poll the status endpoint.
    const cap = setTimeout(() => {
      clearInterval(interval);
      stop();
    }, 15 * 60 * 1000);

    req.on('close', () => {
      clearInterval(interval);
      clearTimeout(cap);
      stop();
    });
  }

  @Post(':id/generate-tools')
  @Roles('admin', 'owner')
  async generateTools(@Request() req, @Param('id') id: string) {
    const result = await this.apisService.generateToolsFromApi(
      id,
      req.user.currentOrganizationId,
    );
    return { success: true, data: result, message: 'Tools generated successfully' };
  }

  @Get(':id/operations')
  @Roles('member', 'admin', 'owner')
  async getOperations(@Request() req, @Param('id') id: string) {
    const result = await this.apisService.getApiOperations(
      id,
      req.user.currentOrganizationId,
    );
    return { success: true, data: result, message: 'Operations retrieved successfully' };
  }

  @Get(':id/resources')
  @Roles('member', 'admin', 'owner')
  async getResources(@Request() req, @Param('id') id: string) {
    const result = await this.apisService.getApiResources(
      id,
      req.user.currentOrganizationId,
    );
    return { success: true, data: result, message: 'Resources retrieved successfully' };
  }

  @Post(':id/test-connection')
  @Roles('admin', 'owner')
  async testConnection(@Request() req, @Param('id') id: string) {
    const result = await this.apisService.testApiConnection(
      id,
      req.user.currentOrganizationId,
    );
    return { success: true, data: result, message: 'Connection test completed successfully' };
  }

  @Get(':id/schemas')
  @Roles('member', 'admin', 'owner')
  async getSchemas(@Request() req, @Param('id') id: string) {
    const result = await this.apisService.getApiSchemas(
      id,
      req.user.currentOrganizationId,
    );
    return { success: true, data: result, message: 'Schemas retrieved successfully' };
  }

  /**
   * On-demand parse of a stored schema. The persisted row only
   * carries the original rawSchema (text/JSON/XML/proto); the
   * parsed object form is rebuilt by the parser when the UI's
   * "view parsed" tab actually asks for it. This trades 8-15 MB
   * of disk per import row for ~50-300 ms of parse latency on
   * the rare clicks that need it.
   */
  @Get(':id/schemas/:schemaId/parsed')
  @Roles('member', 'admin', 'owner')
  async getParsedSchema(
    @Request() req,
    @Param('id') id: string,
    @Param('schemaId') schemaId: string,
  ) {
    const result = await this.apisService.parseSchemaOnDemand(
      id,
      schemaId,
      req.user.currentOrganizationId,
    );
    return { success: true, data: result, message: 'Schema parsed successfully' };
  }

  @Put(':id/status')
  @Roles('admin', 'owner')
  async updateStatus(
    @Request() req,
    @Param('id') id: string,
    @Body('status') status: ApiStatus,
  ) {
    const result = await this.apisService.updateStatus(
      id,
      status,
      req.user.currentOrganizationId,
    );
    return { success: true, data: result, message: 'API status updated successfully' };
  }

}