import { spawn } from 'node:child_process';
import { execSync } from 'node:child_process';

import { SubagentRequest, SubagentResult } from './demo.js';

/**
 * Spawn an agent CLI with the prompt piped on stdin and capture
 * stdout. The exact flag set varies by CLI; we keep the matrix small
 * and tolerant — if a CLI evolves its flag surface, the demo just
 * shells out the prompt as a positional argument and lets the CLI
 * sort it out.
 *
 * After the subagent exits, snapshot which files in `cwd` changed
 * (via `git diff --name-only` against HEAD if the cwd is a git repo,
 * otherwise via mtime sweep before/after).
 */
export async function spawnSubagent(req: SubagentRequest): Promise<SubagentResult> {
  const before = snapshotMtimes(req.cwd);
  const args = buildArgs(req);
  const stdoutBuf: string[] = [];
  const stderrBuf: string[] = [];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(req.cli, args, {
      cwd: req.cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', d => stdoutBuf.push(d.toString()));
    child.stderr?.on('data', d => stderrBuf.push(d.toString()));
    child.on('error', reject);
    child.on('close', () => resolve());
    // Pass the prompt on stdin so we don't blow past argv length
    // limits on long plans/contexts.
    child.stdin?.write(req.prompt);
    child.stdin?.end();
  });

  const output = (stdoutBuf.join('') + (stderrBuf.length ? `\n[stderr]\n${stderrBuf.join('')}` : '')).trim();
  const after = snapshotMtimes(req.cwd);
  const filesModified = diffMtimes(before, after);
  return { output, filesModified };
}

function buildArgs(req: SubagentRequest): string[] {
  // Best-effort flag mapping; reading from stdin is the universal
  // fallback every CLI in the list supports.
  switch (req.cli) {
    case 'claude': return req.model ? ['--model', req.model] : [];
    case 'codex':  return req.model ? ['--model', req.model] : [];
    case 'gemini': return req.model ? ['--model', req.model] : [];
    case 'aider':  return ['--no-auto-commits'];
    default:       return [];
  }
}

function snapshotMtimes(cwd: string): Record<string, number> {
  // Use `find` if available; fast and respects cwd. Falls back to
  // empty object if find isn't on PATH (the diff just won't find
  // files, the orchestrator still works).
  try {
    const out = execSync('find . -type f -not -path "./node_modules/*" -not -path "./.git/*" -printf "%p %T@\\n"', { cwd, encoding: 'utf-8' });
    const map: Record<string, number> = {};
    for (const line of out.split('\n')) {
      if (!line) continue;
      const sp = line.lastIndexOf(' ');
      if (sp < 0) continue;
      const path = line.slice(0, sp);
      const ts = Number(line.slice(sp + 1));
      map[path] = ts;
    }
    return map;
  } catch {
    return {};
  }
}

function diffMtimes(before: Record<string, number>, after: Record<string, number>): string[] {
  const changed: string[] = [];
  for (const [path, ts] of Object.entries(after)) {
    if (before[path] === undefined || before[path] !== ts) changed.push(path);
  }
  return changed;
}
