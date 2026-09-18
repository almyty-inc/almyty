/**
 * Error explanation.
 *
 * Every failure a chat session can reach has to produce a sentence a
 * user can act on. Each case here is one that used to print a status
 * code, a JSON blob, or "Agent not found" regardless of cause.
 */
import { describe, it, expect } from 'vitest';

import { explainError, extractModelName, inspectError } from '../errors.js';
import { EXIT, EXIT_CODE_HELP, exitCodeForError } from '../exit-codes.js';

const CTX = { agentRef: 'acme/support-bot', apiUrl: 'https://api.almyty.com', appUrl: 'https://app.almyty.com' };

/** An error as AlmytyClient.request now throws it. */
function apiError(status: number, body: string) {
  return Object.assign(new Error(`API error ${status}: ${body}`), { status, body });
}

describe('inspectError', () => {
  it('reads the status off the error object', () => {
    expect(inspectError(apiError(404, '{}')).status).toBe(404);
  });

  it('recovers a status from the message when the object has none', () => {
    expect(inspectError(new Error('API error 403: nope')).status).toBe(403);
    expect(inspectError(new Error('SSE 502: bad gateway')).status).toBe(502);
  });

  it('pulls the server code and message out of a JSON body', () => {
    const f = inspectError(apiError(400, '{"success":false,"message":"Agent must be active to invoke","error":"AGENT_NOT_ACTIVE"}'));
    expect(f.code).toBe('AGENT_NOT_ACTIVE');
    expect(f.serverMessage).toBe('Agent must be active to invoke');
  });

  it('recognises a transport failure', () => {
    expect(inspectError(Object.assign(new Error('fetch failed'), { networkError: true })).network).toBe(true);
    expect(inspectError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })).network).toBe(true);
  });

  it('recognises an abort', () => {
    expect(inspectError(Object.assign(new Error('Aborted'), { name: 'AbortError' })).aborted).toBe(true);
  });
});

describe('explainError', () => {
  it('not logged in: names the command that fixes it', () => {
    expect(explainError(apiError(401, ''), CTX)).toContain('npx @almyty/auth login');
  });

  it('missing agent: names the command that lists the real ones', () => {
    const msg = explainError(apiError(404, '{}'), CTX);
    expect(msg).toContain('acme/support-bot');
    expect(msg).toContain('npx @almyty/agents list');
  });

  it('draft agent: says it is not active and where to activate it', () => {
    const msg = explainError(apiError(400, '{"message":"Agent must be active to invoke","error":"AGENT_NOT_ACTIVE"}'), CTX);
    expect(msg).toContain('not active');
    expect(msg).toContain('https://app.almyty.com/agents');
    // Not a bare status code or a JSON blob.
    expect(msg).not.toContain('{');
    expect(msg).not.toContain('400');
  });

  it('wrong organization: says so rather than "not found"', () => {
    const msg = explainError(apiError(403, '{"error":"AGENT_AUTH_FORBIDDEN"}'), CTX);
    expect(msg).toContain('no access');
    expect(msg).toContain('organization');
  });

  it('retired model: names the model and says schedules stay paused', () => {
    const msg = explainError(
      apiError(400, '{"message":"LLM call failed: Model \\"claude-sonnet-4-20250514\\" is not available","error":"MODEL_NOT_FOUND"}'),
      CTX,
    );
    expect(msg).toContain('claude-sonnet-4-20250514');
    expect(msg).toContain('paused');
    expect(msg).toContain('app.almyty.com/agents');
  });

  it('no model configured: says to pick one', () => {
    const msg = explainError(new Error('Agent has no LLM provider configured (modelConfig.providerId or modelConfig.routing is missing)'), CTX);
    expect(msg).toContain('no model configured');
    expect(msg).toContain('app.almyty.com/agents');
  });

  it('out of budget: says the cap is the cause', () => {
    expect(explainError(apiError(402, '{"error":"BUDGET_EXCEEDED"}'), CTX)).toContain('spend cap');
    expect(explainError(new Error('organization budget exceeded for this period'), CTX)).toContain('spend cap');
  });

  it('network drop: names the host and the env var that changes it', () => {
    const msg = explainError(Object.assign(new Error('fetch failed'), { networkError: true }), CTX);
    expect(msg).toContain('https://api.almyty.com');
    expect(msg).toContain('ALMYTY_URL');
  });

  it('rate limited: says to retry', () => {
    expect(explainError(apiError(429, ''), CTX)).toContain('Rate limited');
  });

  it('server error: says it is server-side', () => {
    expect(explainError(apiError(503, ''), CTX)).toContain('server-side');
  });

  it('poll timeout: says the run is still going and how to come back', () => {
    const msg = explainError(Object.assign(new Error('Run r1 did not finish within 300s'), { pollTimeout: true }), CTX);
    expect(msg).toContain('still going');
    expect(msg).toContain('--resume');
  });

  it('cancellation is not an error report', () => {
    expect(explainError(Object.assign(new Error('Aborted'), { name: 'AbortError' }), CTX)).toBe('Cancelled.');
  });

  it('never leaks a raw stack or a bare status for a known cause', () => {
    for (const err of [apiError(401, ''), apiError(403, '{}'), apiError(404, '{}'), apiError(429, '')]) {
      const msg = explainError(err, CTX);
      expect(msg).not.toMatch(/^API error/);
      expect(msg.length).toBeGreaterThan(20);
    }
  });
});

describe('extractModelName', () => {
  it('finds a quoted model name', () => {
    expect(extractModelName('Model "gpt-4o-mini" is not available')).toBe('gpt-4o-mini');
  });
  it('returns null when the message names none', () => {
    expect(extractModelName('the model is gone')).toBeNull();
  });
});

describe('exitCodeForError', () => {
  /** An error as AlmytyClient.request now throws it. */
  function apiError(status: number, body = '{}') {
    return Object.assign(new Error(`API error ${status}: ${body}`), { status, body });
  }

  it('tells "not logged in" apart from "no such agent" apart from "it failed"', () => {
    expect(exitCodeForError(apiError(401))).toBe(EXIT.AUTH);
    expect(exitCodeForError(apiError(403))).toBe(EXIT.AUTH);
    expect(exitCodeForError(apiError(404))).toBe(EXIT.NOT_FOUND);
    expect(exitCodeForError(apiError(400, '{"error":"AGENT_NOT_ACTIVE"}'))).toBe(EXIT.FAILED);
    expect(exitCodeForError(apiError(500))).toBe(EXIT.FAILED);
  });

  it('reads the server code, not just the status', () => {
    expect(exitCodeForError(apiError(400, '{"error":"AGENT_AUTH_EXPIRED"}'))).toBe(EXIT.AUTH);
  });

  it('an unreachable API is an error, not a failed run', () => {
    expect(exitCodeForError(Object.assign(new Error('fetch failed'), { networkError: true }))).toBe(EXIT.ERROR);
  });

  it('falls back to a plain error for anything unclassifiable', () => {
    expect(exitCodeForError(new Error('who knows'))).toBe(EXIT.ERROR);
  });

  it('documents every code it can return', () => {
    for (const code of Object.values(EXIT)) {
      expect(EXIT_CODE_HELP).toContain(`  ${code}  `);
    }
  });
});
