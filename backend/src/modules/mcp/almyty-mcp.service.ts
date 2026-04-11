/**
 * DEPRECATED — replaced by the system gateway approach.
 *
 * Management tools are now real Tool rows (isSystemTool=true) served
 * through the standard gateway MCP infrastructure. See:
 *   - backend/src/modules/gateways/system-gateway.service.ts (provisioning)
 *   - backend/src/modules/tools/executors/system-tool.executor.ts (execution)
 *
 * This file is kept as a no-op stub so existing imports don't break
 * during the transition. It will be removed in a follow-up cleanup.
 */
import { Injectable } from '@nestjs/common';

@Injectable()
export class AlmytyMcpService {
  // No-op — the system gateway serves management tools now.
}
