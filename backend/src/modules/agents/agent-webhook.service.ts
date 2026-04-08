import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

import { Agent } from '../../entities/agent.entity';
import { AgentExecution } from '../../entities/agent-execution.entity';
import { validateUrl } from '../../common/security/url-validator';

/** Outbound webhook payload limits. */
const MAX_OUTPUT_BYTES = 100 * 1024; // 100 KB
const MAX_ERROR_BYTES = 1024;        // 1 KB
const MAX_REQUEST_BYTES = 1024 * 1024;  // 1 MB
const MAX_RESPONSE_BYTES = 16 * 1024;   // 16 KB — we don't need much from the receiver

@Injectable()
export class AgentWebhookService {
  private readonly logger = new Logger(AgentWebhookService.name);

  async sendExecutionWebhook(agent: Agent, execution: AgentExecution): Promise<void> {
    const webhookUrl = agent.webhookUrl;
    if (!webhookUrl) return;

    // SSRF guard. webhookUrl is user-controlled per agent and would otherwise
    // let any user point at 169.254.169.254, localhost:6379, etc., and have
    // the backend make the request on their behalf.
    const validation = validateUrl(webhookUrl);
    if (!validation.valid) {
      this.logger.warn(
        `Webhook blocked for execution ${execution.id}: ${validation.error}`,
      );
      return;
    }

    try {
      await axios.post(
        webhookUrl,
        {
          event: 'agent.execution.completed',
          timestamp: new Date().toISOString(),
          agent: { id: agent.id, name: agent.name },
          execution: {
            id: execution.id,
            status: execution.status,
            output: this.truncateForPayload(execution.output, MAX_OUTPUT_BYTES),
            executionTime: execution.executionTime,
            totalCost: execution.totalCost,
            totalTokens: execution.totalTokens,
            error: this.truncateString(execution.error, MAX_ERROR_BYTES),
          },
        },
        {
          timeout: 5000,
          maxContentLength: MAX_RESPONSE_BYTES,
          maxBodyLength: MAX_REQUEST_BYTES,
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'almyty-webhook/1.0',
          },
        },
      );
      this.logger.log(`Webhook sent for execution ${execution.id} to ${webhookUrl}`);
    } catch (err: any) {
      this.logger.warn(`Webhook failed for execution ${execution.id}: ${err.message}`);
      // Don't throw — webhook failure shouldn't fail the execution
    }
  }

  /**
   * Truncate a value for inclusion in the outbound payload. Strings get a
   * size cap with a "(truncated)" suffix; objects get JSON-stringified and
   * truncated the same way (the receiver still gets a string, which is the
   * common contract for webhooks rendering output in dashboards/logs).
   */
  private truncateForPayload(value: any, maxBytes: number): any {
    if (value == null) return value;
    if (typeof value === 'string') return this.truncateString(value, maxBytes);
    try {
      return this.truncateString(JSON.stringify(value), maxBytes);
    } catch {
      return '[unserialisable]';
    }
  }

  private truncateString(value: string | null | undefined, maxBytes: number): string | null | undefined {
    if (value == null) return value;
    if (value.length <= maxBytes) return value;
    return `${value.slice(0, maxBytes)}… (truncated, ${value.length} chars total)`;
  }
}
