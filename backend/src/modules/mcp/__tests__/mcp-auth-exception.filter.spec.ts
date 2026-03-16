import { HttpException, HttpStatus } from '@nestjs/common';
import { McpAuthExceptionFilter } from '../filters/mcp-auth-exception.filter';

describe('McpAuthExceptionFilter', () => {
  let filter: McpAuthExceptionFilter;
  let mockResponse: any;
  let mockHost: any;

  beforeEach(() => {
    filter = new McpAuthExceptionFilter();

    mockResponse = {
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    mockHost = {
      switchToHttp: jest.fn().mockReturnValue({
        getResponse: jest.fn().mockReturnValue(mockResponse),
      }),
    };
  });

  it('should set WWW-Authenticate header on 401 responses when exception has wwwAuthenticate property', () => {
    const exception = new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
    (exception as any).wwwAuthenticate = 'Bearer realm="test"';

    filter.catch(exception, mockHost as any);

    expect(mockResponse.setHeader).toHaveBeenCalledWith('WWW-Authenticate', 'Bearer realm="test"');
    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.UNAUTHORIZED);
  });

  it('should NOT set WWW-Authenticate on non-401 responses', () => {
    const exception = new HttpException('Forbidden', HttpStatus.FORBIDDEN);
    (exception as any).wwwAuthenticate = 'Bearer realm="test"';

    filter.catch(exception, mockHost as any);

    expect(mockResponse.setHeader).not.toHaveBeenCalled();
    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.FORBIDDEN);
  });

  it('should format error body correctly for string exception responses', () => {
    const exception = new HttpException('Not allowed', HttpStatus.UNAUTHORIZED);

    filter.catch(exception, mockHost as any);

    expect(mockResponse.json).toHaveBeenCalledWith({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Not allowed',
        statusCode: HttpStatus.UNAUTHORIZED,
      },
    });
  });

  it('should format error body correctly for object exception responses', () => {
    const exception = new HttpException(
      { error: 'Invalid API key', errorCode: 'API_KEY_INVALID' },
      HttpStatus.FORBIDDEN,
    );

    filter.catch(exception, mockHost as any);

    expect(mockResponse.json).toHaveBeenCalledWith({
      error: expect.objectContaining({
        code: 'API_KEY_INVALID',
        message: 'Invalid API key',
        statusCode: HttpStatus.FORBIDDEN,
      }),
    });
  });

  it('should include timestamp in error response for object exceptions', () => {
    const exception = new HttpException(
      { error: 'Auth failed', errorCode: 'AUTH_FAILED' },
      HttpStatus.UNAUTHORIZED,
    );

    filter.catch(exception, mockHost as any);

    const body = mockResponse.json.mock.calls[0][0];
    expect(body.error.timestamp).toBeDefined();
    // Verify it's a valid ISO date string
    expect(new Date(body.error.timestamp).toISOString()).toBe(body.error.timestamp);
  });

  it('should include errorCode from exception response', () => {
    const exception = new HttpException(
      { error: 'Token expired', errorCode: 'TOKEN_EXPIRED' },
      HttpStatus.UNAUTHORIZED,
    );
    (exception as any).wwwAuthenticate = 'Bearer realm="gateway"';

    filter.catch(exception, mockHost as any);

    const body = mockResponse.json.mock.calls[0][0];
    expect(body.error.code).toBe('TOKEN_EXPIRED');
    expect(body.error.message).toBe('Token expired');
    expect(mockResponse.setHeader).toHaveBeenCalledWith('WWW-Authenticate', 'Bearer realm="gateway"');
  });
});
