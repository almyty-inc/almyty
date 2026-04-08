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

  /**
   * Build a safe Content-Disposition header value. The filename lives
   * in a quoted-string context and would otherwise let an attacker
   * inject additional headers by uploading a file named
   *   `foo.jpg"; Content-Type: text/html; x="`
   * We escape `\`, `"` and newlines per RFC 6266, and additionally
   * emit a UTF-8 `filename*` parameter for non-ASCII names.
   */
  private buildContentDisposition(name: string): string {
    const fallback = (name || 'download')
      .replace(/[\\"\r\n]/g, '_')
      .replace(/[^\x20-\x7e]/g, '_'); // strip non-ASCII for the plain filename
    // Encode the UTF-8 name for the RFC 5987 `filename*` parameter.
    // encodeURIComponent handles almost everything; RFC 5987 requires
    // the three extra characters ' ( ) to be percent-encoded as well.
    // The old code piped through the deprecated global `escape()` as
    // a shortcut — correct in practice but relying on a legacy API
    // that behaves differently from encodeURIComponent for non-ASCII.
    // Replace it with an explicit lookup so the intent is obvious.
    const extraEncode: Record<string, string> = {
      "'": '%27',
      '(': '%28',
      ')': '%29',
    };
    const utf8 = encodeURIComponent(name || 'download').replace(
      /['()]/g,
      (c) => extraEncode[c],
    );
    return `attachment; filename="${fallback}"; filename*=UTF-8''${utf8}`;
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
  private safeDownloadHeaders(res: Response, file: any, buffer: Buffer): void {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', this.buildContentDisposition(file.name));
    res.setHeader('Content-Length', buffer.length);
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
      this.safeDownloadHeaders(res, file, buffer);
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
