import {
  Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn,
  ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { Organization } from './organization.entity';

export enum MemoryType {
  FACT = 'fact',
  PREFERENCE = 'preference',
  CONTEXT = 'context',
  EPISODE = 'episode',
  INSTRUCTION = 'instruction',
}

export enum MemoryScope {
  AGENT = 'agent',
  SHARED = 'shared',
  GLOBAL = 'global',
}

@Entity('memories')
@Index(['organizationId', 'scope'])
@Index(['organizationId', 'type'])
export class Memory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  organizationId: string;

  @Column({ type: 'varchar' })
  type: MemoryType;

  @Column({ type: 'text' })
  content: string;

  @Column({ type: 'float', array: true, nullable: true })
  embedding: number[];

  @Column({ type: 'json', nullable: true })
  source: { type: string; id?: string; name?: string };

  @Column({ type: 'varchar', default: MemoryScope.SHARED })
  scope: MemoryScope;

  @Column({ type: 'uuid', array: true, default: '{}' })
  agentIds: string[];

  @Column({ type: 'text', array: true, default: '{}' })
  tags: string[];

  @Column({ type: 'json', nullable: true })
  metadata: Record<string, any>;

  @Column({ default: true })
  isActive: boolean;

  @Column({ default: 0 })
  accessCount: number;

  @Column({ nullable: true })
  lastAccessedAt: Date;

  @Column({ nullable: true })
  createdBy: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organizationId' })
  organization: Organization;
}
