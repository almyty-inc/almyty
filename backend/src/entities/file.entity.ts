import {
  Entity, Column, PrimaryGeneratedColumn, CreateDateColumn,
  ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { Organization } from './organization.entity';

@Entity('files')
@Index(['organizationId'])
@Index(['agentId'])
export class AgentFile {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  organizationId: string;

  @Column({ nullable: true })
  agentId: string;

  @Column({ nullable: true })
  runId: string;

  @Column()
  name: string;

  @Column()
  mimeType: string;

  @Column({ default: 0 })
  size: number;

  @Column()
  storageKey: string;

  @Column({ nullable: true })
  storageUrl: string;

  @Column({ type: 'text', nullable: true })
  extractedText: string;

  @Column({ nullable: true })
  memoryId: string;

  /**
   * The conversation a file someone sent in chat belongs to (a channel or
   * web chat attachment). The retention sweep and visitor erasure find it
   * by this; the foreign key cascades (migration FileConversation).
   */
  @Index('IDX_files_conversationId')
  @Column({ type: 'uuid', nullable: true })
  conversationId: string | null;

  @Column({ nullable: true })
  uploadedBy: string;

  @Column({ type: 'json', nullable: true })
  metadata: Record<string, any>;

  @CreateDateColumn()
  createdAt: Date;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organizationId' })
  organization: Organization;
}
