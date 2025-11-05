# MCP Protocol Test Instructions

## For Chrome MCP Extension Testing:

### MCP Server Endpoint:
```
http://localhost:4000/api/mcp
```

### Authentication Required:
```bash
# Get token:
curl -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "realtest@test.com", "password": "testpass123"}'

# Use Bearer token in Authorization header
Authorization: Bearer [token]
```

### Available MCP Methods:
1. `initialize` - Start MCP session
2. `tools/list` - List available tools  
3. `tools/call` - Execute a tool
4. `ping` - Test connection

### Sample MCP Requests:

**Initialize:**
```json
{
  "jsonrpc": "2.0",
  "id": 1, 
  "method": "initialize",
  "params": {
    "protocolVersion": "2024-11-05",
    "capabilities": {"tools": {"listChanged": true}},
    "clientInfo": {"name": "chrome-mcp", "version": "1.0.0"}
  }
}
```

**List Tools:**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/list",
  "params": {}
}
```

**Call Tool:**
```json
{
  "jsonrpc": "2.0", 
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "Pet Store API_listPets",
    "arguments": {}
  }
}
```

## Real Test Data:
- User: realtest@test.com
- Organization: Real Test's Organization (803d1087-9bb7-4ad9-9bb0-c6f1a90769a1)
- API: Pet Store API (f831aee8-3fc6-4338-bfa7-792435439e71)
- Tool: Pet Store API_listPets (2a82b9cf-a56f-45ef-9a9a-bd10d92a5b7b)

All data is real and functional.