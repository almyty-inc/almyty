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
import { Gateway } from './gateway.entity';

export type ChannelInstallationStatus = 'active' | 'revoked';

/**
 * One row per external workspace/tenant a channel gateway is installed
 * into. Lets a single channel deployment (e.g. one Slack app backed by
 * one gateway) serve unlimited customer workspaces: each OAuth install
 * stores that workspace's own credentials (bot token etc.) as a
 * Credential row in the org's store, keyed by the platform tenant id
 * (Slack team_id).
 *
 * `externalTenantId` is deliberately platform-agnostic — Microsoft
 * Teams multi-tenant (AAD tenant id) or any other n-workspace channel
 * can ride the same table later without schema changes.
 *
 * Inbound resolution: adapters extract the tenant id from the webhook
 * payload; when an active installation exists for (gatewayId, tenantId)
 * its credentials override the gateway's single-workspace configuration.
 * Gateways without installations behave exactly as before.
 */
@Entity('channel_installations')
@Index(['gatewayId', 'externalTenantId'], { unique: true })
@Index(['organizationId', 'createdAt'])
export class ChannelInstallation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  gatewayId: string;

  @Column({ type: 'uuid' })
  organizationId: string;

  /** Platform tenant id — Slack team_id, Teams AAD tenant id, ... */
  @Column({ type: 'varchar' })
  externalTenantId: string;

  /**
   * The workspace's own secret (bot token etc.): a Credential row in the
   * org's store, resolved through CredentialRefResolver per inbound
   * event. Released when the installation is revoked.
   */
  @Column({ type: 'uuid', nullable: true })
  credentialId: string | null;

  /**
   * Read-through shim only: rows the startup backfill has not moved yet
   * still carry the encrypted values here. Never written any more; set
   * to null on revoke. TODO(2026-12-01): drop the shim.
   */
  @Column({ type: 'jsonb', nullable: true })
  credentials: Record<string, any> | null;

  @Column({ type: 'varchar', length: 16, default: 'active' })
  status: ChannelInstallationStatus;

  /** Display info (team name, bot user id, granted scopes, ...). */
  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any> | null;

  /** When the workspace (last) completed the OAuth install. */
  @Column({ type: 'timestamptz', default: () => 'now()' })
  installedAt: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => Gateway, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'gatewayId' })
  gateway: Gateway;

  isActive(): boolean {
    return this.status === 'active';
  }
}
