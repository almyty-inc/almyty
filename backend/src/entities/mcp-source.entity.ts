import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Organization } from './organization.entity';

export enum McpSourceStatus {
  ACTIVE = 'active',
  ERROR = 'error',
  SYNCING = 'syncing',
}

export type McpSourceAuthType = 'none' | 'bearer' | 'headers';

/**
 * An external MCP server registered as a tool source. Discovery
 * (initialize + tools/list) materializes each remote tool as a Tool
 * row with type='mcp'; execution proxies tools/call through
 * McpClientService.
 *
 * The auth secret lives in the org's credential store (`credentialId`);
 * `authConfig` is the read-through shim for rows not yet moved by the
 * startup backfill. The API layer never returns either; only authType
 * and the credential reference are exposed.
 */
@Entity('mcp_sources')
@Index(['organizationId', 'name'], { unique: true })
@Index(['organizationId', 'createdAt'])
export class McpSource {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ nullable: true })
  description: string | null;

  @Column()
  url: string;

  @Column({ type: 'varchar', length: 16, default: 'none' })
  authType: McpSourceAuthType;

  /**
   * The auth secret: a Credential row in the org's store (bearer_token
   * with `token`, or custom with `headers`). Resolved through
   * CredentialRefResolver on every call.
   */
  @Column({ type: 'uuid', nullable: true })
  credentialId: string | null;

  /**
   * Read-through shim only: rows the startup backfill has not moved yet
   * still carry the encrypted values here. Never written any more.
   * TODO(2026-12-01): drop the shim.
   */
  @Column({ type: 'json', nullable: true })
  authConfig: {
    /** Encrypted bearer token (field-crypto format). */
    bearerToken?: string;
    /** Custom headers; values encrypted (field-crypto format). */
    headers?: Record<string, string>;
  } | null;

  @Column({ type: 'varchar', length: 16, default: McpSourceStatus.ACTIVE })
  status: McpSourceStatus;

  @Column({ type: 'timestamptz', nullable: true })
  lastSyncAt: Date | null;

  @Column({ type: 'text', nullable: true })
  lastError: string | null;

  @Column({ type: 'int', default: 0 })
  toolCount: number;

  /** serverInfo returned by the remote initialize handshake. */
  @Column({ type: 'json', nullable: true })
  serverInfo: { name?: string; version?: string; protocolVersion?: string } | null;

  @Column()
  organizationId: string;

  @Column({ nullable: true })
  createdBy: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organizationId' })
  organization: Organization;
}
