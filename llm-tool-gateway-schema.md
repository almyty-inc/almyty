# LLM Tool Gateway - Comprehensive Database Schema

## Core Entities Overview

### 1. User Management & Organizations
- **Users** - User accounts with roles and permissions
- **Organizations** - Multi-tenant organization support
- **UserOrganizations** - Many-to-many relationship with roles
- **Teams** - Sub-organization team structures
- **UserTeams** - Team membership with specific permissions

### 2. API Management & Schema Processing  
- **APIs** - External API definitions (REST, GraphQL, SOAP, Protobuf)
- **ApiSchemas** - Raw schema definitions (OpenAPI, WSDL, GraphQL SDL, Protobuf)
- **Operations** - Individual API operations/methods
- **Resources** - API resource/model definitions
- **JsonSchemas** - Central JSON Schema translation layer

### 3. Tool Generation & Management
- **Tools** - Generated tools from API operations
- **ToolParameters** - Tool parameter definitions (JSON Schema based)
- **ToolVersions** - Tool versioning and change tracking
- **ToolCategories** - Tool categorization and tagging

### 4. Gateway & Access Management
- **Gateways** - Different gateway types (MCP, A2A, UTCP, scoped tool)
- **GatewayTools** - Many-to-many relationship between gateways and tools
- **GatewayScopes** - Access scoping and permissions per gateway
- **AccessPolicies** - Fine-grained access control policies

### 5. Authentication & Security
- **Credentials** - API authentication credentials
- **GatewayAuth** - Gateway-level authentication settings
- **ApiKeys** - Generated API keys for gateway access
- **AuthProviders** - OAuth, OIDC, and other auth provider configurations

### 6. LLM Provider Integration
- **LLMProviders** - ChatGPT, Claude, LeChatML, etc.
- **LLMProviderConfigs** - Provider-specific configurations
- **LLMConversations** - Track LLM interactions
- **LLMMessages** - Individual messages in conversations

### 7. Monitoring & Analytics
- **UsageMetrics** - API and tool usage statistics
- **RequestLogs** - Detailed request/response logging
- **ErrorLogs** - Error tracking and analysis
- **PerformanceMetrics** - Response times, throughput, etc.

---

## Detailed Entity Definitions

### User Management

```typescript
@Entity()
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  email: string;

  @Column()
  passwordHash: string;

  @Column()
  firstName: string;

  @Column()
  lastName: string;

  @Column({ default: true })
  isActive: boolean;

  @Column({ default: false })
  isVerified: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @OneToMany(() => UserOrganization, uo => uo.user)
  organizationMemberships: UserOrganization[];

  @OneToMany(() => ApiKey, ak => ak.user)
  apiKeys: ApiKey[];
}

@Entity()
export class Organization {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  name: string;

  @Column({ unique: true })
  slug: string;

  @Column({ nullable: true })
  description: string;

  @Column({ default: true })
  isActive: boolean;

  @Column({ type: 'json', nullable: true })
  settings: OrganizationSettings;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @OneToMany(() => UserOrganization, uo => uo.organization)
  members: UserOrganization[];

  @OneToMany(() => Team, team => team.organization)
  teams: Team[];

  @OneToMany(() => Api, api => api.organization)
  apis: Api[];

  @OneToMany(() => Gateway, gateway => gateway.organization)
  gateways: Gateway[];
}

export enum OrganizationRole {
  OWNER = 'owner',
  ADMIN = 'admin',
  MEMBER = 'member',
  VIEWER = 'viewer'
}

@Entity()
export class UserOrganization {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'enum', enum: OrganizationRole })
  role: OrganizationRole;

  @CreateDateColumn()
  joinedAt: Date;

  @ManyToOne(() => User, user => user.organizationMemberships)
  user: User;

  @ManyToOne(() => Organization, org => org.members)
  organization: Organization;
}
```

### API & Schema Management

```typescript
export enum ApiType {
  OPENAPI = 'openapi',
  GRAPHQL = 'graphql',
  SOAP = 'soap',
  PROTOBUF = 'protobuf',
  OTHER = 'other'
}

export enum ApiStatus {
  DRAFT = 'draft',
  ACTIVE = 'active',
  DEPRECATED = 'deprecated',
  INACTIVE = 'inactive'
}

@Entity()
export class Api {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ nullable: true })
  description: string;

  @Column()
  baseUrl: string;

  @Column()
  version: string;

  @Column({ type: 'enum', enum: ApiType })
  type: ApiType;

  @Column({ type: 'enum', enum: ApiStatus, default: ApiStatus.DRAFT })
  status: ApiStatus;

  @Column({ type: 'json', nullable: true })
  metadata: Record<string, any>;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => Organization, org => org.apis)
  organization: Organization;

  @OneToMany(() => ApiSchema, schema => schema.api)
  schemas: ApiSchema[];

  @OneToMany(() => Operation, op => op.api)
  operations: Operation[];

  @OneToMany(() => Credential, cred => cred.api)
  credentials: Credential[];
}

@Entity()
export class ApiSchema {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text' })
  rawSchema: string;

  @Column({ type: 'json' })
  processedSchema: Record<string, any>;

  @Column()
  schemaHash: string; // For change detection

  @Column()
  version: string;

  @CreateDateColumn()
  createdAt: Date;

  @ManyToOne(() => Api, api => api.schemas)
  api: Api;

  @OneToMany(() => JsonSchema, js => js.sourceSchema)
  jsonSchemas: JsonSchema[];
}

@Entity()
export class JsonSchema {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ type: 'json' })
  schema: Record<string, any>; // JSON Schema definition

  @Column()
  schemaHash: string;

  @Column({ nullable: true })
  description: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => ApiSchema, apiSchema => apiSchema.jsonSchemas)
  sourceSchema: ApiSchema;

  @OneToMany(() => Tool, tool => tool.inputSchema)
  toolsUsingAsInput: Tool[];

  @OneToMany(() => Tool, tool => tool.outputSchema)
  toolsUsingAsOutput: Tool[];
}
```

### Tool Generation & Management

```typescript
export enum ToolType {
  FUNCTION = 'function',
  ACTION = 'action',
  QUERY = 'query',
  MUTATION = 'mutation'
}

export enum ToolStatus {
  DRAFT = 'draft',
  ACTIVE = 'active',
  DEPRECATED = 'deprecated',
  INACTIVE = 'inactive'
}

@Entity()
export class Tool {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ nullable: true })
  description: string;

  @Column({ type: 'enum', enum: ToolType })
  type: ToolType;

  @Column({ type: 'enum', enum: ToolStatus, default: ToolStatus.DRAFT })
  status: ToolStatus;

  @Column()
  version: string;

  @Column({ type: 'json', nullable: true })
  parameters: Record<string, any>; // JSON Schema parameters

  @Column({ type: 'json', nullable: true })
  metadata: Record<string, any>;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => Operation, op => op.tools)
  operation: Operation;

  @ManyToOne(() => JsonSchema, js => js.toolsUsingAsInput)
  inputSchema: JsonSchema;

  @ManyToOne(() => JsonSchema, js => js.toolsUsingAsOutput)
  outputSchema: JsonSchema;

  @OneToMany(() => ToolVersion, tv => tv.tool)
  versions: ToolVersion[];

  @ManyToMany(() => ToolCategory, category => category.tools)
  @JoinTable()
  categories: ToolCategory[];

  @OneToMany(() => GatewayTool, gt => gt.tool)
  gatewayAssociations: GatewayTool[];
}

@Entity()
export class ToolVersion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  version: string;

  @Column({ type: 'json' })
  definition: Record<string, any>;

  @Column({ type: 'text', nullable: true })
  changelog: string;

  @CreateDateColumn()
  createdAt: Date;

  @ManyToOne(() => Tool, tool => tool.versions)
  tool: Tool;
}
```

### Gateway Management

```typescript
export enum GatewayType {
  MCP = 'mcp',
  A2A = 'a2a',
  UTCP = 'utcp',
  SCOPED_TOOL = 'scoped_tool'
}

export enum GatewayStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  MAINTENANCE = 'maintenance'
}

@Entity()
export class Gateway {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ nullable: true })
  description: string;

  @Column({ type: 'enum', enum: GatewayType })
  type: GatewayType;

  @Column({ type: 'enum', enum: GatewayStatus, default: GatewayStatus.ACTIVE })
  status: GatewayStatus;

  @Column({ unique: true })
  endpoint: string; // e.g., /gateways/my-mcp-gateway

  @Column({ type: 'json' })
  configuration: Record<string, any>;

  @Column({ type: 'json', nullable: true })
  rateLimitConfig: RateLimitConfig;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => Organization, org => org.gateways)
  organization: Organization;

  @OneToMany(() => GatewayTool, gt => gt.gateway)
  tools: GatewayTool[];

  @OneToMany(() => GatewayAuth, ga => ga.gateway)
  authConfigs: GatewayAuth[];

  @OneToMany(() => UsageMetric, um => um.gateway)
  usageMetrics: UsageMetric[];
}

@Entity()
export class GatewayTool {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ default: true })
  isActive: boolean;

  @Column({ type: 'json', nullable: true })
  overrides: Record<string, any>; // Tool-specific overrides

  @CreateDateColumn()
  associatedAt: Date;

  @ManyToOne(() => Gateway, gateway => gateway.tools)
  gateway: Gateway;

  @ManyToOne(() => Tool, tool => tool.gatewayAssociations)
  tool: Tool;
}
```

### Monitoring & Analytics

```typescript
export enum MetricType {
  REQUEST_COUNT = 'request_count',
  RESPONSE_TIME = 'response_time',
  ERROR_RATE = 'error_rate',
  THROUGHPUT = 'throughput'
}

@Entity()
export class UsageMetric {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'enum', enum: MetricType })
  type: MetricType;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  value: number;

  @Column({ type: 'json', nullable: true })
  dimensions: Record<string, any>; // Additional metric dimensions

  @Column({ type: 'timestamp' })
  timestamp: Date;

  @ManyToOne(() => Gateway, gateway => gateway.usageMetrics, { nullable: true })
  gateway: Gateway;

  @ManyToOne(() => Tool, { nullable: true })
  tool: Tool;

  @ManyToOne(() => User, { nullable: true })
  user: User;

  @ManyToOne(() => Organization, { nullable: true })
  organization: Organization;
}

@Entity()
export class RequestLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  method: string;

  @Column()
  path: string;

  @Column({ nullable: true })
  userAgent: string;

  @Column({ nullable: true })
  ipAddress: string;

  @Column()
  statusCode: number;

  @Column()
  responseTime: number; // in milliseconds

  @Column({ type: 'json', nullable: true })
  requestHeaders: Record<string, any>;

  @Column({ type: 'json', nullable: true })
  responseHeaders: Record<string, any>;

  @Column({ type: 'text', nullable: true })
  requestBody: string;

  @Column({ type: 'text', nullable: true })
  responseBody: string;

  @Column({ type: 'timestamp' })
  timestamp: Date;

  @ManyToOne(() => Gateway, { nullable: true })
  gateway: Gateway;

  @ManyToOne(() => Tool, { nullable: true })
  tool: Tool;

  @ManyToOne(() => User, { nullable: true })
  user: User;
}
```

## Schema Processing Pipeline

### 1. Schema Ingestion
- Parse raw API definitions (OpenAPI, WSDL, GraphQL SDL, Protobuf)
- Validate and normalize schema structures
- Extract operations, resources, and data models

### 2. JSON Schema Translation
- Convert all schema types to standardized JSON Schema
- Create unified tool parameter definitions
- Maintain bidirectional mapping for round-trip conversion

### 3. Tool Generation
- Generate tools from API operations
- Apply JSON Schema for parameter validation
- Version tools and track changes

### 4. Gateway Configuration
- Associate tools with appropriate gateways
- Apply access controls and rate limiting
- Configure authentication and authorization

## Integration Points

### LLM Provider Adapters
- OpenAI-compatible endpoints
- Claude API integration
- Custom LLM provider support
- Request/response transformation

### Authentication Strategies
- API Key authentication
- OAuth 2.0 / OIDC
- JWT tokens
- Custom authentication providers

### Monitoring & Observability
- Prometheus metrics export
- Structured logging
- Distributed tracing
- Real-time analytics dashboard

This schema provides a robust foundation for your LLM tool gateway system with full multi-tenancy, comprehensive API support, and enterprise-grade monitoring capabilities.