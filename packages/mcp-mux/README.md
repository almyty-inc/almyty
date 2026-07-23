# @almyty/mcp-mux

Southbound stdio-MCP **id-rewrite multiplexer**: fan N client sessions into one
downstream stdio MCP child over a Unix socket, with safe id remapping, framing
serialization, response routing, and crash-respawn.

> Scope: **southbound MCP only** (almyty as the client/proxy to a downstream MCP
> server). This package does not touch northbound ACP/A2A serving.

## Why

A stdio MCP server is a single process with one stdin/stdout pair. If several
sessions write to it concurrently you get interleaved framing and JSON-RPC `id`
collisions (two clients both pick `id: 1`; responses can't be told apart). This
package puts the child behind a proxy that:

- **rewrites** every client request `id` to a global monotonic proxy id and
  reverse-maps `{proxyId -> (sessionId, originalId)}`, so colliding client ids
  never alias and each response routes home with its original id restored;
- **serializes** stdin writes through a single async queue, so concurrent
  sessions can never interleave a frame;
- **routes** each response to its issuing session; load-and-delete on the id-map
  means a duplicate/late response is dropped, never double-routed;
- **isolates teardown**: closing one session drops only that session's mappings,
  leaving every other session's in-flight requests intact;
- **survives downstream death**: on child exit, all in-flight requests are
  errored (`-32011`), the id-map is cleared, and the child is respawned with
  exponential backoff (3s → 30s).

## Architecture

```
 clients ──unix socket──► SocketListener ──Session──┐
                                                    ├──► McpStdioMux ──Downstream──► child stdio MCP
 Supervisor ──spawn/respawn/reap──► NodeDownstream ─┘     (id remap, write queue,
   (FSM + error-path resource ledger)                      response routing, TTL sweep)
```

- `McpStdioMux` — pure logic, owns NO process or socket. Fully unit-testable
  with in-process fakes (`Downstream` / `Session` are the test seams).
- `Supervisor` — owns the child lifecycle + respawn/teardown FSM, and enforces
  the **error-path resource-ownership invariant** (see below).
- `NodeDownstream` / `SocketListener` — the only files that touch
  `child_process` / `net`.

### The FD-leak invariant

The reference implementation this was specced against leaked a log fd: `Start()`
opened it, then errored *before* registering for `Stop()`, so the fd was never
closed — repeated failing attaches drained the fd budget over hours.

`Supervisor.start()` pre-empts that bug class with an **acquire ledger**: every
resource acquired is pushed onto a release list *before* the next acquisition.
If anything throws before the ownership-transfer point, the ledger is unwound in
reverse. The `FD-LEAK HAMMER` test runs 500 failing starts and asserts the net
open-handle count returns to zero.

## Usage

```ts
import { createStdioMux } from '@almyty/mcp-mux';

const handle = await createStdioMux({
  socketPath: '/tmp/my-mcp.sock',
  downstream: { command: 'npx', args: ['-y', 'some-mcp-server'] },
  supervisor: { backoffBaseMs: 3000, backoffCapMs: 30000 },
});

// ... clients connect to the socket and speak newline-delimited JSON-RPC ...

await handle.close(); // stop accepting, reap child, release resources
```

## Design note

Full design — id-map lifecycle, framing serialization, response routing, the
respawn/teardown state machine, and error-path resource ownership — lives in
[`DESIGN.md`](./DESIGN.md).

## Develop

```bash
npm install
npm run typecheck   # tsc --noEmit (includes tests)
npm test            # vitest run
npm run build       # emits dist/ (tests excluded)
```

## About almyty

almyty is the full-stack platform for AI agents, agnostic by design: any LLM, any
API turned into tools, served over MCP, A2A, UTCP, and Agent Skills. Open source,
no lock-in.

- Website — https://almyty.com
- Docs — https://docs.almyty.com
- Source — https://github.com/almyty-inc/almyty

Apache-2.0 © Almyty Inc.
