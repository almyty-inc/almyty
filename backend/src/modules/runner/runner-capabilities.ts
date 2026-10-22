/**
 * The methods a runner publishes as tools (RunnerCapabilityPublisher):
 * `runner.<name>.<method>` for a self-hosted runner and
 * `env.<name>.<method>` for a hosted environment. Plain data, so the tool
 * executor can read a capability's declaration without importing the
 * publisher.
 */
export interface CapabilityDef {
  method: string;
  description: string;
  requiresWorkspace: boolean;
  parameters: Record<string, unknown>;
  /**
   * Inputs that ARE the command or code the method runs. The pattern checks
   * for command and SQL injection skip them (tools/tool-executable-inputs.ts):
   * running a command is the method's purpose, and what guards it is the
   * runner's sandbox, its binary and deny policies, and ask-first approvals.
   */
  executableInputs?: string[];
}

export const RUNNER_CAPABILITIES: CapabilityDef[] = [
  {
    method: 'runner.info',
    description: 'Return runtime info (OS, arch, node version, installed binaries) for the runner host.',
    requiresWorkspace: false,
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    method: 'agent.list',
    description: 'List the coding-agent CLIs this runner can drive (claude, codex, gemini, cursor, copilot, …), with each platform\'s provider family, auth/config levers, MCP support, and resume mechanism.',
    requiresWorkspace: false,
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    method: 'shell.exec',
    description: 'Execute a one-shot shell command on the runner host. Captures stdout/stderr and exit code. Workspace-scoped.',
    requiresWorkspace: true,
    executableInputs: ['command'],
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Shell command to run. Interpreted by the runner\'s default shell.',
        },
        cwd: {
          type: 'string',
          description: 'Working directory relative to the workspace root. Defaults to the cloned repository on a hosted environment with one, else the workspace root.',
        },
        env: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Extra environment variables for this invocation.',
        },
        timeoutMs: {
          type: 'integer',
          minimum: 1,
          description: 'Hard timeout in milliseconds. The runner kills the process if exceeded.',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
];

/** The inputs of a runner method that are the command it runs (none for an unknown method). */
export function runnerExecutableInputs(method: string | null | undefined): string[] {
  return RUNNER_CAPABILITIES.find((cap) => cap.method === method)?.executableInputs ?? [];
}

/** The longest a single runner call is waited for: a command's own timeoutMs is honoured up to this. */
export const MAX_RUNNER_CALL_WAIT_MS = 60 * 60_000;
/** Time for a command's answer to come back after the runner stops it at its own timeout. */
const RUNNER_ANSWER_GRACE_MS = 10_000;

/**
 * How long to wait for a runner call. The tool's own timeout wins. Without
 * one, a call that sets its own hard timeout (shell.exec's `timeoutMs`) is
 * waited for that long plus time for the answer to arrive: the runner
 * stops the command then, and the answer says so. Otherwise undefined, the
 * dispatch default. Waiting only the 30-second default while the command
 * was allowed ten minutes reported a coding assistant still at work as a
 * runner that did not answer.
 */
export function runnerCallWait(configured: number | undefined, params: unknown): number | undefined {
  if (typeof configured === 'number' && configured > 0) return configured;
  const own = (params as { timeoutMs?: unknown } | null)?.timeoutMs;
  if (typeof own !== 'number' || !Number.isFinite(own) || own <= 0) return undefined;
  return Math.min(own, MAX_RUNNER_CALL_WAIT_MS) + RUNNER_ANSWER_GRACE_MS;
}
