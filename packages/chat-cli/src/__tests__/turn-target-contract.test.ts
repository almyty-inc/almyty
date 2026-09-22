/**
 * TurnTarget must be satisfiable by the GatewayClient in this repo.
 *
 * chat-cli declares the slice of the gateway a turn needs as `TurnTarget`
 * and hands a real `GatewayClient` to `runTurn`. Nothing in this package's
 * own test run notices when the two drift: vitest transpiles with esbuild,
 * which strips types without checking them, and `tsc` resolves
 * `@almyty/client` to the last tarball PUBLISHED to npm rather than to the
 * sibling in this tree. That is exactly how #657 happened -- `streamInvoke`
 * was added to GatewayClient two months after @almyty/client@1.2.0 shipped,
 * so chat-cli's build could not typecheck against the registry copy however
 * correct the source was, and CI disabled the build step instead.
 * `cancelExecution` then repeated the pattern.
 *
 * So assert the contract against the sibling's SOURCE, which is always the
 * tree under test. A method added to TurnTarget with no counterpart on
 * GatewayClient fails here, in the package that made the promise, on the
 * commit that made it -- with no publish and no typechecker involved.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const turnSource = readFileSync(new URL('../turn.ts', import.meta.url), 'utf-8');
const clientSource = readFileSync(
  new URL('../../../client/src/client.ts', import.meta.url),
  'utf-8',
);

/** The lines inside the `{ ... }` block whose opening line matches `opener`. */
function blockLines(source: string, opener: RegExp): string[] {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => opener.test(line));
  if (start === -1) throw new Error(`no line matching ${opener} found`);
  const end = lines.findIndex((line, i) => i > start && line === '}');
  if (end === -1) throw new Error(`block opened by ${opener} is never closed`);
  return lines.slice(start + 1, end);
}

/**
 * Member names declared at the block's own indentation (two spaces).
 * Statements nested inside a method body are indented further, so this
 * sees class methods and interface members and nothing else.
 */
function memberMethods(lines: string[]): string[] {
  const names = new Set<string>();
  for (const line of lines) {
    const match = /^ {2}(?:async )?([A-Za-z_$][\w$]*)\s*[(<]/.exec(line);
    if (match && match[1] !== 'constructor') names.add(match[1]);
  }
  return [...names];
}

const required = memberMethods(blockLines(turnSource, /^export interface TurnTarget\s*\{/));
const provided = memberMethods(blockLines(clientSource, /^export class GatewayClient\s*\{/));

describe('TurnTarget / GatewayClient contract', () => {
  it('parses both declarations', () => {
    // A rename or a reformat that silently emptied either list would turn
    // the real check below into a vacuous pass.
    expect(required.length).toBeGreaterThanOrEqual(5);
    expect(provided.length).toBeGreaterThanOrEqual(10);
  });

  it('covers the methods runTurn actually calls', () => {
    expect(required).toEqual(
      expect.arrayContaining([
        'startRun',
        'streamRun',
        'streamInvoke',
        'invoke',
        'cancelRun',
        'cancelExecution',
      ]),
    );
  });

  it.each(required)('GatewayClient implements %s', (name) => {
    expect(provided).toContain(name);
  });
});
