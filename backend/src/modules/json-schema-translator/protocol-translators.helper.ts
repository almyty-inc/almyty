import { JSONSchema7 } from 'json-schema';
import { Operation } from '../../entities/operation.entity';

/**
 * Maximum recursion depth for normalizePropertyToJsonSchema. Real
 * schemas nest a few levels; 50 is well beyond any legitimate shape
 * and cheaply prevents a stack overflow on malformed / adversarial input.
 */
const MAX_NORMALIZE_DEPTH = 50;

/**
 * Normalize a parser-emitted property descriptor to JSONSchema7.
 * Cycle- and depth-guarded so a malformed schema with cyclic items /
 * properties degrades to a shallow object rather than blowing the stack.
 */
export function normalizePropertyToJsonSchema(
  property: any,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): JSONSchema7 {
  if (depth >= MAX_NORMALIZE_DEPTH) {
    return { type: 'object', description: 'truncated: max normalize depth' };
  }
  if (property && typeof property === 'object') {
    if (seen.has(property)) {
      return { type: 'object', description: 'truncated: cyclic reference' };
    }
    seen.add(property);
  }

  if (typeof property === 'object' && property.type) {
    return property as JSONSchema7;
  }

  const normalized: JSONSchema7 = { type: 'string' };

  if (property.type) normalized.type = property.type;
  if (property.description) normalized.description = property.description;
  if (property.example !== undefined) normalized.examples = [property.example];
  if (property.enum) normalized.enum = property.enum;
  if (property.format) normalized.format = property.format;
  if (property.minimum !== undefined) normalized.minimum = property.minimum;
  if (property.maximum !== undefined) normalized.maximum = property.maximum;
  if (property.minLength !== undefined) normalized.minLength = property.minLength;
  if (property.maxLength !== undefined) normalized.maxLength = property.maxLength;
  if (property.pattern) normalized.pattern = property.pattern;

  if (property.items) {
    normalized.items = normalizePropertyToJsonSchema(property.items, depth + 1, seen);
  }

  if (property.properties) {
    normalized.properties = {};
    for (const [name, prop] of Object.entries(property.properties)) {
      normalized.properties[name] = normalizePropertyToJsonSchema(prop, depth + 1, seen);
    }
  }

  if (property.required && Array.isArray(property.required)) {
    normalized.required = property.required;
  }

  return normalized;
}

export function translateOpenAPIOperationInput(operation: Operation): JSONSchema7 {
  const schema: JSONSchema7 = {
    type: 'object',
    title: `${operation.name} Input`,
    description: `Input parameters for ${operation.name}`,
    properties: {},
    required: [],
  };

  if (operation.parameters) {
    if (operation.parameters.path) {
      for (const [name, param] of Object.entries(operation.parameters.path)) {
        schema.properties![name] = normalizePropertyToJsonSchema(param);
        if (param.required) schema.required!.push(name);
      }
    }

    if (operation.parameters.query) {
      for (const [name, param] of Object.entries(operation.parameters.query)) {
        schema.properties![name] = normalizePropertyToJsonSchema(param);
        if (param.required) schema.required!.push(name);
      }
    }

    if (operation.parameters.header) {
      for (const [name, param] of Object.entries(operation.parameters.header)) {
        schema.properties![name] = normalizePropertyToJsonSchema(param);
        if (param.required) schema.required!.push(name);
      }
    }

    if (operation.parameters.body) {
      if (operation.parameters.body.schema) {
        if (typeof operation.parameters.body.schema === 'object') {
          Object.assign(schema, operation.parameters.body.schema);
        }
      } else if (Object.keys(operation.parameters.body).length > 0) {
        for (const [name, param] of Object.entries(operation.parameters.body)) {
          if (name !== 'schema' && typeof param === 'object') {
            schema.properties![name] = normalizePropertyToJsonSchema(param);
            if (param.required) schema.required!.push(name);
          }
        }
      }
    }
  }

  return schema;
}

export function translateOpenAPIOperationOutput(operation: Operation): JSONSchema7 {
  const schema: JSONSchema7 = {
    type: 'object',
    title: `${operation.name} Output`,
    description: `Output response for ${operation.name}`,
    properties: {},
  };

  if (operation.responses) {
    const successResponse = Object.entries(operation.responses)
      .find(([code]) => code.startsWith('2'))?.[1];

    if (successResponse && successResponse.schema && typeof successResponse.schema === 'object') {
      Object.assign(schema, successResponse.schema);
    }
  }

  return schema;
}

export function translateGraphQLOperationInput(operation: Operation): JSONSchema7 {
  const schema: JSONSchema7 = {
    type: 'object',
    title: `${operation.name} Variables`,
    description: `GraphQL variables for ${operation.name}`,
    properties: {},
    required: [],
  };

  if (operation.parameters?.body?.variables?.properties) {
    schema.properties = operation.parameters.body.variables.properties;
    schema.required = operation.parameters.body.variables.required || [];
  }

  return schema;
}

export function translateGraphQLOperationOutput(operation: Operation): JSONSchema7 {
  return {
    type: 'object',
    title: `${operation.name} Response`,
    description: `GraphQL response for ${operation.name}`,
    properties: {
      data: { type: 'object', description: 'GraphQL response data' },
      errors: {
        type: 'array',
        description: 'GraphQL errors',
        items: {
          type: 'object',
          properties: {
            message: { type: 'string' },
            path: { type: 'array' },
            extensions: { type: 'object' },
          },
        },
      },
    },
  };
}

export function translateSOAPOperationInput(operation: Operation): JSONSchema7 {
  return {
    type: 'object',
    title: `${operation.name} SOAP Request`,
    description: `SOAP request for ${operation.name}`,
    properties: {
      soapEnvelope: {
        type: 'object',
        properties: {
          'soap:Envelope': {
            type: 'object',
            properties: {
              'soap:Body': {
                type: 'object',
                properties: {
                  [operation.name]: {
                    type: 'object',
                    description: `${operation.name} parameters`,
                  },
                },
              },
            },
          },
        },
      },
    },
    required: ['soapEnvelope'],
  };
}

export function translateSOAPOperationOutput(operation: Operation): JSONSchema7 {
  return {
    type: 'object',
    title: `${operation.name} SOAP Response`,
    description: `SOAP response for ${operation.name}`,
    properties: {
      soapEnvelope: {
        type: 'object',
        properties: {
          'soap:Envelope': {
            type: 'object',
            properties: {
              'soap:Body': {
                type: 'object',
                properties: {
                  [`${operation.name}Response`]: {
                    type: 'object',
                    description: `${operation.name} response`,
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}

export function translateProtobufOperationInput(operation: Operation): JSONSchema7 {
  const schema: JSONSchema7 = {
    type: 'object',
    title: `${operation.name} gRPC Request`,
    description: `gRPC request for ${operation.name}`,
    properties: {},
  };

  if (operation.parameters?.body?.message?.properties) {
    schema.properties = operation.parameters.body.message.properties;
  }

  return schema;
}

export function translateProtobufOperationOutput(operation: Operation): JSONSchema7 {
  const schema: JSONSchema7 = {
    type: 'object',
    title: `${operation.name} gRPC Response`,
    description: `gRPC response for ${operation.name}`,
    properties: {},
  };

  if (operation.responses?.['200']?.schema?.properties) {
    schema.properties = operation.responses['200'].schema.properties;
  }

  return schema;
}
