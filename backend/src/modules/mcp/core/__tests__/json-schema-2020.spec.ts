import * as fs from 'fs';
import * as path from 'path';

import { JSON_SCHEMA_2020_12, normalizeInputSchema, normalizeJsonSchema, normalizeOutputSchema } from '../json-schema-2020';
import { jsonSchema2020CompileError } from '../output-schema-check';
import { OpenAPIParserService } from '../../../schema-parser/parsers/openapi-parser.service';
import { GraphQLParserService } from '../../../schema-parser/parsers/graphql-parser.service';
import { SOAPParserService } from '../../../schema-parser/parsers/soap-parser.service';
import { ProtobufParserService } from '../../../schema-parser/parsers/protobuf-parser.service';
import {
  translateGraphQLOperationInput,
  translateGraphQLOperationOutput,
  translateOpenAPIOperationInput,
  translateOpenAPIOperationOutput,
  translateProtobufOperationInput,
  translateProtobufOperationOutput,
  translateSOAPOperationInput,
  translateSOAPOperationOutput,
} from '../../../json-schema-translator/protocol-translators.helper';

describe('JSON Schema 2020-12 normalisation', () => {
  it('turns OpenAPI 3.0 nullable into a null type', () => {
    expect(normalizeJsonSchema({ type: 'string', nullable: true })).toEqual({ type: ['string', 'null'] });
    expect(normalizeJsonSchema({ type: ['integer'], nullable: true })).toEqual({ type: ['integer', 'null'] });
    expect(normalizeJsonSchema({ type: 'string', enum: ['a'], nullable: true })).toEqual({
      type: ['string', 'null'],
      enum: ['a', null],
    });
  });

  it('turns draft-04 boolean exclusive bounds into the numeric form', () => {
    expect(normalizeJsonSchema({ type: 'number', minimum: 0, exclusiveMinimum: true, maximum: 9, exclusiveMaximum: false })).toEqual({
      type: 'number',
      exclusiveMinimum: 0,
      maximum: 9,
    });
  });

  it('renames definitions to $defs and keeps refs into it working', () => {
    const out = normalizeJsonSchema({
      type: 'object',
      properties: { a: { $ref: '#/definitions/A' } },
      definitions: { A: { type: 'string' } },
    }) as any;
    expect(out.$defs).toEqual({ A: { type: 'string' } });
    expect(out.definitions).toBeUndefined();
    expect(out.properties.a).toEqual({ $ref: '#/$defs/A' });
  });

  it('drops refs that cannot resolve inside the schema', () => {
    const out = normalizeJsonSchema({
      type: 'object',
      properties: {
        local: { $ref: '#/components/schemas/Pet' },
        remote: { $ref: 'https://example.com/pet.json' },
      },
    }) as any;
    expect(out.properties.local).toEqual({});
    expect(out.properties.remote).toEqual({});
  });

  it('keeps 2020-12 features exactly (conformance json-schema-2020-12)', () => {
    const schema = {
      $schema: JSON_SCHEMA_2020_12,
      type: 'object',
      $defs: { address: { type: 'object', properties: { street: { type: 'string' }, city: { type: 'string' } } } },
      properties: { name: { type: 'string' }, address: { $ref: '#/$defs/address' } },
      additionalProperties: false,
    };
    expect(normalizeInputSchema(schema)).toEqual(schema);
  });

  it('drops a $schema that names another dialect', () => {
    expect(normalizeJsonSchema({ $schema: 'http://json-schema.org/draft-07/schema#', type: 'object' })).toEqual({ type: 'object' });
  });

  it('rewrites draft-04 tuple items as prefixItems', () => {
    expect(normalizeJsonSchema({ type: 'array', items: [{ type: 'string' }], additionalItems: false })).toEqual({
      type: 'array',
      prefixItems: [{ type: 'string' }],
      items: false,
    });
  });

  it('drops OpenAPI-only keywords and turns example into examples', () => {
    expect(
      normalizeJsonSchema({ type: 'object', discriminator: { propertyName: 'k' }, xml: { name: 'x' }, externalDocs: {}, example: { k: 1 } }),
    ).toEqual({ type: 'object', examples: [{ k: 1 }] });
  });

  it('never touches property names that look like keywords', () => {
    const out = normalizeJsonSchema({ type: 'object', properties: { nullable: { type: 'boolean' }, example: { type: 'string' } } }) as any;
    expect(Object.keys(out.properties)).toEqual(['nullable', 'example']);
  });

  // The OpenAPI parameter translator marks a required parameter with
  // `required: true` on the property, which no 2020-12 validator accepts.
  it('moves a boolean required on a property into the parent array', () => {
    expect(
      normalizeJsonSchema({
        type: 'object',
        required: ['a'],
        properties: { a: { type: 'string' }, b: { type: 'string', required: true }, c: { type: 'string', required: false } },
      }),
    ).toEqual({
      type: 'object',
      required: ['a', 'b'],
      properties: { a: { type: 'string' }, b: { type: 'string' }, c: { type: 'string' } },
    });
  });
  it('gives an input schema an object root', () => {
    expect(normalizeInputSchema(undefined)).toEqual({ type: 'object', properties: {} });
    expect(normalizeInputSchema({ properties: { a: { type: 'string' } } })).toEqual({
      type: 'object',
      properties: { a: { type: 'string' } },
    });
    expect(normalizeInputSchema({ type: 'string' })).toEqual({ type: 'object', properties: {} });
  });

  it('declares an output schema only when it describes an object', () => {
    expect(normalizeOutputSchema({ type: 'array', items: { type: 'string' } })).toBeNull();
    expect(normalizeOutputSchema({ type: 'object', properties: {} })).toEqual({ type: 'object', properties: {} });
  });

  it('bounds a pathologically deep schema instead of recursing forever', () => {
    let deep: any = { type: 'string' };
    for (let i = 0; i < 500; i++) deep = { type: 'object', properties: { x: deep } };
    expect(() => normalizeJsonSchema(deep)).not.toThrow();
  });
});

/**
 * Guard: every schema the generators produce from the parser fixtures, after
 * normalisation, is a valid 2020-12 schema with none of the draft-04/OpenAPI
 * idioms left. A new parser idiom fails here before a client rejects it.
 */
describe('every generated tool schema is 2020-12 after normalisation', () => {
  const fixtures = path.join(__dirname, '../../../schema-parser/__fixtures__');
  const read = (name: string) => fs.readFileSync(path.join(fixtures, name), 'utf8');

  const cases: Array<[string, () => Promise<Array<{ input: unknown; output: unknown }>>]> = [
    ...['openapi3-petstore.json', 'openapi3-weather.yaml', 'openapi3-calendar-oauth.yaml', 'swagger2-store.json'].map(
      (file) =>
        [
          file,
          async () => {
            const parser = new OpenAPIParserService();
            const ops = await parser.extractOperations(await parser.parseSchema(read(file), file));
            return ops.map((op) => ({ input: translateOpenAPIOperationInput(op), output: translateOpenAPIOperationOutput(op) }));
          },
        ] as [string, () => Promise<Array<{ input: unknown; output: unknown }>>],
    ),
    [
      'countries.graphql',
      async () => {
        const parser = new GraphQLParserService();
        const ops = await parser.extractOperations(await parser.parseSchema(read('countries.graphql'), 'countries.graphql'));
        return ops.map((op) => ({ input: translateGraphQLOperationInput(op), output: translateGraphQLOperationOutput(op) }));
      },
    ],
    [
      'temperature.wsdl',
      async () => {
        const parser = new SOAPParserService();
        const ops = await parser.extractOperations(await parser.parseSchema(read('temperature.wsdl'), 'temperature.wsdl'));
        return ops.map((op) => ({ input: translateSOAPOperationInput(op), output: translateSOAPOperationOutput(op) }));
      },
    ],
    [
      'greeter.proto',
      async () => {
        const parser = new ProtobufParserService();
        const ops = await parser.extractOperations(await parser.parseSchema(read('greeter.proto'), 'greeter.proto'));
        return ops.map((op) => ({ input: translateProtobufOperationInput(op), output: translateProtobufOperationOutput(op) }));
      },
    ],
  ];

  const leftovers = (schema: unknown): string[] => {
    const found: string[] = [];
    const walk = (node: any, at: string) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${at}/${i}`));
      if ('nullable' in node && typeof node.nullable === 'boolean') found.push(`${at}: nullable`);
      if (typeof node.exclusiveMinimum === 'boolean') found.push(`${at}: boolean exclusiveMinimum`);
      if (typeof node.exclusiveMaximum === 'boolean') found.push(`${at}: boolean exclusiveMaximum`);
      if ('definitions' in node && typeof node.definitions === 'object' && !node.properties?.definitions) found.push(`${at}: definitions`);
      for (const [key, value] of Object.entries(node)) {
        if (key === 'properties' && value && typeof value === 'object') {
          for (const [name, sub] of Object.entries(value as object)) walk(sub, `${at}/properties/${name}`);
        } else if (key !== 'enum' && key !== 'const' && key !== 'examples' && key !== 'default') {
          walk(value, `${at}/${key}`);
        }
      }
    };
    walk(schema, '#');
    return found;
  };

  it.each(cases)('%s', async (_name, load) => {
    const schemas = await load();
    expect(schemas.length).toBeGreaterThan(0);
    for (const { input, output } of schemas) {
      const normalizedInput = normalizeInputSchema(input);
      expect(normalizedInput.type).toBe('object');
      expect(jsonSchema2020CompileError(normalizedInput)).toBeNull();
      expect(leftovers(normalizedInput)).toEqual([]);

      const normalizedOutput = normalizeOutputSchema(output);
      if (normalizedOutput) {
        expect(jsonSchema2020CompileError(normalizedOutput)).toBeNull();
        expect(leftovers(normalizedOutput)).toEqual([]);
      }
    }
  });
});
