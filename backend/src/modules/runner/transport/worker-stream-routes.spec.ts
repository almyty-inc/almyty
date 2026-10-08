import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { RunnerModule } from '../runner.module';
import { RunnerController } from '../runner.controller';
import { RunnerService } from '../runner.service';
import { RunnerCallService } from '../runner-call.service';
import { CodingRelayService } from '../coding-relay.service';
import { WorkerStreamController } from './worker-stream.controller';
import { WorkerStreamTransport } from './worker-stream.transport';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { listenOnLoopback } from '../../../test/http';
import { RunnerCredentialGuard } from '../runner-credential';

const HOSTED_RUNNER_ID = '6f1c2a3b-4d5e-4f60-8a9b-0c1d2e3f4a5b';

/**
 * GET /runners/stream must reach the worker stream. RunnerController owns
 * GET /runners/:runnerId with a UUID pipe, and Express matches routes in
 * registration order: registered after it, the stream route answered 400
 * "uuid is expected" to every runner (found by a real runner against a
 * running API, not by a unit test).
 */
describe('worker stream routes', () => {
  let app: INestApplication;
  const stream = {
    handlePost: jest.fn((_req, res) => res.status(202).end()),
    handleStream: jest.fn((_req, res) => res.status(200).json({ reached: 'stream' })),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      // The controllers in the order the module registers them.
      controllers: Reflect.getMetadata('controllers', RunnerModule),
      providers: [
        { provide: WorkerStreamTransport, useValue: stream },
        { provide: RunnerService, useValue: {} },
        { provide: RunnerCallService, useValue: {} },
        { provide: CodingRelayService, useValue: {} },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: any) => {
          ctx.switchToHttp().getRequest().user = { id: 'u-1', currentOrganizationId: 'org-1' };
          return true;
        },
      })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RunnerCredentialGuard)
      .useValue({
        canActivate: (ctx: any) => {
          ctx.switchToHttp().getRequest().runnerCredential = {
            runnerId: HOSTED_RUNNER_ID,
            organizationId: 'org-hosted',
            hostedRunnerId: 'hr-1',
            actUserId: 'u-1',
          };
          return true;
        },
      })
      .compile();
    app = await listenOnLoopback(moduleRef.createNestApplication());
  });

  afterAll(async () => {
    await app.close();
  });

  it('registers the worker stream before the runner routes', () => {
    const controllers: unknown[] = Reflect.getMetadata('controllers', RunnerModule);
    expect(controllers.indexOf(WorkerStreamController)).toBeLessThan(controllers.indexOf(RunnerController));
  });

  it.each(['/runners/stream', '/mcp/streamable'])('GET %s reaches the worker stream', async (path) => {
    const res = await request(app.getHttpServer()).get(path).expect(200);
    expect(res.body).toEqual({ reached: 'stream' });
  });

  it.each(['/runners/stream', '/mcp/streamable'])('POST %s reaches the worker stream', async (path) => {
    await request(app.getHttpServer()).post(path).send({ v: 1 }).expect(202);
  });

  // A hosted runner's stream: the session belongs to its runner credential,
  // known as `runner:<id>`, in the credential's organization -- never to a
  // person.
  it('POST /runners/hosted/stream reaches the worker stream as the runner credential', async () => {
    stream.handlePost.mockClear();
    await request(app.getHttpServer()).post('/runners/hosted/stream').send({ v: 1 }).expect(202);
    const [, , organizationId, userId] = stream.handlePost.mock.calls[0] as unknown as [unknown, unknown, string, string];
    expect(organizationId).toBe('org-hosted');
    expect(userId).toBe(`runner:${HOSTED_RUNNER_ID}`);
  });

  it('GET /runners/hosted/stream reaches the worker stream as the runner credential', async () => {
    stream.handleStream.mockClear();
    await request(app.getHttpServer()).get('/runners/hosted/stream').expect(200);
    const [, , organizationId, userId] = stream.handleStream.mock.calls[0] as unknown as [unknown, unknown, string, string];
    expect(organizationId).toBe('org-hosted');
    expect(userId).toBe(`runner:${HOSTED_RUNNER_ID}`);
  });

  it('guards the hosted routes with the runner credential and nothing else', () => {
    for (const handler of ['hostedPost', 'hostedOpen'] as const) {
      const guards = Reflect.getMetadata('__guards__', WorkerStreamController.prototype[handler]);
      expect(guards).toEqual([RunnerCredentialGuard]);
    }
  });
});
