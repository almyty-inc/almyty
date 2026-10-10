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
          description: 'Working directory relative to the workspace root. Defaults to workspace root.',
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
