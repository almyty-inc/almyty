import {
  Entity, Column, PrimaryGeneratedColumn, CreateDateColumn,
  ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { Organization } from './organization.entity';

export enum AuditAction {
  // Generic CRUD
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  // Agent-specific
  ACTIVATE = 'activate',
  DEACTIVATE = 'deactivate',
  EXECUTE = 'execute',
  INVOKE = 'invoke',
  SCHEDULE = 'schedule',
  UNSCHEDULE = 'unschedule',
  DUPLICATE = 'duplicate',
  IMPORT = 'import',
  EXPORT = 'export',
  ROLLBACK = 'rollback',
  // Run-specific
  RUN_START = 'run_start',
  RUN_COMPLETE = 'run_complete',
  RUN_FAIL = 'run_fail',
  RUN_CANCEL = 'run_cancel',
  RUN_INPUT = 'run_input',
  // Tool-specific
  TOOL_EXECUTE = 'tool_execute',
  TOOL_ACTIVATE = 'tool_activate',
  TOOL_DEACTIVATE = 'tool_deactivate',
  // Gateway-specific
  GATEWAY_ACTIVATE = 'gateway_activate',
  GATEWAY_DEACTIVATE = 'gateway_deactivate',
  TOOL_ASSIGN = 'tool_assign',
  TOOL_REMOVE = 'tool_remove',
  // Memory
  MEMORY_STORE = 'memory_store',
  MEMORY_RECALL = 'memory_recall',
  MEMORY_UPDATE = 'memory_update',
  MEMORY_DELETE = 'memory_delete',
  // Canonical memory (v1) operations beyond basic CRUD.
  MEMORY_SUPERSEDE = 'memory_supersede',
  MEMORY_SEARCH = 'memory_search',
  MEMORY_TRANSFER = 'memory_transfer',
  MEMORY_SYNC = 'memory_sync',
  MEMORY_DENIED = 'memory_denied',
  MEMORY_SOFTCAP_WARNING = 'memory_softcap_warning',
  // File
  FILE_UPLOAD = 'file_upload',
  FILE_DOWNLOAD = 'file_download',
  FILE_DELETE = 'file_delete',
  // Interface
  INTERFACE_DEPLOY = 'interface_deploy',
  INTERFACE_MESSAGE = 'interface_message',
  // Auth / Access
  LOGIN = 'login',
  API_KEY_CREATE = 'api_key_create',
  API_KEY_REVOKE = 'api_key_revoke',
  // Referral program
  REFERRAL_ATTRIBUTED = 'referral_attributed',
  REFERRAL_QUALIFIED = 'referral_qualified',
  REFERRAL_REWARDED = 'referral_rewarded',
  // Credential
  CREDENTIAL_CREATE = 'credential_create',
  CREDENTIAL_UPDATE = 'credential_update',
  CREDENTIAL_DELETE = 'credential_delete',
  CREDENTIAL_USE = 'credential_use',
  // Data retention
  RETENTION_SWEEP = 'retention_sweep',
}

export enum AuditResource {
  AGENT = 'agent',
  AGENT_RUN = 'agent_run',
  TOOL = 'tool',
  GATEWAY = 'gateway',
  API = 'api',
  MEMORY = 'memory',
  FILE = 'file',
  INTERFACE = 'interface',
  CREDENTIAL = 'credential',
  API_KEY = 'api_key',
  USER = 'user',
  ORGANIZATION = 'organization',
  LLM_PROVIDER = 'llm_provider',
  LLM_SESSION = 'llm_session',
  REFERRAL = 'referral',
}

@Entity('audit_logs')
@Index(['organizationId', 'createdAt'])
@Index(['resourceType', 'resourceId'])
@Index(['userId', 'createdAt'])
@Index(['action'])
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  organizationId: string;

  @Column({ nullable: true })
  userId: string;

  @Column({ nullable: true })
  userEmail: string;

  @Column({ type: 'varchar' })
  action: AuditAction;

  @Column({ type: 'varchar' })
  resourceType: AuditResource;

  @Column()
  resourceId: string;

  @Column({ nullable: true })
  resourceName: string;

  @Column({ type: 'json', nullable: true })
  details: Record<string, any>;

  @Column({ type: 'json', nullable: true })
  changes: { field: string; from: any; to: any }[];

  @Column({ nullable: true })
  ipAddress: string;

  @Column({ nullable: true })
  userAgent: string;

  @Column({ type: 'varchar', nullable: true })
  status: string;

  @Column({ type: 'float', nullable: true })
  duration: number;

  @Column({ type: 'float', nullable: true })
  cost: number;

  @Column({ type: 'json', nullable: true })
  metadata: Record<string, any>;

  @CreateDateColumn()
  createdAt: Date;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organizationId' })
  organization: Organization;
}
