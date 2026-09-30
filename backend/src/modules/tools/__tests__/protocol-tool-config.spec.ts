import { BadRequestException } from '@nestjs/common';

import { assertProtocolToolShape, impliedExecutionMethod } from '../protocol-tool-config';

const PROTO = 'syntax = "proto3"; package p; service Svc { rpc Get(Req) returns (Res); } message Req {} message Res {}';

describe('assertProtocolToolShape', () => {
  const graphqlTool = {
    executionMethod: 'graphql',
    code: null,
    apiId: null,
    graphqlConfig: { endpoint: 'https://api.example.com/graphql', query: '{ a }' },
  };

  it('refuses code added to a stored GraphQL tool', () => {
    expect(() => assertProtocolToolShape({ code: 'return 1' }, graphqlTool)).toThrow(BadRequestException);
  });

  it('accepts an update that only changes the query', () => {
    expect(() =>
      assertProtocolToolShape({ graphqlConfig: { endpoint: 'https://api.example.com/graphql', query: '{ b }' } }, graphqlTool),
    ).not.toThrow();
  });

  it('lets a tool linked to an API leave the endpoint and the proto to it', () => {
    expect(() =>
      assertProtocolToolShape({ executionMethod: 'grpc', apiId: 'api-1', grpcConfig: { serviceName: 'Svc', methodName: 'Get' } }),
    ).not.toThrow();
  });

  it('refuses an endpoint that is not http(s)', () => {
    expect(() =>
      assertProtocolToolShape({ executionMethod: 'grpc', grpcConfig: { endpoint: 'grpc://h:50051', serviceName: 'Svc', methodName: 'Get', protoDefinition: PROTO } }),
    ).toThrow(/https:\/\//);
  });

  it('finds a service by its full name too', () => {
    expect(() =>
      assertProtocolToolShape({ executionMethod: 'grpc', grpcConfig: { endpoint: 'https://h', serviceName: 'p.Svc', methodName: 'Get', protoDefinition: PROTO } }),
    ).not.toThrow();
  });

  it('names what the proto defines when the service is wrong', () => {
    expect(() =>
      assertProtocolToolShape({ executionMethod: 'grpc', grpcConfig: { endpoint: 'https://h', serviceName: 'Nope', methodName: 'Get', protoDefinition: PROTO } }),
    ).toThrow(/It defines: p\.Svc/);
  });

  it('refuses a proto that does not parse', () => {
    expect(() =>
      assertProtocolToolShape({ executionMethod: 'grpc', grpcConfig: { endpoint: 'https://h', serviceName: 'Svc', methodName: 'Get', protoDefinition: 'service {' } }),
    ).toThrow(/does not parse/);
  });

  it('implies the execution method from the config sent', () => {
    expect(impliedExecutionMethod({ soapConfig: { operation: 'X' } })).toBe('soap');
    expect(impliedExecutionMethod({})).toBeUndefined();
  });
});
