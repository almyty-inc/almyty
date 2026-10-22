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

/** A call told to wait for its hosted machine (starting, or busy with another job): it did not run, and is retried. */
export function isWaitingForMachine(result: { success?: boolean; metadata?: Record<string, any> } | null | undefined): boolean {
  const code = result?.metadata?.runnerErrorCode;
  return !!result && !result.success && (code === WORKSPACE_WAKING || code === WORKSPACE_BUSY);
}

/**
 * A call whose machine could not start: it failed to provision, or it was
 * still not up when the wake budget ran out. The tool result carries it in
 * `metadata.machineFailed` (with the raw `machineError`), and a run ends
 * failed on it -- retrying cannot help, and the model must not answer as
 * if the call ran.
 */
export const MACHINE_FAILED = 'machineFailed';

/** Bearer tokens, key=value secrets, JWTs and long opaque strings, masked before an error is stored or shown. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
    .replace(/\b(token|access_token|api[_-]?key|password|secret|authorization)(["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi, '$1$2[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, '[redacted]');
}

/** The kinds of machine error people are told apart, in the order they are tested. */
export type MachineErrorKind = 'image' | 'certificate' | 'access' | 'capacity' | 'other';

export function machineErrorKind(raw: string | null | undefined): MachineErrorKind {
  const text = raw ?? '';
  if (/imagepullbackoff|errimagepull|pull(ing)? (the )?image|image pull|could not be pulled|failed to pull|manifest unknown/i.test(text)) return 'image';
  if (/certificate|x509|self[- ]signed|unable to verify|cert_|\btls\b|\bssl\b/i.test(text)) return 'certificate';
  if (/\b40[13]\b|unauthori[sz]ed|forbidden/i.test(text)) return 'access';
  if (/capacity|insufficient (cpu|memory)|unschedulable|failedscheduling|no nodes available/i.test(text)) return 'capacity';
  return 'other';
}

const MACHINE_ERROR_SENTENCES: Record<MachineErrorKind, string> = {
  image: "Couldn't download the environment image",
  certificate: "Can't reach the cluster: its certificate isn't trusted",
  access: "The cluster rejected almyty's access",
  capacity: 'Waiting for a free sandbox machine',
  other: "The machine couldn't start",
};

/**
 * A machine's error in one short sentence, by its kind. The raw text is
 * kept beside it, redacted, for whoever wants the details.
 */
export function describeMachineError(raw: string | null | undefined): string {
  return MACHINE_ERROR_SENTENCES[machineErrorKind(raw)];
}

/**
 * A cluster error that waiting cannot fix: its certificate is not trusted,
 * or it refused almyty (401/403). The machine fails at once rather than
 * waiting out the wake budget. Read from the error's text, its TLS code and
 * its HTTP status; an image pull refused with a 401 is the registry's
 * answer, not the cluster's, and is not one of these.
 */
export function isTerminalClusterError(error: any): boolean {
  const text = `${error?.message ?? error ?? ''} ${typeof error?.code === 'string' ? error.code : ''}`;
  const kind = machineErrorKind(text);
  if (kind === 'image') return false;
  if (kind === 'certificate' || kind === 'access') return true;
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
  return status === 401 || status === 403;
}

/**
 * What a person is shown about a machine that cannot start: the sentence,
 * and the raw error with secrets masked (behind "Details"). The only place
 * the mapping lives; the API and run traces carry it, the UI renders it.
 */
export interface MachineProblem {
  sentence: string;
  detail: string | null;
}

export function machineProblem(raw: string | null | undefined): MachineProblem {
  return { sentence: describeMachineError(raw), detail: raw ? redactSecrets(raw) : null };
}

/** The problem as one tool-result text, for a caller that reads text (an MCP client). */
export function machineProblemText(problem: MachineProblem): string {
  return `The hosted machine couldn't start: ${problem.sentence}.${problem.detail ? `\nDetails: ${problem.detail}` : ''}`;
}
