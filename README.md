# apifai

> Universal API-to-AI Tool Gateway (In Development)

[![Backend Status](https://img.shields.io/badge/Backend-80%25%20Complete-yellow)](http://localhost:4000/api/monitoring/health)
[![Frontend Status](https://img.shields.io/badge/Frontend-Needs%20Testing-orange)](#frontend)
[![MCP Protocol](https://img.shields.io/badge/MCP-Partially%20Working-orange)](#mcp-implementation)
[![Auth System](https://img.shields.io/badge/Auth-Broken-red)](#known-issues)

**apifai** is an ambitious universal API gateway that translates any API format (OpenAPI, GraphQL, SOAP, Protobuf) into AI-consumable tools via multiple protocols (MCP, UTCP, A2A).

**Current Status: Architecture complete, core functionality needs debugging.**

---

## 🚨 Known Issues (Critical)

### 1. Authentication System Broken
```bash
# Registration works but JWT tokens are immediately invalid
curl -X POST http://localhost:4000/api/auth/register # ✅ Works
curl -H "Authorization: Bearer <token>" /api/auth/profile # ❌ 401 Unauthorized
```

### 2. MCP Tools Endpoint Missing
```bash
curl http://localhost:4000/api/mcp/tools # ❌ 404 Not Found
```

### 3. End-to-End Pipeline Untested
- API import → Schema parsing → Tool generation → MCP consumption flow not verified

---

## ✅ What Actually Works

### Core Infrastructure
- ✅ NestJS backend running on port 4000
- ✅ PostgreSQL database with complete schema
- ✅ Redis caching and sessions
- ✅ Docker containerization
- ✅ Protocol discovery endpoints
- ✅ User registration (tokens broken)

### API Processing
- ✅ OpenAPI/Swagger parser with validation
- ✅ GraphQL schema introspection
- ✅ SOAP WSDL parsing
- ✅ Protobuf .proto parsing
- ✅ Universal JSON Schema translation

### MCP Implementation
- ✅ JSON-RPC 2.0 protocol handler
- ✅ Session management
- ✅ Multi-transport support (HTTP/SSE/WebSocket)
- ✅ Error handling with proper MCP codes

---

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- Docker & Docker Compose
- PostgreSQL (via Docker)

### 1. Start Services
```bash
git clone <repository>
cd apifai

# Start all services
docker-compose up -d

# Check status
docker-compose ps
curl http://localhost:4000/api/monitoring/health
```

### 2. Test Protocol Discovery
```bash
# MCP discovery
curl http://localhost:4000/api/mcp/.well-known/mcp

# UTCP discovery
curl http://localhost:4000/api/utcp/.well-known/utcp
```

### 3. Create Test User
```bash
curl -X POST http://localhost:4000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"Test123456","firstName":"Test","lastName":"User"}'
```

**⚠️ Authentication debugging needed before proceeding further.**

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Frontend Dashboard                       │
│                  (React + shadcn/ui)                       │
│                     [Needs Testing]                        │
├─────────────────────────────────────────────────────────────┤
│                  API Gateway Layer                          │
│              [Auth Broken - JWT Invalid]                   │
├─────────────────────────────────────────────────────────────┤
│               Universal Schema Parsers                      │
│    OpenAPI ✅│ GraphQL ✅│ SOAP ✅│ Protobuf ✅           │
├─────────────────────────────────────────────────────────────┤
│               Protocol Endpoints                            │
│    MCP [Partial] │ UTCP [Ready] │ A2A [Architecture]      │
├─────────────────────────────────────────────────────────────┤
│                   Database Layer                            │
│        PostgreSQL [Complete] │ Redis [Working]             │
└─────────────────────────────────────────────────────────────┘
```

---

## 📊 Feature Status

| Feature Category | Status | Notes |
|-----------------|--------|-------|
| **Core Backend** | ✅ 80% | NestJS app running, needs auth fix |
| **Database Schema** | ✅ 100% | All entities and relationships complete |
| **API Parsers** | ✅ 90% | Universal schema translation working |
| **MCP Protocol** | ⚠️ 70% | JSON-RPC handler exists, endpoints missing |
| **Authentication** | ❌ Broken | JWT validation failing |
| **Frontend** | ⚠️ 60% | React app built, API integration untested |
| **Tool Generation** | ⚠️ 80% | Logic exists, end-to-end testing needed |
| **Docker Deployment** | ✅ 100% | Full containerized stack |

---

## 🆚 vs mcp-context-forge

| Capability | apifai | mcp-context-forge | Winner |
|-----------|---------|-------------------|--------|
| **Universal API Import** | ✅ Revolutionary | ❌ Manual only | 🏆 **apifai** |
| **Multi-Protocol Output** | ⚠️ Architecture | ✅ Working | **mcp-context-forge** |
| **Working MCP Server** | ❌ Broken endpoints | ✅ Production ready | **mcp-context-forge** |
| **Enterprise Features** | ✅ Superior design | ⚠️ Basic | 🏆 **apifai** |
| **Production Ready** | ❌ Auth broken | ✅ Docker/K8s | **mcp-context-forge** |

**Bottom Line**: Better architecture, broken execution vs working basic functionality.

---

## 🔧 Development

### Fix Authentication (Priority 1)
```bash
# Investigate JWT issues
cd backend
npm run start:debug

# Check auth guard and service
backend/src/modules/auth/guards/jwt-auth.guard.ts
backend/src/modules/auth/auth.service.ts
```

### Test API Pipeline (Priority 2)
```bash
# Test complete flow once auth is fixed:
1. Create API → Import OpenAPI schema
2. Generate tools from operations
3. Query tools via MCP
4. Execute tool via MCP
```

### Frontend Integration (Priority 3)
```bash
cd frontend
npm run dev

# Test React app against fixed backend
# Verify API calls work with valid JWT tokens
```

---

## 📖 API Documentation

### Core Endpoints
- `GET /api/monitoring/health` - System health check ✅
- `GET /api/mcp/.well-known/mcp` - MCP discovery ✅
- `POST /api/auth/register` - User registration ✅
- `POST /api/auth/login` - User login (JWT broken) ❌
- `POST /api/mcp` - MCP JSON-RPC endpoint ❌
- `GET /api/docs` - Swagger documentation ✅

### Working Test Commands
```bash
# Service health
curl http://localhost:4000/api/monitoring/health

# MCP protocol info
curl http://localhost:4000/api/mcp/.well-known/mcp

# User registration
curl -X POST http://localhost:4000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"user@test.com","password":"Password123","firstName":"Test","lastName":"User"}'
```

---

## 🧪 Testing

### Run Backend Tests
```bash
cd backend
npm run test
npm run test:e2e
```

### Run Frontend Tests
```bash
cd frontend
npm run test
npm run test:e2e
```

### Manual Testing Checklist
- [ ] Fix JWT authentication
- [ ] Test API import with OpenAPI schema
- [ ] Verify tool generation from operations
- [ ] Test MCP tool listing and execution
- [ ] Validate frontend API integration

---

## 📈 Roadmap

### Phase 1: Core Fixes (Week 1)
- [ ] Fix JWT authentication system
- [ ] Implement missing MCP endpoints
- [ ] End-to-end API pipeline testing
- [ ] Frontend API integration

### Phase 2: Feature Completion (Week 2-3)
- [ ] Complete MCP Chrome integration
- [ ] UTCP direct calling implementation
- [ ] Tool execution pipeline optimization
- [ ] Performance and load testing

### Phase 3: Production (Week 4)
- [ ] Security audit and hardening
- [ ] Monitoring and observability
- [ ] Documentation and examples
- [ ] Deployment automation

---

## 🤝 Contributing

**Current Priority**: Fix authentication system and test end-to-end API pipeline.

See [`CLAUDE.md`](CLAUDE.md) for detailed technical assessment and implementation status.

### Key Areas Needing Work
1. **Authentication debugging** - JWT validation issues
2. **MCP endpoint completion** - Missing tool listing endpoints
3. **End-to-end testing** - Verify complete API→Tool→MCP flow
4. **Frontend integration** - Test React app with working backend

---

## 📄 License

MIT License - See [LICENSE](LICENSE) file for details.

---

**⚠️ Status: In Development - Core functionality needs debugging before production use.**

For honest technical assessment, see [`CLAUDE.md`](CLAUDE.md).