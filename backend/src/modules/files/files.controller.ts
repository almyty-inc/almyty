import {
  Controller, Get, Post, Delete, Param, Query, Res, UseGuards, Request,
  ParseUUIDPipe, HttpStatus, HttpException, Logger, UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Response } from 'express';
import { FilesService } from './files.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { TempFileInterceptor } from './temp-upload';
import { allowedUploadType, attachmentDisposition } from './media-type';

@Controller('files')
@ApiTags('Files')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
export class FilesController {
  private readonly logger = new Logger(FilesController.name);

  constructor(private readonly filesService: FilesService) {}

  private getOrgId(req: any): string {
    // Prefer the JWT strategy's resolved org (set from X-Organization-Id
    // header for multi-org users, or the single membership for
    // single-org users). DO NOT fall back to `organizations[0]`: that
    // silently scopes multi-org users to their first org and defeats
    // the explicit-context safety we added in the JWT strategy.
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

  /** A safe Content-Disposition for a stored name (media-type.ts). */
  private buildContentDisposition(name: string): string {
    return attachmentDisposition(name);
  }

  /**
   * Override the Content-Type the client claimed on upload. We never
   * want to echo back an attacker-chosen MIME on download: the stored
   * file could be an HTML document claiming to be an image, and
   * browsers would render it in the viewer's origin → stored XSS.
   *
   * We return `application/octet-stream` plus `X-Content-Type-Options:
   * nosniff` so modern browsers refuse to guess the real type. The
   * trade-off is that legitimate image previews require the caller
   * to fetch via a separate, MIME-whitelisted endpoint (not built
   * yet — flagged as follow-up).
   */
  private safeDownloadHeaders(res: Response, file: any, size?: number): void {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', this.buildContentDisposition(file.name));
    // From the row rather than a materialized buffer, so the response
    // can be streamed and still declare its length.
    if (typeof size === 'number') res.setHeader('Content-Length', size);
  }

  @Post('upload')
  @Roles('member', 'admin', 'owner')
  @UseInterceptors(TempFileInterceptor('file', 50 * 1024 * 1024))
  async upload(
    @UploadedFile() file: any,
    @Query('agentId', new ParseUUIDPipe({ optional: true })) agentId: string,
    @Query('runId', new ParseUUIDPipe({ optional: true })) runId: string,
    @Request() req: any,
  ) {
    try {
      if (!file) {
        throw new HttpException({ success: false, message: 'No file provided', error: 'NO_FILE' }, HttpStatus.BAD_REQUEST);
      }
      // Parsed exactly and stored as parsed (media-type.ts): a prefix match
      // let `text/plain, text/html` through, and it went to storage as given.
      const mimetype = allowedUploadType(file.mimetype);
      if (!mimetype) {
        throw new HttpException(
          {
            success: false,
            message: `Upload refused: mime type "${file.mimetype}" is not in the allowlist`,
            error: 'MIME_NOT_ALLOWED',
          },
          HttpStatus.BAD_REQUEST,
        );
      }
      const organizationId = this.getOrgId(req);
      const userId = req.user.sub || req.user.id;
      const result = await this.filesService.upload(organizationId, { ...file, mimetype }, { agentId, runId, uploadedBy: userId });
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
      // Storage that can presign gives a direct URL; otherwise point at
      // this controller's own download route, which streams the bytes.
      const url =
        (await this.filesService.getDownloadUrl(id, organizationId)) ??
        `/files/${id}/download`;
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
      const { stream, file } = await this.filesService.downloadStream(id, organizationId);
      this.safeDownloadHeaders(res, file, file.size);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
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
