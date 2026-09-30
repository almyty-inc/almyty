import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsSelect, In, Repository } from 'typeorm';
import { AgentFile } from '../../entities/file.entity';
import { StorageService } from './storage.service';
import { TextExtractorService } from './text-extractor.service';
import { v4 as uuidv4 } from 'uuid';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuditAction, AuditResource } from '../../entities/audit-log.entity';
import { Readable } from 'stream';

/**
 * What an upload is for, when the uploader says. Only an app icon has one
 * today: an icon chosen on the branding page and never saved is cleared by
 * a sweep a day later.
 */
export const FILE_PURPOSES = ['app_icon'] as const;
export type FilePurpose = (typeof FILE_PURPOSES)[number];

/** Every file column a list returns: all of them but `extractedText`. */
const FILE_LIST_COLUMNS: FindOptionsSelect<AgentFile> = {
  id: true,
  organizationId: true,
  agentId: true,
  runId: true,
  name: true,
  mimeType: true,
  size: true,
  storageKey: true,
  storageUrl: true,
  memoryId: true,
  conversationId: true,
  uploadedBy: true,
  metadata: true,
  createdAt: true,
};

/** What removing a file needs: which row, and which stored object. */
const STORED_OBJECT_COLUMNS: FindOptionsSelect<AgentFile> = { id: true, storageKey: true };

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
    file: { path: string; originalname: string; mimetype: string; size: number },
    options?: { agentId?: string; runId?: string; uploadedBy?: string; extractText?: boolean; purpose?: FilePurpose },
  ): Promise<AgentFile> {
    // agentId becomes a storage-key segment. Unchecked, `../<other org>/x`
    // normalizes to a key under another org's prefix, which the key guard
    // in StorageService accepts because it no longer starts with `..`.
    // Both ids come from the query string, so hold them to the id shape.
    for (const [field, value] of [['agentId', options?.agentId], ['runId', options?.runId]] as const) {
      if (value && !isUUID(value)) {
        throw new BadRequestException(`${field} must be a UUID`);
      }
    }
    const fileId = uuidv4();
    // Sanitize the user-supplied filename before embedding it in the
    // storage key. The key is used as a filesystem path by the local
    // storage provider — an unsanitized `../../etc/passwd` would
    // escape the uploads directory. We allow a conservative set of
    // characters and collapse everything else to `_`.
    const safeName = this.sanitizeStoredFilename(file.originalname);
    const storageKey = `${organizationId}/${options?.agentId || 'general'}/${fileId}/${safeName}`;

    // Upload to storage, from the temp file multer spooled it to: the
    // bytes are streamed, never held whole (files/temp-upload.ts).
    const storageUrl = await this.storageService.uploadFile(storageKey, file.path, file.mimetype);

    // Extract text if requested and possible
    let extractedText: string | null = null;
    if (options?.extractText !== false) {
      extractedText = await this.textExtractor.extractFromFile(file.path, file.size, file.mimetype, file.originalname);
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
      metadata: options?.purpose ? { purpose: options.purpose } : null,
    });

    let saved: AgentFile;
    try {
      saved = await this.fileRepository.save(agentFile);
    } catch (error) {
      // No row points at the object, so nothing would ever delete it.
      await this.storageService.delete(storageKey).catch((cleanupError) =>
        this.logger.warn(`Could not remove orphaned upload ${storageKey}: ${cleanupError.message}`),
      );
      throw error;
    }

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

    const where: Record<string, string> = { organizationId };
    if (filters?.agentId) where.agentId = filters.agentId;
    if (filters?.runId) where.runId = filters.runId;
    if (filters?.mimeType) where.mimeType = filters.mimeType;

    // A list carries no extracted text. It is the full text of every
    // document in the page (up to 100 of them), readable by any viewer of
    // the org whether or not they could open the file; GET /files/:id is
    // the one place it is served. Not selected, and dropped from the rows
    // regardless, so a later change to the select cannot bring it back.
    //
    // Tied `createdAt` values order arbitrarily; with skip/take that
    // duplicates one row across pages and drops another. See
    // ApisService.findAllByOrganization for the same pairing.
    const [rows, total] = await this.fileRepository.findAndCount({
      where,
      select: FILE_LIST_COLUMNS,
      order: { createdAt: 'DESC', id: 'DESC' },
      skip,
      take: limit,
    });
    const data = rows.map(({ extractedText: _omitted, ...file }) => file);
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  /**
   * Files uploaded for `purpose` before `before`, in every organization,
   * oldest first: for the sweeps that clear uploads nothing came to use
   * (an app icon chosen on the branding page and never saved).
   */
  async findForPurposeBefore(purpose: FilePurpose, before: Date, limit = 500): Promise<AgentFile[]> {
    return this.fileRepository
      .createQueryBuilder('f')
      .where(`f.metadata ->> 'purpose' = :purpose`, { purpose })
      .andWhere('f.createdAt < :before', { before })
      .orderBy('f.createdAt', 'ASC')
      .take(limit)
      .getMany();
  }

  async findById(id: string, organizationId: string): Promise<AgentFile> {
    const file = await this.fileRepository.findOne({ where: { id, organizationId } });
    if (!file) throw new NotFoundException('File not found');
    return file;
  }

  /**
   * A direct link to the stored object, when storage can mint one.
   *
   * Local storage cannot, and returns null rather than a URL that
   * resolves to nothing. Callers fall back to `/files/:id/download`,
   * which streams the bytes through the API either way.
   */
  async getDownloadUrl(id: string, organizationId: string): Promise<string | null> {
    const file = await this.findById(id, organizationId);
    if (!this.storageService.canPresign) return null;
    return this.storageService.getSignedUrl(file.storageKey, undefined, file.name);
  }

  async download(id: string, organizationId: string): Promise<{ buffer: Buffer; file: AgentFile }> {
    const file = await this.findById(id, organizationId);
    const buffer = await this.storageService.download(file.storageKey);

    // Audit log (fire-and-forget)
    this.auditLogService.log({ organizationId, action: AuditAction.FILE_DOWNLOAD, resourceType: AuditResource.FILE, resourceId: file.id, resourceName: file.name });

    return { buffer, file };
  }

  /**
   * The same download, piped rather than buffered.
   *
   * Reading a 50MB upload into heap and then `res.send`ing it (which
   * copies) pinned ~100MB per concurrent download on a pod that peaks
   * around 286MB.
   */
  async downloadStream(id: string, organizationId: string): Promise<{ stream: Readable; file: AgentFile }> {
    const file = await this.findById(id, organizationId);
    const stream = await this.storageService.downloadStream(file.storageKey);

    this.auditLogService.log({ organizationId, action: AuditAction.FILE_DOWNLOAD, resourceType: AuditResource.FILE, resourceId: file.id, resourceName: file.name });

    return { stream, file };
  }

  // ---------------------------------------------------------------------------
  // Files someone sent in a conversation (channel and web chat attachments)
  // ---------------------------------------------------------------------------

  /**
   * Store the bytes of a file someone sent in chat: a channel attachment
   * fetched from the platform, or a web chat upload. Unlike `upload`, the
   * bytes are already in memory (bounded by the caller's cap) and the file
   * belongs to a conversation rather than to a dashboard user, so it is
   * found and erased with that conversation (`removeForConversations`).
   * `conversationId` may follow later, once the run that reads the file has
   * one (`attachToConversation`).
   */
  async storeBytes(
    organizationId: string,
    bytes: Buffer,
    file: { name: string; mimeType: string },
    options: {
      agentId?: string | null;
      conversationId?: string | null;
      extractedText?: string | null;
      metadata?: Record<string, any>;
    } = {},
  ): Promise<AgentFile> {
    if (options.agentId && !isUUID(options.agentId)) throw new BadRequestException('agentId must be a UUID');
    const fileId = uuidv4();
    const storageKey = `${organizationId}/${options.agentId || 'general'}/${fileId}/${this.sanitizeStoredFilename(file.name)}`;
    const storageUrl = await this.storageService.upload(storageKey, bytes, file.mimeType);
    const row = this.fileRepository.create({
      id: fileId,
      organizationId,
      agentId: options.agentId || null,
      conversationId: options.conversationId ?? null,
      name: file.name,
      mimeType: file.mimeType,
      size: bytes.length,
      storageKey,
      storageUrl,
      extractedText: options.extractedText ?? null,
      uploadedBy: null,
      metadata: options.metadata ?? null,
    });
    try {
      return await this.fileRepository.save(row);
    } catch (error) {
      await this.storageService.delete(storageKey).catch((cleanupError) =>
        this.logger.warn(`Could not remove orphaned attachment ${storageKey}: ${cleanupError.message}`),
      );
      throw error;
    }
  }

  /** File the attachments of one message under the conversation (and run) that read them. */
  async attachToConversation(
    organizationId: string,
    fileIds: string[],
    conversationId: string,
    runId?: string | null,
  ): Promise<void> {
    const ids = fileIds.filter((id) => isUUID(id));
    if (!ids.length) return;
    await this.fileRepository.update(
      { id: In(ids), organizationId },
      { conversationId, ...(runId ? { runId } : {}) },
    );
  }

  /**
   * Remove files and their stored objects, by id. For attachments stored
   * for a message that never reached a conversation (the run was refused).
   */
  async removeMany(organizationId: string, fileIds: string[]): Promise<number> {
    const ids = fileIds.filter((id) => isUUID(id));
    if (!ids.length) return 0;
    return this.removeRows(await this.fileRepository.find({ where: { id: In(ids), organizationId }, select: STORED_OBJECT_COLUMNS }));
  }

  /**
   * Remove every file filed under these conversations, stored object first.
   * Called by each path that erases conversations (the retention sweep,
   * visitor erasure, a widget thread's erasure) before it deletes them: the
   * foreign key would cascade the rows on its own, but not the objects.
   */
  async removeForConversations(organizationId: string, conversationIds: string[]): Promise<number> {
    if (!conversationIds.length) return 0;
    let removed = 0;
    for (let i = 0; i < conversationIds.length; i += 500) {
      const batch = conversationIds.slice(i, i + 500);
      removed += await this.removeRows(
        await this.fileRepository.find({ where: { conversationId: In(batch), organizationId }, select: STORED_OBJECT_COLUMNS }),
      );
    }
    return removed;
  }

  /** Where a conversation attachment came from (`metadata.source`). */
  static readonly ATTACHMENT_SOURCES = ['channel_attachment', 'web_chat_upload', 'widget_upload'] as const;

  /**
   * Attachments a visitor uploaded and has not sent yet: no conversation,
   * this gateway, this visitor (a web chat end user, or a widget thread).
   * Returned only when every id is theirs; one that is not refuses the lot.
   */
  async findUnsentUploads(
    organizationId: string,
    fileIds: string[],
    owner: { gatewayId: string; endUserId?: string; threadId?: string },
  ): Promise<AgentFile[] | null> {
    const ids = [...new Set(fileIds)].filter((id) => isUUID(id));
    if (!ids.length || ids.length !== fileIds.length) return null;
    const qb = this.fileRepository
      .createQueryBuilder('file')
      .where('file.id IN (:...ids)', { ids })
      .andWhere('file.organizationId = :organizationId', { organizationId })
      .andWhere('file.conversationId IS NULL')
      .andWhere(`file.metadata->>'gatewayId' = :gatewayId`, { gatewayId: owner.gatewayId });
    if (owner.endUserId) qb.andWhere(`file.metadata->>'endUserId' = :endUserId`, { endUserId: owner.endUserId });
    else if (owner.threadId) qb.andWhere(`file.metadata->>'threadId' = :threadId`, { threadId: owner.threadId });
    else return null;
    const rows = await qb.getMany();
    return rows.length === ids.length ? rows : null;
  }

  /**
   * Remove a visitor's unsent uploads on a gateway: part of erasing what a
   * surface holds about them.
   */
  async removeUnsentUploads(
    organizationId: string,
    owner: { gatewayId: string; endUserId?: string; threadId?: string },
  ): Promise<number> {
    if (!owner.endUserId && !owner.threadId) return 0;
    const qb = this.fileRepository
      .createQueryBuilder('file')
      .select(['file.id', 'file.storageKey'])
      .where('file.organizationId = :organizationId', { organizationId })
      .andWhere('file.conversationId IS NULL')
      .andWhere(`file.metadata->>'gatewayId' = :gatewayId`, { gatewayId: owner.gatewayId });
    if (owner.endUserId) qb.andWhere(`file.metadata->>'endUserId' = :endUserId`, { endUserId: owner.endUserId });
    else qb.andWhere(`file.metadata->>'threadId' = :threadId`, { threadId: owner.threadId });
    return this.removeRows(await qb.take(500).getMany());
  }

  /**
   * Remove conversation attachments that never reached a conversation
   * (uploaded and not sent, or stored for a message whose run was never
   * linked) once they are older than `cutoff`. Deployment-wide; the
   * retention sweep runs it on its hourly tick.
   */
  async removeUnsentAttachments(cutoff: Date, batch = 500): Promise<number> {
    const rows = await this.fileRepository
      .createQueryBuilder('file')
      .select(['file.id', 'file.storageKey'])
      .where('file.conversationId IS NULL')
      .andWhere(`file.metadata->>'source' IN (:...sources)`, { sources: [...FilesService.ATTACHMENT_SOURCES] })
      .andWhere('file.createdAt < :cutoff', { cutoff })
      .take(batch)
      .getMany();
    return this.removeRows(rows);
  }

  private async removeRows(rows: Array<Pick<AgentFile, 'id' | 'storageKey'>>): Promise<number> {
    if (!rows.length) return 0;
    for (const row of rows) {
      // An object that is already gone is not a reason to keep the row.
      await this.storageService.delete(row.storageKey).catch((err) =>
        this.logger.warn(`Could not remove stored object for file ${row.id}: ${err?.message ?? err}`),
      );
    }
    const result = await this.fileRepository.delete({ id: In(rows.map((r) => r.id)) });
    return result.affected ?? rows.length;
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
