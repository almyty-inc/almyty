import { AgentRunStatus } from '../../../../entities/agent-run.entity';
import { AuditAction } from '../../../../entities/audit-log.entity';
import { approvalActionData, approvalRef } from '../channel-approval';
import { AGENT, GW_SLACK, ORG, OWNER, SLACK, alwaysOnAgent, world } from './always-on.harness';

/**
 * Approve in chat (docs/always-on.md, "Approving from your channel"): a
 * held call is posted on the owner's channel with its preview and buttons;
 * the owner decides with a button or a "yes"/"no"; anyone else is refused;
 * the page and the chat race safely; every answer is in the audit log.
 */
const APPROVAL = 'a1b2c3d4-0000-4000-8000-000000000001';
const SECOND = 'e5f6a7b8-0000-4000-8000-000000000002';

type W = ReturnType<typeof world>;

function seedRun(w: W, id = 'run-1', patch: Record<string, any> = {}) {
  return w.runs.seed({
    id,
    agentId: AGENT,
    organizationId: ORG,
    userId: OWNER,
    status: AgentRunStatus.WAITING_APPROVAL,
    conversationId: 'conv-1',
    metadata: { triggerType: 'always_on' },
    steps: [],
    currentStep: 3,
    createdAt: new Date(),
    ...patch,
  });
}

function seedApproval(w: W, id = APPROVAL, patch: Record<string, any> = {}) {
  return w.approvalRows.seed({
    id,
    organizationId: ORG,
    agentId: AGENT,
    runId: 'run-1',
    reason: 'Ask before “issue_refund” (it is on the ask-first list).',
    payload: { tool: 'issue_refund', parameters: { order: 'NW-7', amount: 120 } },
    status: 'pending',
    createdAt: new Date(),
    ...patch,
  });
}

const press = (data: string, senderId = 'U-OWNER') => ({ organizationId: ORG, agentId: AGENT, gatewayId: GW_SLACK, senderId, data });

const inbound = (text: string, senderId = 'U-OWNER', extra: Record<string, any> = {}) => {
  const replies: string[] = [];
  return {
    replies,
    msg: {
      organizationId: ORG,
      agentId: AGENT,
      gatewayId: GW_SLACK,
      senderId,
      text,
      deliveryId: `d-${Math.random()}`,
      reply: async (t: string) => {
        replies.push(t);
      },
      ...extra,
    },
  };
};

const channelAudits = (w: W) => w.audited.filter((a) => a.action === AuditAction.CHANNEL_APPROVAL);

async function settle() {
  await new Promise((r) => setTimeout(r, 10));
}

describe('Approve in chat: posting the request', () => {
  it('posts a held call on the owner\'s channel with the preview, the ref and Approve and Reject buttons', async () => {
    const w = world();
    await w.service.onModuleInit();
    seedRun(w);
    const row = seedApproval(w);
    w.approvals.emit('approval.requested', row);
    await settle();
    expect(w.posted).toHaveLength(1);
    const [post] = w.posted;
    expect(post.delivery).toMatchObject({ channelId: SLACK, to: 'U-OWNER' });
    expect(post.text).toContain('Support agent wants to do something and is waiting for your OK');
    expect(post.text).toContain('Tool: issue_refund\norder: NW-7\namount: 120');
    expect(post.text).toContain(`Reply yes to approve or no to reject (ref ${approvalRef(APPROVAL)})`);
    expect(post.text).not.toContain('Approve or reject it in Approvals.');
    expect(post.actions?.map((a) => a.label)).toEqual(['Approve', 'Reject']);
    expect(post.actions?.[0].id).toBe(approvalActionData(APPROVAL, 'approve'));
    w.service.onModuleDestroy();
  });

  it('posts a request of any run of the agent there, not only an always-on one', async () => {
    const w = world();
    await w.service.onModuleInit();
    seedRun(w, 'run-1', { metadata: { gatewayId: 'gw-visitor', threadId: 't' } });
    w.approvals.emit('approval.requested', seedApproval(w));
    await settle();
    expect(w.posted.map((p) => p.delivery.to)).toEqual(['U-OWNER']);
    w.service.onModuleDestroy();
  });

  it('posts nothing for a run that is not always on when the owner named no channel', async () => {
    const w = world({ agent: alwaysOnAgent({}, { ownerChannel: null }) });
    await w.service.onModuleInit();
    seedRun(w, 'run-1', { metadata: {} });
    w.approvals.emit('approval.requested', seedApproval(w));
    await settle();
    expect(w.posted).toHaveLength(0);
    w.service.onModuleDestroy();
  });

  it('keeps the preview and the buttons to the owner\'s own chat; a shared reports channel gets one line', async () => {
    const w = world({ agent: alwaysOnAgent({}, { reportTo: { kind: 'channel', channelId: SLACK, to: 'C-SALES' } }) });
    await w.users.update({ id: OWNER }, { firstName: 'Maya' });
    await w.service.onModuleInit();
    seedRun(w);
    const raw = Buffer.from('To: ana@example.com\r\nSubject: Refund\r\n\r\nYour refund of 120 is on its way.').toString('base64url');
    w.approvals.emit('approval.requested', seedApproval(w, APPROVAL, { payload: { tool: 'Send a message', parameters: { raw } } }));
    await settle();
    const [mine, shared] = w.posted;
    expect(mine.delivery.to).toBe('U-OWNER');
    expect(mine.text).toContain('Your refund of 120 is on its way.');
    expect(mine.actions).toHaveLength(2);
    expect(shared.delivery.to).toBe('C-SALES');
    expect(shared.text).toBe('Support agent is waiting for Maya\'s OK on an email. Approvals: https://app.almyty.com/approvals');
    expect(shared.text).not.toContain('ana@example.com');
    expect(shared.actions).toBeUndefined();
    w.service.onModuleDestroy();
  });

  it('posts once, in full, when the reports go to the owner\'s own chat', async () => {
    const w = world({ agent: alwaysOnAgent({}, { reportTo: { kind: 'channel', channelId: SLACK, to: 'U-OWNER' } }) });
    await w.service.onModuleInit();
    seedRun(w);
    w.approvals.emit('approval.requested', seedApproval(w));
    await settle();
    expect(w.posted).toHaveLength(1);
    expect(w.posted[0].actions).toHaveLength(2);
    w.service.onModuleDestroy();
  });
  it('goes to the direct conversation the owner last wrote from, once', async () => {
    const w = world();
    await w.service.onModuleInit();
    // The owner wrote from a DM: that conversation is remembered.
    await w.service.routeInbound({ ...inbound('status?').msg, conversation: { to: 'D-OWNER-DM' } });
    seedRun(w, 'run-1', { metadata: { triggerType: 'always_on', replyTo: [{ kind: 'channel', channelId: SLACK, to: 'D-OWNER-DM' }] } });
    w.approvals.emit('approval.requested', seedApproval(w));
    await settle();
    expect(w.posted.map((p) => p.delivery.to)).toEqual(['D-OWNER-DM']);
    w.service.onModuleDestroy();
  });
});

describe('Approve in chat: buttons', () => {
  it('lets the owner approve with a button, and records it with the channel and the identity', async () => {
    const w = world();
    seedApproval(w);
    const outcome = await w.service.decideFromChannel(press(approvalActionData(APPROVAL, 'approve')));
    expect(outcome).toEqual({ text: 'Approved. It carries on.', settled: true });
    expect(w.approvals.approve).toHaveBeenCalledWith(APPROVAL, expect.objectContaining({ decidedBy: OWNER }), { id: OWNER }, ORG);
    expect(w.approvalRows.row(APPROVAL)).toMatchObject({ status: 'approved', decidedBy: OWNER });
    expect(w.approvalRows.row(APPROVAL)!.decisionReason).toContain('Support Slack');
    const [audit] = channelAudits(w);
    expect(audit).toMatchObject({
      organizationId: ORG,
      userId: OWNER,
      resourceId: AGENT,
      details: { approvalId: APPROVAL, decision: 'approve', via: 'button', outcome: 'decided', channelId: SLACK, channelType: 'slack', identity: 'U-OWNER' },
    });
  });

  it('lets the owner reject with a button', async () => {
    const w = world();
    seedApproval(w);
    expect(await w.service.decideFromChannel(press(approvalActionData(APPROVAL, 'reject')))).toEqual({ text: 'Rejected. It will not do it.', settled: true });
    expect(w.approvalRows.row(APPROVAL)!.status).toBe('rejected');
  });

  it('refuses anyone but the owner, politely, decides nothing and records the attempt', async () => {
    const w = world();
    seedApproval(w);
    const outcome = await w.service.decideFromChannel(press(approvalActionData(APPROVAL, 'approve'), 'U-SOMEONE'));
    expect(outcome).toEqual({ text: 'Sorry, only the person this agent works for can approve or reject what it asks.', settled: false });
    expect(w.approvals.approve).not.toHaveBeenCalled();
    expect(w.approvalRows.row(APPROVAL)!.status).toBe('pending');
    expect(channelAudits(w)[0].details).toMatchObject({ outcome: 'refused', identity: 'U-SOMEONE', channelId: SLACK });
  });

  it('ignores a button whose data was not signed for it', async () => {
    const w = world();
    seedApproval(w);
    const forged = approvalActionData(APPROVAL, 'approve').replace(/:[0-9a-f]{16}$/, ':0000000000000000');
    expect(await w.service.decideFromChannel(press(forged))).toBeNull();
    expect(w.approvalRows.row(APPROVAL)!.status).toBe('pending');
  });

  it('does not decide another agent\'s request', async () => {
    const w = world();
    seedApproval(w, APPROVAL, { agentId: 'another-agent' });
    expect(await w.service.decideFromChannel(press(approvalActionData(APPROVAL, 'approve')))).toMatchObject({ settled: true });
    expect(w.approvals.approve).not.toHaveBeenCalled();
    expect(w.approvalRows.row(APPROVAL)!.status).toBe('pending');
  });

  it('sends the owner to Approvals when they may not decide it there', async () => {
    const w = world({ approverCannotManage: true });
    seedApproval(w);
    const outcome = await w.service.decideFromChannel(press(approvalActionData(APPROVAL, 'approve')));
    expect(outcome?.settled).toBe(false);
    expect(outcome?.text).toContain('Decide it in Approvals');
  });
});

describe('Approve in chat: racing the Approvals page', () => {
  it('a press after the page approved says it was already approved', async () => {
    const w = world();
    seedApproval(w);
    await w.approvals.approve(APPROVAL, { decidedBy: OWNER }, { id: OWNER }, ORG);
    expect(await w.service.decideFromChannel(press(approvalActionData(APPROVAL, 'reject')))).toEqual({ text: 'This was already approved.', settled: true });
    expect(w.approvalRows.row(APPROVAL)!.status).toBe('approved');
  });

  it('a press and the page at the same moment: one wins, the other is told it is decided', async () => {
    const w = world();
    seedApproval(w);
    const [chat, page] = await Promise.allSettled([
      w.service.decideFromChannel(press(approvalActionData(APPROVAL, 'approve'))),
      w.approvals.reject(APPROVAL, { decidedBy: OWNER }, { id: OWNER }, ORG),
    ]);
    const status = w.approvalRows.row(APPROVAL)!.status;
    expect(['approved', 'rejected']).toContain(status);
    if (status === 'approved') {
      expect(chat).toMatchObject({ status: 'fulfilled', value: { text: 'Approved. It carries on.' } });
      expect(page).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: 'approval already approved' }) });
    } else {
      expect(page.status).toBe('fulfilled');
      expect(chat).toMatchObject({ status: 'fulfilled', value: { text: 'This was already rejected.', settled: true } });
    }
  });

  it('a press the page beat between the read and the write is told so too', async () => {
    const w = world();
    seedApproval(w);
    // The page decides while the chat's decision is on its way.
    const real = w.approvals.approve.getMockImplementation()!;
    w.approvals.approve.mockImplementationOnce(async (...args: any[]) => {
      await w.approvalRows.update({ id: APPROVAL }, { status: 'rejected' });
      return (real as any)(...args);
    });
    expect(await w.service.decideFromChannel(press(approvalActionData(APPROVAL, 'approve')))).toEqual({ text: 'This was already rejected.', settled: true });
    expect(channelAudits(w)[0].details.outcome).toBe('already_decided');
  });
});

describe('Approve in chat: replies', () => {
  it('"yes" from the owner approves the one request waiting and answers them', async () => {
    const w = world();
    seedRun(w);
    seedApproval(w);
    const { msg, replies } = inbound('Yes');
    expect(await w.service.routeInbound(msg)).toBe('consumed');
    expect(w.approvalRows.row(APPROVAL)!.status).toBe('approved');
    expect(replies).toEqual(['Approved. It carries on.']);
    expect(channelAudits(w)[0].details).toMatchObject({ via: 'reply', outcome: 'decided', identity: 'U-OWNER' });
    // Not a wake: the answer is the decision.
    expect(w.wakes.rows()).toHaveLength(0);
  });

  it('"reject" and "no" reject, in any case', async () => {
    const w = world();
    seedRun(w);
    seedApproval(w);
    expect(await w.service.routeInbound(inbound('REJECT').msg)).toBe('consumed');
    expect(w.approvalRows.row(APPROVAL)!.status).toBe('rejected');
  });

  it('with two waiting, asks which one, and takes the one a ref names', async () => {
    const w = world();
    seedRun(w);
    seedApproval(w, APPROVAL, { createdAt: new Date(Date.now() - 1000) });
    seedApproval(w, SECOND, { reason: 'Ask before “send_email”.' });
    const first = inbound('yes');
    expect(await w.service.routeInbound(first.msg)).toBe('consumed');
    expect(first.replies[0]).toContain('2 requests are waiting for your OK');
    expect(first.replies[0]).toContain(approvalRef(APPROVAL));
    expect(first.replies[0]).toContain(approvalRef(SECOND));
    expect(w.approvalRows.rows().every((r) => r.status === 'pending')).toBe(true);

    const second = inbound(`no ${approvalRef(SECOND).toLowerCase()}`);
    expect(await w.service.routeInbound(second.msg)).toBe('consumed');
    expect(w.approvalRows.row(SECOND)!.status).toBe('rejected');
    expect(w.approvalRows.row(APPROVAL)!.status).toBe('pending');
  });

  it('a reply to the request\'s message decides that one (Telegram quotes it)', async () => {
    const w = world();
    seedRun(w);
    seedApproval(w, APPROVAL, { createdAt: new Date(Date.now() - 1000) });
    seedApproval(w, SECOND);
    const { msg } = inbound('approve', 'U-OWNER', { replyToText: `... Reply yes to approve or no to reject (ref ${approvalRef(SECOND)}), or ...` });
    expect(await w.service.routeInbound(msg)).toBe('consumed');
    expect(w.approvalRows.row(SECOND)!.status).toBe('approved');
  });

  it('a reply to a request that is no longer waiting says so', async () => {
    const w = world();
    seedRun(w);
    seedApproval(w, APPROVAL, { status: 'approved' });
    const { msg, replies } = inbound('yes', 'U-OWNER', { replyToText: `(ref ${approvalRef(APPROVAL)})` });
    expect(await w.service.routeInbound(msg)).toBe('consumed');
    expect(replies[0]).toContain('no longer waiting');
  });

  it('someone else\'s "yes" to a request is refused politely, and their plain "yes" stays their own chat', async () => {
    const w = world();
    seedRun(w);
    seedApproval(w);
    const named = inbound(`yes ${approvalRef(APPROVAL)}`, 'U-SOMEONE');
    expect(await w.service.routeInbound(named.msg)).toBe('consumed');
    expect(named.replies).toEqual(['Sorry, only the person this agent works for can approve or reject what it asks.']);
    expect(w.approvalRows.row(APPROVAL)!.status).toBe('pending');
    expect(channelAudits(w)[0].details).toMatchObject({ outcome: 'refused', identity: 'U-SOMEONE' });

    const plain = inbound('yes', 'U-SOMEONE');
    expect(await w.service.routeInbound(plain.msg)).toBe('continue');
    expect(plain.replies).toEqual([]);
  });

  it('a "yes" that says more, or with nothing waiting, is an ordinary message to the agent', async () => {
    const w = world();
    seedRun(w);
    seedApproval(w);
    expect(await w.service.routeInbound(inbound('yes, but only half of it').msg)).toBe('consumed');
    expect(w.approvalRows.row(APPROVAL)!.status).toBe('pending');
    expect(w.wakes.rows()).toHaveLength(1);

    const quiet = world();
    expect(await quiet.service.routeInbound(inbound('yes').msg)).toBe('consumed');
    expect(quiet.wakes.rows()[0].payload.ownerMessage.text).toBe('yes');
  });

  it('a "yes" while the agent waits for the owner\'s answer to a question answers the question', async () => {
    const w = world();
    seedRun(w, 'run-1', { status: AgentRunStatus.WAITING_INPUT });
    seedRun(w, 'run-other', { status: AgentRunStatus.WAITING_APPROVAL, metadata: {} });
    seedApproval(w, APPROVAL, { runId: 'run-other' });
    await w.agents.update({ id: AGENT }, { alwaysOn: { ...alwaysOnAgent().alwaysOn, liveRunId: 'run-1' } });
    expect(await w.service.routeInbound(inbound('yes').msg)).toBe('consumed');
    expect(w.approvalRows.row(APPROVAL)!.status).toBe('pending');
    expect(w.wakes.rows()[0].payload.ownerMessage.text).toBe('yes');
  });

  it('an email "yes" is refused unless the owner trusts their email, which cannot prove who sent it', async () => {
    const w = world({ agent: alwaysOnAgent({}, { ownerChannel: { channelId: 'email-channel', address: 'owner@example.com' } }) });
    w.channels.seed({ id: 'email-channel', organizationId: ORG, agentId: AGENT, type: 'email', name: 'Inbox', gatewayId: 'gw-email' });
    seedRun(w);
    seedApproval(w);
    const { msg, replies } = inbound('yes', 'Owner <owner@example.com>', { gatewayId: 'gw-email' });
    expect(await w.service.routeInbound(msg)).toBe('consumed');
    expect(replies[0]).toContain('An email cannot prove who sent it');
    expect(w.approvalRows.row(APPROVAL)!.status).toBe('pending');
  });
});

describe('Approve in chat: questions', () => {
  it('posts an ask_user question on the owner\'s channel once, and their reply goes back into the run', async () => {
    const w = world();
    seedRun(w, 'run-1', {
      status: AgentRunStatus.WAITING_INPUT,
      steps: [{ type: 'llm_call', output: { status: 'waiting_input', question: 'Refund NW-7 in full?' } }],
    });
    await w.service.onRunWaiting('run-1');
    await w.service.onRunWaiting('run-1');
    expect(w.posted).toHaveLength(1);
    expect(w.posted[0].delivery).toMatchObject({ channelId: SLACK, to: 'U-OWNER' });
    expect(w.posted[0].text).toBe('Support agent has a question for you:\n\nRefund NW-7 in full?\n\nReply here and it carries on.');

    await w.agents.update({ id: AGENT }, { alwaysOn: { ...alwaysOnAgent().alwaysOn, liveRunId: 'run-1' } });
    expect(await w.service.routeInbound(inbound('Yes, in full').msg)).toBe('consumed');
    await w.service.process(AGENT, ORG);
    expect(w.sendInput).toHaveBeenCalledWith('run-1', ORG, 'Yes, in full');
  });

  it('posts nothing for a run that is not waiting for an answer, or not always on', async () => {
    const w = world();
    seedRun(w, 'run-1', { status: AgentRunStatus.SLEEPING, steps: [{ output: { status: 'waiting_input', question: 'x' } }] });
    seedRun(w, 'run-2', { status: AgentRunStatus.WAITING_INPUT, metadata: {}, steps: [{ output: { status: 'waiting_input', question: 'x' } }] });
    await w.service.onRunWaiting('run-1');
    await w.service.onRunWaiting('run-2');
    expect(w.posted).toHaveLength(0);
  });
});
