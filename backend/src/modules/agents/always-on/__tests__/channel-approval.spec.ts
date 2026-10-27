import {
  approvalActionData,
  approvalActions,
  approvalMessage,
  approvalNotice,
  approvalPreview,
  approvalRef,
  parseDecision,
  questionMessage,
  quotedRef,
  readApprovalAction,
} from '../channel-approval';

/**
 * Approve in chat, the pure part: the words a request is posted as, the
 * reply grammar ("yes", "no", "approve", "reject"), and the data a button
 * carries, signed so a crafted callback cannot name another request.
 */
const ID = '3f9a1c2b-1111-4111-8111-111111111111';
const OTHER = '7d2e4f60-2222-4222-8222-222222222222';
const ENV = { CHANNEL_ACTION_SECRET: 'test-action-secret' };

function gmailRaw(headers: string, body: string): string {
  return Buffer.from(`${headers}\r\n\r\n${body}`).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('approvalRef', () => {
  it('is the first six of the id, upper case', () => {
    expect(approvalRef(ID)).toBe('3F9A1C');
  });
});

describe('parseDecision', () => {
  it.each([
    ['yes', 'approve'],
    ['Yes.', 'approve'],
    ['YES!', 'approve'],
    ['approve', 'approve'],
    ['Approve', 'approve'],
    ['no', 'reject'],
    ['No.', 'reject'],
    ['reject', 'reject'],
    ['REJECT', 'reject'],
  ])('reads %p as %p', (text, decision) => {
    expect(parseDecision(text)).toEqual({ decision });
  });

  it('reads the ref that comes with it, in any case and with or without "ref"', () => {
    expect(parseDecision('yes 3f9a1c')).toEqual({ decision: 'approve', ref: '3F9A1C' });
    expect(parseDecision('no ref 3F9A1C')).toEqual({ decision: 'reject', ref: '3F9A1C' });
    expect(parseDecision('approve #3F9A1C')).toEqual({ decision: 'approve', ref: '3F9A1C' });
  });

  it('takes a first line that says more for a message, not a decision', () => {
    expect(parseDecision('no, send it tomorrow instead')).toBeNull();
    expect(parseDecision('yes please and also check the other one')).toBeNull();
    expect(parseDecision('yesterday it failed')).toBeNull();
    expect(parseDecision('nothing to add')).toBeNull();
    expect(parseDecision('')).toBeNull();
    expect(parseDecision(null)).toBeNull();
  });

  it('reads only the first line, so an email quote below does not count', () => {
    expect(parseDecision('Yes\n\nOn Tue, the agent wrote:\n> no')).toEqual({ decision: 'approve' });
    expect(parseDecision('Can you wait?\n> yes')).toBeNull();
  });
});

describe('quotedRef', () => {
  it('finds the ref in the message a reply quotes', () => {
    expect(quotedRef(null, '> Reply yes to approve or no to reject (ref 3F9A1C), or decide in Approvals')).toBe('3F9A1C');
    expect(quotedRef('Reply yes ... (ref 7d2e4f)')).toBe('7D2E4F');
    expect(quotedRef('nothing here', undefined)).toBeNull();
  });
});

describe('approvalPreview and approvalMessage', () => {
  it('shows an email it would send as To, Subject and text, not base64', () => {
    const raw = gmailRaw('To: ana@example.com\r\nCc: lead@example.com\r\nSubject: Your refund', 'Hi Ana,\r\nYour refund is on its way.');
    const preview = approvalPreview({ tool: 'Send a message', parameters: { raw } });
    expect(preview).toContain('The email it will send:');
    expect(preview).toContain('To: ana@example.com');
    expect(preview).toContain('Cc: lead@example.com');
    expect(preview).toContain('Subject: Your refund');
    expect(preview).toContain('Your refund is on its way.');
    expect(preview).not.toContain(raw);
    // The email's CRLF line breaks become plain ones, as chat shows them.
    expect(preview).toContain('Hi Ana,\nYour refund is on its way.');
    expect(preview).not.toContain('\r');
  });

  it('lists the tool and its arguments, leaving the gate bookkeeping out', () => {
    const preview = approvalPreview({ tool: 'Issue a refund', parameters: { order: 'NW-7', amount: 120, note: { why: 'late' } }, _gate: { rule: 'x' } });
    expect(preview).toBe('Tool: Issue a refund\norder: NW-7\namount: 120\nnote: {"why":"late"}');
  });

  it('lists the changes of a script', () => {
    const preview = approvalPreview({ kind: 'change_set', changeSet: [{ summary: 'Refund NW-7' }, { summary: 'Close ticket 9' }] });
    expect(preview).toBe('2 changes:\n- Refund NW-7\n- Close ticket 9');
  });

  it('says who asks and why, what it would do, and how to answer, with the ref', () => {
    const text = approvalMessage(
      'Support agent',
      { id: ID, reason: 'Ask before “issue_refund” (it is on the ask-first list).', payload: { tool: 'issue_refund', parameters: { order: 'NW-7' } } },
      'https://app.test/approvals',
    );
    expect(text).toBe(
      [
        'Support agent wants to do something and is waiting for your OK: Ask before “issue_refund” (it is on the ask-first list).',
        '',
        'Tool: issue_refund',
        'order: NW-7',
        '',
        'Reply yes to approve or no to reject (ref 3F9A1C), or decide in Approvals: https://app.test/approvals',
      ].join('\n'),
    );
    expect(text).not.toContain('Approve or reject it in Approvals.');
  });

  it('says in one line, for a channel others read, whose OK it waits for and on what, never the preview', () => {
    const raw = gmailRaw('To: ana@example.com\r\nSubject: Your refund', 'Hi Ana');
    const url = 'https://app.test/approvals';
    expect(approvalNotice('Biz-dev assistant', 'Maya', { payload: { tool: 'Send a message', parameters: { raw } } }, url)).toBe(
      "Biz-dev assistant is waiting for Maya's OK on an email. Approvals: https://app.test/approvals",
    );
    expect(approvalNotice('Support agent', null, { payload: { tool: 'Issue a refund', parameters: { amount: 820 } } }, url)).toBe(
      "Support agent is waiting for its owner's OK on “Issue a refund”. Approvals: https://app.test/approvals",
    );
    expect(approvalNotice('A', 'Maya', { payload: { kind: 'change_set', changeSet: [] } }, url)).toContain('on a set of changes.');
    expect(approvalNotice('A', 'Maya', { payload: { tool: 'x', parameters: { amount: 820 } } }, url)).not.toContain('820');
  });

  it('puts a question to the owner with how to answer', () => {
    expect(questionMessage('Support agent', 'Refund NW-7 in full?')).toBe(
      'Support agent has a question for you:\n\nRefund NW-7 in full?\n\nReply here and it carries on.',
    );
  });
});

describe('button data', () => {
  it('fits Telegram (64 bytes) and Discord (100) and reads back to the request and the decision', () => {
    const approve = approvalActionData(ID, 'approve', ENV);
    expect(Buffer.byteLength(approve)).toBeLessThanOrEqual(64);
    expect(readApprovalAction(approve, ENV)).toEqual({ approvalId: ID, decision: 'approve' });
    expect(readApprovalAction(approvalActionData(ID, 'reject', ENV), ENV)).toEqual({ approvalId: ID, decision: 'reject' });
  });

  it('refuses data whose tag was not made for it: another request, another decision, another key', () => {
    const approve = approvalActionData(ID, 'approve', ENV);
    const [, , , tag] = approve.split(':');
    expect(readApprovalAction(`apv:a:${OTHER}:${tag}`, ENV)).toBeNull();
    expect(readApprovalAction(`apv:r:${ID}:${tag}`, ENV)).toBeNull();
    expect(readApprovalAction(approve, { CHANNEL_ACTION_SECRET: 'another-install' })).toBeNull();
    expect(readApprovalAction('apv:a:not-an-id:0000000000000000', ENV)).toBeNull();
    expect(readApprovalAction('something else', ENV)).toBeNull();
  });

  it('makes an Approve and a Reject button', () => {
    const [approve, reject] = approvalActions(ID, ENV);
    expect(approve).toEqual({ id: approvalActionData(ID, 'approve', ENV), label: 'Approve', style: 'primary' });
    expect(reject).toEqual({ id: approvalActionData(ID, 'reject', ENV), label: 'Reject', style: 'danger' });
  });
});
