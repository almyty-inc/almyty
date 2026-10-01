/**
 * Tunables of the MCP client that connects almyty to outside MCP servers
 * (mcp-sources, the connection check). Read from the environment when asked
 * for, so a test sets a variable and sees it applied; a value that is not a
 * number in range falls back to its default.
 *
 *   MCP_CLIENT_ERA                    auto (default): try MCP 2026-07-28 first and
 *                                     fall back to initialize; modern or legacy
 *                                     pin one era for every server
 *   MCP_CLIENT_TIMEOUT_MS             one HTTP request to the server (default 30000)
 *   MCP_CLIENT_MAX_TOOL_PAGES         tools/list pages followed (default 50)
 *   MCP_CLIENT_TASK_DEADLINE_MS       longest a remote task is followed within one
 *                                     tool call before it is cancelled (default 600000)
 *   MCP_CLIENT_TASK_POLL_MIN_MS       floor for the server's pollIntervalMs (default 500)
 *   MCP_CLIENT_TASK_POLL_MAX_MS       ceiling for it (default 30000)
 *   MCP_CLIENT_INPUT_ROUNDS           input_required rounds answered automatically in one
 *                                     call (roots/list) before giving up (default 3)
 *   MCP_CLIENT_PENDING_INPUT_SECONDS  how long a question a remote asked inside an agent
 *                                     run waits for the person's answer (default 3600)
 *   MCP_CLIENT_RUN_CANCEL_CHECK_MS    how often a call made for an agent run checks whether
 *                                     the run was cancelled, to cancel its remote task (default 2000)
 */

type Env = Record<string, string | undefined>;

function intSetting(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

export type McpClientEraSetting = 'auto' | 'modern' | 'legacy';

export interface McpClientSettings {
  era: McpClientEraSetting;
  timeoutMs: number;
  maxToolPages: number;
  taskDeadlineMs: number;
  taskPollMinMs: number;
  taskPollMaxMs: number;
  inputRounds: number;
  pendingInputSeconds: number;
  /** How often a call made for an agent run checks whether the run was cancelled. */
  runCancelCheckMs: number;
}

export function mcpClientSettings(env: Env = process.env): McpClientSettings {
  const era = (env.MCP_CLIENT_ERA ?? '').trim().toLowerCase();
  const pollMin = intSetting(env, 'MCP_CLIENT_TASK_POLL_MIN_MS', 500, 50, 600_000);
  return {
    era: era === 'modern' || era === 'legacy' ? era : 'auto',
    timeoutMs: intSetting(env, 'MCP_CLIENT_TIMEOUT_MS', 30_000, 100, 600_000),
    maxToolPages: intSetting(env, 'MCP_CLIENT_MAX_TOOL_PAGES', 50, 1, 10_000),
    taskDeadlineMs: intSetting(env, 'MCP_CLIENT_TASK_DEADLINE_MS', 600_000, 1_000, 86_400_000),
    taskPollMinMs: pollMin,
    taskPollMaxMs: Math.max(pollMin, intSetting(env, 'MCP_CLIENT_TASK_POLL_MAX_MS', 30_000, 50, 3_600_000)),
    inputRounds: intSetting(env, 'MCP_CLIENT_INPUT_ROUNDS', 3, 0, 20),
    pendingInputSeconds: intSetting(env, 'MCP_CLIENT_PENDING_INPUT_SECONDS', 3_600, 30, 7 * 86_400),
    runCancelCheckMs: intSetting(env, 'MCP_CLIENT_RUN_CANCEL_CHECK_MS', 2_000, 100, 600_000),
  };
}
