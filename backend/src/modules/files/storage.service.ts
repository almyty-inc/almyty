import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';

export interface StorageProvider {
  upload(key: string, data: Buffer, contentType: string): Promise<string>;
  download(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  getSignedUrl(key: string, expiresInSeconds?: number): Promise<string>;
}

/**
 * Local filesystem storage provider (default, no external deps)
 */
class LocalStorageProvider implements StorageProvider {
  private readonly basePath: string;
  private readonly baseUrl: string;

  constructor(basePath: string, baseUrl: string) {
    this.basePath = basePath;
    this.baseUrl = baseUrl;
  }

  async upload(key: string, data: Buffer, contentType: string): Promise<string> {
    const filePath = path.join(this.basePath, key);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, data);
    return `${this.baseUrl}/files/${key}`;
  }

  async download(key: string): Promise<Buffer> {
    const filePath = path.join(this.basePath, key);
    return fs.readFileSync(filePath);
  }

  async delete(key: string): Promise<void> {
    const filePath = path.join(this.basePath, key);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  async getSignedUrl(key: string, expiresInSeconds?: number): Promise<string> {
    // Local doesn't have signed URLs, return direct path
    return `${this.baseUrl}/files/${key}/download`;
  }
}

/**
 * S3-compatible storage provider (works with AWS S3, DigitalOcean Spaces, Cloudflare R2, MinIO, etc.)
 */
class S3StorageProvider implements StorageProvider {
  private s3Client: any;
  private bucket: string;
  private cdnUrl: string | null;

  constructor(config: {
    endpoint: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
    cdnUrl?: string;
  }) {
    // Dynamic import to avoid requiring aws-sdk when not used
    this.bucket = config.bucket;
    this.cdnUrl = config.cdnUrl || null;

    // S3Client initialization is deferred — caller must have @aws-sdk/client-s3 installed
    try {
      const { S3Client } = require('@aws-sdk/client-s3');
      this.s3Client = new S3Client({
        endpoint: config.endpoint,
        region: config.region,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
        forcePathStyle: true,
      });
    } catch {
      throw new Error('S3 storage requires @aws-sdk/client-s3 package. Install it or use local storage.');
    }
  }

  async upload(key: string, data: Buffer, contentType: string): Promise<string> {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await this.s3Client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: data,
      ContentType: contentType,
      ACL: 'private',
    }));
    return this.cdnUrl ? `${this.cdnUrl}/${key}` : key;
  }

  async download(key: string): Promise<Buffer> {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const response = await this.s3Client.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    }));
    const chunks: Buffer[] = [];
    for await (const chunk of response.Body) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  async delete(key: string): Promise<void> {
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    await this.s3Client.send(new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: key,
    }));
  }

  async getSignedUrl(key: string, expiresInSeconds = 3600): Promise<string> {
    try {
      const { GetObjectCommand } = require('@aws-sdk/client-s3');
      const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
      const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
      return getSignedUrl(this.s3Client, command, { expiresIn: expiresInSeconds });
    } catch {
      // Fallback if presigner not installed
      return this.cdnUrl ? `${this.cdnUrl}/${key}` : key;
    }
  }
}

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private provider: StorageProvider;

  constructor(private readonly configService: ConfigService) {
    this.provider = this.initializeProvider();
  }

  private initializeProvider(): StorageProvider {
    const storageType = this.configService.get('STORAGE_TYPE', 'local');

    if (storageType === 's3') {
      const endpoint = this.configService.get('STORAGE_S3_ENDPOINT');
      const region = this.configService.get('STORAGE_S3_REGION', 'us-east-1');
      const accessKeyId = this.configService.get('STORAGE_S3_ACCESS_KEY');
      const secretAccessKey = this.configService.get('STORAGE_S3_SECRET_KEY');
      const bucket = this.configService.get('STORAGE_S3_BUCKET');
      const cdnUrl = this.configService.get('STORAGE_S3_CDN_URL');

      if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
        this.logger.warn('S3 config incomplete, falling back to local storage');
        return this.createLocalProvider();
      }

      this.logger.log(`Using S3-compatible storage: ${endpoint}/${bucket}`);
      return new S3StorageProvider({ endpoint, region, accessKeyId, secretAccessKey, bucket, cdnUrl });
    }

    return this.createLocalProvider();
  }

  private createLocalProvider(): StorageProvider {
    const basePath = this.configService.get('STORAGE_LOCAL_PATH', './uploads');
    const baseUrl = this.configService.get('API_BASE_URL', 'http://localhost:3000');
    this.logger.log(`Using local file storage: ${basePath}`);
    return new LocalStorageProvider(basePath, baseUrl);
  }

  async upload(key: string, data: Buffer, contentType: string): Promise<string> {
    return this.provider.upload(key, data, contentType);
  }

  async download(key: string): Promise<Buffer> {
    return this.provider.download(key);
  }

  async delete(key: string): Promise<void> {
    return this.provider.delete(key);
  }

  async getSignedUrl(key: string, expiresInSeconds?: number): Promise<string> {
    return this.provider.getSignedUrl(key, expiresInSeconds);
  }
}
