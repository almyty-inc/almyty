import { ChildProcess, execFileSync, spawn } from 'child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

/**
 * `scripts/dev-stack.sh down` killed whatever its pid files named. A pid
 * file left from an earlier stack pointed at a pid the system had since
 * given to another process, and `down` killed that process. It now stops a
 * pid only while it is the one the stack started: same start time, and
 * running from this checkout's backend/ or frontend/.
 */
const ROOT = resolve(__dirname, '../../../..');
const SCRIPT = join(ROOT, 'scripts', 'dev-stack.sh');
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
  new Promise<void>(done => (child.exitCode !== null || child.signalCode !== null ? done() : child.once('exit', () => done())));

describe('dev-stack.sh down', () => {
  let logDir: string;
  let bin: string;
  const children: ChildProcess[] = [];

  beforeEach(() => {
    logDir = mkdtempSync(join(tmpdir(), 'dev-stack-'));
    // docker is not what is under test: a stand-in that does nothing.
    bin = mkdtempSync(join(tmpdir(), 'dev-stack-bin-'));
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
  const writePid = (name: string, line: string) => writeFileSync(join(logDir, `${name}.pid`), `${line}\n`);
  const down = () =>
    execFileSync('bash', [SCRIPT, 'down'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        LOG_DIR: logDir,
        // The port look reads every process on the host; what is under test is the pid files.
        PORT_SWEEP: '0',
        API_PORT: '1',
        WEB_PORT: '2',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

  it('stops the process it started', async () => {
    const child = sleeper(join(ROOT, 'backend'));
    writePid('backend', `${child.pid}\t${started(child.pid!)}\t${execFileSync('pwd', ['-P'], { cwd: join(ROOT, 'backend'), encoding: 'utf8' }).trim()}`);

    down();

    await exited(child);
    expect(alive(child.pid!)).toBe(false);
    expect(existsSync(join(logDir, 'backend.pid'))).toBe(false);
  });

  it('leaves alone a pid that was reused by another process', () => {
    const other = sleeper(tmpdir());
    // The pid file of a stack long gone: the same pid, an earlier start.
    writePid('backend', `${other.pid}\tThu Jan  1 00:00:00 2026\t${join(ROOT, 'backend')}`);

    down();

    expect(alive(other.pid!)).toBe(true);
    expect(existsSync(join(logDir, 'backend.pid'))).toBe(false);
  });

  it('leaves alone a process that runs from somewhere else, and an old pid-only file', () => {
    const other = sleeper(tmpdir());
    writePid('frontend', `${other.pid}\t${started(other.pid!)}\t${join(ROOT, 'frontend')}`);
    const legacy = sleeper(tmpdir());
    writePid('backend', String(legacy.pid));

    down();

    expect(alive(other.pid!)).toBe(true);
    expect(alive(legacy.pid!)).toBe(true);
  });
});
