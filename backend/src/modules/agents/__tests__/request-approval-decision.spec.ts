import { readFileSync } from 'fs';
import { join } from 'path';

import { AgentRun, AgentRunStatus } from '../../../entities/agent-run.entity';
import { Message } from '../../../entities/message.entity';
import { fakeRepository } from '../../../test/fake-repository';
import { AgentRuntimeService } from '../agent-runtime.service';
import { AgentBuiltInToolsHelper } from '../agent-builtin-tools.helper';

/**
 * request_approval promises "on approval, this tool resolves with
 * { approved: true, decision_reason }", but the model only ever saw the
 * placeholder "Awaiting human approval": the approval did not even carry
 * the call's id, so nothing could be written back. Now the call id rides
 * along and the decision (approved or not, by whom, the note) replaces the
 * placeholder as the call's result.
 */
describe('request_approval: the decision reaches the model', () => {
  function runtimeWith(messages: ReturnType<typeof fakeRepository<Message>>, run: Partial<AgentRun>) {
    const runs = fakeRepository<AgentRun>({ seed: [run as AgentRun] });
    const users = { findOne: jest.fn(async () => ({ id: 'u-ana', firstName: 'Ana', lastName: 'Lind', email: 'ana@example.com' })) };
    (messages as any).manager = { getRepository: () => users };
    const svc: any = Object.create(AgentRuntimeService.prototype);
    Object.assign(svc, {
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
      runRepository: runs,
      messageRepository: messages,
      runtimeQueue: { add: jest.fn() },
      workspaceRepository: fakeRepository({ seed: [] }),
    });
    return { svc, runs, users };
  }

  const placeholder = () => {
    const msg = Message.createToolResultMessage('conv-1', 'tc-1', 'Awaiting human approval (id=a1). Run paused; will resume after approve/reject.');
    msg.runId = 'run-1';
    return msg;
  };

  it('replaces "Awaiting human approval" with who approved and their note, and resumes', async () => {
    const messages = fakeRepository<Message>({ make: () => new Message(), seed: [placeholder()], idPrefix: 'm' });
    const { svc, runs } = runtimeWith(messages, { id: 'run-1', conversationId: 'conv-1', status: AgentRunStatus.WAITING_APPROVAL });

    await svc.handleApprovalDecided({
      runId: 'run-1', status: 'approved', decidedBy: 'u-ana', decisionReason: 'Customer is on the gold plan', toolCallId: 'tc-1', payload: null,
    });

    const [result] = await messages.find({ where: { toolCallId: 'tc-1' } });
    expect(JSON.parse(result.content as string)).toEqual({
      approved: true,
      status: 'approved',
      decided_by: 'Ana Lind',
      decision_reason: 'Customer is on the gold plan',
    });
    expect((await runs.findOne({ where: { id: 'run-1' } }))!.status).toBe(AgentRunStatus.RUNNING);
  });

  it('records a rejection on the call too, so the conversation knows', async () => {
    const messages = fakeRepository<Message>({ make: () => new Message(), seed: [placeholder()], idPrefix: 'm' });
    const { svc, runs } = runtimeWith(messages, { id: 'run-1', conversationId: 'conv-1', status: AgentRunStatus.WAITING_APPROVAL });

    await svc.handleApprovalDecided({
      runId: 'run-1', status: 'rejected', decidedBy: 'u-ana', decisionReason: 'Too large', toolCallId: 'tc-1', payload: null,
    });

    const [result] = await messages.find({ where: { toolCallId: 'tc-1' } });
    expect(JSON.parse(result.content as string)).toMatchObject({ approved: false, decided_by: 'Ana Lind', decision_reason: 'Too large' });
    expect((await runs.findOne({ where: { id: 'run-1' } }))!.status).toBe(AgentRunStatus.CANCELLED);
  });

  it('the approval carries the call id it was asked from', async () => {
    const approvals = { create: jest.fn(async () => ({ id: 'a1' })) };
    const helper = new AgentBuiltInToolsHelper({} as any, {} as any, {} as any, approvals as any);
    const run: any = { id: 'run-1', organizationId: 'org-1', status: AgentRunStatus.RUNNING };

    await helper.executeBuiltInTool('request_approval', { reason: 'Refund 2,500', _toolCallId: 'tc-1' }, run, { id: 'agent-1', teamId: null } as any);

    expect(approvals.create).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-1', toolCallId: 'tc-1' }));
  });

  it('the step processor hands request_approval its call id', () => {
    const source = readFileSync(join(__dirname, '..', 'agent-step-processor.ts'), 'utf8');
    expect(source).toMatch(/toolCall\.name === 'request_approval'\s*\?\s*\{ \.\.\.\(toolCall\.parameters \|\| \{\}\), _toolCallId: toolCall\.id \}/);
  });
});
