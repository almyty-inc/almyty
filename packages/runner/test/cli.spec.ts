import { describe, expect, it } from 'vitest';

import { parseArgs } from '../src/cli-args';

/** parseArgs takes a full argv, so the first two entries are node and the script. */
const argv = (...args: string[]) => ['node', 'almyty-runner', ...args];

describe('almyty-runner argument parsing', () => {
  it('reads the commands and their options', () => {
    expect(parseArgs(argv('status'))).toEqual({ command: 'status' });
    expect(parseArgs(argv('stop'))).toEqual({ command: 'stop' });
    expect(parseArgs(argv())).toEqual({ command: 'help' });
    expect(parseArgs(argv('--version'))).toEqual({ command: 'version' });
    expect(parseArgs(argv('start', '--name', 'box', '--url', 'https://api.example', '--config', '/tmp/c.json'))).toEqual({
      command: 'start',
      name: 'box',
      url: 'https://api.example',
      configPath: '/tmp/c.json',
    });
    expect(parseArgs(argv('start', '--label', 'gpu=a100', '--label', 'zone=eu')).labels).toEqual({ gpu: 'a100', zone: 'eu' });
  });

  it('reports an unknown command instead of printing help and succeeding', () => {
    // `almyty-runner statuss` printed the help text and exited 0, so a
    // script could not tell a typo from a runner that was actually up.
    const parsed = parseArgs(argv('statuss'));
    expect(parsed.error).toMatch(/Unknown command: statuss/);
    expect(parsed.error).toMatch(/start, status, stop/);
  });

  it('reports an unknown option instead of ignoring it', () => {
    // `start --nmae box` registered under the machine's hostname and
    // never said why the name had not taken.
    expect(parseArgs(argv('start', '--nmae', 'box')).error).toMatch(/Unknown option: --nmae/);
  });

  it('reports a flag left without a value', () => {
    expect(parseArgs(argv('start', '--name')).error).toMatch(/--name needs a value/);
    expect(parseArgs(argv('start', '--url', '--name', 'box')).error).toMatch(/--url needs a value/);
  });

  it('still reports a label that is not key=value', () => {
    expect(parseArgs(argv('start', '--label', 'gpu')).error).toMatch(/--label expects key=value/);
  });

  it('lets --help win wherever it appears, with no error', () => {
    expect(parseArgs(argv('start', '--help'))).toEqual({ command: 'help' });
    expect(parseArgs(argv('-h'))).toEqual({ command: 'help' });
  });
});
