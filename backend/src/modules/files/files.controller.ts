import {
  Controller, Get, Post, Delete, Param, Query, Res, UseGuards, Request,
  ParseUUIDPipe, HttpStatus, HttpException, Logger, UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Response } from 'express';
import { FilesService } from './files.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

@Controller('files')
@ApiTags('Files')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
export class FilesController {
  private readonly logger = new Logger(FilesController.name);

  constructor(private readonly filesService: FilesService) {}

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

  @Post('upload')
  @Roles('member', 'admin', 'owner')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 50 * 1024 * 1024 } })) // 50MB limit
  async upload(
    @UploadedFile() file: any,
    @Query('agentId') agentId: string,
    @Query('runId') runId: string,
    @Request() req: any,
  ) {
    try {
      if (!file) {
        throw new HttpException({ success: false, message: 'No file provided', error: 'NO_FILE' }, HttpStatus.BAD_REQUEST);
      }
      const organizationId = this.getOrgId(req);
      const userId = req.user.sub || req.user.id;
      const result = await this.filesService.upload(organizationId, file, { agentId, runId, uploadedBy: userId });
      return { success: true, data: result, message: 'File uploaded successfully' };
    } catch (error) {
      throw new HttpException({ success: false, message: error.message, error: 'FILE_UPLOAD_FAILED' }, error.status || HttpStatus.BAD_REQUEST);
    }
  }

  @Get()
  @Roles('viewer', 'member', 'admin', 'owner')
  async findAll(
    @Query() query: { agentId?: string; runId?: string; mimeType?: string; page?: string; limit?: string },
    @Request() req: any,
  ) {
    try {
      const organizationId = this.getOrgId(req);
      const result = await this.filesService.findAll(organizationId, {
        agentId: query.agentId,
        runId: query.runId,
        mimeType: query.mimeType,
        page: query.page ? parseInt(query.page) : 1,
        limit: query.limit ? parseInt(query.limit) : 50,
      });
      return { success: true, data: result.data, pagination: { total: result.total, page: result.page, limit: result.limit, totalPages: result.totalPages } };
    } catch (error) {
      throw new HttpException({ success: false, message: error.message, error: 'FILES_FETCH_FAILED' }, error.status || HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get(':id')
  @Roles('viewer', 'member', 'admin', 'owner')
  async findById(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) {
    try {
      const organizationId = this.getOrgId(req);
      const file = await this.filesService.findById(id, organizationId);
      const url = await this.filesService.getDownloadUrl(id, organizationId);
      return { success: true, data: { ...file, downloadUrl: url } };
    } catch (error) {
      throw new HttpException({ success: false, message: error.message, error: 'FILE_FETCH_FAILED' }, error.status || HttpStatus.NOT_FOUND);
    }
  }

  @Get(':id/download')
  @Roles('viewer', 'member', 'admin', 'owner')
  async download(@Param('id', ParseUUIDPipe) id: string, @Request() req: any, @Res() res: Response) {
    try {
      const organizationId = this.getOrgId(req);
      const { buffer, file } = await this.filesService.download(id, organizationId);
      res.setHeader('Content-Type', file.mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="${file.name}"`);
      res.setHeader('Content-Length', buffer.length);
      res.send(buffer);
    } catch (error) {
      res.status(error.status || HttpStatus.NOT_FOUND).json({ success: false, message: error.message, error: 'FILE_DOWNLOAD_FAILED' });
    }
  }

  @Delete(':id')
  @Roles('member', 'admin', 'owner')
  async remove(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) {
    try {
      const organizationId = this.getOrgId(req);
      await this.filesService.remove(id, organizationId);
      return { success: true, message: 'File deleted successfully' };
    } catch (error) {
      throw new HttpException({ success: false, message: error.message, error: 'FILE_DELETE_FAILED' }, error.status || HttpStatus.BAD_REQUEST);
    }
  }
}
