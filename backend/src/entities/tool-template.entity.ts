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

@Entity('tool_templates')
@Index(['provider'])
@Index(['category'])
@Index(['organizationId'])
export class ToolTemplate {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ length: 100 })
  provider: string;

  @Column({ nullable: true, length: 500 })
  providerIcon: string;

  @Column({ length: 100 })
  category: string;

  @Column({ type: 'text', array: true, default: '{}' })
  tags: string[];

  @Column({ length: 50 })
  executionMethod: string;

  @Column({ type: 'json', nullable: true })
  httpConfig: any;

  @Column({ type: 'json', default: {} })
  parameters: Record<string, any>;

  @Column({ type: 'json', default: {} })
  configuration: Record<string, any>;

  @Column({ type: 'json', default: [] })
  examples: Array<{ name: string; input: any; expectedOutput?: any }>;

  @Column({ type: 'json', nullable: true })
  apiConfig: {
    name: string;
    baseUrl: string;
    headers?: Record<string, string>;
    authRequirements?: {
      type: string;
      scopes?: string[];
      setupInstructions?: string;
    };
  } | null;

  @Column({ type: 'jsonb', nullable: true })
  sdkConfig: any | null;

  @Column({ type: 'jsonb', nullable: true })
  sdkMap: any | null;

  @Column({ default: false })
  isBuiltIn: boolean;

  @Column({ nullable: true })
  organizationId: string;

  @Column({ default: 'public', length: 20 })
  visibility: string;

  @Column({ default: '1.0.0', length: 20 })
  version: string;

  @Column({ default: 0 })
  installCount: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => Organization, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organizationId' })
  organization: Organization;
}
