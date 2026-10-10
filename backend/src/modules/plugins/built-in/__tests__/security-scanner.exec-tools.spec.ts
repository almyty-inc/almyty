import { SecurityScannerPlugin } from '../security-scanner.plugin';
import { PluginContext, PluginHookType } from '../../types/plugin.types';
import { executableInputs } from '../../../tools/tool-executable-inputs';

/**
 * An agent asked a runner to run `ls && printf 'one line\n' > NOTES.md`
 * through `runner.<name>.shell.exec`, and the security scanner refused it
 * as "Potential SQL injection, Potential command injection": a `'`
 * followed by a space read as SQL, and `&& ls` as command injection.
 *
 * A shell tool's command is supposed to contain shell syntax. Its
 * declared executable inputs (tool-executable-inputs.ts) skip the command
 * and SQL injection checks; every other input, and every other tool,
 * is scanned as before.
 */

const settings = {
  scanRequests: true,
  scanResponses: true,
  scanToolParameters: true,
  blockOnThreat: true,
  logThreats: false,
  whitelistPatterns: [],
  customPatterns: [],
  severityThreshold: 'medium',
};

const SHELL_TOOL = { name: 'runner.box.shell.exec', runnerConfig: { runnerId: 'r-1', method: 'shell.exec', requiresWorkspace: true } };
const HTTP_TOOL = { name: 'notes_api_create', runnerConfig: null };

function toolCall(tool: { name: string; runnerConfig: any }, data: Record<string, unknown>): PluginContext {
  return {
    hookType: PluginHookType.PRE_TOOL_EXECUTION,
    organizationId: 'org-1',
    requestId: 'req-1',
    data,
    metadata: {
      timestamp: new Date().toISOString(),
      plugin: { id: '', name: '', version: '' },
      execution: { attempt: 1, timeout: 0, startTime: Date.now() },
      tool: { id: 'tool-1', name: tool.name, executableInputs: executableInputs(tool) },
    },
  };
}

function request(data: unknown): PluginContext {
  return { ...toolCall(HTTP_TOOL, {}), hookType: PluginHookType.PRE_REQUEST, data, metadata: { timestamp: '' } as any };
}

const DEV_COMMANDS = [
  "ls && printf 'one line\\n' > NOTES.md",
  'npm test && git status',
  'grep -r "foo" . | wc -l',
  "cat <<'EOF' > a.txt\nhello\nEOF",
  'cd app && ls -la',
  'ps aux | grep node; kill -0 123',
  'echo "built at $(date)" >> build.log',
  'git log --format=`%h` -1',
  "psql -c \"SELECT id, name FROM users WHERE name = 'x'\" && rm -rf tmp",
  'sqlite3 app.db "DELETE FROM sessions WHERE expired = 1; DROP TABLE tmp;"',
];

describe('security scanner: the command of a shell tool', () => {
  const plugin = new SecurityScannerPlugin();

  it('the shell tool declares its command as executable input', () => {
    expect(executableInputs(SHELL_TOOL)).toEqual(['command']);
    expect(executableInputs({ runnerConfig: { environmentId: 'e-1', method: 'shell.exec' } })).toEqual(['command']);
    expect(executableInputs({ runnerConfig: { runnerId: 'r-1', method: 'runner.info' } })).toEqual([]);
    expect(executableInputs(HTTP_TOOL)).toEqual([]);
  });

  it.each(DEV_COMMANDS)('runs %j', async (command) => {
    const result = await plugin.scanToolParameters(toolCall(SHELL_TOOL, { command, cwd: 'repo' }), settings);
    expect({ ok: result.success, error: result.error?.message }).toEqual({ ok: true, error: undefined });
    expect(result.metadata.warnings).toEqual([]);
  });

  it('still scans the shell tool\'s other inputs', async () => {
    const result = await plugin.scanToolParameters(
      toolCall(SHELL_TOOL, { command: 'ls && pwd', cwd: 'x; rm -rf /' }),
      settings,
    );
    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('Security check blocked tool "runner.box.shell.exec": command injection in input "cwd"');
    expect((result.error?.details as any).threats.every((t: any) => t.inputs?.join() === 'cwd')).toBe(true);
  });

  it('still applies the XSS check to the command itself', async () => {
    const result = await plugin.scanToolParameters(
      toolCall(SHELL_TOOL, { command: 'echo "<script>alert(1)</script>" > index.html' }),
      settings,
    );
    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('Security check blocked tool "runner.box.shell.exec": XSS in input "command"');
  });

  it.each([
    ['cd app && ls -la', 'command injection'],
    ['ps aux | grep node; kill -0 123', 'command injection'],
    ['echo "built at $(date)" >> build.log', 'command injection'],
    ["psql -c \"SELECT id, name FROM users WHERE name = 'x'\" && rm -rf tmp", 'SQL injection'],
  ])('a non-shell tool given %j is still refused', async (text, check) => {
    const result = await plugin.scanToolParameters(toolCall(HTTP_TOOL, { body: text }), settings);
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain(`${check} in input "body"`);
    expect(result.error?.message).toMatch(/^Security check blocked tool "notes_api_create": /);
  });

  it('a shell-tool name sent by a non-shell tool is not exempt: the exemption is the declaration', async () => {
    const result = await plugin.scanToolParameters(
      toolCall({ name: 'my_tool', runnerConfig: null }, { command: 'cd app && ls -la' }),
      settings,
    );
    expect(result.success).toBe(false);
  });
});

describe('security scanner: SQL injection needs SQL', () => {
  const plugin = new SecurityScannerPlugin();

  it.each([
    'Please update the README and delete the old notes',
    "The users' files are in the shared folder",
    "printf 'one line' > NOTES.md",
    'select a color from the list',
    "It's 'red' and blue",
    'Execute the plan, then drop me a line',
    'Insert a row in the table below',
    'Step 1; update the docs',
  ])('lets %j through', async (text) => {
    const result = await plugin.scanRequest(request({ message: text }), settings);
    expect({ text, threats: (result.error?.details as any)?.threats ?? [] }).toEqual({ text, threats: [] });
  });

  it.each([
    "1' UNION SELECT * FROM users--",
    "1 UNION ALL SELECT password FROM users",
    "admin'--",
    "'; DROP TABLE users; --",
    '1; DROP TABLE users',
    "admin' OR '1'='1",
    "x' OR 'a'='a",
    "' OR 1=1--",
    'id=1 OR 1=1',
    "x' AND sleep(5)",
    'SELECT * FROM users',
    'SELECT id, password FROM users',
    "INSERT INTO users (name) VALUES ('x')",
    "UPDATE users SET role='admin'",
    'DELETE FROM users WHERE 1=1',
    "EXEC xp_cmdshell 'dir'",
    'TRUNCATE TABLE audit_log',
    "1'; WAITFOR DELAY '0:0:5'--",
  ])('flags %j', async (text) => {
    const result = await plugin.scanRequest(request({ q: text }), settings);
    expect((result.error?.details as any)?.threats?.map((t: any) => t.type)).toContain('sql_injection');
  });

  it('flags the command-injection examples it was written for, and not "; identity"', async () => {
    for (const text of ['file.txt | cat /etc/passwd', 'input.txt; rm -rf /', '`whoami`', 'file$(ls -la)', 'a;ls', 'x && id']) {
      const result = await plugin.scanRequest(request({ v: text }), settings);
      expect({ text, types: (result.error?.details as any)?.threats?.map((t: any) => t.type) }).toEqual({ text, types: expect.arrayContaining(['command_injection']) });
    }
    for (const text of ['Build; identify the flaky test', 'Options | listing']) {
      const result = await plugin.scanRequest(request({ v: text }), settings);
      expect({ text, ok: result.success }).toEqual({ text, ok: true });
    }
  });

  it('a request scan names the checks, without tool wording', async () => {
    const result = await plugin.scanRequest(request("' UNION SELECT * FROM users-- <script>alert(1)</script>"), settings);
    expect(result.error?.message).toBe('Security threat detected: SQL injection; XSS');
  });
});
