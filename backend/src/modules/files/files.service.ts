import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgentFile } from '../../entities/file.entity';
import { StorageService } from './storage.service';
import { TextExtractorService } from './text-extractor.service';
import { v4 as uuidv4 } from 'uuid';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuditAction, AuditResource } from '../../entities/audit-log.entity';

@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  constructor(
    @InjectRepository(AgentFile)
    private readonly fileRepository: Repository<AgentFile>,
    private readonly storageService: StorageService,
    private readonly textExtractor: TextExtractorService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async upload(
    organizationId: string,
    file: { buffer: Buffer; originalname: string; mimetype: string; size: number },
    options?: { agentId?: string; runId?: string; uploadedBy?: string; extractText?: boolean },
  ): Promise<AgentFile> {
    const fileId = uuidv4();
    // Sanitize the user-supplied filename before embedding it in the
    // storage key. The key is used as a filesystem path by the local
    // storage provider — an unsanitized `../../etc/passwd` would
    // escape the uploads directory. We allow a conservative set of
    // characters and collapse everything else to `_`.
    const safeName = this.sanitizeStoredFilename(file.originalname);
    const storageKey = `${organizationId}/${options?.agentId || 'general'}/${fileId}/${safeName}`;

    // Upload to storage
    const storageUrl = await this.storageService.upload(storageKey, file.buffer, file.mimetype);

    // Extract text if requested and possible
    let extractedText: string | null = null;
    if (options?.extractText !== false) {
      extractedText = await this.textExtractor.extract(file.buffer, file.mimetype, file.originalname);
    }

    const agentFile = this.fileRepository.create({
      id: fileId,
      organizationId,
      agentId: options?.agentId || null,
      runId: options?.runId || null,
      name: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      storageKey,
      storageUrl,
      extractedText,
      uploadedBy: options?.uploadedBy || null,
    });

    const saved = await this.fileRepository.save(agentFile);

    // Audit log (fire-and-forget)
    this.auditLogService.log({ organizationId, userId: options?.uploadedBy, action: AuditAction.FILE_UPLOAD, resourceType: AuditResource.FILE, resourceId: saved.id, resourceName: saved.name, details: { mimeType: file.mimetype, size: file.size } });

    return saved;
  }

  async findAll(organizationId: string, filters?: {
    agentId?: string;
    runId?: string;
    mimeType?: string;
    page?: number;
    limit?: number;
  }) {
    const page = filters?.page || 1;
    const limit = Math.min(filters?.limit || 50, 100);
    const skip = (page - 1) * limit;

    const qb = this.fileRepository.createQueryBuilder('file')
      .where('file.organizationId = :organizationId', { organizationId });

    if (filters?.agentId) qb.andWhere('file.agentId = :agentId', { agentId: filters.agentId });
    if (filters?.runId) qb.andWhere('file.runId = :runId', { runId: filters.runId });
    if (filters?.mimeType) qb.andWhere('file.mimeType = :mimeType', { mimeType: filters.mimeType });

    qb.orderBy('file.createdAt', 'DESC').skip(skip).take(limit);

    const [data, total] = await qb.getManyAndCount();
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async findById(id: string, organizationId: string): Promise<AgentFile> {
    const file = await this.fileRepository.findOne({ where: { id, organizationId } });
    if (!file) throw new NotFoundException('File not found');
    return file;
  }

  async getDownloadUrl(id: string, organizationId: string): Promise<string> {
    const file = await this.findById(id, organizationId);
    return this.storageService.getSignedUrl(file.storageKey);
  }

  async download(id: string, organizationId: string): Promise<{ buffer: Buffer; file: AgentFile }> {
    const file = await this.findById(id, organizationId);
    const buffer = await this.storageService.download(file.storageKey);

    // Audit log (fire-and-forget)
    this.auditLogService.log({ organizationId, action: AuditAction.FILE_DOWNLOAD, resourceType: AuditResource.FILE, resourceId: file.id, resourceName: file.name });

    return { buffer, file };
  }

  async remove(id: string, organizationId: string): Promise<void> {
    const file = await this.findById(id, organizationId);
    await this.storageService.delete(file.storageKey);
    await this.fileRepository.remove(file);

    // Audit log (fire-and-forget)
    this.auditLogService.log({ organizationId, action: AuditAction.FILE_DELETE, resourceType: AuditResource.FILE, resourceId: id, resourceName: file.name });
  }

  /**
   * Sanitize a user-supplied filename for use as a filesystem path
   * component.
   *
   * - Strips directory separators and NUL bytes.
   * - Collapses unsafe characters to underscores.
   * - Preserves a reasonable extension for the common case (matters
   *   for humans browsing the uploads dir; the canonical name in the
   *   DB is the original `file.originalname`, not this sanitized one).
   * - Prevents the bare `.` and `..` segments.
   * - Truncates to 200 chars to avoid path-length overflow on Windows
   *   / some filesystems.
   */
  private sanitizeStoredFilename(raw: string): string {
    if (!raw || typeof raw !== 'string') return 'upload.bin';
    // Take only the basename — strips any leading directory component
    // that a malicious client might have included via `../` or `\`.
    // Handle both `/` and `\` since Windows clients may send either.
    const basename = raw.replace(/\\/g, '/').split('/').pop() || 'upload.bin';
    // Remove NULs and replace anything outside a conservative whitelist
    // with `_`. The whitelist is alphanumerics + `.-_ ` (space is OK in
    // filenames on every modern FS).
    let cleaned = basename.replace(/\0/g, '').replace(/[^A-Za-z0-9._\- ]/g, '_');
    // Collapse leading dots so we can't produce `.`, `..`, or hidden files.
    cleaned = cleaned.replace(/^\.+/, '');
    if (!cleaned) cleaned = 'upload.bin';
    if (cleaned.length > 200) cleaned = cleaned.slice(0, 200);
    return cleaned;
  }
}
