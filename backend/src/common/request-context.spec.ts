import { requestContextMiddleware } from './middleware/request-context.middleware';
import { CorrelatedConsoleLogger } from './logging/correlated-console.logger';
import {
  getRequestId,
  getRequestContext,
  runWithRequestContext,
  sanitizeInboundRequestId,
  updateRequestContext,
} from './request-context';

/**
 * The correlation id is the multiplier for every other observability
 * fix: without one, a user-facing 500 has no path to its log line, a
 * request_logs row has no path to the run it started, and a run step has
 * no path to the tool execution it made. Nothing minted one before.
 */
describe('request correlation', () => {
  const runMiddleware = (req: any, res: any) =>
    new Promise<void>((resolve) => {
      requestContextMiddleware(req, res, () => resolve());
    });

  const request = (headers: Record<string, any> = {}) => ({ headers });
  const response = () => {
    const headers: Record<string, string> = {};
    return {
      headers,
      setHeader: (k: string, v: string) => {
        headers[k] = v;
      },
    };
  };

  describe('middleware', () => {
    it('mints an id for a request that carried none', async () => {
      const req: any = request();
      const res: any = response();
      let seen: string | undefined;

      await new Promise<void>((resolve) => {
        requestContextMiddleware(req, res, () => {
          seen = getRequestId();
          resolve();
        });
      });

      expect(seen).toMatch(/^[0-9a-f-]{36}$/);
      // Echoed to the caller, so a person can quote it, and reachable
      // from plain `req` for express-level helpers.
      expect(res.headers['X-Request-Id']).toBe(seen);
      expect(req.requestId).toBe(seen);
    });

    it('adopts a well-formed inbound x-request-id so one id spans hops', async () => {
      const req: any = request({ 'x-request-id': 'edge-7f3a91b2c4d5' });
      const res: any = response();
      let seen: string | undefined;

      await new Promise<void>((resolve) => {
        requestContextMiddleware(req, res, () => {
          seen = getRequestId();
          resolve();
        });
      });

      expect(seen).toBe('edge-7f3a91b2c4d5');
      expect(res.headers['X-Request-Id']).toBe('edge-7f3a91b2c4d5');
    });

    it('replaces a hostile inbound id rather than logging it', async () => {
      const req: any = request({ 'x-request-id': 'bad\nINJECTED LOG LINE' });
      const res: any = response();
      let seen: string | undefined;

      await new Promise<void>((resolve) => {
        requestContextMiddleware(req, res, () => {
          seen = getRequestId();
          resolve();
        });
      });

      expect(seen).not.toContain('INJECTED');
      expect(seen).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('gives concurrent requests distinct ids that do not bleed', async () => {
      const ids: string[] = [];
      await Promise.all(
        [1, 2, 3].map(
          () =>
            new Promise<void>((resolve) => {
              requestContextMiddleware(request() as any, response() as any, () => {
                // Yield, so the three scopes are genuinely interleaved.
                setImmediate(() => {
                  ids.push(getRequestId()!);
                  resolve();
                });
              });
            }),
        ),
      );

      expect(ids).toHaveLength(3);
      expect(new Set(ids).size).toBe(3);
    });

    it('leaves no context outside a request', () => {
      expect(getRequestId()).toBeUndefined();
      // Updating outside a scope is a no-op, not a throw: a unit test
      // that calls a service directly has no request.
      expect(() => updateRequestContext({ runId: 'r1' })).not.toThrow();
    });
  });

  describe('sanitizeInboundRequestId', () => {
    it.each([
      ['abcdefgh', 'abcdefgh'],
      ['7f3a91b2-c4d5-4e6f-8a9b-0c1d2e3f4a5b', '7f3a91b2-c4d5-4e6f-8a9b-0c1d2e3f4a5b'],
    ])('accepts %s', (input, expected) => {
      expect(sanitizeInboundRequestId(input)).toBe(expected);
    });

    it.each([
      ['short', 'too short'],
      ['has space here', 'whitespace'],
      ['line\nbreak', 'newline'],
      ['x'.repeat(200), 'too long'],
      [42, 'not a string'],
      [undefined, 'absent'],
    ])('rejects %p (%s)', (input: any, _why: string) => {
      expect(sanitizeInboundRequestId(input as any)).toBeUndefined();
    });
  });

  describe('scopes', () => {
    it('inherits the request id into a nested scope rather than minting a second', () => {
      runWithRequestContext({ requestId: 'req-1', organizationId: 'org-1' }, () => {
        runWithRequestContext({ runId: 'run-9' }, () => {
          const ctx = getRequestContext();
          expect(ctx?.requestId).toBe('req-1');
          expect(ctx?.organizationId).toBe('org-1');
          expect(ctx?.runId).toBe('run-9');
        });
        // The child's fields do not leak back out.
        expect(getRequestContext()?.runId).toBeUndefined();
      });
    });

    it('mints an id for a scope opened with none (a queue consumer)', () => {
      runWithRequestContext({ queue: 'agent-runtime', jobId: '42' }, () => {
        expect(getRequestId()).toMatch(/^[0-9a-f-]{36}$/);
      });
    });

    it('updateRequestContext adds facts discovered mid-request', () => {
      runWithRequestContext({ requestId: 'req-2' }, () => {
        updateRequestContext({ organizationId: 'org-2', gatewayId: 'gw-3' });
        expect(getRequestContext()).toMatchObject({
          requestId: 'req-2',
          organizationId: 'org-2',
          gatewayId: 'gw-3',
        });
      });
    });
  });

  describe('CorrelatedConsoleLogger', () => {
    it('appends the correlation fields after the existing message', () => {
      const logger = new CorrelatedConsoleLogger();
      const lines: any[] = [];
      jest
        .spyOn(Object.getPrototypeOf(Object.getPrototypeOf(logger)), 'error')
        .mockImplementation((...args: any[]) => {
          lines.push(args[0]);
        });

      runWithRequestContext(
        { requestId: 'req-3', organizationId: 'org-3', runId: 'run-3' },
        () => logger.error('run failed: upstream 500'),
      );

      expect(lines[0]).toBe('run failed: upstream 500 | req=req-3 org=org-3 run=run-3');
      // The message still LEADS with the original text, so a runbook
      // grep on the message prefix keeps matching.
      expect(String(lines[0]).startsWith('run failed: upstream 500')).toBe(true);
    });

    it('leaves a line logged outside any request exactly as before', () => {
      const logger = new CorrelatedConsoleLogger();
      const lines: any[] = [];
      jest
        .spyOn(Object.getPrototypeOf(Object.getPrototypeOf(logger)), 'log')
        .mockImplementation((...args: any[]) => {
          lines.push(args[0]);
        });

      logger.log('Application is running on: http://localhost:3000');

      expect(lines[0]).toBe('Application is running on: http://localhost:3000');
    });

    it('does not corrupt a structured (non-string) message', () => {
      const logger = new CorrelatedConsoleLogger();
      const lines: any[] = [];
      jest
        .spyOn(Object.getPrototypeOf(Object.getPrototypeOf(logger)), 'warn')
        .mockImplementation((...args: any[]) => {
          lines.push(args[0]);
        });

      const payload = { event: 'budget_exceeded', orgId: 'org-4' };
      runWithRequestContext({ requestId: 'req-4' }, () => logger.warn(payload));

      expect(lines[0]).toBe(payload);
    });
  });
});
