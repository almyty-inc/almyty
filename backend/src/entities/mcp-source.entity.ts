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
 * authConfig secret values (bearer token, custom header values) are
 * encrypted at rest with the field-crypto AES-256-GCM scheme — the
 * same ENCRYPTION_KEY that covers credentials and LLM provider keys.
 * The API layer never returns authConfig; only authType is exposed.
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
