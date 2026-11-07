import { ValidationPipeOptions } from '@nestjs/common';

/**
 * The options of the application's global ValidationPipe (main.ts).
 *
 * One constant, because two callers validate request DTOs: the HTTP
 * pipeline, and the management MCP, which runs a route's handler for an
 * MCP caller (mcp/management/route-invoker.service.ts). If they differed,
 * a field the dashboard refuses could pass over MCP.
 */
export const GLOBAL_VALIDATION_OPTIONS: ValidationPipeOptions = {
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: {
    enableImplicitConversion: false, // Disabled for performance - use explicit @Type() decorators
  },
};
