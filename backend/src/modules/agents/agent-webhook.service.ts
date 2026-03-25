import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

import { Agent } from '../../entities/agent.entity';
import { AgentExecution } from '../../entities/agent-execution.entity';

@Injectable()
export class AgentWebhookService {
  private readonly logger = new Logger(AgentWebhookService.name);

  async sendExecutionWebhook(agent: Agent, execution: AgentExecution): Promise<void> {
    const webhookUrl = agent.webhookUrl;
    if (!webhookUrl) return;

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
            output: execution.output,
            executionTime: execution.executionTime,
            totalCost: execution.totalCost,
            totalTokens: execution.totalTokens,
            error: execution.error,
          },
        },
        {
          timeout: 5000,
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
}
