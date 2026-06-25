# Design note — Southbound stdio-MCP id-rewrite multiplexer

Status: design (deliverable 1 of 2). Scope: **southbound MCP only** (almyty acting as an
MCP *client/proxy* to a downstream stdio MCP server). **Out of scope, do not touch:** ACP/A2A
northbound, and almyty-as-MCP-*server* (`backend/src/modules/mcp/*`, `packages/mcp-server` server side).

Reference studied (mechanism only, no code copied): `agent-deck/internal/mcppool/{socket_proxy,pool_simple,fd_leak_test}.go`.

---

## 0. Assessment — does our multiplexing core already do this cleanly?

**No. There is no southbound stdio-MCP multiplexer in almyty today.** Every MCP path is northbound
or HTTP request/response. The three things that *look* adjacent and why none of them is it:

| Component | What it actually is | Why it's NOT the pattern |
|---|---|---|
| `packages/mcp-server/src/proxy.ts` `AlmytyProxy` | stdio-MCP **server** (to a client like Claude Desktop) that forwards to the almyty **HTTP** backend | `nextId()` (l.53) is a per-call JSON-RPC counter, but each call is an independent `fetch()` request/response (l.70, 211). The HTTP response *is* the routing — there is **no reverse map, no fan-in, no stdin framing, no downstream process**. A degenerate id counter that needs no routing. |
| `packages/runner/src/process-manager.ts` `ProcessManager` | per-workspace raw subprocess pool (PTY/pipe), byte buffers, `read/write/wait/kill` | No JSON-RPC, no id rewriting, no MCP framing. It faithfully ships bytes; it does not interpret frames (l.71-75). One process ≠ many sessions fanned in. |
| `packages/runner/src/protocol.ts` + backend `worker-protocol.types.ts` | backend↔runner control plane envelopes `{v,type,id,seq,ts,payload}` with session ids | This is the runner daemon talking to the backend, not a stdio-MCP process shared across sessions. Closest *concept* (string ids, sessions, `UNKNOWN_SESSION`) but wrong layer. |

**Conclusion:** this is a greenfield component. "Implement against our existing proxy" → the natural
home is `packages/mcp-server` (it already owns the southbound-ish concerns and the `AlmytyProxy`
shape), as a new `McpStdioMux` class; `AlmytyProxy` is left untouched (different transport). Final
placement is the one open decision — see §9.

---

## 1. Component shape

```
N MCP clients ──(unix socket, one conn per session)──► McpStdioMux ──(1 stdin/stdout)──► downstream MCP child
        ▲                                                   │
        └───────────── response routed back ────────────────┘
```

Three cooperating units, each with one job:

- **`SocketListener`** — accepts client connections on a Unix socket; one connection == one `Session`.
- **`McpStdioMux`** — owns the downstream child, the id map, the stdin write lock, the stdout
  reader, and the session table. The multiplexer proper.
- **`Supervisor`** — owns the respawn/teardown state machine and the resource-ownership ledger.

Node/TS idiom mapping from the Go reference:
- `sync.Map`/`atomic.Int64` → a plain `Map<number, IdMapping>` + a `number` counter (single-threaded
  event loop ⇒ no atomics needed; **but** see §4 on the false sense of safety this gives).
- `stdinMu sync.Mutex` → an async write **queue** (a promise chain), because Node stream writes can
  back-pressure and we must serialize *frames*, not just calls.
- goroutine-per-client → an event handler per socket connection.

---

## 2. id-map lifecycle (the core)

```ts
interface IdMapping { sessionId: string; originalId: string | number | null; sentAt: number; }
private idMap = new Map<number, IdMapping>();   // proxyId -> mapping
private proxyIdSeq = 0;                          // monotonic, never reused within a process life
```

**Allocate (on request from a session):**
1. Parse the client frame. **If it has no `id`** (a JSON-RPC *notification*), forward as-is, allocate
   nothing (notifications get no response — mapping one would leak).
2. `const proxyId = ++this.proxyIdSeq` (monotonic; wraps only past `Number.MAX_SAFE_INTEGER`, ~quadrillions — a process-lifetime non-issue, but assert it).
3. `this.idMap.set(proxyId, { sessionId, originalId: req.id, sentAt: now })`.
4. Rewrite `req.id = proxyId`, serialize, hand to the stdin queue (§3).

**Free (exactly once, on response):**
1. Read downstream line, parse, normalize `resp.id` to a `number` (JSON numbers arrive as JS
   numbers already, but ids may be strings if the *downstream* echoes oddly — coerce + validate).
2. `const m = this.idMap.get(proxyId); this.idMap.delete(proxyId)` — **load-and-delete together**
   so a duplicate/late response can't double-route.
3. If `!m` → downstream replied to an unknown/already-freed id: log + drop (do not crash, do not route).
4. Restore `resp.id = m.originalId`, serialize, write to `sessions.get(m.sessionId)` (§4).

**Collision safety across sessions:** two sessions both sending JSON-RPC `id: 1` is the whole reason
this exists. After rewrite they are `proxyId` 41 and 42; the downstream never sees a collision; the
reverse map restores each session's original `1`. The proxy id space is **global and monotonic**, so
collisions are structurally impossible within a process; across respawns the map is cleared (§7) so
stale ids from a dead child can't alias a new child's ids.

**Staleness / leak guard:** `sentAt` exists so a periodic sweep can evict mappings older than a TTL
(downstream that accepts a request but never answers). Without this the map grows unbounded under a
flaky downstream. Default TTL generous (e.g. 5 min) and configurable; eviction routes a synthetic
JSON-RPC error (`-32603`, "downstream timed out") back to the originating session so the client isn't
left hanging, then frees the entry.

---

## 3. Framing serialization (stdin)

The downstream reads **newline-delimited JSON**. Two concurrent sessions writing must never interleave
bytes of two frames. Node has no parallel threads, but `stream.write()` can return `false`
(back-pressure) and the *next* `write` can begin before the prior frame's bytes have drained — and we
build a frame as `payload` + `\n`, two writes. So we serialize at the **frame** granularity:

```ts
private writeChain: Promise<void> = Promise.resolve();
private enqueueFrame(line: string) {
  this.writeChain = this.writeChain.then(() => this.writeFrameAwaitingDrain(line + '\n'));
  return this.writeChain;               // caller may await for back-pressure accounting
}
// writeFrameAwaitingDrain resolves only after stdin.write()'s drain callback fires,
// guaranteeing the whole frame is flushed before the next frame starts.
```

This is the TS analog of `stdinMu.Lock(); write(line); write("\n"); Unlock()` but it additionally
respects back-pressure (the Go reference doesn't have to — blocking writes). One queue per
multiplexer (per downstream child), not per session.

---

## 4. Response routing & the single-thread trap

Routing is §2's free-step: `idMap.delete(proxyId)` → `mapping.sessionId` → `sessions.get(...)` →
write the restored frame to that socket. The stdout reader is a **line reader** over the child's
stdout; partial lines are buffered until `\n` (a partial-frame reader is mandatory — never `JSON.parse`
a chunk).

**The trap:** "JS is single-threaded so I don't need locks" is true for the *map mutation* but false
for *I/O ordering*. Stdin needs the §3 queue (back-pressure). Stdout needs the partial-line buffer.
Socket writes back to a slow client need their own per-session back-pressure handling (a slow reader
must not stall the multiplexer; bound the per-session outbound buffer and drop+error the session if
it exceeds it, rather than letting it pin memory).

---

## 5. Respawn / teardown state machine

Downstream child states (Supervisor owns this; transitions are the only way state changes):

```
        spawn() ok                       stdout EOF / write EPIPE / spawn error
 idle ───────────► running ──────────────────────────────────────► failed
   ▲                  │                                                │
   │ backoff elapsed  │ stop()/release()                              │ reap()+sweep done
   └──── respawning ◄─┴───────────────► stopped (terminal)            ▼
              ▲                                              (failed → respawning, capped backoff)
              └──────────────────────────────────────────────────────┘
```

- **running → failed** is triggered by *any* of: stdout reader hits EOF, a stdin frame write rejects
  (EPIPE), or `child.on('error'/'exit')`. All collapse to one `markFailed(reason)` (idempotent).
- **failed → reap**: `child.kill()` if still alive, `await once(child,'exit')` **exactly once** (guard
  with a `reaped` flag — the Go bug class is a double-`Wait`; ours is a double-`kill`/double-listener).
  Then `closeAllOnFailure()` (§6) and `sweepIdMap()` (clear *all* mappings — every in-flight request is
  now unanswerable; route a synthetic `-32603` to each owning session before clearing).
- **failed → respawning**: exponential backoff (base ~3s as in the reference, cap ~30s, reset on a
  clean run > N seconds). A **single** respawn timer; never two in flight (guard with the FSM state).
- **stop()/release()** is terminal (`stopped`): cancels any pending respawn timer, kills the child,
  reaps once, frees all resources. Idempotent.

**Per-session teardown without dropping others' in-flight requests** (the explicit requirement):
when *one* session's socket closes,
```
for (const [proxyId, m] of idMap) if (m.sessionId === gone) idMap.delete(proxyId);
sessions.delete(gone);
```
We delete only *that* session's mappings; other sessions' mappings and their in-flight downstream
requests are untouched. We do **not** touch the downstream child (other sessions still need it). A
late downstream response for a torn-down session hits §2-step-3 (unknown id → drop) — safe.

---

## 6. Error-path resource ownership (pre-empting their FD leak)

Their bug: `Start()` acquired a **log file descriptor**, then errored *before* registering the proxy
for `Stop()` to clean up. The FD was never closed; repeated failing attaches drained the FD budget
over hours. **Rule:** *every resource acquired before its cleanup handle is registered must be
released on the error path of the function that acquired it.*

Concretely, `start()` acquires, in order: a **listen socket**, a **child process** (and its
stdin/stdout/stderr pipes), and possibly a **log stream**. Encode ownership as an explicit ledger and
unwind it in reverse on any failure:

```ts
async start() {
  const acquired: Array<() => void> = [];
  const cleanup = () => { while (acquired.length) try { acquired.pop()!(); } catch {} };
  try {
    const log = openLog();           acquired.push(() => log.close());
    const sock = await listen(path); acquired.push(() => sock.close());
    const child = spawn(...);         acquired.push(() => { try { child.kill('SIGKILL'); } catch {} });
    // ...wire stdout reader / stdin queue...
    this.registerForStop({ log, sock, child });   // <-- cleanup handle registered HERE
    acquired.length = 0;                            // ownership transferred; don't double-free
  } catch (e) { cleanup(); throw e; }              // <-- every pre-registration resource released
}
```

The invariant: **between acquiring a resource and `registerForStop`, the only exit is `cleanup()`**.
After `registerForStop`, ownership is the Supervisor's and `stop()` frees it. This makes the leak
*structurally* impossible, not just "remembered."

---

## 7. (covered above — id-map clear on respawn lives in §5 reap; restated for the FSM)

On `failed → reap`: route synthetic errors to all owning sessions, then `idMap.clear()`. A fresh
child starts `proxyIdSeq` *where it left off* (monotonic across respawns) so even a buggy old child's
late line (if its fd somehow lingered) can't alias a new id — defense in depth on top of the clear.

---

## 8. Tests (deliverable 2 ships these)

1. **FD-leak hammer (the pre-empt).** Loop `start()` N×500 where `start()` is forced to fail *after*
   acquiring the log + socket but *before* `registerForStop` (inject a throwing `spawn`). Assert
   open-handle count is flat. Measure via `process.report.getReport().libuv` handle count and/or
   `fs` fd count on `/proc/self/fd` (Linux) / a counting fake. Fail if growth > small constant.
2. **id collision.** Two sessions both send `id: 1`; assert the downstream sees two distinct ids and
   each session gets its own `id: 1` back, with the right payload.
3. **Framing serialization.** Fire M concurrent large requests from K sessions at a downstream that
   echoes the raw line; assert every line the downstream received is a single valid JSON frame (no
   interleave), and count == M.
4. **Respawn.** Kill the downstream mid-flight; assert: in-flight requests get a `-32603` to their
   sessions, the child is reaped exactly once (no double-kill/zombie), a new child spawns after
   backoff, and new requests succeed.
5. **Teardown isolation.** Session A has 3 in-flight; close session B (which has its own in-flight);
   assert A's mappings + responses are unaffected and B's are gone; a late B response is dropped, not
   misrouted.
6. **Unknown/duplicate downstream id.** Downstream emits a response for an id never sent / sent twice;
   assert drop, no crash, no double-route.

All tests use a synthetic in-process downstream (a fake that speaks newline-JSON) so no real
subprocess is needed — mirrors `ProcessManager`'s `AdapterFactory` test seam (process-manager.ts l.34-49).

---

## 9. Open decision for review (placement)

The task said "implement against our existing proxy," but §0 shows there's **no** existing southbound
proxy — `AlmytyProxy` is an HTTP client. Options:

- **(recommended) New `McpStdioMux` in `packages/mcp-server/src/`**, sibling to `AlmytyProxy`,
  reusing its options/logging conventions. Cleanest; touches nothing northbound.
- New tiny package `packages/mcp-mux/` if it must be consumable by the runner too.
- Inside the runner (`packages/runner/`) if the downstream MCP processes are meant to live on the
  user's machine alongside the CLI-agent processes `ProcessManager` already supervises — in which
  case the Supervisor/FSM should *reuse* `ProcessManager`'s adapter seam rather than re-spawn.

Recommendation: `packages/mcp-server/src/mcp-stdio-mux.ts` + `socket-listener.ts` + tests, unless the
downstream is runner-resident (then runner). Confirm before I build.
```
```
