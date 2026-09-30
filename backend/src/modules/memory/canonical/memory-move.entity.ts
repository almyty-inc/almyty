import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { Mode, ScopeType } from './canonical.types';

/**
 * Moving memories from one memory account to another: copy each one to the
 * target, then delete it from the source.
 *
 * An account is almyty's own memory (`service` almyty-native, no
 * credential) or a connection of a memory service (`service` the backend
 * id, `credential_id` the connection). The row is the move's progress and
 * its result; `memory_move_items` records each memory's step, so a move
 * that stopped part way (a service down, the process restarted) resumes
 * where it was: a memory already copied is not copied again, only deleted
 * from the source.
 */
export type MemoryMoveStatus = 'queued' | 'running' | 'completed' | 'failed';

@Entity('memory_moves')
@Index('memory_moves_org', ['organizationId', 'createdAt'])
export class MemoryMove {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({ name: 'source_service', type: 'text' })
  sourceService: string;

  @Column({ name: 'source_credential_id', type: 'uuid', nullable: true })
  sourceCredentialId: string | null;

  @Column({ name: 'target_service', type: 'text' })
  targetService: string;

  @Column({ name: 'target_credential_id', type: 'uuid', nullable: true })
  targetCredentialId: string | null;

  @Column({ name: 'scope_type', type: 'text' })
  scopeType: ScopeType;

  @Column({ name: 'scope_id', type: 'text' })
  scopeId: string;

  @Column({ type: 'text', default: 'memory' })
  mode: Mode;

  @Column({ type: 'text', default: 'queued' })
  status: MemoryMoveStatus;

  /** Memories moved: copied to the target and deleted from the source. */
  @Column({ type: 'int', default: 0 })
  moved: number;

  /** Memories the last run could not move; a resume tries them again. */
  @Column({ type: 'int', default: 0 })
  failed: number;

  /** How many the source said it holds when the move started; null when it does not say. */
  @Column({ type: 'int', nullable: true })
  total: number | null;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError: string | null;

  /** What the target cannot keep that the source had (MemoryRouter's transfer warnings). */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  warnings: Array<{ capability: string; field: string; count: number }>;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  /** Also the heartbeat of a running move: a run touches it after every page. */
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt: Date | null;
}

/**
 * One memory of a move. `copied`: it is on the target, not yet deleted
 * from the source. `moved`: done. `failed`: the copy failed (a resume
 * copies it again).
 */
export type MemoryMoveItemState = 'copied' | 'moved' | 'failed';

@Entity('memory_move_items')
@Index('memory_move_items_source', ['moveId', 'sourceId'], { unique: true })
export class MemoryMoveItem {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'move_id', type: 'uuid' })
  moveId: string;

  /** The id the source deletes the memory by. */
  @Column({ name: 'source_id', type: 'text' })
  sourceId: string;

  /** The id the target knows the copy by. */
  @Column({ name: 'target_id', type: 'text', nullable: true })
  targetId: string | null;

  @Column({ type: 'text' })
  state: MemoryMoveItemState;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
