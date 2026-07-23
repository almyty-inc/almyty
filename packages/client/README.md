# @almyty/client

Shared HTTP client and credential resolver used by all almyty CLI packages.

## Usage

```typescript
import { AlmytyClient, resolveCredentialsOrExit } from '@almyty/client';

const creds = resolveCredentialsOrExit();
const client = new AlmytyClient(creds.url, creds.token);

const agents = await client.listAgents();
```

## Exports

- `AlmytyClient` -- API client (agents, runs, gateways)
- `GatewayClient` -- gateway-scoped client (invoke, stream, conversations)
- `resolveCredentials()` -- read `~/.almyty/credentials.json` (returns null if missing)
- `resolveCredentialsOrExit()` -- same, but exits with an error message if missing
- `getOrgSlugFromToken(token)` -- extract org slug from JWT
- `loadCredentials()` -- raw file read
- `CREDENTIALS_FILE` -- path to `~/.almyty/credentials.json`

## About almyty

almyty is the full-stack platform for AI agents, agnostic by design: any LLM, any
API turned into tools, served over MCP, A2A, UTCP, and Agent Skills. Open source,
no lock-in.

- Website — https://almyty.com
- Docs — https://docs.almyty.com
- Source — https://github.com/almyty-inc/almyty

Apache-2.0 © Almyty Inc.
