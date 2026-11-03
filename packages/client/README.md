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
- `isPermanentStreamError(err)` -- whether a run stream failed in a way a retry would not change

## Following a run

`client.followRun(agentId, runId, handler, signal?, options?)` and the gateway's
`gw.streamRun(runId, handler, signal?, options?)` keep watching a run until it ends.
If the connection drops, they reconnect by themselves and carry on where they left
off: each event reaches `handler` once and in order, and `options.onLog` gets the
run's history one event at a time. If the run is gone, or not yours to see, they
stop at once and throw an error with its `status` (400, 401, 403, 404 or 410);
anything else (a network error, a server error) is retried a few times, waiting a
little longer each time.

```typescript
const run = await client.followRun(agentId, runId, (event) => {
  if (event.type === 'llm.chunk') process.stdout.write(String(event.data.content));
}, undefined, {
  onLog: (logged) => console.error(`#${logged.seq} ${logged.type}`),
});
```

To pick up a run you were already following, pass the position you had:
`{ afterSeq, livePos }`, which `followRunStream` returns and `onReconnect` reports.

## About almyty

almyty is the full-stack platform for AI agents, agnostic by design: any LLM, any
API turned into tools, served over MCP, A2A, UTCP, and Agent Skills. Open source,
no lock-in.

- Website: https://almyty.com
- Docs: https://docs.almyty.com
- Source: https://github.com/almyty-inc/almyty

Apache-2.0 © Almyty Inc.
