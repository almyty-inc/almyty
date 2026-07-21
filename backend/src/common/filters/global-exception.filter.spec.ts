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
});
