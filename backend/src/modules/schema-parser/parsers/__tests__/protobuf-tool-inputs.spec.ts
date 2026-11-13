import { ProtobufParserService } from '../protobuf-parser.service';
import { ToolsOperationHelper } from '../../../tools/tools-operation.helper';
import { operationHeaderParams } from '../../../tools/operation-header-params';

/**
 * A tool generated from a .proto takes its request message's fields as
 * inputs. The parser puts them under `parameters.body.message`; the tool
 * parameters used to lift only GraphQL's `body.variables` and a body
 * `schema`, so DummyUnary came out with no f_string to fill in -- the
 * staging gate's "gRPC import (grpcbin proto)" failure.
 */

// grpcbin.proto (github.com/moul/pb), the parts DummyUnary uses.
const PROTO = `
syntax = "proto3";
package grpcbin;
service GRPCBin {
  rpc Empty(EmptyMessage) returns (EmptyMessage) {}
  rpc DummyUnary(DummyMessage) returns (DummyMessage) {}
  rpc SpecificError(SpecificErrorRequest) returns (EmptyMessage) {}
}
message EmptyMessage {}
message SpecificErrorRequest { uint32 code = 1; string reason = 2; }
message DummyMessage {
  message Sub { string f_string = 1; }
  enum Enum { ENUM_0 = 0; ENUM_1 = 1; }
  string f_string = 1;
  repeated string f_strings = 2;
  int32 f_int32 = 3;
  Enum f_enum = 5;
  repeated Enum f_enums = 6;
  Sub f_sub = 7;
  bool f_bool = 9;
}
`;

async function toolInputs(method: string) {
  const parser = new ProtobufParserService();
  const ops = await parser.extractOperations(await parser.parseSchema(PROTO));
  const op = ops.find((o) => o.name === method)!;
  const helper = new ToolsOperationHelper({} as any, {} as any, {} as any, {} as any);
  return helper.generateToolParametersFromOperation(op);
}

describe('gRPC import: the request message fields are the tool inputs', () => {
  it('DummyUnary takes DummyMessage fields, named as the .proto writes them', async () => {
    const params = await toolInputs('DummyUnary');
    expect(Object.keys(params.properties).sort()).toEqual(
      ['f_bool', 'f_enum', 'f_enums', 'f_int32', 'f_string', 'f_strings', 'f_sub'],
    );
    expect(params.properties.f_string.type).toBe('string');
  });

  it('takes no transport header (grpc-encoding, content-type) as an input', async () => {
    const params = await toolInputs('DummyUnary');
    for (const name of Object.keys(params.properties)) {
      expect(name.toLowerCase()).not.toMatch(/^(grpc-|content-type$|te$)/);
    }
  });

  it('an enum field is a string, one of its value names', async () => {
    const params = await toolInputs('DummyUnary');
    expect(params.properties.f_enum).toMatchObject({ type: 'string', enum: ['ENUM_0', 'ENUM_1'] });
    expect(params.properties.f_enums).toMatchObject({ type: 'array', items: { type: 'string', enum: ['ENUM_0', 'ENUM_1'] } });
    // A nested message stays an object.
    expect(params.properties.f_sub.type).toBe('object');
  });

  it('SpecificError takes code and reason', async () => {
    const params = await toolInputs('SpecificError');
    expect(Object.keys(params.properties)).toEqual(expect.arrayContaining(['code', 'reason']));
  });

  it('a method taking an empty message has no inputs', async () => {
    const params = await toolInputs('Empty');
    expect(Object.keys(params.properties)).toEqual([]);
  });
});

describe('operationHeaderParams', () => {
  it('leaves gRPC transport headers out of an operation stored with them', () => {
    const stored = {
      parameters: {
        header: {
          'Content-Type': { type: 'string', default: 'application/grpc' },
          'grpc-encoding': { type: 'string', enum: ['identity', 'gzip'] },
          'grpc-timeout': { type: 'string' },
          TE: { type: 'string' },
          'x-tenant': { type: 'string' },
        },
      },
    };
    expect(operationHeaderParams(stored).map(([name]) => name)).toEqual(['x-tenant']);
  });
});