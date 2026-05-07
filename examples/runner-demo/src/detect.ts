import { spawn } from 'node:child_process';

/**
 * Detect which agent CLIs the local machine has installed. Same
 * probe logic the runner uses (binary --version with a short
 * timeout); duplicated here so the demo entrypoint doesn't need
 * to spin up a runner connection just to discover what's local.
 */
const CLIS = ['claude', 'codex', 'gemini', 'aider'];

export async function detectInstalledClis(): Promise<Record<string, string | null>> {
  const entries = await Promise.all(CLIS.map(async name => {
    const v = await probe(name);
    return [name, v] as const;
  }));
  return Object.fromEntries(entries);
}

function probe(bin: string): Promise<string | null> {
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let timer: NodeJS.Timeout;
    let child;
    try {
      child = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve(null);
      return;
    }
    child.stdout?.on('data', d => { stdout += d.toString(); });
    child.stderr?.on('data', d => { stderr += d.toString(); });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) {
        const out = (stdout || stderr).trim();
        const firstLine = out.split('\n')[0] || 'unknown';
        resolve(firstLine);
      } else if (code === 127) {
        resolve(null);
      } else {
        resolve(null);
      }
    });
    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* */ }
      resolve(null);
    }, 1500);
    timer.unref?.();
  });
}
