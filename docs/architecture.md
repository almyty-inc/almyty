# LLM Tool Gateway - Technical Architecture & Implementation Plan

## Technology Stack

### Backend (NestJS + TypeScript)
- **Framework**: NestJS 10+ with TypeScript
- **Database**: PostgreSQL with TypeORM
- **Caching**: Redis for session management and caching
- **Authentication**: Passport.js with JWT + OAuth strategies
- **Validation**: class-validator with JSON Schema integration
- **API Documentation**: Swagger/OpenAPI
- **Monitoring**: Prometheus + Grafana
- **Message Queue**: Bull/BullMQ with Redis

### Frontend (React + shadcn/ui)
- **Framework**: React 18+ with TypeScript
- **UI Library**: shadcn/ui + Tailwind CSS
- **State Management**: Zustand or Redux Toolkit
- **Forms**: React Hook Form with Zod validation
- **Data Fetching**: TanStack Query (React Query)
- **Routing**: React Router v6
- **Charts**: Recharts or Chart.js

### Infrastructure & DevOps
- **Containerization**: Docker + Docker Compose
- **Orchestration**: Kubernetes (optional for production)
- **CI/CD**: GitHub Actions
- **Testing**: Jest + Supertest (backend), Vitest + Testing Library (frontend)
- **Code Quality**: ESLint, Prettier, Husky

## Core System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    LLM Tool Gateway                         │
├─────────────────────────────────────────────────────────────┤
│  Frontend (React + shadcn/ui)                              │
├─────────────────────────────────────────────────────────────┤
│  API Gateway Layer                                          │
│  ├─ Authentication & Authorization                          │
│  ├─ Rate Limiting & Throttling                             │
│  └─ Request/Response Logging                               │
├─────────────────────────────────────────────────────────────┤
│  Business Logic Layer (NestJS)                             │
│  ├─ User Management Service                                │
│  ├─ Organization Management Service                        │
│  ├─ API Schema Processing Service                          │
│  ├─ JSON Schema Translation Service                        │
│  ├─ Tool Generation Service                                │
│  ├─ Gateway Management Service                             │
│  ├─ LLM Provider Integration Service                       │
│  └─ Monitoring & Analytics Service                         │
├─────────────────────────────────────────────────────────────┤
│  Data Access Layer                                         │
│  ├─ Repository Pattern (TypeORM)                           │
│  └─ Database Migrations                                     │
├─────────────────────────────────────────────────────────────┤
│  External Integrations                                      │
│  ├─ Schema Parsers (OpenAPI, GraphQL, SOAP, Protobuf)     │
│  ├─ LLM Providers (OpenAI, Anthropic, etc.)               │
│  └─ External APIs (user-configured)                        │
├─────────────────────────────────────────────────────────────┤
│  Infrastructure Layer                                       │
│  ├─ PostgreSQL Database                                    │
│  ├─ Redis Cache                                            │
│  └─ Message Queue                                          │
└─────────────────────────────────────────────────────────────┘
```

## Phase 1: Foundation & Authentication (Weeks 1-2)

### 1.1 Project Setup
```bash
# Backend setup
npx @nestjs/cli new llm-tool-gateway-backend
cd llm-tool-gateway-backend

# Add core dependencies
npm install @nestjs/typeorm typeorm pg
npm install @nestjs/passport passport passport-jwt passport-local
npm install @nestjs/jwt @nestjs/config
npm install class-validator class-transformer
npm install bcryptjs uuid
npm install @nestjs/swagger swagger-ui-express

# Frontend setup
npx create-react-app llm-tool-gateway-frontend --template typescript
cd llm-tool-gateway-frontend

# Add frontend dependencies
npm install @tanstack/react-query react-router-dom
npm install @hookform/resolvers react-hook-form zod
npm install zustand axios
npx shadcn-ui@latest init
```

### 1.2 Database Setup & Core Entities
- Set up PostgreSQL with Docker Compose
- Implement User, Organization, UserOrganization entities
- Create database migrations
- Set up TypeORM configuration

### 1.3 Authentication System
```typescript
// auth.module.ts
@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_SECRET,
      signOptions: { expiresIn: '24h' },
    }),
    PassportModule,
    UsersModule,
  ],
  providers: [AuthService, LocalStrategy, JwtStrategy],
  controllers: [AuthController],
  exports: [AuthService],
})
export class AuthModule {}

// jwt.strategy.ts
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    @InjectRepository(User)
    private usersRepository: Repository<User>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET,
    });
  }

  async validate(payload: any) {
    const user = await this.usersRepository.findOne({
      where: { id: payload.sub },
      relations: ['organizationMemberships', 'organizationMemberships.organization'],
    });
    return user;
  }
}
```

### 1.4 RBAC System
```typescript
// Role-based access control decorators
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata('permissions', permissions);

@Injectable()
export class PermissionsGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const requiredPermissions = this.reflector.get<Permission[]>('permissions', context.getHandler());
    if (!requiredPermissions) return true;

    const request = context.switchToHttp().getRequest();
    const user = request.user;
    
    return this.hasPermissions(user, requiredPermissions);
  }
}
```

## Phase 2: API Schema Processing (Weeks 3-4)

### 2.1 Schema Parser Architecture
```typescript
// schema-parser.interface.ts
export interface SchemaParser {
  parseSchema(rawSchema: string): Promise<ParsedSchema>;
  validateSchema(schema: string): Promise<boolean>;
  extractOperations(schema: ParsedSchema): Promise<Operation[]>;
  extractModels(schema: ParsedSchema): Promise<ResourceModel[]>;
}

// parsers/openapi.parser.ts
@Injectable()
export class OpenAPIParser implements SchemaParser {
  async parseSchema(rawSchema: string): Promise<ParsedSchema> {
    const swaggerParser = new SwaggerParser();
    const api = await swaggerParser.validate(JSON.parse(rawSchema));
    
    return {
      version: api.openapi || api.swagger,
      info: api.info,
      servers: api.servers,
      paths: api.paths,
      components: api.components,
    };
  }
}

// parsers/graphql.parser.ts
@Injectable() 
export class GraphQLParser implements SchemaParser {
  async parseSchema(rawSchema: string): Promise<ParsedSchema> {
    const schema = buildSchema(rawSchema);
    const typeMap = schema.getTypeMap();
    
    return {
      types: this.extractTypes(typeMap),
      queries: this.extractQueries(schema.getQueryType()),
      mutations: this.extractMutations(schema.getMutationType()),
      subscriptions: this.extractSubscriptions(schema.getSubscriptionType()),
    };
  }
}
```

### 2.2 JSON Schema Translation Layer
```typescript
// json-schema-translator.service.ts
@Injectable()
export class JsonSchemaTranslatorService {
  translateOpenAPIToJsonSchema(openApiSchema: any): JSONSchema7 {
    // Convert OpenAPI schema to JSON Schema
    return {
      type: 'object',
      properties: this.convertProperties(openApiSchema.properties),
      required: openApiSchema.required || [],
      additionalProperties: false,
    };
  }

  translateGraphQLToJsonSchema(graphqlType: GraphQLType): JSONSchema7 {
    // Convert GraphQL type to JSON Schema
    if (isScalarType(graphqlType)) {
      return this.convertScalarType(graphqlType);
    }
    if (isObjectType(graphqlType)) {
      return this.convertObjectType(graphqlType);
    }
    // ... handle other GraphQL types
  }

  translateProtobufToJsonSchema(protobufMessage: any): JSONSchema7 {
    // Convert Protobuf message to JSON Schema
    const properties = {};
    protobufMessage.fields.forEach(field => {
      properties[field.name] = this.convertProtobufField(field);
    });

    return {
      type: 'object',
      properties,
      required: protobufMessage.fields
        .filter(f => f.rule === 'required')
        .map(f => f.name),
    };
  }
}
```

## Phase 3: Tool Generation Engine (Weeks 5-6)

### 3.1 Tool Generator Service
```typescript
// tool-generator.service.ts
@Injectable()
export class ToolGeneratorService {
  async generateToolsFromApi(api: Api): Promise<Tool[]> {
    const tools: Tool[] = [];
    
    for (const operation of api.operations) {
      const tool = await this.generateToolFromOperation(operation);
      tools.push(tool);
    }
    
    return tools;
  }

  private async generateToolFromOperation(operation: Operation): Promise<Tool> {
    const inputSchema = await this.jsonSchemaTranslator
      .translateOperationToJsonSchema(operation);
      
    const tool = new Tool();
    tool.name = this.generateToolName(operation);
    tool.description = operation.description || `Execute ${operation.method} ${operation.endpoint}`;
    tool.type = this.determineToolType(operation);
    tool.parameters = inputSchema;
    tool.operation = operation;
    
    return await this.toolRepository.save(tool);
  }

  private generateToolName(operation: Operation): string {
    // Generate semantic tool names
    const pathParts = operation.endpoint.split('/').filter(Boolean);
    const resourceName = pathParts[pathParts.length - 1];
    const action = this.methodToAction(operation.method);
    
    return `${action}_${resourceName}`;
  }
}
```

### 3.2 Tool Execution Engine
```typescript
// tool-executor.service.ts
@Injectable()
export class ToolExecutorService {
  async executeTool(
    toolId: string, 
    parameters: Record<string, any>,
    context: ExecutionContext
  ): Promise<ToolExecutionResult> {
    const tool = await this.toolRepository.findOne({
      where: { id: toolId },
      relations: ['operation', 'operation.api'],
    });

    // Validate parameters against JSON Schema
    const isValid = await this.validateParameters(tool.parameters, parameters);
    if (!isValid) {
      throw new BadRequestException('Invalid parameters');
    }

    // Execute the tool
    const result = await this.executeApiOperation(
      tool.operation,
      parameters,
      context
    );

    // Log execution
    await this.logToolExecution(tool, parameters, result, context);

    return result;
  }

  private async executeApiOperation(
    operation: Operation,
    parameters: Record<string, any>,
    context: ExecutionContext
  ): Promise<any> {
    const api = operation.api;
    const credentials = await this.getApiCredentials(api);
    
    const httpConfig = {
      method: operation.method,
      url: `${api.baseUrl}${operation.endpoint}`,
      headers: this.buildHeaders(credentials),
      data: operation.method !== 'GET' ? parameters : undefined,
      params: operation.method === 'GET' ? parameters : undefined,
    };

    const response = await this.httpService.request(httpConfig);
    return response.data;
  }
}
```

## Phase 4: Gateway Management System (Weeks 7-8)

### 4.1 Gateway Types Implementation
```typescript
// gateway-types/mcp.gateway.ts
@Injectable()
export class MCPGatewayService extends BaseGatewayService {
  async handleMCPRequest(request: MCPRequest): Promise<MCPResponse> {
    switch (request.method) {
      case 'tools/list':
        return this.listTools(request.params);
      case 'tools/call':
        return this.callTool(request.params);
      case 'resources/list':
        return this.listResources(request.params);
      default:
        throw new Error(`Unsupported MCP method: ${request.method}`);
    }
  }

  private async listTools(params: any): Promise<MCPResponse> {
    const gateway = await this.getGatewayFromContext();
    const tools = await this.getGatewayTools(gateway.id);
    
    return {
      result: {
        tools: tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.parameters,
        })),
      },
    };
  }
}

// gateway-types/a2a.gateway.ts
@Injectable()
export class A2AGatewayService extends BaseGatewayService {
  async handleA2ARequest(request: A2ARequest): Promise<A2AResponse> {
    // Handle Agent-to-Agent requests
    const agent = await this.authenticateAgent(request.headers);
    const result = await this.executeToolForAgent(request.tool, request.parameters, agent);
    
    return {
      success: true,
      data: result,
      metadata: {
        timestamp: new Date(),
        executionTime: Date.now() - request.startTime,
      },
    };
  }
}
```

### 4.2 Gateway Router & Middleware
```typescript
// gateway.controller.ts
@Controller('gateways')
export class GatewayController {
  @Post(':gatewayId/mcp')
  async handleMCPRequest(
    @Param('gatewayId') gatewayId: string,
    @Body() request: MCPRequest,
    @Req() req: Request
  ) {
    const gateway = await this.gatewayService.findById(gatewayId);
    if (gateway.type !== GatewayType.MCP) {
      throw new BadRequestException('Not an MCP gateway');
    }
    
    return this.mcpGatewayService.handleMCPRequest(request);
  }

  @Post(':gatewayId/a2a')
  async handleA2ARequest(
    @Param('gatewayId') gatewayId: string,
    @Body() request: A2ARequest
  ) {
    const gateway = await this.gatewayService.findById(gatewayId);
    if (gateway.type !== GatewayType.A2A) {
      throw new BadRequestException('Not an A2A gateway');
    }
    
    return this.a2aGatewayService.handleA2ARequest(request);
  }
}
```

## Phase 5: Frontend Development (Weeks 9-11)

### 5.1 React Application Structure
```
frontend/src/
├── components/
│   ├── ui/                 # shadcn/ui components
│   ├── layout/            # Layout components
│   ├── forms/             # Form components
│   └── charts/            # Analytics components
├── pages/
│   ├── dashboard/
│   ├── apis/
│   ├── tools/
│   ├── gateways/
│   └── analytics/
├── hooks/                 # Custom React hooks
├── services/              # API service layer
├── stores/                # Zustand stores
├── types/                 # TypeScript types
└── utils/                 # Utility functions
```

### 5.2 Key Frontend Components
```typescript
// components/api/ApiSchemaUpload.tsx
export function ApiSchemaUpload() {
  const [file, setFile] = useState<File | null>(null);
  const uploadMutation = useMutation({
    mutationFn: (data: FormData) => apiService.uploadSchema(data),
    onSuccess: () => {
      toast.success('Schema uploaded successfully');
      router.push('/apis');
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Upload API Schema</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <Select>
            <SelectTrigger>
              <SelectValue placeholder="Select schema type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="openapi">OpenAPI</SelectItem>
              <SelectItem value="graphql">GraphQL</SelectItem>
              <SelectItem value="soap">SOAP/WSDL</SelectItem>
              <SelectItem value="protobuf">Protobuf</SelectItem>
            </SelectContent>
          </Select>
          
          <FileUpload
            accept=".json,.yaml,.yml,.proto,.wsdl"
            onFileSelect={setFile}
          />
          
          <Button 
            onClick={() => uploadMutation.mutate(createFormData(file))}
            disabled={!file || uploadMutation.isPending}
          >
            {uploadMutation.isPending ? 'Uploading...' : 'Upload Schema'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// components/tools/ToolEditor.tsx
export function ToolEditor({ tool }: { tool: Tool }) {
  const form = useForm<ToolFormData>({
    resolver: zodResolver(toolSchema),
    defaultValues: tool,
  });

  return (
    <Form {...form}>
      <div className="space-y-6">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Tool Name</FormLabel>
              <FormControl>
                <Input {...field} />
              </FormControl>
            </FormItem>
          )}
        />
        
        <FormField
          control={form.control}
          name="parameters"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Parameters (JSON Schema)</FormLabel>
              <FormControl>
                <JsonEditor
                  value={field.value}
                  onChange={field.onChange}
                  schema={jsonSchemaSchema}
                />
              </FormControl>
            </FormItem>
          )}
        />
        
        <Button type="submit">Save Tool</Button>
      </div>
    </Form>
  );
}
```

## Phase 6: LLM Provider Integration (Weeks 12-13)

### 6.1 LLM Provider Abstraction
```typescript
// providers/base.provider.ts
export abstract class BaseLLMProvider {
  abstract async generateResponse(
    prompt: string,
    tools: Tool[],
    options: LLMOptions
  ): Promise<LLMResponse>;
  
  abstract async streamResponse(
    prompt: string,
    tools: Tool[],
    options: LLMOptions
  ): AsyncIterable<LLMStreamChunk>;
}

// providers/openai.provider.ts
@Injectable()
export class OpenAIProvider extends BaseLLMProvider {
  private client: OpenAI;

  constructor() {
    super();
    this.client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  async generateResponse(
    prompt: string,
    tools: Tool[],
    options: LLMOptions
  ): Promise<LLMResponse> {
    const response = await this.client.chat.completions.create({
      model: options.model || 'gpt-4',
      messages: [{ role: 'user', content: prompt }],
      tools: this.convertToolsToOpenAIFormat(tools),
      tool_choice: 'auto',
    });

    return this.convertOpenAIResponse(response);
  }
}

// providers/anthropic.provider.ts
@Injectable()
export class AnthropicProvider extends BaseLLMProvider {
  private client: Anthropic;

  constructor() {
    super();
    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
  }

  async generateResponse(
    prompt: string,
    tools: Tool[],
    options: LLMOptions
  ): Promise<LLMResponse> {
    const response = await this.client.messages.create({
      model: options.model || 'claude-3-sonnet-20240229',
      max_tokens: options.maxTokens || 1024,
      messages: [{ role: 'user', content: prompt }],
      tools: this.convertToolsToAnthropicFormat(tools),
    });

    return this.convertAnthropicResponse(response);
  }
}
```

## Phase 7: Monitoring & Analytics (Week 14)

### 7.1 Metrics Collection
```typescript
// monitoring/metrics.service.ts
@Injectable()
export class MetricsService {
  private requestCounter = new Counter({
    name: 'gateway_requests_total',
    help: 'Total number of gateway requests',
    labelNames: ['gateway_id', 'tool_name', 'status'],
  });

  private responseTime = new Histogram({
    name: 'gateway_response_duration_seconds',
    help: 'Response time in seconds',
    labelNames: ['gateway_id', 'tool_name'],
  });

  recordRequest(gatewayId: string, toolName: string, status: string) {
    this.requestCounter.inc({ gateway_id: gatewayId, tool_name: toolName, status });
  }

  recordResponseTime(gatewayId: string, toolName: string, duration: number) {
    this.responseTime.observe({ gateway_id: gatewayId, tool_name: toolName }, duration / 1000);
  }
}
```

## Deployment Strategy

### Development Environment
```yaml
# docker-compose.dev.yml
version: '3.8'
services:
  postgres:
    image: postgres:15
    environment:
      POSTGRES_DB: llm_gateway
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: password
    ports:
      - "5432:5432"
    
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
      
  backend:
    build: ./backend
    ports:
      - "3000:3000"
    depends_on:
      - postgres
      - redis
    environment:
      DATABASE_URL: postgresql://postgres:password@postgres:5432/llm_gateway
      REDIS_URL: redis://redis:6379
      
  frontend:
    build: ./frontend
    ports:
      - "3001:3000"
    depends_on:
      - backend
```

### Production Considerations
- **Kubernetes deployment** with Helm charts
- **PostgreSQL with read replicas** for scalability
- **Redis Cluster** for high availability
- **Nginx ingress** with SSL termination
- **Horizontal Pod Autoscaling** based on CPU/memory
- **Persistent volumes** for file storage
- **Backup strategies** for database and Redis

This comprehensive architecture provides a solid foundation for building your LLM tool gateway system with enterprise-grade capabilities, scalability, and maintainability.