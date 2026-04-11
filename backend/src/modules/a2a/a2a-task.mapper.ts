import { AgentRun, AgentRunStatus } from '../../entities/agent-run.entity';
import { Message, MessageRole } from '../../entities/message.entity';
import type {
  Task,
  TaskStatus,
  TaskState,
  Part,
  A2AMessage,
} from './types/a2a-spec.types';

/**
 * Map an AgentRunStatus to the corresponding A2A TaskStatus.
 */
export function mapRunStatusToTaskState(status: AgentRunStatus): TaskStatus {
  switch (status) {
    case AgentRunStatus.PENDING:
      return 'submitted';
    case AgentRunStatus.RUNNING:
      return 'working';
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
      return 'working';
    default:
      return 'working';
  }
}

/**
 * Convert internal Message entities into A2A history TaskState entries.
 */
function messagesToHistory(messages: Message[]): TaskState[] {
  return messages.map((msg) => {
    const role: 'user' | 'agent' =
      msg.role === MessageRole.USER ? 'user' : 'agent';

    const parts: Part[] = [];
    if (msg.content) {
      parts.push({ type: 'text', text: msg.content });
    }

    const a2aMsg: A2AMessage = { role, parts };

    return {
      state: 'completed' as TaskStatus,
      message: a2aMsg,
      timestamp: msg.createdAt?.toISOString(),
    };
  });
}

/**
 * Map an AgentRun (with associated messages) to an A2A Task.
 */
export function agentRunToTask(run: AgentRun, messages: Message[]): Task {
  const state = mapRunStatusToTaskState(run.status);

  // Build the latest status message from the run's output or error
  const statusParts: Part[] = [];
  if (state === 'failed' && run.error) {
    statusParts.push({ type: 'text', text: run.error });
  } else if (run.output) {
    const text = typeof run.output === 'string' ? run.output : JSON.stringify(run.output);
    statusParts.push({ type: 'text', text });
  }

  const statusMessage: A2AMessage | undefined = statusParts.length > 0
    ? { role: 'agent', parts: statusParts }
    : undefined;

  const taskState: TaskState = {
    state,
    message: statusMessage,
    timestamp: run.updatedAt?.toISOString() || new Date().toISOString(),
  };

  const task: Task = {
    id: run.id,
    contextId: run.conversationId || undefined,
    status: taskState,
    history: messagesToHistory(messages),
    metadata: {
      agentId: run.agentId,
      totalCost: run.totalCost,
      executionTime: run.executionTime,
    },
  };

  // If the run completed with output, surface it as an artifact
  if (state === 'completed' && run.output) {
    const outputText = typeof run.output === 'string' ? run.output : JSON.stringify(run.output);
    task.artifacts = [
      {
        name: 'result',
        parts: [{ type: 'text', text: outputText }],
        lastChunk: true,
      },
    ];
  }

  return task;
}
