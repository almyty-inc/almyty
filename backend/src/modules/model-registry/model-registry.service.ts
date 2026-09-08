import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { promises as fs } from 'fs';
import { join } from 'path';

import { Credential, CredentialType } from '../../entities/credential.entity';
import { Organization } from '../../entities/organization.entity';
import { EnvelopeCryptoService } from '../kms/envelope-crypto.service';
import { ModelManifest, manifestSha, totalSizeBytes, validateManifest } from './manifest';
import { ParsedRegistryUri, parseRegistryUri } from './registry-uri';

/** The registry connection's credential type. Lives in the credential enum as data; the literal is used until the enum value is compiled in. */
export const REGISTRY_CREDENTIAL_TYPE = 's3_compatible' as CredentialType;

export interface RegistryObjectStore {
  getObject(bucket: string, key: string): Promise<Buffer>;
  putObject(bucket: string, key: string, body: Buffer, contentType: string): Promise<{ etag: string }>;
  headObject(bucket: string, key: string): Promise<{ etag: string; sizeBytes: number } | null>;
}

export const MANIFEST_FILE = 'almyty-manifest.json';

/** One organization's registry: its own bucket, its own keys. */
export interface RegistryConnection {
  credentialId: string;
  endpoint?: string;
  region: string;
  bucket: string;
  prefix?: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** What adapters receive so they can read the org's weights themselves. Keys named to match the adapter contract. */
export interface RegistryAdapterCredentials {
  registryAccessKeyId: string;
  registrySecretAccessKey: string;
  registryEndpoint?: string;
  registryRegion?: string;
  registryBucket?: string;
}

export class RegistryNotConnectedError extends Error {
  readonly code = 'REGISTRY_NOT_CONNECTED';
  constructor(organizationId: string) {
    super('This organization has no model registry connection. Connect an S3-compatible bucket first.');
    this.name = 'RegistryNotConnectedError';
    void organizationId;
  }
}

/** Test seam: a store per organization, or one store for every organization. */
export type RegistryStoreOverride = RegistryObjectStore | ((organizationId: string) => RegistryObjectStore | null);

/**
 * The registry is the customer's own bucket. Every read and write is
 * resolved through the organization's registry connection (a Credential
 * of type s3_compatible); there is no install-wide bucket. The only role
 * the MODEL_REGISTRY_S3_* / STORAGE_S3_* variables keep is to seed one
 * org-scoped connection on first boot of a single-tenant self-host, when
 * exactly one organization exists and it has none.
 */
@Injectable()
export class ModelRegistryService implements OnModuleInit {
  private readonly logger = new Logger(ModelRegistryService.name);
  private readonly stores = new Map<string, { key: string; store: RegistryObjectStore }>();

  constructor(
    @Optional() private readonly configService?: ConfigService,
    /** Injected in tests; production builds the S3 store from the org's connection. */
    @Optional() private readonly storeOverride?: RegistryStoreOverride,
    @Optional() @InjectRepository(Credential) private readonly credentials?: Repository<Credential>,
    @Optional() @InjectRepository(Organization) private readonly organizations?: Repository<Organization>,
    @Optional() private readonly envelopeCrypto?: EnvelopeCryptoService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    try {
      await this.seedSingleTenantFromEnv();
    } catch (err: any) {
      this.logger.warn(`registry seed skipped: ${err?.message ?? err}`);
    }
  }

  /** Environment settings; only ever used by the single-tenant seed. */
  envConfig(): { endpoint?: string; region: string; accessKeyId?: string; secretAccessKey?: string; bucket?: string; prefix?: string } {
    const get = (k: string, d?: string) => (this.configService?.get<string>(k) ?? process.env[k] ?? d) as string | undefined;
    return {
      endpoint: get('MODEL_REGISTRY_S3_ENDPOINT') ?? get('STORAGE_S3_ENDPOINT'),
      region: get('MODEL_REGISTRY_S3_REGION') ?? get('STORAGE_S3_REGION', 'us-east-1') ?? 'us-east-1',
      accessKeyId: get('MODEL_REGISTRY_S3_ACCESS_KEY') ?? get('STORAGE_S3_ACCESS_KEY'),
      secretAccessKey: get('MODEL_REGISTRY_S3_SECRET_KEY') ?? get('STORAGE_S3_SECRET_KEY'),
      bucket: get('MODEL_REGISTRY_S3_BUCKET') ?? get('STORAGE_S3_BUCKET'),
      prefix: get('MODEL_REGISTRY_S3_PREFIX'),
    };
  }

  /**
   * Single-tenant convenience: with exactly one organization and env keys
   * present, create that organization's registry connection once. With
   * two or more organizations the variables are ignored: a bucket shared
   * across tenants is never created.
   */
  async seedSingleTenantFromEnv(): Promise<Credential | null> {
    const env = this.envConfig();
    if (!env.accessKeyId || !env.secretAccessKey || !env.bucket) return null;
    if (!this.credentials || !this.organizations) return null;
    const orgCount = await this.organizations.count();
    if (orgCount !== 1) {
      if (orgCount > 1) this.logger.warn('MODEL_REGISTRY_S3_* ignored: more than one organization exists; each connects its own registry');
      return null;
    }
    const org = await this.organizations.findOne({ where: {} });
    if (!org) return null;
    const existing = await this.credentials.findOne({ where: { organizationId: org.id, type: REGISTRY_CREDENTIAL_TYPE } });
    if (existing) return null;
    const credential = this.credentials.create({
      organizationId: org.id,
      name: 'Model registry (seeded from environment)',
      description: 'Created on first boot from MODEL_REGISTRY_S3_* / STORAGE_S3_*. Rotate or replace it in Settings.',
      type: REGISTRY_CREDENTIAL_TYPE,
      config: { endpoint: env.endpoint, region: env.region, bucket: env.bucket, prefix: env.prefix, accessKeyId: env.accessKeyId, secretAccessKey: env.secretAccessKey },
      isActive: true,
    } as Partial<Credential>) as Credential;
    if (this.envelopeCrypto && typeof (credential as any).encryptSensitiveDataForOrg === 'function') {
      await (credential as any).encryptSensitiveDataForOrg(this.envelopeCrypto);
    } else {
      credential.encryptSensitiveData();
    }
    const saved = await this.credentials.save(credential);
    this.logger.log(`seeded the registry connection for organization ${org.id} from the environment`);
    return saved;
  }

  /** The organization's registry connection, decrypted, or a typed refusal. */
  async connectionFor(organizationId: string): Promise<RegistryConnection> {
    if (!this.credentials) throw new RegistryNotConnectedError(organizationId);
    if (this.envelopeCrypto) await this.envelopeCrypto.warmOrg(organizationId);
    const credential = await this.credentials.findOne({ where: { organizationId, type: REGISTRY_CREDENTIAL_TYPE, isActive: true } });
    if (!credential) throw new RegistryNotConnectedError(organizationId);
    const cfg = credential.getDecryptedConfig();
    if (!cfg.bucket || !cfg.accessKeyId || !cfg.secretAccessKey) {
      throw Object.assign(new Error('The registry connection is incomplete (bucket and keys are required)'), { code: 'REGISTRY_CONNECTION_INVALID', credentialId: credential.id });
    }
    return {
      credentialId: credential.id,
      endpoint: cfg.endpoint || undefined,
      region: cfg.region || 'us-east-1',
      bucket: cfg.bucket,
      prefix: cfg.prefix || undefined,
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    };
  }

  async isConnected(organizationId: string): Promise<boolean> {
    try {
      await this.connectionFor(organizationId);
      return true;
    } catch {
      return this.resolveOverride(organizationId) != null;
    }
  }

  /** Keys an adapter needs to read this organization's weights, in the adapter contract's names. */
  async adapterCredentialsFor(organizationId: string): Promise<RegistryAdapterCredentials> {
    const c = await this.connectionFor(organizationId);
    return {
      registryAccessKeyId: c.accessKeyId,
      registrySecretAccessKey: c.secretAccessKey,
      ...(c.endpoint ? { registryEndpoint: c.endpoint } : {}),
      registryRegion: c.region,
      registryBucket: c.bucket,
    };
  }

  private resolveOverride(organizationId: string): RegistryObjectStore | null {
    if (!this.storeOverride) return null;
    return typeof this.storeOverride === 'function' ? this.storeOverride(organizationId) : this.storeOverride;
  }

  private async objectStore(organizationId: string): Promise<RegistryObjectStore> {
    const override = this.resolveOverride(organizationId);
    if (override) return override;
    const c = await this.connectionFor(organizationId);
    const cacheKey = `${c.credentialId}:${c.accessKeyId}:${c.endpoint ?? ''}:${c.region}`;
    const cached = this.stores.get(organizationId);
    if (cached && cached.key === cacheKey) return cached.store;
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
    const store: RegistryObjectStore = {
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
    this.stores.set(organizationId, { key: cacheKey, store });
    return store;
  }

  /** The manifest a registry URI points at, validated, read with the organization's own keys. */
  async readManifest(uri: string, organizationId: string): Promise<ModelManifest> {
    const parsed = parseRegistryUri(uri);
    const raw = await this.readText(parsed, MANIFEST_FILE, organizationId);
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw Object.assign(new Error(`${MANIFEST_FILE} at ${uri} is not valid JSON`), { code: 'REGISTRY_MANIFEST_INVALID' });
    }
    return validateManifest(json);
  }

  /**
   * Write a manifest for weights already uploaded under the organization's
   * bucket at `prefix` and return the pinned URI a version is registered with.
   * The bucket comes from the connection; a caller never names one.
   */
  async publishManifest(organizationId: string, prefix: string, manifest: ModelManifest): Promise<{ registryUri: string; manifestSha: string; sizeBytes: number }> {
    const valid = validateManifest(manifest);
    const store = await this.objectStore(organizationId);
    const bucket = await this.bucketFor(organizationId);
    const fullPrefix = [await this.prefixFor(organizationId), prefix].filter(Boolean).join('/').replace(/\/+$/, '');
    const body = Buffer.from(JSON.stringify(valid, null, 2));
    const key = fullPrefix ? `${fullPrefix}/${MANIFEST_FILE}` : MANIFEST_FILE;
    const { etag } = await store.putObject(bucket, key, body, 'application/json');
    const sha = manifestSha(valid);
    return { registryUri: `s3://${bucket}/${fullPrefix}@${etag || sha}`, manifestSha: sha, sizeBytes: totalSizeBytes(valid) };
  }

  /** Everything a ModelVersion row needs from a URI: validated manifest, digest, size. */
  async describeVersion(uri: string, organizationId: string): Promise<{ manifest: ModelManifest; manifestSha: string; sizeBytes: number; parsed: ParsedRegistryUri }> {
    const parsed = parseRegistryUri(uri);
    const manifest = await this.readManifest(uri, organizationId);
    return { manifest, manifestSha: manifestSha(manifest), sizeBytes: totalSizeBytes(manifest), parsed };
  }

  private async bucketFor(organizationId: string): Promise<string> {
    if (this.resolveOverride(organizationId) && !this.credentials) return 'registry';
    try {
      return (await this.connectionFor(organizationId)).bucket;
    } catch (err) {
      if (this.resolveOverride(organizationId)) return 'registry';
      throw err;
    }
  }

  private async prefixFor(organizationId: string): Promise<string | undefined> {
    try {
      return (await this.connectionFor(organizationId)).prefix;
    } catch {
      return undefined;
    }
  }

  private async readText(parsed: ParsedRegistryUri, file: string, organizationId: string): Promise<string> {
    switch (parsed.scheme) {
      case 's3': {
        const key = parsed.prefix ? `${parsed.prefix}/${file}` : file;
        const store = await this.objectStore(organizationId);
        return (await store.getObject(parsed.location, key)).toString('utf8');
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
