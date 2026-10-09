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
  /** Memories moved from one memory account to another (MemoryMoveService): started, and finished. */
  MEMORY_MOVE = 'memory_move',
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

  // Models layer
  MODEL_REGISTERED = 'model_registered',
  MODEL_VALIDATED = 'model_validated',
  MODEL_PRICE_UPDATED = 'model_price_updated',
  MODEL_ROUTED = 'model_routed',
  MODEL_ROUTE_ESCALATED = 'model_route_escalated',
  MODEL_DEPLOYMENT_TRANSITION = 'model_deployment_transition',
  MODEL_DEPLOYMENT_BUDGET_STOP = 'model_deployment_budget_stop',
  MODEL_DEPLOYMENT_ORPHAN_TEARDOWN = 'model_deployment_orphan_teardown',

  // Connections layer
  CONNECTION_CONNECT = 'connection_connect',
  CONNECTION_VALIDATE = 'connection_validate',
  CONNECTION_DISCONNECT = 'connection_disconnect',
  CONNECTION_ROTATE = 'connection_rotate',
  CONNECTION_REVOKE = 'connection_revoke',
  CONNECTION_RESOLVE = 'connection_resolve',
  CONNECTION_GRANT = 'connection_grant',
  CONNECTION_REVOKE_GRANT = 'connection_revoke_grant',
  CONNECTION_SHARE = 'connection_share',
  CONNECTOR_CREATE = 'connector_create',

  // Governance: a departed member's private resources handed to someone
  // else, and a deleted team's resources widened to the organization.
  OWNERSHIP_TRANSFER = 'ownership_transfer',
  VISIBILITY_CHANGE = 'visibility_change',

  // A tool call held for a person's approval by an approval policy's
  // amount rule (ToolApprovalGate): asked, or refused where nobody can be asked.
  APPROVAL_GATE = 'approval_gate',

  // A person's data on an agent's channels: their copy sent to them, or
  // everything held about them erased, by the visitor themselves or by an
  // owner answering their request. Counts and a hashed reference only.
  VISITOR_DATA_EXPORT = 'visitor_data_export',
  VISITOR_DATA_ERASE = 'visitor_data_erase',

  // Always on (docs/always-on.md): switched on or off by a person, paused
  // by the system (with its reason), and a wake that could not start a run.
  ALWAYS_ON_ENABLE = 'always_on_enable',
  ALWAYS_ON_DISABLE = 'always_on_disable',
  ALWAYS_ON_PAUSE = 'always_on_pause',
  WAKE_DROPPED = 'wake_dropped',

  // Hosted runners (docs/hosted-runners.md): an environment's changes, every
  // move of its machines (details.from/to: provisioned, woken, suspended,
  // torn down, failed), a pod enrolling, and a workspace parked or resumed.
  ENVIRONMENT_CREATED = 'environment_created',
  ENVIRONMENT_UPDATED = 'environment_updated',
  ENVIRONMENT_DELETED = 'environment_deleted',
  HOSTED_RUNNER_TRANSITION = 'hosted_runner_transition',
  RUNNER_ENROLLED = 'runner_enrolled',
  WORKSPACE_SUSPENDED = 'workspace_suspended',
  WORKSPACE_RESUMED = 'workspace_resumed',
  // The pod-scoped model token: minted at pod start, revoked when the pod
  // stops, and every model call a pod makes with it.
  HOSTED_MODEL_TOKEN_ISSUED = 'hosted_model_token_issued',
  HOSTED_MODEL_TOKEN_REVOKED = 'hosted_model_token_revoked',
  HOSTED_MODEL_CALL = 'hosted_model_call',
}

export enum AuditResource {
  AGENT = 'agent',
  AGENT_RUN = 'agent_run',
  TOOL = 'tool',
  TOOL_TEMPLATE = 'tool_template',
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
  MODEL = 'model',
  MODEL_VERSION = 'model_version',
  MODEL_DEPLOYMENT = 'model_deployment',
  CONNECTION = 'connection',
  CONNECTOR = 'connector',

  REFERRAL = 'referral',
  RUNNER = 'runner',
  ENVIRONMENT = 'environment',
  HOSTED_RUNNER = 'hosted_runner',
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
