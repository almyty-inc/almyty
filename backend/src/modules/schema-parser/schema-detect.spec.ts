import { readFileSync } from 'fs';
import { join } from 'path';

import { ApiType } from '../../entities/api.entity';
import { detectApiSchema, SchemaNotRecognizedError } from './schema-detect';
import { OpenAPIParserService } from './parsers/openapi-parser.service';
import { GraphQLParserService } from './parsers/graphql-parser.service';
import { SOAPParserService } from './parsers/soap-parser.service';
import { ProtobufParserService } from './parsers/protobuf-parser.service';
import { SchemaParserService } from './schema-parser.service';

/**
 * Connecting an API is one box: paste a link, drop a file or paste the
 * text. Everything the old form asked for -- type, name, version,
 * description, base URL, sign-in scheme and header -- is read out of the
 * description here, so each fixture below is a real file of its format
 * and each expectation is a field the user no longer types.
 */
const fixture = (name: string) => readFileSync(join(__dirname, '__fixtures__', name), 'utf8');

const parsers = new SchemaParserService(
  new OpenAPIParserService(),
  new GraphQLParserService(),
  new SOAPParserService(),
  new ProtobufParserService(),
);

/** What detection hands on must be something the import job can parse. */
async function parses(type: ApiType, content: string) {
  const parsed = await parsers.parseApiSchema(content, type);
  return parsed.operations.map((o) => o.operationId).sort();
}

describe('detectApiSchema', () => {
  it('reads an OpenAPI 3 JSON file: name, version, description, address and an api key header', async () => {
    const found = detectApiSchema(fixture('openapi3-petstore.json'), { fileName: 'openapi3-petstore.json' });
    expect(found).toMatchObject({
      type: ApiType.OPENAPI,
      format: 'openapi3',
      name: 'Petstore',
      version: '2.1.0',
      description: 'Pets you can list, add and look up.',
      baseUrl: 'https://petstore.example.com/v2',
      auth: { type: 'api_key', headerName: 'X-Pets-Key', location: 'header' },
    });
    expect(await parses(found.type, found.content)).toEqual(['createPet', 'getPet', 'listPets']);
  });

  it('reads OpenAPI 3 YAML, fills server variables from their defaults, and finds a bearer scheme named by an operation', async () => {
    const found = detectApiSchema(fixture('openapi3-weather.yaml'));
    expect(found).toMatchObject({
      type: ApiType.OPENAPI,
      format: 'openapi3',
      name: 'Weather',
      version: '1.4',
      description: 'Forecasts by city.',
      baseUrl: 'https://eu.weather.example.com/api',
      auth: { type: 'bearer' },
    });
    expect(await parses(found.type, found.content)).toEqual(['getForecast']);
  });

  it('resolves a relative server against the link it came from and keeps the OAuth2 flow the spec declares', () => {
    const found = detectApiSchema(fixture('openapi3-calendar-oauth.yaml'), {
      sourceUrl: 'https://calendar.example.com/specs/openapi.yaml',
    });
    expect(found.baseUrl).toBe('https://calendar.example.com/calendar/v3');
    expect(found.name).toBe('Calendar');
    expect(found.auth).toEqual({
      type: 'oauth2',
      oauth2: {
        flow: 'authorization_code',
        authorizationUrl: 'https://auth.calendar.example.com/authorize',
        tokenUrl: 'https://auth.calendar.example.com/token',
        scopes: ['events.read', 'events.write'],
      },
    });
  });

  it('leaves the address empty for a relative server when there is no link to resolve it against', () => {
    expect(detectApiSchema(fixture('openapi3-calendar-oauth.yaml')).baseUrl).toBeNull();
  });

  it('reads Swagger 2: host, basePath and https, and an api key sent as a query parameter', async () => {
    const found = detectApiSchema(fixture('swagger2-store.json'));
    expect(found).toMatchObject({
      type: ApiType.OPENAPI,
      format: 'swagger2',
      name: 'Store',
      version: '1.0.5',
      description: 'An online store.',
      baseUrl: 'https://store.example.com/api',
      auth: { type: 'api_key', headerName: 'api_key', location: 'query' },
    });
    expect(await parses(found.type, found.content)).toEqual(['getOrder', 'listOrders']);
  });

  it('reads GraphQL SDL, named after its file', async () => {
    const found = detectApiSchema(fixture('countries.graphql'), { fileName: 'countries.graphql' });
    expect(found).toMatchObject({
      type: ApiType.GRAPHQL,
      format: 'graphql-sdl',
      name: 'countries',
      description: 'Countries, continents and languages.',
      baseUrl: null,
      auth: { type: 'none' },
    });
    expect(await parses(found.type, found.content)).toEqual(expect.arrayContaining(['query_continents', 'query_countries', 'query_country']));
  });

  it('turns an introspection result into SDL the GraphQL parser reads, with the endpoint as the address', async () => {
    const found = detectApiSchema(fixture('countries-introspection.json'), {
      graphqlEndpoint: 'https://countries.example.com/graphql',
    });
    expect(found).toMatchObject({
      type: ApiType.GRAPHQL,
      format: 'graphql-introspection',
      name: 'countries.example.com',
      baseUrl: 'https://countries.example.com/graphql',
    });
    expect(found.content).toContain('type Query');
    expect(await parses(found.type, found.content)).toEqual(expect.arrayContaining(['query_continents', 'query_countries', 'query_country']));
  });

  it('reads a WSDL: its name, documentation and soap:address', async () => {
    const found = detectApiSchema(fixture('temperature.wsdl'));
    expect(found).toMatchObject({
      type: ApiType.SOAP,
      format: 'wsdl',
      name: 'TemperatureConversions',
      description: 'Converts temperatures between Celsius and Fahrenheit.',
      baseUrl: 'https://temperature.example.com/TempConvert.asmx',
      auth: { type: 'none' },
    });
    expect(await parses(found.type, found.content)).toHaveLength(1);
  });

  it('reads a .proto: the service name, the version in its package, and no address', async () => {
    const found = detectApiSchema(fixture('greeter.proto'));
    expect(found).toMatchObject({
      type: ApiType.GRPC,
      format: 'proto',
      name: 'Greeter',
      version: 'v1',
      description: 'Says hello, one person or many.',
      baseUrl: null,
    });
    expect((await parses(found.type, found.content)).length).toBe(2);
  });

  it.each([
    ['an HTML page', 'garbage.html'],
    ['a JSON body that is not a description', 'not-an-api.json'],
  ])('refuses %s in plain words', (_label, name) => {
    expect(() => detectApiSchema(fixture(name))).toThrow(SchemaNotRecognizedError);
    expect(() => detectApiSchema(fixture(name))).toThrow("We couldn't read this as OpenAPI, GraphQL, WSDL or proto.");
  });

  it('refuses plain prose and empty input', () => {
    expect(() => detectApiSchema('Just some notes about our API, no spec here.')).toThrow(SchemaNotRecognizedError);
    expect(() => detectApiSchema('   ')).toThrow('There is nothing to import yet.');
  });

  it('picks the scheme the top-level security names over the first one declared', () => {
    const doc = {
      openapi: '3.0.0',
      info: { title: 'Two schemes', version: '1' },
      paths: {},
      security: [{ second: [] }],
      components: {
        securitySchemes: {
          first: { type: 'http', scheme: 'basic' },
          second: { type: 'apiKey', in: 'header', name: 'X-Second' },
        },
      },
    };
    expect(detectApiSchema(JSON.stringify(doc)).auth).toEqual({ type: 'api_key', headerName: 'X-Second', location: 'header' });
  });
});
