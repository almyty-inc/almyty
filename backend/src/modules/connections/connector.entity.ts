import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Organization } from '../../entities/organization.entity';
import { ConnectorDefinition, ConnectorKind } from './connector.types';

/**
 * An org-defined connector: any OpenAI-compatible endpoint, any MCP
 * server, any bucket. The definition is the same shape as a built-in
 * catalog entry and is validated on write; built-ins are data in
 * connector-catalog.ts and never stored here.
 */
@Entity('connectors')
@Index(['organizationId', 'key'], { unique: true })
export class CustomConnector {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  organizationId: string;

  @Column({ type: 'varchar', length: 64 })
  key: string;

  @Column({ type: 'varchar', length: 32 })
  kind: ConnectorKind;

  @Column({ type: 'varchar', length: 120 })
  displayName: string;

  @Column({ type: 'json' })
  definition: ConnectorDefinition;

  @Column({ type: 'uuid', nullable: true })
  createdBy: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organizationId' })
  organization: Organization;
}
