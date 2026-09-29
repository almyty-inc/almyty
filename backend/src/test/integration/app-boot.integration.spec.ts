import 'reflect-metadata';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../app.module';

/**
 * The container must actually build.
 *
 * The topology smoke test compares module names, and the image build only
 * requires the module file, so neither noticed when a global enterprise
 * module imported a module inside the providers/tools/agents forwardRef
 * cycle: every unit suite stayed green, the image built, and the pod then
 * hung forever half way through instantiating modules, with no error to
 * read. This boots the real graph, enterprise modules included, and fails
 * loudly instead of hanging.
 */
const run = process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;

const BOOT_BUDGET_MS = 90_000;

/** Sockets this process still holds (Postgres, Redis, anything else). */
function openSockets(): number {
  return process.getActiveResourcesInfo().filter((r) => r === 'TCPSocketWrap' || r === 'TCPWRAP').length;
}

async function settled(expected: number, withinMs: number): Promise<number> {
  const deadline = Date.now() + withinMs;
  while (openSockets() > expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return openSockets();
}

run('the application graph instantiates (real Postgres + Redis)', () => {
  jest.setTimeout(120_000);

  it('creates every module without deadlocking, and closing it lets the process exit', async () => {
    const socketsBefore = openSockets();

    // A deadlocked graph never settles; fail with a reason instead of
    // running into the jest timeout with the process pinned open.
    let timer: NodeJS.Timeout | undefined;
    const moduleRef = await Promise.race([
      Test.createTestingModule({ imports: [AppModule] }).compile(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`AppModule did not finish instantiating within ${BOOT_BUDGET_MS / 1000}s`)),
          BOOT_BUDGET_MS,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    expect(moduleRef).toBeDefined();

    await moduleRef.close();

    // Everything the graph opened is closed with it. A provider that opens
    // a connection and never closes it passed this spec before -- and then
    // jest sat there for good, which is what "the boot spec hangs" was.
    expect(await settled(socketsBefore, 5_000)).toBe(socketsBefore);
  });
});