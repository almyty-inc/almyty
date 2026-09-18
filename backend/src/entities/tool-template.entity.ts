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
// One name per owner. The two partial indexes are deliberate: Postgres
// treats NULLs as distinct, so a single (organizationId, name) index
// would leave public templates -- the rows every tenant sees -- with no
// uniqueness at all.
@Index('tool_templates_org_name_uq', ['organizationId', 'name'], {
  unique: true,
  where: '"organizationId" IS NOT NULL',
})
@Index('tool_templates_public_name_uq', ['name'], {
  unique: true,
  where: '"organizationId" IS NULL',
})
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

  /**
   * Owning organization, and the only thing that decides who can see
   * this template. NULL means public: visible to every tenant. A row
   * with an organizationId is visible to that tenant alone.
   *
   * Nothing reachable over HTTP writes NULL here -- publishing always
   * stamps the caller's current organization -- so a public template
   * can only be created by an operator with database access.
   */
  @Column({ nullable: true })
  organizationId: string;

  /** The user who published this template. */
  @Column({ type: 'uuid', nullable: true })
  createdBy: string | null;

  /**
   * The tool this template was published from, kept for provenance.
   * SET NULL on delete: deleting the source tool does not retract a
   * template other organizations may already have installed.
   */
  @Column({ type: 'uuid', nullable: true })
  sourceToolId: string | null;

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
