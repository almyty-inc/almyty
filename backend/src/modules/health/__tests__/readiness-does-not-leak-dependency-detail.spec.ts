import { Test } from '@nestjs/testing';
import { ServiceUnavailableException } from '@nestjs/common';
import { HealthCheckService, TypeOrmHealthIndicator, MemoryHealthIndicator } from '@nestjs/terminus';
import { HealthController } from '../health.controller';
import { HealthService } from '../health.service';

/**
 * /health/ready is reachable from the internet without a credential
 * (it is the k8s readiness probe, and it carries @SkipThrottle).
 *
 * Terminus serialises a failing indicator's error message into the
 * response body. A TypeORM ping failure carries the driver's own
 * string, which names the database host -- on a managed provider that
 * hostname also encodes the account id. The same leak was already
 * closed on GET /health; this is its sibling, left open.
 *
 * Kubernetes probes read the STATUS CODE and ignore the body, so
 * trimming the body costs the probe nothing. Operators who want the
 * breakdown use the token-gated /monitoring/health/details.
 */
describe('GET /health/ready does not disclose dependency detail', () => {
  const leakyFailure = () =>
    new ServiceUnavailableException({
      status: 'error',
      info: {},
      error: {
        database: {
          status: 'down',
          message:
            'getaddrinfo ENOTFOUND almyty-db-do-user-4417723-0.b.db.ondigitalocean.com',
        },
      },
      details: {
        database: {
          status: 'down',
          message:
            'getaddrinfo ENOTFOUND almyty-db-do-user-4417723-0.b.db.ondigitalocean.com',
        },
      },
    });

  async function controllerWith(check: () => unknown) {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: HealthCheckService, useValue: { check } },
        { provide: TypeOrmHealthIndicator, useValue: { pingCheck: jest.fn() } },
        { provide: MemoryHealthIndicator, useValue: { checkHeap: jest.fn() } },
        { provide: HealthService, useValue: { isRedisHealthy: jest.fn() } },
      ],
    }).compile();
    return moduleRef.get(HealthController);
  }

  it('answers a healthy probe with nothing but the status', async () => {
    const controller = await controllerWith(async () => ({
      status: 'ok',
      info: { database: { status: 'up' } },
      error: {},
      details: { database: { status: 'up' }, redis: { status: 'up', message: 'PONG' } },
    }));

    await expect(controller.readiness()).resolves.toEqual({ status: 'ok' });
  });

  it('still answers 503 when a dependency is down', async () => {
    const controller = await controllerWith(async () => {
      throw leakyFailure();
    });

    await expect(controller.readiness()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('never puts the database hostname on the wire', async () => {
    const controller = await controllerWith(async () => {
      throw leakyFailure();
    });

    let body: unknown;
    try {
      await controller.readiness();
      throw new Error('readiness() resolved; it was supposed to reject');
    } catch (err) {
      body = (err as ServiceUnavailableException).getResponse();
    }

    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain('ondigitalocean.com');
    expect(serialised).not.toContain('ENOTFOUND');
    expect(serialised).not.toContain('database');
    expect(body).toEqual({ status: 'error' });
  });
});
