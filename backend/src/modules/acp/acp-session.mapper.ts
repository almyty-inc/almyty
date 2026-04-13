import { AgentRun, AgentRunStatus } from '../../entities/agent-run.entity';
import { Message, MessageRole } from '../../entities/message.entity';
import type {
  SessionUpdate,
  SessionStatus,
  SessionState,
  Part,
  AcpMessage,
} from './types/acp.types';

/**
 * Map an AgentRunStatus to the corresponding ACP SessionStatus.
 */
export function mapRunStatusToSessionStatus(status: AgentRunStatus): SessionStatus {
  switch (status) {
    case AgentRunStatus.PENDING:
      return 'created';
    case AgentRunStatus.RUNNING:
      return 'active';
    case AgentRunStatus.WAITING_INPUT:
      return 'input-required';
    case AgentRunStatus.COMPLETED:
      return 'completed';
    case AgentRunStatus.FAILED:
      return 'failed';
    case AgentRunStatus.CANCELLED:
      return 'canceled';
    case AgentRunStatus.TIMEOUT:
      return 'failed';
    case AgentRunStatus.SLEEPING:
      return 'active';
    default:
      return 'active';
  }
}

/**
 * Convert internal Message entities into ACP history SessionState entries.
 */
function messagesToHistory(messages: Message[]): SessionState[] {
  return messages.map((msg) => {
    const role: 'user' | 'agent' =
      msg.role === MessageRole.USER ? 'user' : 'agent';

    const parts: Part[] = [];
    if (msg.content) {
      parts.push({ type: 'text', text: msg.content });
    }

    const acpMsg: AcpMessage = { role, parts };

    return {
      status: 'completed' as SessionStatus,
      message: acpMsg,
      timestamp: msg.createdAt?.toISOString(),
    };
  });
}

/**
 * Map an AgentRun (with associated messages) to an ACP SessionUpdate.
 */
export function agentRunToSessionUpdate(run: AgentRun, messages: Message[]): SessionUpdate {
  const sessionStatus = mapRunStatusToSessionStatus(run.status);

  // Build the latest status message from the run's output or error
  const statusParts: Part[] = [];
  if (sessionStatus === 'failed' && run.error) {
    statusParts.push({ type: 'text', text: run.error });
  } else if (run.output) {
    const text = typeof run.output === 'string' ? run.output : JSON.stringify(run.output);
    statusParts.push({ type: 'text', text });
  }

  const statusMessage: AcpMessage | undefined = statusParts.length > 0
    ? { role: 'agent', parts: statusParts }
    : undefined;

  const state: SessionState = {
    status: sessionStatus,
    message: statusMessage,
    timestamp: run.updatedAt?.toISOString() || new Date().toISOString(),
  };

  const update: SessionUpdate = {
    sessionId: run.id,
    status: state,
    metadata: {
      agentId: run.agentId,
      contextId: run.conversationId || undefined,
      totalCost: run.totalCost,
      executionTime: run.executionTime,
      history: messagesToHistory(messages),
    },
  };

  // If the run completed with output, surface it as an artifact
  if (sessionStatus === 'completed' && run.output) {
    const outputText = typeof run.output === 'string' ? run.output : JSON.stringify(run.output);
    update.artifacts = [
      {
        name: 'result',
        parts: [{ type: 'text', text: outputText }],
        lastChunk: true,
      },
    ];
  }

  return update;
}
