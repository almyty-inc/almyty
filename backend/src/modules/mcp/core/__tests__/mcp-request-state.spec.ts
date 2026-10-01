import { openRequestState, requestDigest, sealRequestState } from '../mcp-request-state';
import { snapshotEnv } from '../../../../test/env';

/**
 * requestState decides what an MCP retry may do (which approval it answers,
 * which run it resumes), so it is sealed and bound to the caller, an expiry
 * and the request (2026-07-28 MRTR, server requirements 4 and 5).
 */
describe('MCP requestState', () => {
  const restore = snapshotEnv('ENCRYPTION_KEY', 'MCP_REQUEST_STATE_TTL_SECONDS', 'NODE_ENV');
  afterEach(restore);
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = 'a'.repeat(64);
  });

  const params = { name: 'issue_refund', arguments: { amount: 820, order: 'NW-1' }, _meta: { x: 1 } };
  const bind = { principal: 'user-1', method: 'tools/call', params };
  const payload = { kind: 'held_call', data: { approvalId: 'appr-1' } };

  it('opens what it sealed, for the same caller and request', () => {
    const state = sealRequestState(payload, bind);
    expect(openRequestState(state, bind)).toEqual({ payload });
  });

  it('ignores what changes between the call and its retry: _meta, inputResponses, requestState', () => {
    const state = sealRequestState(payload, bind);
    const retry = { ...params, _meta: { other: true }, inputResponses: { a: {} }, requestState: state };
    expect(openRequestState(state, { ...bind, params: retry })).toEqual({ payload });
    expect(requestDigest('tools/call', { arguments: { b: 2, a: 1 }, name: 'x' })).toBe(
      requestDigest('tools/call', { name: 'x', arguments: { a: 1, b: 2 } }),
    );
  });

  it('refuses it for another caller, and when minted for nobody', () => {
    const state = sealRequestState(payload, bind);
    expect(openRequestState(state, { ...bind, principal: 'user-2' })).toEqual({ refusal: 'wrong_principal' });
    const anonymous = sealRequestState(payload, { ...bind, principal: null });
    expect(openRequestState(anonymous, { ...bind, principal: null })).toEqual({ refusal: 'wrong_principal' });
  });

  it('refuses it on another request: other arguments, tool or method', () => {
    const state = sealRequestState(payload, bind);
    expect(openRequestState(state, { ...bind, params: { ...params, arguments: { amount: 1, order: 'NW-1' } } })).toEqual({
      refusal: 'wrong_request',
    });
    expect(openRequestState(state, { ...bind, params: { ...params, name: 'other' } })).toEqual({ refusal: 'wrong_request' });
    expect(openRequestState(state, { ...bind, method: 'prompts/get' })).toEqual({ refusal: 'wrong_request' });
  });

  it('refuses it after MCP_REQUEST_STATE_TTL_SECONDS', () => {
    process.env.MCP_REQUEST_STATE_TTL_SECONDS = '60';
    const t0 = Date.UTC(2026, 9, 1, 12, 0, 0);
    const state = sealRequestState(payload, bind, t0);
    expect(openRequestState(state, bind, t0 + 59_000)).toEqual({ payload });
    expect(openRequestState(state, bind, t0 + 60_000)).toEqual({ refusal: 'expired' });
  });

  it('refuses a changed byte, a state sealed under another key, and junk', () => {
    const state = sealRequestState(payload, bind);
    const raw = Buffer.from(state, 'base64url');
    raw[raw.length - 1] ^= 1;
    expect(openRequestState(raw.toString('base64url'), bind)).toEqual({ refusal: 'tampered' });

    process.env.ENCRYPTION_KEY = 'b'.repeat(64);
    expect(openRequestState(state, bind)).toEqual({ refusal: 'tampered' });

    for (const junk of [undefined, null, 42, '', 'short', 'x'.repeat(20_000)]) {
      expect(openRequestState(junk, bind)).toEqual({ refusal: 'malformed' });
    }
  });

  it('cannot be read by the client', () => {
    const state = sealRequestState({ kind: 'held_call', data: { approvalId: 'visible-id-123' } }, bind);
    expect(Buffer.from(state, 'base64url').toString('latin1')).not.toContain('visible-id-123');
  });

  it('refuses to seal without ENCRYPTION_KEY in production', () => {
    delete process.env.ENCRYPTION_KEY;
    process.env.NODE_ENV = 'production';
    expect(() => sealRequestState(payload, bind)).toThrow(/ENCRYPTION_KEY/);
  });
});
