import {
  GraphQLField,
  GraphQLOutputType,
  getNamedType,
  isInterfaceType,
  isLeafType,
  isNonNullType,
  isObjectType,
} from 'graphql';

/**
 * The GraphQL document a generated tool sends: one operation that calls
 * one root field, its arguments passed as variables, and a selection set
 * built from the field's return type.
 *
 * A tool made from a GraphQL import has no query of its own to send,
 * and GraphQL servers answer a request without one with a 400. This is
 * the query the executor sends (operation.metadata.query).
 */
export interface GraphQLOperationDocument {
  query: string;
  operationName: string;
}

/**
 * How many levels of object fields the selection descends below the
 * root field: `country { continent { code } }` is two. Deeper objects
 * are left out; the caller can still pass a query of its own.
 */
export const MAX_SELECTION_DEPTH = 3;

/** Ceiling on fields in one document, so a wide schema stays a small request. */
export const MAX_SELECTED_FIELDS = 200;

type Kind = 'query' | 'mutation' | 'subscription';

export function buildOperationDocument(
  kind: Kind,
  fieldName: string,
  field: GraphQLField<any, any>,
): GraphQLOperationDocument {
  const operationName = fieldName.charAt(0).toUpperCase() + fieldName.slice(1);
  // graphql-js prints a type the way the SDL writes it: `[String!]!`.
  const variableDefs = field.args.map((arg) => `$${arg.name}: ${String(arg.type)}`);
  const argUses = field.args.map((arg) => `${arg.name}: $${arg.name}`);
  const budget = { left: MAX_SELECTED_FIELDS };
  const selection = selectionFor(field.type, 1, [], budget);

  const header = `${kind} ${operationName}${variableDefs.length ? `(${variableDefs.join(', ')})` : ''}`;
  const call = `${fieldName}${argUses.length ? `(${argUses.join(', ')})` : ''}`;
  const query = `${header} {\n  ${call}${selection ? ` ${selection}` : ''}\n}`;
  return { query, operationName };
}

/**
 * The selection set for a value of `type`, or '' for a scalar or enum
 * (which take none). `depth` is the nesting level of the set being built;
 * `path` holds the object types already open above it, so a cycle
 * (Country.continent -> Continent.countries -> Country) stops instead of
 * repeating.
 */
function selectionFor(
  type: GraphQLOutputType,
  depth: number,
  path: string[],
  budget: { left: number },
): string {
  const named = getNamedType(type);
  if (isLeafType(named)) return '';

  const lines: string[] = [];
  if (isObjectType(named) || isInterfaceType(named)) {
    const inner = [...path, named.name];
    for (const child of Object.values(named.getFields())) {
      if (budget.left <= 0) break;
      // A field with a required argument cannot be selected without a value for it.
      if (child.args.some((a) => isNonNullType(a.type) && a.defaultValue === undefined)) continue;
      const childNamed = getNamedType(child.type);
      if (isLeafType(childNamed)) {
        lines.push(child.name);
        budget.left--;
        continue;
      }
      if (depth >= MAX_SELECTION_DEPTH || inner.includes(childNamed.name)) continue;
      budget.left--;
      const sub = selectionFor(child.type, depth + 1, inner, budget);
      if (sub) lines.push(`${child.name} ${sub}`);
    }
  }
  // A union's members may share a field name at different types, which a
  // single document cannot select together; its type name is always valid.
  // An object whose fields were all left out selects the same.
  if (lines.length === 0) lines.push('__typename');

  const pad = '  '.repeat(depth + 1);
  const close = '  '.repeat(depth);
  return `{\n${lines.map((l) => `${pad}${l}`).join('\n')}\n${close}}`;
}

/** The arguments of a root field the caller has to give: non-null, no default. */
export function requiredArgumentNames(field: GraphQLField<any, any>): string[] {
  return field.args
    .filter((a) => isNonNullType(a.type) && a.defaultValue === undefined)
    .map((a) => a.name);
}
