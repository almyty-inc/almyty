import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'fs';
import { join } from 'path';

import { ModelManifest, manifestSha, totalSizeBytes, validateManifest } from './manifest';
import { ParsedRegistryUri, parseRegistryUri } from './registry-uri';

/**
 * Reads and writes the model registry.
 *
 * S3-compatible storage is the default and the only path the conformance
 * suite exercises; the endpoint is configurable so MinIO, R2 and Spaces
 * work. `file://` serves a runner-local copy. `hf://` is an optional
 * read-only source and nothing may require it. The S3 client is loaded
 * lazily, like the files module does, so the community build does not
 * need the SDK unless a registry is configured.
 */
export interface RegistryObjectStore {
  getObject(bucket: string, key: string): Promise<Buffer>;
  putObject(bucket: string, key: string, body: Buffer, contentType: string): Promise<{ etag: string }>;
  headObject(bucket: string, key: string): Promise<{ etag: string; sizeBytes: number } | null>;
}

export const MANIFEST_FILE = 'almyty-manifest.json';

export interface RegistryConfig {
  endpoint?: string;
  region: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  bucket?: string;
}

@Injectable()
export class ModelRegistryService {
  private readonly logger = new Logger(ModelRegistryService.name);
  private store: RegistryObjectStore | null = null;

  constructor(
    @Optional() private readonly configService?: ConfigService,
    /** Injected in tests; production builds the S3 store from config. */
    @Optional() storeOverride?: RegistryObjectStore,
  ) {
    if (storeOverride) this.store = storeOverride;
  }

  /** Registry settings, falling back to the files module's S3 settings so one bucket can serve both. */
  config(): RegistryConfig {
    const get = (k: string, d?: string) => (this.configService?.get<string>(k) ?? process.env[k] ?? d) as string | undefined;
    return {
      endpoint: get('MODEL_REGISTRY_S3_ENDPOINT') ?? get('STORAGE_S3_ENDPOINT'),
      region: get('MODEL_REGISTRY_S3_REGION') ?? get('STORAGE_S3_REGION', 'us-east-1') ?? 'us-east-1',
      accessKeyId: get('MODEL_REGISTRY_S3_ACCESS_KEY') ?? get('STORAGE_S3_ACCESS_KEY'),
      secretAccessKey: get('MODEL_REGISTRY_S3_SECRET_KEY') ?? get('STORAGE_S3_SECRET_KEY'),
      bucket: get('MODEL_REGISTRY_S3_BUCKET') ?? get('STORAGE_S3_BUCKET'),
    };
  }

  isConfigured(): boolean {
    const c = this.config();
    return !!(this.store || (c.accessKeyId && c.secretAccessKey && c.bucket));
  }

  private objectStore(): RegistryObjectStore {
    if (this.store) return this.store;
    const c = this.config();
    if (!c.accessKeyId || !c.secretAccessKey) {
      throw Object.assign(new Error('model registry is not configured (MODEL_REGISTRY_S3_* or STORAGE_S3_*)'), { code: 'REGISTRY_NOT_CONFIGURED' });
    }
    // Lazy so the SDK is only needed when a registry is actually used.
    const { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
    const client = new S3Client({
      endpoint: c.endpoint,
      region: c.region,
      credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
      forcePathStyle: true,
    });
    const toBuffer = async (body: any): Promise<Buffer> => {
      if (typeof body?.transformToByteArray === 'function') return Buffer.from(await body.transformToByteArray());
      const chunks: Buffer[] = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks);
    };
    this.store = {
      async getObject(bucket, key) {
        const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return toBuffer(out.Body);
      },
      async putObject(bucket, key, body, contentType) {
        const out = await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
        return { etag: String(out.ETag ?? '').replace(/"/g, '') };
      },
      async headObject(bucket, key) {
        try {
          const out = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
          return { etag: String(out.ETag ?? '').replace(/"/g, ''), sizeBytes: Number(out.ContentLength ?? 0) };
        } catch (err: any) {
          if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound') return null;
          throw err;
        }
      },
    };
    return this.store;
  }

  /** The manifest a registry URI points at, validated. */
  async readManifest(uri: string): Promise<ModelManifest> {
    const parsed = parseRegistryUri(uri);
    const raw = await this.readText(parsed, MANIFEST_FILE);
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw Object.assign(new Error(`${MANIFEST_FILE} at ${uri} is not valid JSON`), { code: 'REGISTRY_MANIFEST_INVALID' });
    }
    return validateManifest(json);
  }

  /**
   * Write a manifest for weights already uploaded under `s3://bucket/prefix`
   * and return the pinned URI a version is registered with.
   */
  async publishManifest(bucket: string, prefix: string, manifest: ModelManifest): Promise<{ registryUri: string; manifestSha: string; sizeBytes: number }> {
    const valid = validateManifest(manifest);
    const body = Buffer.from(JSON.stringify(valid, null, 2));
    const key = prefix ? `${prefix.replace(/\/+$/, '')}/${MANIFEST_FILE}` : MANIFEST_FILE;
    const { etag } = await this.objectStore().putObject(bucket, key, body, 'application/json');
    const sha = manifestSha(valid);
    return { registryUri: `s3://${bucket}/${prefix.replace(/\/+$/, '')}@${etag || sha}`, manifestSha: sha, sizeBytes: totalSizeBytes(valid) };
  }

  /** Everything a ModelVersion row needs from a URI: validated manifest, digest, size. */
  async describeVersion(uri: string): Promise<{ manifest: ModelManifest; manifestSha: string; sizeBytes: number; parsed: ParsedRegistryUri }> {
    const parsed = parseRegistryUri(uri);
    const manifest = await this.readManifest(uri);
    return { manifest, manifestSha: manifestSha(manifest), sizeBytes: totalSizeBytes(manifest), parsed };
  }

  private async readText(parsed: ParsedRegistryUri, file: string): Promise<string> {
    switch (parsed.scheme) {
      case 's3': {
        const key = parsed.prefix ? `${parsed.prefix}/${file}` : file;
        return (await this.objectStore().getObject(parsed.location, key)).toString('utf8');
      }
      case 'file': {
        const path = join(parsed.location, file);
        return fs.readFile(path, 'utf8');
      }
      case 'hf': {
        // Read-only, optional: the hub serves raw files over HTTPS.
        const url = `https://huggingface.co/${parsed.location}/resolve/${parsed.pin}/${file}`;
        const res = await fetch(url, { headers: process.env.HF_TOKEN ? { Authorization: `Bearer ${process.env.HF_TOKEN}` } : {} });
        if (!res.ok) throw Object.assign(new Error(`hub returned ${res.status} for ${url}`), { code: 'REGISTRY_SOURCE_UNAVAILABLE' });
        return res.text();
      }
    }
  }
}
