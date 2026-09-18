import {
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { GlobalExceptionFilter } from './global-exception.filter';

// Mock @sentry/node so we can assert capture behavior without a real DSN /
// network. isInitialized() is toggled per-test to simulate DSN set vs unset.
const sentryMock = {
  isInitialized: jest.fn(),
  captureException: jest.fn(),
};
jest.mock('@sentry/node', () => sentryMock);

describe('GlobalExceptionFilter — Sentry 5xx reporting', () => {
  let filter: GlobalExceptionFilter;
  let mockResponse: any;
  let mockRequest: any;
  let mockHost: any;

  beforeEach(() => {
    filter = new GlobalExceptionFilter();
    // Silence the filter's error logs during the test run.
    jest.spyOn((filter as any).logger, 'error').mockImplementation(() => undefined);

    sentryMock.isInitialized.mockReset();
    sentryMock.captureException.mockReset();

    mockResponse = {
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    mockRequest = { method: 'GET', path: '/agents', headers: {} };
    mockHost = {
      switchToHttp: jest.fn().mockReturnValue({
        getResponse: jest.fn().mockReturnValue(mockResponse),
        getRequest: jest.fn().mockReturnValue(mockRequest),
      }),
    };
  });

  describe('when Sentry is enabled (DSN configured)', () => {
    beforeEach(() => sentryMock.isInitialized.mockReturnValue(true));

    it('reports an unhandled Error (500) to Sentry', () => {
      const err = new Error('boom');
      filter.catch(err, mockHost);
      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(sentryMock.captureException).toHaveBeenCalledTimes(1);
      expect(sentryMock.captureException).toHaveBeenCalledWith(err);
    });

    it('reports a thrown 5xx HttpException (e.g. 503) to Sentry', () => {
      const err = new ServiceUnavailableException('db down');
      filter.catch(err, mockHost);
      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
      expect(sentryMock.captureException).toHaveBeenCalledTimes(1);
    });

    it('reports a non-Error thrown value that resolves to 500', () => {
      filter.catch('some string', mockHost);
      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(sentryMock.captureException).toHaveBeenCalledTimes(1);
    });

    it('does NOT report a 400 BadRequest', () => {
      filter.catch(new BadRequestException('bad'), mockHost);
      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
      expect(sentryMock.captureException).not.toHaveBeenCalled();
    });

    it('does NOT report a 404 NotFound', () => {
      filter.catch(new NotFoundException('missing'), mockHost);
      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
      expect(sentryMock.captureException).not.toHaveBeenCalled();
    });

    it('does NOT report a generic 4xx HttpException', () => {
      filter.catch(new HttpException('teapot', 418), mockHost);
      expect(mockResponse.status).toHaveBeenCalledWith(418);
      expect(sentryMock.captureException).not.toHaveBeenCalled();
    });
  });

  describe('custom error code passthrough', () => {
    beforeEach(() => sentryMock.isInitialized.mockReturnValue(false));

    it('honours a `code` set on the HttpException response payload', () => {
      // Mirrors auth.service throwing ForbiddenException({ code: 'EMAIL_NOT_VERIFIED', ... }).
      const err = new HttpException(
        { code: 'EMAIL_NOT_VERIFIED', message: 'Please verify your email address before signing in.' },
        HttpStatus.FORBIDDEN,
      );
      filter.catch(err, mockHost);

      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.FORBIDDEN);
      const body = mockResponse.json.mock.calls[0][0];
      expect(body.error.code).toBe('EMAIL_NOT_VERIFIED');
      expect(body.error.statusCode).toBe(403);
      expect(body.error.message).toMatch(/verify your email/i);
    });

    it('falls back to the status-derived code when no custom code is present', () => {
      filter.catch(new NotFoundException('missing'), mockHost);
      const body = mockResponse.json.mock.calls[0][0];
      expect(body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('when Sentry is disabled (DSN unset)', () => {
    beforeEach(() => sentryMock.isInitialized.mockReturnValue(false));

    it('does not call captureException even for a 500', () => {
      filter.catch(new Error('boom'), mockHost);
      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(sentryMock.captureException).not.toHaveBeenCalled();
    });

    it('still returns a standardized error body (no-op tracking, normal response)', () => {
      filter.catch(new Error('boom'), mockHost);
      const body = mockResponse.json.mock.calls[0][0];
      expect(body.error.code).toBe('INTERNAL_ERROR');
      expect(body.error.statusCode).toBe(500);
    });
  });

  describe('body-parser errors raised before the handler runs', () => {
    // Shape body-parser actually throws (see raw-body / body-parser docs):
    // a plain Error with `status`, `type`, and `expose`.
    const bodyParserError = (type: string, status: number, message: string) =>
      Object.assign(new Error(message), { type, status, statusCode: status, expose: true });

    it('maps entity.too.large to 413 instead of a 500', () => {
      mockRequest.method = 'POST';
      mockRequest.path = '/public/chat/acme/messages';
      mockRequest.headers = { 'content-type': 'application/json' };
      filter.catch(bodyParserError('entity.too.large', 413, 'request entity too large'), mockHost);
      expect(mockResponse.status).toHaveBeenCalledWith(413);
      const body = mockResponse.json.mock.calls[0][0];
      expect(body.error.code).toBe('PAYLOAD_TOO_LARGE');
      expect(body.error.message).toBe('Request body too large');
      expect(sentryMock.captureException).not.toHaveBeenCalled();
    });

    it('maps encoding.unsupported to 415', () => {
      filter.catch(bodyParserError('encoding.unsupported', 415, 'unsupported content encoding "br"'), mockHost);
      expect(mockResponse.status).toHaveBeenCalledWith(415);
      expect(mockResponse.json.mock.calls[0][0].error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    });

    it('does not hijack an ordinary Error that happens to carry a non-4xx status', () => {
      filter.catch(Object.assign(new Error('upstream'), { status: 502, type: 'x' }), mockHost);
      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    });
  });

  describe('malformed JSON on public HTTP endpoints', () => {
    it('returns a plain 400 for /public/* rather than a JSON-RPC parse-error envelope', () => {
      mockRequest.method = 'POST';
      mockRequest.path = '/public/chat/acme/messages';
      mockRequest.headers = { 'content-type': 'application/json' };
      filter.catch(bodyParserError400(), mockHost);
      expect(mockResponse.status).toHaveBeenCalledWith(400);
      const body = mockResponse.json.mock.calls[0][0];
      expect(body.jsonrpc).toBeUndefined();
      expect(body.error.code).toBe('BAD_REQUEST');
      expect(body.error.message).toBe('Malformed request body');
    });

    it('keeps the JSON-RPC parse-error envelope for gateway paths', () => {
      mockRequest.method = 'POST';
      mockRequest.path = '/gw/acme/mcp';
      mockRequest.headers = { 'content-type': 'application/json' };
      filter.catch(bodyParserError400(), mockHost);
      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json.mock.calls[0][0].error.code).toBe(-32700);
    });

    function bodyParserError400() {
      return Object.assign(
        new SyntaxError('Unexpected token o in JSON at position 12'),
        { type: 'entity.parse.failed', status: 400, statusCode: 400, expose: true },
      );
    }
  });
});

describe('GlobalExceptionFilter: structured detail reaches the client', () => {
  let filter: GlobalExceptionFilter;
  let mockResponse: any;
  let mockHost: any;

  const body = () => mockResponse.json.mock.calls[0][0].error;

  beforeEach(() => {
    filter = new GlobalExceptionFilter();
    jest.spyOn((filter as any).logger, 'error').mockImplementation(() => undefined);
    mockResponse = { setHeader: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    mockHost = {
      switchToHttp: jest.fn().mockReturnValue({
        getResponse: jest.fn().mockReturnValue(mockResponse),
        getRequest: jest.fn().mockReturnValue({ method: 'POST', path: '/model-deployments', headers: {} }),
      }),
    };
  });

  /**
   * The body used to be rebuilt from five fixed fields, so a handler that
   * threw `{ code, message, accepts }` to tell the caller what it could
   * have sent had `accepts` stripped on the way out. The service spec
   * asserting it passed, because it never crossed the wire, and the UI
   * panel that renders it was dead code against a live server.
   */
  it('forwards the fields a handler attached, not just code and message', () => {
    filter.catch(
      new BadRequestException({
        code: 'ADAPTER_UNSUPPORTED_SOURCE',
        message: 'Hugging Face Inference Endpoints cannot run s3://weights/x@e3b0',
        accepts: ['hf://'],
      }),
      mockHost,
    );
    expect(body()).toMatchObject({
      code: 'ADAPTER_UNSUPPORTED_SOURCE',
      message: expect.stringContaining('cannot run s3://'),
      accepts: ['hf://'],
      statusCode: 400,
      path: '/model-deployments',
    });
  });

  it('keeps its own fields authoritative, so a payload cannot forge the status or the path', () => {
    filter.catch(
      new BadRequestException({ code: 'X', message: 'm', statusCode: 200, path: '/elsewhere', timestamp: 'nope' }),
      mockHost,
    );
    expect(body()).toMatchObject({ statusCode: 400, path: '/model-deployments' });
    expect(body().timestamp).not.toBe('nope');
  });

  it('adds nothing when the payload carries nothing extra', () => {
    filter.catch(new NotFoundException('Deployment not found'), mockHost);
    expect(Object.keys(body()).sort()).toEqual(['code', 'message', 'path', 'statusCode', 'timestamp']);
  });

  it('leaves a ValidationPipe payload alone, whose keys are all reserved', () => {
    filter.catch(new BadRequestException({ statusCode: 400, message: ['a must be a string', 'b is required'], error: 'Bad Request' }), mockHost);
    expect(body().message).toBe('a must be a string; b is required');
    expect(Object.keys(body()).sort()).toEqual(['code', 'message', 'path', 'statusCode', 'timestamp']);
  });

  describe('the reason is readable in both shapes', () => {
    it('puts the message at the top level as well as under error', () => {
      // 63 frontend files read response.data.message and this filter only
      // set error.message, so every one of them showed a generic string
      // instead of the reason the server gave. Answering in both shapes
      // fixes them all at once and cannot be got wrong by the next reader.
      filter.catch(new BadRequestException('Organization name must be at least 2 characters long'), mockHost as any);

      const body = mockResponse.json.mock.calls[0][0];
      expect(body.message).toBe('Organization name must be at least 2 characters long');
      expect(body.error.message).toBe(body.message);
    });

    it('marks the body as not successful, so code branching on it is not fooled', () => {
      filter.catch(new BadRequestException('nope'), mockHost as any);
      expect(mockResponse.json.mock.calls[0][0].success).toBe(false);
    });
  });
});

/**
 * The four defects that made a 500 uninvestigable: no id the user could
 * quote, a Sentry event with no organization/user/request tag, a lost
 * database connection reported as a client 400, and a `code` key dropped
 * off the response entirely for an uncoded 5xx.
 */
describe('GlobalExceptionFilter — correlation, DB classification, codes', () => {
  const { QueryFailedError } = require('typeorm');
  const { runWithRequestContext } = require('../request-context');

  let filter: GlobalExceptionFilter;
  let mockResponse: any;
  let mockRequest: any;
  let mockHost: any;

  const body = () => mockResponse.json.mock.calls[0][0];

  beforeEach(() => {
    filter = new GlobalExceptionFilter();
    jest.spyOn((filter as any).logger, 'error').mockImplementation(() => undefined);
    sentryMock.isInitialized.mockReset().mockReturnValue(true);
    sentryMock.captureException.mockReset();
    (sentryMock as any).withIsolationScope = jest.fn((fn: any) =>
      fn({
        setTag: jest.fn(),
        setUser: jest.fn(),
        setContext: jest.fn(),
      }),
    );

    mockResponse = {
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    mockRequest = { method: 'POST', path: '/agents', headers: {} };
    mockHost = {
      switchToHttp: jest.fn().mockReturnValue({
        getResponse: jest.fn().mockReturnValue(mockResponse),
        getRequest: jest.fn().mockReturnValue(mockRequest),
      }),
    };
  });

  it('gives the user a request id to quote, on the body and the header', () => {
    runWithRequestContext({ requestId: 'req-abc-123' }, () => {
      filter.catch(new Error('boom'), mockHost);
    });

    expect(mockResponse.setHeader).toHaveBeenCalledWith('X-Request-Id', 'req-abc-123');
    expect(body().requestId).toBe('req-abc-123');
    expect(body().error.requestId).toBe('req-abc-123');
    // Still no internal detail in the message itself.
    expect(body().message).toBe('Internal server error');
  });

  it('tags the Sentry event with organization, user and request id', () => {
    const tags: Record<string, string> = {};
    let capturedUser: any = null;
    (sentryMock as any).withIsolationScope = jest.fn((fn: any) =>
      fn({
        setTag: (k: string, v: string) => {
          tags[k] = v;
        },
        setUser: (u: any) => {
          capturedUser = u;
        },
        setContext: jest.fn(),
      }),
    );
    mockRequest.user = { id: 'user-9', currentOrganizationId: 'org-7', email: 'a@b.test' };

    runWithRequestContext(
      { requestId: 'req-xyz', organizationId: 'org-7', runId: 'run-5' },
      () => filter.catch(new Error('boom'), mockHost),
    );

    expect(tags.request_id).toBe('req-xyz');
    expect(tags.organization_id).toBe('org-7');
    expect(tags.run_id).toBe('run-5');
    expect(tags.http_status).toBe('500');
    expect(tags.error_code).toBe('INTERNAL_ERROR');
    expect(capturedUser).toEqual({ id: 'user-9' });
    // An error report must not widen who holds personal data.
    expect(JSON.stringify(capturedUser)).not.toContain('a@b.test');
    expect(sentryMock.captureException).toHaveBeenCalledTimes(1);
  });

  it('classifies a lost database connection as 503 and reports it', () => {
    const err = new QueryFailedError('SELECT 1', [], {
      code: 'ECONNREFUSED',
      message: 'connect ECONNREFUSED 10.0.0.5:5432',
    } as any);

    filter.catch(err, mockHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    expect(body().error.code).toBe('DATABASE_UNAVAILABLE');
    // A 5xx-rate alert can only see a database outage if it is a 5xx.
    expect(sentryMock.captureException).toHaveBeenCalledTimes(1);
  });

  it('classifies an admin shutdown (57P01) as 503', () => {
    const err = new QueryFailedError('SELECT 1', [], {
      code: '57P01',
      message: 'terminating connection due to administrator command',
    } as any);
    filter.catch(err, mockHost);
    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
  });

  it('still treats a constraint violation as a client 400 and does not report it', () => {
    const err = new QueryFailedError('INSERT ...', [], {
      code: '23505',
      message: 'duplicate key value violates unique constraint "tools_name_uq"',
    } as any);

    filter.catch(err, mockHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(body().error.code).toBe('DATABASE_ERROR');
    expect(sentryMock.captureException).not.toHaveBeenCalled();
  });

  it('always answers a code, even for an uncoded 5xx HttpException', () => {
    filter.catch(new HttpException('upstream exploded', 502), mockHost);

    const sent = body();
    expect(sent.error.code).toBe('BAD_GATEWAY');
    // `code: undefined` was silently dropped by JSON.stringify, leaving a
    // client with an error body carrying no machine-readable reason.
    expect(Object.keys(sent.error)).toContain('code');
    expect(sent.error.code).toBeDefined();
  });

  it('answers a code for a 503 HttpException with no explicit code', () => {
    filter.catch(new HttpException('maintenance', 503), mockHost);
    expect(body().error.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('answers a code for a status with no case at all', () => {
    filter.catch(new HttpException('teapot', 418), mockHost);
    expect(body().error.code).toBe('REQUEST_FAILED');
  });
});
