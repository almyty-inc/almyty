import { getMetadataStorage } from 'class-validator';
import { defaultMetadataStorage } from 'class-transformer/cjs/storage';

/**
 * A JSON Schema for a request DTO, read from the class-validator
 * decorators the global ValidationPipe enforces on it.
 *
 * The management MCP's operations run the route's own handler, and the
 * handler's DTO is validated exactly as over HTTP. This schema is how an
 * MCP client learns the shape before it calls: it is derived from the
 * same decorators, so the two cannot disagree about which fields exist or
 * which are required. Constraints this mapping does not know (a custom
 * validator, a cross-field rule) are still enforced at call time; the
 * schema simply does not spell them out.
 */
export type JsonSchema = Record<string, any>;

const PRIMITIVES = new Set<unknown>([String, Number, Boolean, Object, Array, Date, undefined, null]);

/** Is `metatype` a DTO class the ValidationPipe would validate? */
export function isDtoClass(metatype: unknown): metatype is new (...args: any[]) => any {
  return typeof metatype === 'function' && !PRIMITIVES.has(metatype) && !!metatype.prototype;
}

function constraintSchema(name: string, constraints: any[] | undefined, schema: JsonSchema): void {
  const c = constraints ?? [];
  switch (name) {
    case 'isString':
    case 'isNotEmpty':
    case 'isUUID':
    case 'isUrl':
    case 'isEmail':
    case 'isDateString':
    case 'isISO8601':
    case 'matches':
    case 'minLength':
    case 'maxLength':
    case 'isHexColor':
    case 'isFQDN':
    case 'isJWT':
    case 'isAlphanumeric':
    case 'length':
      if (!schema.type) schema.type = 'string';
      if (name === 'isUUID') schema.format = 'uuid';
      if (name === 'isUrl') schema.format = 'uri';
      if (name === 'isEmail') schema.format = 'email';
      if (name === 'isDateString' || name === 'isISO8601') schema.format = 'date-time';
      if (name === 'minLength' && typeof c[0] === 'number') schema.minLength = c[0];
      if (name === 'maxLength' && typeof c[0] === 'number') schema.maxLength = c[0];
      if (name === 'length') {
        if (typeof c[0] === 'number') schema.minLength = c[0];
        if (typeof c[1] === 'number') schema.maxLength = c[1];
      }
      if (name === 'isNotEmpty' && schema.type === 'string' && schema.minLength === undefined) schema.minLength = 1;
      break;
    case 'isNumber':
    case 'isNumberString':
      schema.type = name === 'isNumberString' ? 'string' : 'number';
      break;
    case 'isInt':
      schema.type = 'integer';
      break;
    case 'isPositive':
      schema.exclusiveMinimum = 0;
      break;
    case 'min':
      if (typeof c[0] === 'number') schema.minimum = c[0];
      break;
    case 'max':
      if (typeof c[0] === 'number') schema.maximum = c[0];
      break;
    case 'isBoolean':
    case 'isBooleanString':
      schema.type = name === 'isBoolean' ? 'boolean' : 'string';
      break;
    case 'isEnum': {
      const values = c[0] && typeof c[0] === 'object' ? Object.values(c[0]) : [];
      // A numeric TS enum carries its reverse map; keep the values only.
      const enumValues = values.filter((v) => typeof v !== 'string' || !values.includes(Number(v) as any));
      if (enumValues.length) schema.enum = [...new Set(enumValues)];
      break;
    }
    case 'isIn':
      if (Array.isArray(c[0])) schema.enum = c[0];
      break;
    case 'isArray':
      schema.type = 'array';
      break;
    case 'arrayMinSize':
      if (typeof c[0] === 'number') schema.minItems = c[0];
      break;
    case 'arrayMaxSize':
      if (typeof c[0] === 'number') schema.maxItems = c[0];
      break;
    case 'isObject':
      schema.type = 'object';
      break;
    case 'isDate':
      schema.type = 'string';
      schema.format = 'date-time';
      break;
    default:
      break;
  }
}

/**
 * The schema of one DTO class: its validated properties, which of them are
 * required (validated and not `@IsOptional`), and `additionalProperties:
 * false`, because the global pipe runs with `forbidNonWhitelisted`.
 */
export function dtoSchema(dto: new (...args: any[]) => any, depth = 0): JsonSchema {
  const metadatas = getMetadataStorage().getTargetValidationMetadatas(dto, '', true, false);
  const properties: Record<string, JsonSchema> = {};
  const optional = new Set<string>();
  for (const meta of metadatas) {
    const prop = meta.propertyName;
    const schema = (properties[prop] ??= {});
    if (meta.type === 'conditionalValidation') {
      optional.add(prop);
      continue;
    }
    if (meta.type === 'nestedValidation') {
      const typeMeta = defaultMetadataStorage.findTypeMetadata(dto, prop);
      const nested = typeMeta?.typeFunction?.();
      const nestedSchema = depth < 3 && isDtoClass(nested) ? dtoSchema(nested, depth + 1) : { type: 'object' };
      if (meta.each || schema.type === 'array') {
        schema.type = 'array';
        schema.items = nestedSchema;
      } else {
        Object.assign(schema, nestedSchema);
      }
      continue;
    }
    if (meta.type !== 'customValidation' || !meta.name) continue;
    if (meta.each) {
      schema.type = 'array';
      schema.items ??= {};
      constraintSchema(meta.name, meta.constraints, schema.items);
    } else if (schema.type === 'array' && meta.name !== 'isArray' && !meta.name.startsWith('array')) {
      schema.items ??= {};
      constraintSchema(meta.name, meta.constraints, schema.items);
    } else {
      constraintSchema(meta.name, meta.constraints, schema);
    }
  }
  const required = Object.keys(properties).filter((p) => !optional.has(p));
  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}
