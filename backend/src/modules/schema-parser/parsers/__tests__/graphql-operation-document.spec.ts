import { buildSchema, parse, validate } from 'graphql';
import { GraphQLParserService } from '../graphql-parser.service';
import { MAX_SELECTED_FIELDS } from '../graphql-operation-document';
import { graphqlOperationRequest } from '../../../tools/executors/graphql-operation-request';
import { ToolsOperationHelper } from '../../../tools/tools-operation.helper';

/**
 * A tool generated from a GraphQL import sends the document the import
 * built for it (operation.metadata.query). Without one the request goes
 * out with no query and the server answers 400 -- the staging gate's
 * "GraphQL import (Countries)" failure.
 */

// The shape of countries.trevorblades.com, trimmed, plus the cases it lacks.
const SDL = `
  scalar Upload
  enum Size { SMALL LARGE }
  type Continent { code: ID! name: String! countries: [Country!]! }
  type Language { code: ID! name: String! rtl: Boolean! }
  type State { code: String name: String! country: Country! }
  type Country {
    code: ID!
    name(lang: String): String!
    capital: String
    continent: Continent!
    languages: [Language!]!
    states: [State!]!
    translation(lang: String!): String
  }
  input CountryFilterInput { code: String continent: String }
  type Image { url: String! size: Size }
  type Video { url: Int }
  union Media = Image | Video
  interface Node { id: ID! }
  type Post implements Node { id: ID! title: String! author: Author }
  type Author { name: String! avatar: Image }
  type Query {
    country(code: ID!): Country
    countries(filter: CountryFilterInput): [Country!]!
    continent(code: ID!): Continent
    node(id: ID!): Node
    media: [Media]
    ping: String
    sizes(of: [Size!]!, limit: Int = 10): [Size]
  }
  type Mutation { upload(file: Upload!, tags: [String!]): Post! }
`;

const schema = buildSchema(SDL);

async function parsedOperations() {
  const parser = new GraphQLParserService();
  const parsed = await parser.parseSchema(SDL);
  return parser.extractOperations(parsed);
}

describe('GraphQL import: the document a generated tool sends', () => {
  it('stores a query for every operation, and every one is valid against the schema', async () => {
    const ops = await parsedOperations();
    expect(ops.length).toBeGreaterThan(0);
    for (const op of ops) {
      const query = op.metadata?.query;
      expect(typeof query).toBe('string');
      expect(validate(schema, parse(query))).toEqual([]);
    }
  });

  it('passes the arguments as variables with their declared types', async () => {
    const ops = await parsedOperations();
    const country = ops.find((o) => o.name === 'country')!;
    expect(country.metadata.query).toContain('query Country($code: ID!)');
    expect(country.metadata.query).toContain('country(code: $code)');
    expect(country.metadata.operationName).toBe('Country');

    const sizes = ops.find((o) => o.name === 'sizes')!.metadata.query;
    expect(sizes).toContain('$of: [Size!]!');
    expect(sizes).toContain('$limit: Int');

    const upload = ops.find((o) => o.name === 'upload')!.metadata.query;
    expect(upload).toMatch(/^mutation Upload\(\$file: Upload!, \$tags: \[String!\]\)/);
  });

  it('selects scalars and nested objects, and stops at a cycle and at required arguments', async () => {
    const ops = await parsedOperations();
    const doc = parse(ops.find((o) => o.name === 'country')!.metadata.query);
    const root = (doc.definitions[0] as any).selectionSet.selections[0];
    const names = (sel: any) => sel.selectionSet.selections.map((s: any) => s.name.value);
    const child = (sel: any, name: string) => sel.selectionSet.selections.find((s: any) => s.name.value === name);

    expect(names(root)).toEqual(expect.arrayContaining(['code', 'name', 'capital', 'continent', 'languages', 'states']));
    // translation(lang: String!) cannot be selected without a value.
    expect(names(root)).not.toContain('translation');
    // Continent.countries leads back to Country.
    expect(names(child(root, 'continent'))).toEqual(['code', 'name']);
    // State.country too.
    expect(names(child(root, 'states'))).toEqual(['code', 'name']);
  });

  it('selects an interface by its fields and a union by its type name; a scalar result takes no selection', async () => {
    const ops = await parsedOperations();
    expect(ops.find((o) => o.name === 'node')!.metadata.query).toMatch(/node\(id: \$id\) \{\s+id\s+\}/);
    expect(ops.find((o) => o.name === 'media')!.metadata.query).toMatch(/media \{\s+__typename\s+\}/);
    expect(ops.find((o) => o.name === 'ping')!.metadata.query).toBe('query Ping {\n  ping\n}');
    // Mutation result: Post { author { avatar { url size } } } -- three levels.
    expect(ops.find((o) => o.name === 'upload')!.metadata.query).toMatch(/avatar \{\s+url\s+size\s+\}/);
  });

  it('keeps a wide schema to a bounded document', async () => {
    const fields = Array.from({ length: 1000 }, (_, i) => `f${i}: String`).join(' ');
    const sdl = `type Wide { ${fields} } type Query { wide: Wide }`;
    const parser = new GraphQLParserService();
    const [op] = await parser.extractOperations(await parser.parseSchema(sdl));
    const selected = (op.metadata.query.match(/\bf\d+\b/g) || []).length;
    expect(selected).toBe(MAX_SELECTED_FIELDS);
    expect(validate(buildSchema(sdl), parse(op.metadata.query))).toEqual([]);
  });

  it('makes the non-null arguments required tool inputs, and not the query string', async () => {
    const ops = await parsedOperations();
    const helper = new ToolsOperationHelper({} as any, {} as any, {} as any, {} as any);
    const params = await helper.generateToolParametersFromOperation(ops.find((o) => o.name === 'country')!);
    expect(Object.keys(params.properties)).toEqual(['code']);
    expect(params.required).toEqual(['code']);
  });
});

describe('graphqlOperationRequest', () => {
  const operation = {
    metadata: { query: 'query Search($query: String!, $first: Int) { search(query: $query, first: $first) { id } }', operationName: 'Search' },
    parameters: { body: { variables: { properties: { query: { type: 'string' }, first: { type: 'number' } } } } },
  } as any;

  it('sends the stored document with the declared arguments as variables', async () => {
    const ops = await parsedOperations();
    const country = ops.find((o) => o.name === 'country')!;
    expect(graphqlOperationRequest(country, { code: 'DE', stray: 1 })).toEqual({
      query: country.metadata.query,
      variables: { code: 'DE' },
      operationName: 'Country',
    });
  });

  it('treats an argument named query as a variable, not as the document', () => {
    const req = graphqlOperationRequest(operation, { query: 'berlin', first: 3 });
    expect(req.query).toBe(operation.metadata.query);
    expect(req.variables).toEqual({ query: 'berlin', first: 3 });
  });

  it('lets a caller send its own query when no argument has that name', async () => {
    const ops = await parsedOperations();
    const country = ops.find((o) => o.name === 'country')!;
    const own = '{ country(code: "FR") { capital } }';
    expect(graphqlOperationRequest(country, { query: own, variables: {} })).toEqual({
      query: own,
      variables: {},
      operationName: undefined,
    });
  });

  it('reads variables from an explicit variables object', async () => {
    const ops = await parsedOperations();
    const country = ops.find((o) => o.name === 'country')!;
    expect(graphqlOperationRequest(country, { variables: { code: 'JP' } }).variables).toEqual({ code: 'JP' });
  });
});
