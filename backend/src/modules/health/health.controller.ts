import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import {
  HealthCheck,
  HealthCheckService,
  TypeOrmHealthIndicator,
  MemoryHealthIndicator,
} from '@nestjs/terminus';
import { HealthService } from './health.service';

@Controller('health')
@SkipThrottle()
export class HealthController {
  constructor(
    private health: HealthCheckService,
    private db: TypeOrmHealthIndicator,
    private memory: MemoryHealthIndicator,
    private healthService: HealthService,
  ) {}

  /**
   * Minimal public health endpoint. Returns `{status: "ok"}` on
   * a 200 — no component breakdown, no dependency detail, no
   * error-payload leak. External dashboards and uptime checkers
   * that just need a "is it alive" signal use this; anything
   * that needs actual diagnostics should use the token-gated
   * /monitoring/health/details endpoint.
   *
   * Previously this returned the full Terminus check result
   * (DB + Redis + memory), which on failure serialised the
   * underlying connection error string — including the database
   * hostname, port, and sometimes a fragment of the connection
   * string. Anyone on the internet could poll it during a
   * deploy to enumerate the platform's dependencies. The new
   * shape hands out nothing beyond "alive".
   */
  @Get()
  check() {
    return { status: 'ok' };
  }

  /**
   * Liveness probe — simple uptime, no dependency checks
   * Used by: Kubernetes liveness probe
   * If this fails, k8s restarts the pod
   *
   * Threshold is set near the Node heap ceiling (NODE_OPTIONS pins
   * --max-old-space-size=3500). The previous 500 MB threshold was
   * a foot-cannon: any heavy-but-legitimate work (real-world OpenAPI
   * import — 7.7 MB Stripe spec, AWS-class spec, etc.) routinely
   * pushed heap past 500 MB, the liveness probe failed, and k8s
   * killed the worker mid-import. The job then "stalled" in BullMQ
   * because the worker was getting restarted, not because it was
   * actually wedged.
   *
   * 3.4 GB leaves a small margin under the 3500 MB heap ceiling so
   * we still catch a genuine runaway leak before V8 itself OOMs,
   * but we don't kill the pod for doing the work it was sized to do.
   */
  @Get('live')
  @HealthCheck()
  liveness() {
    return this.health.check([
      () => this.memory.checkHeap('memory_heap', 3400 * 1024 * 1024),
    ]);
  }

  /**
   * Readiness probe — DB + Redis must be reachable.
   * Used by: Kubernetes readiness probe.
   * If this fails, k8s removes the pod from service endpoints.
   *
   * The body is deliberately just the status. This endpoint is
   * reachable from the internet without a credential and carries
   * @SkipThrottle, and Terminus serialises a failing indicator's
   * error message into the response — for a TypeORM ping that is the
   * driver's own string, which names the database host. On a managed
   * provider that hostname also encodes the account id, so a passer-by
   * polling during an incident learns where the data lives.
   *
   * GET /health above was already trimmed for exactly this reason;
   * this is its sibling, and it was missed. Kubernetes probes read the
   * status code and ignore the body, so the probe loses nothing.
   * Operators who need the per-indicator breakdown use the token-gated
   * /monitoring/health/details.
   */
  @Get('ready')
  @HealthCheck()
  async readiness() {
    try {
      await this.health.check([
        () => this.db.pingCheck('database'),
        () => this.healthService.isRedisHealthy('redis'),
      ]);
      return { status: 'ok' };
    } catch {
      // Same 503 Terminus would have thrown, carrying no detail.
      throw new ServiceUnavailableException({ status: 'error' });
    }
  }
}
