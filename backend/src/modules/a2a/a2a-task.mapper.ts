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
  // A2A v1.0 uses TASK_STATE_* enum values
  switch (status) {
    case AgentRunStatus.PENDING:
      return 'TASK_STATE_SUBMITTED';
    case AgentRunStatus.RUNNING:
      return 'TASK_STATE_WORKING';
    case AgentRunStatus.WAITING_INPUT:
      return 'TASK_STATE_INPUT_REQUIRED';
    case AgentRunStatus.COMPLETED:
      return 'TASK_STATE_COMPLETED';
    case AgentRunStatus.FAILED:
      return 'TASK_STATE_FAILED';
    case AgentRunStatus.CANCELLED:
      return 'TASK_STATE_CANCELED';
    case AgentRunStatus.TIMEOUT:
      return 'TASK_STATE_FAILED';
    case AgentRunStatus.SLEEPING:
      return 'TASK_STATE_WORKING';
    default:
      return 'TASK_STATE_WORKING';
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
      state: 'TASK_STATE_COMPLETED' as TaskStatus,
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
  if (state === 'TASK_STATE_FAILED' && run.error) {
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
  if (state === 'TASK_STATE_COMPLETED' && run.output) {
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
