import type { ExecutionPrincipal } from '../../common/authorization/execution-access.service';

/**
 * What the tool executor needs of hosted environments, as a token, so the
 * tools module does not import the hosted-runners module (which imports
 * the runner module the tools module already depends on).
 *
 * `resolveTarget` answers where a call to an environment goes now: its
 * runner and workspace when the machine is up, "waking, try again in
 * retryAfterMs" while it starts, or "busy" while another job of the same
 * person works in the workspace (one folder, one job at a time). A ready
 * answer carries the workspace lease the call holds; `releaseLease` gives
 * back a lone call's lease when it returns. `touchRunner` restarts the
 * idle clock after a dispatch.
 */
export interface HostedDispatch {
  resolveTarget(
    environmentId: string,
    caller: {
      organizationId: string;
      principal?: ExecutionPrincipal;
      callerUserId?: string | null;
      agentId?: string | null;
      runId?: string | null;
      workspaceId?: string | null;
      signal?: AbortSignal;
    },
  ): Promise<
    | { kind: 'ready'; runnerId: string; workspaceId: string; hostedRunnerId: string; lease?: { holder: string; releaseAfterCall: boolean } }
    | { kind: 'waking'; workspaceId: string; hostedRunnerId: string; retryAfterMs: number; message: string }
    | { kind: 'busy'; workspaceId: string; hostedRunnerId: string; retryAfterMs: number; message: string }
  >;
  touchRunner(runnerId: string): Promise<void>;
  releaseLease(workspaceId: string, holder: string): Promise<void>;
}

export const HOSTED_DISPATCH = Symbol('HOSTED_DISPATCH');

/** The runner-call error code a waking hosted workspace reports; a run sleeps and retries on it. */
export const WORKSPACE_WAKING = 'workspace_waking';

/** The runner-call error code while another job works in the workspace; a run sleeps and retries on it too. */
export const WORKSPACE_BUSY = 'workspace_busy';
