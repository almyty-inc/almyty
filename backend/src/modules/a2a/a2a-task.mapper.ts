import { AgentRun, AgentRunStatus } from '../../entities/agent-run.entity';
import { Message, MessageRole } from '../../entities/message.entity';
import type {
  Task,
  TaskStatus,
  TaskState,
  Part,
  Role,
  A2AMessage,
} from './types/a2a-spec.types';
import { textPart } from './types/a2a-spec.types';

/**
 * Map an AgentRunStatus to the corresponding A2A TaskState.
 *
 * A2A v1.0 carries the ProtoJSON encoding of the `TaskState` enum on every
 * binding, JSON-RPC included, hence the TASK_STATE_* values. (v0.2.x / v0.3.x
 * used lowercase kebab-case strings; see types/a2a-spec.types.ts.)
 */
export function mapRunStatusToTaskState(status: AgentRunStatus): TaskState {
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
 * Convert internal Message entities into A2A Task history.
 *
 * `Task.history` is a list of Messages — the conversation — not a list of
 * status snapshots.
 */
function messagesToHistory(
  messages: Message[],
  taskId: string,
  contextId?: string,
): A2AMessage[] {
  return messages.map((msg, index) => {
    const role: Role =
      msg.role === MessageRole.USER ? 'ROLE_USER' : 'ROLE_AGENT';

    const parts: Part[] = [];
    if (msg.content) {
      parts.push(textPart(msg.content));
    }

    return {
      messageId: msg.id || `${taskId}-msg-${index}`,
      role,
      parts,
      taskId,
      ...(contextId ? { contextId } : {}),
    };
  });
}

/**
 * Map an AgentRun (with associated messages) to an A2A Task.
 */
export function agentRunToTask(run: AgentRun, messages: Message[]): Task {
  const state = mapRunStatusToTaskState(run.status);

  // Prefer the external A2A contextId (set via SendMessage message.contextId)
  // over the internal conversationId so round-trip filtering works. Fall back
  // to the run id: TaskStatusUpdateEvent.contextId is required, so a Task
  // without one cannot produce a valid stream event.
  const contextId = run.metadata?.a2aContextId || run.conversationId || run.id;

  // Build the latest status message from the run's output or error
  const statusParts: Part[] = [];
  if (state === 'TASK_STATE_FAILED' && run.error) {
    statusParts.push(textPart(run.error));
  } else if (run.output) {
    const text =
      typeof run.output === 'string' ? run.output : JSON.stringify(run.output);
    statusParts.push(textPart(text));
  }

  const statusMessage: A2AMessage | undefined =
    statusParts.length > 0
      ? {
          messageId: `${run.id}-status`,
          role: 'ROLE_AGENT',
          parts: statusParts,
          taskId: run.id,
          contextId,
        }
      : undefined;

  const taskStatus: TaskStatus = {
    state,
    message: statusMessage,
    timestamp: run.updatedAt?.toISOString() || new Date().toISOString(),
  };

  const task: Task = {
    id: run.id,
    contextId,
    status: taskStatus,
    history: messagesToHistory(messages, run.id, contextId),
    metadata: {
      agentId: run.agentId,
      totalCost: run.totalCost,
      executionTime: run.executionTime,
    },
  };

  // If the run completed with output, surface it as an artifact
  if (state === 'TASK_STATE_COMPLETED' && run.output) {
    const outputText =
      typeof run.output === 'string' ? run.output : JSON.stringify(run.output);
    task.artifacts = [
      {
        artifactId: `${run.id}-result`,
        name: 'result',
        parts: [textPart(outputText)],
      },
    ];
  }

  return task;
}
