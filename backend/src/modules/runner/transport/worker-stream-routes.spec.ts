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
});
