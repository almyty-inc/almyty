import { Controller, Get } from '@nestjs/common';
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
   */
  @Get('live')
  @HealthCheck()
  liveness() {
    return this.health.check([
      () => this.memory.checkHeap('memory_heap', 500 * 1024 * 1024), // 500MB
    ]);
  }

  /**
   * Readiness probe — DB + Redis must be reachable
   * Used by: Kubernetes readiness probe
   * If this fails, k8s removes pod from service endpoints
   */
  @Get('ready')
  @HealthCheck()
  readiness() {
    return this.health.check([
      () => this.db.pingCheck('database'),
      () => this.healthService.isRedisHealthy('redis'),
    ]);
  }
}
