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
