/**
 * Pure helpers for GraphQL skill rendering: query templating,
 * selection-set building, JSON-schema → GraphQL type mapping, and
 * the kebab-segment dedup used to keep tool names short. No DI;
 * callers pass operations / strings directly.
 */

export function jsonTypeToGraphQLType(t: string | undefined): string {
  switch ((t || '').toLowerCase()) {
    case 'integer':
    case 'int':
      return 'Int';
    case 'number':
    case 'float':
      return 'Float';
    case 'boolean':
    case 'bool':
      return 'Boolean';
    case 'array':
      return '[String]';
    case 'string':
    default:
      return 'String';
  }
}

/** Unwrap a JSON-schema array wrapper to expose the item shape. */
export function unwrapReturnType(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema;
  if (schema.type === 'array' && schema.items) {
    return unwrapReturnType(schema.items);
  }
  return schema;
}

/**
 * Render a starter selection set for the operation's return type.
 * Includes scalar/enum leaf fields directly. For nested object
 * fields, emits a nested block with `__typename` so the query is
 * still syntactically complete — the agent can flesh it out.
 */
export function buildGraphQLSelectionSet(operation: any): string {
  const dataSchema = unwrapReturnType(
    operation.responses?.['200']?.schema?.properties?.data,
  );
  const props = dataSchema?.properties as Record<string, any> | undefined;
  if (!props || Object.keys(props).length === 0) {
    return `{\n    __typename\n  }`;
  }

  const lines: string[] = [];
  for (const [name, prop] of Object.entries(props)) {
    const inner = unwrapReturnType(prop);
    if (!inner) continue;
    if (inner.type === 'object') {
      lines.push(`${name} {\n      __typename\n    }`);
    } else if (inner.type === 'array' && (inner.items as any)?.type === 'object') {
      lines.push(`${name} {\n      __typename\n    }`);
    } else {
      lines.push(name);
    }
  }
  if (lines.length === 0) {
    return `{\n    __typename\n  }`;
  }
  return `{\n    ${lines.join('\n    ')}\n  }`;
}

export function buildGraphQLQueryTemplate(operation: any): string {
  const opType: 'query' | 'mutation' | 'subscription' =
    operation.type === 'mutation' || operation.type === 'subscription'
      ? operation.type
      : 'query';
  const opName = operation.name || 'op';
  const vars = (operation.parameters?.body?.variables?.properties || {}) as Record<string, any>;
  const required = new Set<string>(operation.parameters?.body?.variables?.required || []);

  const declarations: string[] = [];
  const args: string[] = [];
  for (const [name, schema] of Object.entries(vars)) {
    // The GraphQL parser stores the original type signature on
    // `schema.gqlType` ("ID!", "[String!]!", "Int") — use it directly
    // when present so re-rendered queries faithfully match the
    // server's expected variable types. Older imports without that
    // field fall back to the JSON-schema → GraphQL best-effort
    // mapping plus a `required` boolean.
    let decl: string;
    if (typeof schema?.gqlType === 'string' && schema.gqlType.length > 0) {
      decl = schema.gqlType;
    } else {
      const gqlType = jsonTypeToGraphQLType(schema?.type);
      const bang = required.has(name) ? '!' : '';
      decl = `${gqlType}${bang}`;
    }
    declarations.push(`$${name}: ${decl}`);
    args.push(`${name}: $${name}`);
  }

  const head = declarations.length
    ? `${opType} ${opName}(${declarations.join(', ')})`
    : `${opType} ${opName}`;
  const argsBlock = args.length ? `(${args.join(', ')})` : '';
  const selection = buildGraphQLSelectionSet(operation);
  return `${head} {\n  ${opName}${argsBlock} ${selection}\n}`;
}

/**
 * Drop kebab segments from the head of `tail` that are already present
 * at the head of `head` (in order). Walks one segment at a time so
 * partial matches don't false-positive.
 */
export function dedupeSharedSegments(head: string, tail: string): string {
  const headParts = head.split('-').filter(Boolean);
  const tailParts = tail.split('-').filter(Boolean);
  let i = 0;
  while (
    i < tailParts.length &&
    i < headParts.length &&
    tailParts[i] === headParts[i]
  ) {
    i++;
  }
  return tailParts.slice(i).join('-');
}
