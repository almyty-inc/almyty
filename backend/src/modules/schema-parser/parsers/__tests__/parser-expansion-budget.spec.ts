import { Test, TestingModule } from '@nestjs/testing';
import { GraphQLParserService } from '../graphql-parser.service';
import { ProtobufParserService } from '../protobuf-parser.service';

/**
 * Field expansion in both of these parsers is quadratic: cost is
 * |types or methods| x |fields|, and both factors are linear in the
 * input. So input size does not bound output size, and a document
 * comfortably under each parser's 5 MB byte cap can still ask for tens
 * of millions of objects.
 *
 * That failure is a V8 heap OOM, which aborts the process — the
 * parsers' own try/catch never runs. These fixtures are a few hundred
 * KB and finish in seconds with the expansion budget in place; without
 * it they take the worker down.
 */
describe('schema parsers - quadratic field expansion is bounded', () => {
  let graphql: GraphQLParserService;
  let protobufParser: ProtobufParserService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [GraphQLParserService, ProtobufParserService],
    }).compile();
    graphql = module.get(GraphQLParserService);
    protobufParser = module.get(ProtobufParserService);
  });

  it('bounds GraphQL N-fields-of-an-M-field-type expansion', async () => {
    const N = 3000;
    const M = 3000;
    const sdl = [
      'type Query { q: A }',
      `type A { ${Array.from({ length: N }, (_, i) => `f${i}: T`).join(' ')} }`,
      `type T { ${Array.from({ length: M }, (_, i) => `g${i}: String`).join(' ')} }`,
    ].join('\n');

    // Unbudgeted this asks for N*M = 9,000,000 property objects.
    const parsed = await graphql.parseSchema(sdl, 'wide.graphql');

    const a = parsed.resources.find((r) => r.name === 'A')!;
    expect(a).toBeDefined();
    const expanded = Object.values(a.properties).filter(
      (p: any) => p?.properties !== undefined,
    ).length;
    expect(expanded).toBeLessThan(N);
  }, 120000);

  it('bounds protobuf per-method message property rebuilds', async () => {
    const FIELDS = 2000;
    const METHODS = 2000;
    const proto = [
      'syntax = "proto3";',
      'package p;',
      `message Big { ${Array.from(
        { length: FIELDS },
        (_, i) => `string g${i} = ${i + 1};`,
      ).join(' ')} }`,
      `service S { ${Array.from(
        { length: METHODS },
        (_, i) => `rpc M${i} (Big) returns (Big);`,
      ).join(' ')} }`,
    ].join('\n');

    // Unbudgeted this asks for METHODS * 2 * FIELDS = 8,000,000 objects.
    const parsed = await protobufParser.parseSchema(proto, 'wide.proto');

    expect(parsed.operations).toHaveLength(METHODS);
    const totalProps = parsed.operations.reduce(
      (n, op: any) =>
        n + Object.keys(op.parameters?.body?.message?.properties ?? {}).length,
      0,
    );
    expect(totalProps).toBeLessThan(METHODS * FIELDS);
  }, 120000);

  it('still expands fields fully for an ordinary-sized GraphQL schema', async () => {
    const sdl = [
      'type Query { user(id: ID!): User }',
      'type User { id: ID! name: String posts: [Post!]! }',
      'type Post { id: ID! title: String }',
    ].join('\n');

    const parsed = await graphql.parseSchema(sdl, 'small.graphql');
    const user = parsed.resources.find((r) => r.name === 'User')!;
    expect(user.properties.posts.items.properties).toEqual(
      expect.objectContaining({ title: { type: 'string' } }),
    );
  });

  it('still expands fields fully for an ordinary-sized .proto', async () => {
    const proto = [
      'syntax = "proto3";',
      'package p;',
      'message Req { string name = 1; int32 n = 2; }',
      'message Res { string out = 1; }',
      'service S { rpc Do (Req) returns (Res); }',
    ].join('\n');

    const parsed = await protobufParser.parseSchema(proto, 'small.proto');
    expect(parsed.operations).toHaveLength(1);
    expect(
      Object.keys((parsed.operations[0] as any).parameters.body.message.properties),
    ).toEqual(['name', 'n']);
  });
});
