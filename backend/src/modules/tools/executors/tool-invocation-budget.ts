/**
 * The budget for `tools.invoke` calls made from inside sandboxed tools.
 *
 * One budget is created per ROOT execution -- the tool call that came in
 * from a gateway, an agent run or the REST API -- and every nested call
 * underneath it, at any depth, draws on the same object. It bounds three
 * things:
 *
 *   - depth: how many levels of nesting a call may sit at. A tool that
 *     invokes itself stops here.
 *   - total: how many nested calls the whole tree may make. A tool that
 *     catches the depth error and keeps calling stops here.
 *   - in flight: how many nested calls may be running at once. Nested
 *     sandbox executions do not wait for a slot in the shared worker pool
 *     (their caller already holds one, and making them queue behind it is
 *     a deadlock), so this is what keeps one tree from spawning an
 *     unbounded number of workers alongside the pool.
 *
 * Every limit refuses rather than waits: a refusal surfaces in the calling
 * tool as a rejected `tools.invoke`, which it can catch, and cannot
 * deadlock against anything.
 */

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_NESTED = 25;
const DEFAULT_MAX_IN_FLIGHT = 4;

function positiveIntFromEnv(name: string, fallback: number): number {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export class ToolInvocationBudget {
  private used = 0;
  private inFlight = 0;

  constructor(
    readonly maxDepth: number,
    readonly maxNested: number,
    readonly maxInFlight: number,
  ) {}

  static fromEnv(): ToolInvocationBudget {
    return new ToolInvocationBudget(
      positiveIntFromEnv('SANDBOX_MAX_INVOKE_DEPTH', DEFAULT_MAX_DEPTH),
      positiveIntFromEnv('SANDBOX_MAX_NESTED_INVOCATIONS', DEFAULT_MAX_NESTED),
      positiveIntFromEnv('SANDBOX_MAX_NESTED_IN_FLIGHT', DEFAULT_MAX_IN_FLIGHT),
    );
  }

  /**
   * Claim one nested call that will run at `depth` (1 for a call made by
   * the root tool). Throws when any limit is reached; otherwise returns
   * the function that releases the in-flight slot, which the caller must
   * call exactly once when the nested call settles.
   */
  claim(depth: number): () => void {
    if (depth > this.maxDepth) {
      throw new Error(
        `tools.invoke depth limit reached: nested tool calls may go at most ${this.maxDepth} levels deep`,
      );
    }
    if (this.used >= this.maxNested) {
      throw new Error(
        `tools.invoke budget exhausted: at most ${this.maxNested} nested tool calls per execution`,
      );
    }
    if (this.inFlight >= this.maxInFlight) {
      throw new Error(
        `tools.invoke concurrency limit reached: at most ${this.maxInFlight} nested tool calls may run at once`,
      );
    }
    this.used++;
    this.inFlight++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight--;
    };
  }
}
