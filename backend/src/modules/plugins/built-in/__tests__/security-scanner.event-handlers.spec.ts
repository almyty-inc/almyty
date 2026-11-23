import { readFileSync } from 'fs';
import { join } from 'path';
import { SecurityScannerPlugin } from '../security-scanner.plugin';
import { eventHandlerMatcher } from '../security-scanner.matchers';
import { PluginContext, PluginHookType } from '../../types/plugin.types';
import { executableInputs } from '../../../tools/tool-executable-inputs';

/**
 * A runner's `shell.exec` was refused three times in one run as
 * `XSS in input "command"` for ordinary Python: `region_rev = ...`,
 * `json_data = ...`. The event-handler check was a bare `/on\w+\s*=/gi`,
 * so any word with `on` in it before an `=` read as an HTML attribute.
 * It now needs an HTML context: inside a tag, or after a closing quote
 * that breaks out of an attribute value.
 *
 * fixtures/runner-shell-commands.json holds the seven commands of that
 * run verbatim; `blocked` records which ones the scanner refused.
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

const SHELL_TOOL = {
  name: 'runner.northwind-demo-mac.shell.exec',
  runnerConfig: { runnerId: 'r-1', method: 'shell.exec', requiresWorkspace: true },
};
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

const RUN: Array<{ call: number; blocked: boolean; command: string }> = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'runner-shell-commands.json'), 'utf8'),
);

describe('security scanner: event handlers need an HTML context', () => {
  const plugin = new SecurityScannerPlugin();

  it('the fixture holds the three refused commands', () => {
    expect(RUN.filter((c) => c.blocked).map((c) => c.call)).toEqual([2, 3, 4]);
  });

  it.each(RUN.map((c) => [c.call, c.command] as const))('runs command %i of the demo run', async (_call, command) => {
    const result = await plugin.scanToolParameters(
      toolCall(SHELL_TOOL, { command, cwd: '/home/demo/almyty-demo-runner/work' }),
      settings,
    );
    expect({ ok: result.success, error: result.error?.message }).toEqual({ ok: true, error: undefined });
    expect(result.metadata.warnings).toEqual([]);
  });

  it.each([
    'region_rev = {}',
    'json_data = json.loads(raw)',
    'button_label = "Save"',
    'python3 -c "con = sqlite3.connect(\'a.db\')"',
    'one = 1\nonly_new = True\non_click = None',
    'name = "x"\nonly_new = True',
    'if a<b:\n    pass\nconnection = open_db()',
    'cat <<EOF > notes.txt\nsummary = done\nEOF',
    'export DATABASE_CONNECTION=postgres://localhost/app',
    'docker run -e "ONLY_X=1" -e "ONE=2" app',
    'The <b>conversion</b> rate = 3%',
  ])('lets %j through as a tool input and a request body', async (text) => {
    const tool = await plugin.scanToolParameters(toolCall(HTTP_TOOL, { body: text }), settings);
    expect({ text, threats: (tool.error?.details as any)?.threats ?? [] }).toEqual({ text, threats: [] });
    const body = await plugin.scanRequest(request({ text }), settings);
    expect({ text, threats: (body.error?.details as any)?.threats ?? [] }).toEqual({ text, threats: [] });
  });

  it.each([
    '<img src=x onerror=alert(1)>',
    '<img src="x" onerror="alert(1)">',
    '<IMG SRC=x ONERROR=alert(1)>',
    '<svg onload=alert(1)>',
    '<svg/onload=alert(1)>',
    '<svg\nonload=alert(1)>',
    '<svg\tonload=alert(1)>',
    '<img src="x"onerror=alert(1)>',
    '<body onload = "steal()">',
    '<a href="#" title="t" onmouseover="alert(1)">x</a>',
    '<details open ontoggle=alert(1)>',
    '<input autofocus onfocus=alert(1)>',
    '<x-widget data-a="1"\n  onclick="go()">',
    'x" onmouseover="alert(1)',
    "x' onfocus='alert(1)' autofocus='",
    '" onmouseover=alert(1) x="',
  ])('flags %j', async (payload) => {
    for (const result of [
      await plugin.scanRequest(request({ comment: payload }), settings),
      await plugin.scanRequest(request(payload), settings),
      await plugin.scanToolParameters(toolCall(SHELL_TOOL, { command: `echo '${payload}' > page.html` }), settings),
    ]) {
      expect({ payload, ok: result.success, message: result.error?.message }).toEqual({
        payload,
        ok: false,
        message: expect.stringContaining('XSS'),
      });
      expect((result.error?.details as any).threats.map((t: any) => t.pattern)).toContain(eventHandlerMatcher.pattern);
    }
  });

  it('returns the handler text it matched', () => {
    expect(eventHandlerMatcher.match('<img src=x onerror=alert(1) onload =y>')).toEqual(['onerror=', 'onload =']);
    expect(eventHandlerMatcher.match('region_rev = {}; <b>on</b> x')).toBeNull();
  });

  it('stays linear on hostile bodies', () => {
    const size = 100_000;
    for (const body of ['<a on=x '.repeat(size / 8), '" on=x '.repeat(size / 7), '\\\\\\non='.repeat(size / 8), '<a' + ' '.repeat(size) + 'on']) {
      const started = Date.now();
      eventHandlerMatcher.match(body);
      expect(Date.now() - started).toBeLessThan(250);
    }
  });
});
