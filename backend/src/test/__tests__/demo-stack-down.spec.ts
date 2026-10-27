import { ChildProcess, execFileSync, spawn } from 'child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

/**
 * `scripts/demo-seed/stack.sh down` killed whatever its pid files named,
 * and left the BACKEND_EE API (node dist-ee/src/main) running: nothing
 * recorded that process, so nothing stopped it. It now stops a pid only
 * while it is the one the stack started (same start time, same directory),
 * and afterwards stops what still listens on the stack's ports only when
 * it runs from this checkout.
 */
const ROOT = resolve(__dirname, '../../../..');
const SCRIPT = join(ROOT, 'scripts', 'demo-seed', 'stack.sh');
const HERE = join(ROOT, 'scripts', 'demo-seed');
const physical = (dir: string) => execFileSync('pwd', ['-P'], { cwd: dir, encoding: 'utf8' }).trim();
const started = (pid: number) => execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim();
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const exited = (child: ChildProcess) =>
  new Promise<void>((done) => (child.exitCode !== null || child.signalCode !== null ? done() : child.once('exit', () => done())));

describe('demo-seed stack.sh down', () => {
  jest.setTimeout(90_000);
  let logDir: string;
  let bin: string;
  const children: ChildProcess[] = [];

  beforeEach(() => {
    logDir = mkdtempSync(join(tmpdir(), 'demo-stack-'));
    // docker is not what is under test: a stand-in that does nothing.
    bin = mkdtempSync(join(tmpdir(), 'demo-stack-bin-'));
    writeFileSync(join(bin, 'docker'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, 'docker'), 0o755);
  });

  afterEach(() => {
    for (const child of children.splice(0)) if (child.pid && alive(child.pid)) child.kill('SIGKILL');
    rmSync(logDir, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  });

  const sleeper = (cwd: string) => {
    const child = spawn('sleep', ['300'], { cwd, stdio: 'ignore' });
    children.push(child);
    return child;
  };
  /** A process listening on a free port, started in `cwd`; resolves with its port. */
  const listener = (cwd: string) =>
    new Promise<{ child: ChildProcess; port: number }>((done, fail) => {
      const child = spawn(process.execPath, ['-e', "const s=require('http').createServer().listen(0,'127.0.0.1',()=>console.log(s.address().port))"], {
        cwd,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      children.push(child);
      child.stdout!.once('data', (b) => done({ child, port: Number(String(b).trim()) }));
      child.once('error', fail);
    });
  const writePid = (name: string, line: string) => writeFileSync(join(logDir, `${name}.pid`), `${line}\n`);
  const down = (env: Record<string, string> = {}) =>
    execFileSync('bash', [SCRIPT, 'down'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        LOG_DIR: logDir,
        PORT_SWEEP: '0',
        API_PORT: '1',
        WEB_PORT: '2',
        FAKE_PORT: '3',
        USECASE_PORT: '4',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

  it('stops the fake upstream it started', async () => {
    const child = sleeper(HERE);
    writePid('fake', `${child.pid}\t${started(child.pid!)}\t${physical(HERE)}`);
    down();
    await exited(child);
    expect(alive(child.pid!)).toBe(false);
    expect(existsSync(join(logDir, 'fake.pid'))).toBe(false);
  });

  it('leaves alone a reused pid and a pid-only file from before', () => {
    const reused = sleeper(tmpdir());
    writePid('fake', `${reused.pid}\tThu Jan  1 00:00:00 2026\t${physical(HERE)}`);
    const legacy = sleeper(tmpdir());
    writePid('usecase', String(legacy.pid));
    down();
    expect(alive(reused.pid!)).toBe(true);
    expect(alive(legacy.pid!)).toBe(true);
  });

  it("stops the API still listening on the stack's port when it runs from this checkout, and nothing else", async () => {
    const api = await listener(join(ROOT, 'backend'));
    const stranger = await listener(tmpdir());
    down({ PORT_SWEEP: '1', API_PORT: String(api.port), WEB_PORT: String(stranger.port) });
    await exited(api.child);
    expect(alive(api.child.pid!)).toBe(false);
    expect(alive(stranger.child.pid!)).toBe(true);
  });
});
