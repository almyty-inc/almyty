import { runnerExecutableInputs } from '../runner/runner-capabilities';

/**
 * The inputs of a tool that are the command or code the tool exists to
 * run -- `command` on a runner's or hosted environment's `shell.exec`.
 *
 * Pattern checks for command and SQL injection (the input sanitizer's
 * shell-command check, the security-scanner plugin) skip these inputs and
 * keep scanning every other one. A command that chains with `&&`, pipes
 * into `wc` or quotes a string is what a shell tool is for; flagging it
 * refused every real command an agent sent. What guards these tools is
 * the runner's sandbox, its binary and deny policies, and ask-first
 * approvals.
 *
 * Declared on the capability definition (runner-capabilities.ts), not
 * matched by tool name, so a tool row published before the declaration
 * existed is covered too.
 */
export function executableInputs(tool: { runnerConfig?: { method?: string | null; [key: string]: unknown } | null }): string[] {
  return tool.runnerConfig ? runnerExecutableInputs(tool.runnerConfig.method) : [];
}
