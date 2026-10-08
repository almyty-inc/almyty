import type { ExecutionPrincipal } from '../../common/authorization/execution-access.service';

/**
 * What the tool executor needs of hosted environments, as a token, so the
 * tools module does not import the hosted-runners module (which imports
 * the runner module the tools module already depends on).
 *
 * `resolveTarget` answers where a call to an environment goes now: its
 * runner and workspace when the machine is up, or "waking, try again in
 * retryAfterMs" while it starts. `touchRunner` restarts the idle clock
 * after a dispatch.
 */
export interface HostedDispatch {
  resolveTarget(
    environmentId: string,
    caller: { organizationId: string; principal?: ExecutionPrincipal; callerUserId?: string | null; agentId?: string | null },
  ): Promise<
    | { kind: 'ready'; runnerId: string; workspaceId: string; hostedRunnerId: string }
    | { kind: 'waking'; workspaceId: string; hostedRunnerId: string; retryAfterMs: number; message: string }
  >;
  touchRunner(runnerId: string): Promise<void>;
}

export const HOSTED_DISPATCH = Symbol('HOSTED_DISPATCH');

/** The runner-call error code a waking hosted workspace reports; a run sleeps and retries on it. */
export const WORKSPACE_WAKING = 'workspace_waking';
