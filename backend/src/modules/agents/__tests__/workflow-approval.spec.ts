import { heldCallWords, settledHeldCall, waitingRunText } from '../workflow-approval';

describe('what a waiting workflow run says', () => {
  it('names a held call in plain words', () => {
    expect(heldCallWords('issue_refund', 'amount is 820')).toBe('Issue refund (amount is 820)');
    expect(waitingRunText([{ kind: 'tool_call', changes: 1, call: 'Issue refund (amount is 820)' }])).toBe(
      'Waiting for your approval: Issue refund (amount is 820).',
    );
  });

  it('counts changes for Code steps, and requests when a run waits on several kinds', () => {
    expect(waitingRunText([{ changes: 2 }, { changes: 1 }])).toBe('Waiting for your approval: 3 changes.');
    expect(waitingRunText([{ changes: 2 }, { kind: 'tool_call', changes: 1, call: 'Issue refund' }])).toBe(
      'Waiting for your approval: 2 requests.',
    );
  });

  it('settles a held call: its result, its failure, or a plain "Rejected"', () => {
    expect(settledHeldCall('approved', { success: true, data: { refunded: true } })).toEqual({ output: { refunded: true } });
    expect(settledHeldCall('approved', { success: false, error: 'card declined' }).error).toBe('Approved, but the call failed: card declined.');
    expect(settledHeldCall('rejected', null, 'not this one')).toEqual({ error: 'Rejected (not this one). The call was not made.', errorCode: 'APPROVAL_REJECTED' });
    expect(settledHeldCall('expired', null).error).toBe('Nobody approved in time. The call was not made.');
  });
});
