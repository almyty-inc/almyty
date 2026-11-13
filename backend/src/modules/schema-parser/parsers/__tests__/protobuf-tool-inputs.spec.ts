import { ProtobufParserService } from '../protobuf-parser.service';
import { ToolsOperationHelper } from '../../../tools/tools-operation.helper';

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
  it('DummyUnary takes DummyMessage fields', async () => {
    const params = await toolInputs('DummyUnary');
    expect(Object.keys(params.properties)).toEqual(
      expect.arrayContaining(['f_string', 'f_strings', 'f_int32', 'f_enum', 'f_sub', 'f_bool']),
    );
    expect(params.properties.f_string.type).toBe('string');
  });

  it('SpecificError takes code and reason', async () => {
    const params = await toolInputs('SpecificError');
    expect(Object.keys(params.properties)).toEqual(expect.arrayContaining(['code', 'reason']));
  });

  it('a method taking an empty message has no message inputs', async () => {
    const params = await toolInputs('Empty');
    expect(Object.keys(params.properties).filter((k) => k.startsWith('f_') || k === 'code')).toEqual([]);
  });
});
