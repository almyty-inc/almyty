import { Injectable } from '@nestjs/common';
import { HealthIndicator, HealthIndicatorResult, HealthCheckError } from '@nestjs/terminus';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';

@Injectable()
export class HealthService extends HealthIndicator {
  constructor(@InjectRedis() private readonly redis: Redis) {
    super();
  }

  async isRedisHealthy(key: string): Promise<HealthIndicatorResult> {
    try {
      const result = await this.redis.ping();
      const isHealthy = result === 'PONG';

      const data = this.getStatus(key, isHealthy, { message: result });

      if (isHealthy) {
        return data;
      }

      throw new HealthCheckError('Redis check failed', data);
    } catch (error) {
      if (error instanceof HealthCheckError) {
        throw error;
      }
      throw new HealthCheckError(
        'Redis check failed',
        this.getStatus(key, false, { message: error.message }),
      );
    }
  }
}
