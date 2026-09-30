import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { ScopeType } from './canonical.types';

/**
 * When almyty deletes a memory an agent saved in an outside memory account
 * that cannot expire memories itself (Mem0, Zep, Supermemory, the Claude
 * memory tool). One row per saved memory, holding the id that service
 * deletes it by; the hourly sweep (MemoryExpirySweeperProcessor) deletes
 * each one through the service's API once `expiresAt` has passed.
 *
 * `expiresAt` null means "keep until deleted": the row stays so a later
 * change to the agent's retention can still reach the memories it saved.
 * almyty's own store expires memories through `ttl_seconds` and has no
 * rows here.
 */
@Entity('memory_expiries')
@Index('memory_expiries_agent', ['organizationId', 'agentId'])
export class MemoryExpiry {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({ name: 'agent_id', type: 'uuid', nullable: true })
  agentId: string | null;

  @Column({ name: 'backend_id', type: 'text' })
  backendId: string;

  @Column({ name: 'scope_type', type: 'text' })
  scopeType: ScopeType;

  @Column({ name: 'scope_id', type: 'text' })
  scopeId: string;

  /** What the outside service deletes the memory by (MemoryBackend.nativeId). */
  @Column({ name: 'native_id', type: 'text' })
  nativeId: string;

  /** The agent's own account it was saved with (a connection); null for the organization's. */
  @Column({ name: 'credential_id', type: 'uuid', nullable: true })
  credentialId: string | null;

  /** The canonical id the memory was saved under. */
  @Column({ name: 'memory_id', type: 'text' })
  memoryId: string;

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
