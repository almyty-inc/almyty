import { Operation } from '../../../entities/operation.entity';
import { GraphQLRequest } from '../tool-execution.types';

/**
 * The request body a tool generated from a GraphQL import sends.
 *
 * The import builds one document per root field and keeps it on the
 * operation (`metadata.query`, graphql-operation-document.ts); the tool's
 * inputs are that field's arguments, sent as variables. A caller may
 * still pass a `query` of its own (with `variables`/`operationName`),
 * unless the field has an argument of that name: then the value is the
 * argument, and the stored document is sent.
 *
 * An operation stored without a document (older imports) keeps the
 * earlier shape: `parameters.query`, and every other key as a variable.
 */
export function graphqlOperationRequest(
  operation: Pick<Operation, 'metadata' | 'parameters'>,
  parameters: Record<string, any>,
): GraphQLRequest {
  const params = parameters || {};
  const stored: string | undefined = (operation.metadata as any)?.query;
  const declared: Record<string, unknown> =
    (operation.parameters as any)?.body?.variables?.properties ?? {};
  const isArg = (name: string) => Object.prototype.hasOwnProperty.call(declared, name);

  const ownQuery = !isArg('query') && typeof params.query === 'string' && params.query.trim() ? params.query : undefined;

  if (stored && !ownQuery) {
    const source =
      !isArg('variables') && params.variables && typeof params.variables === 'object' && !Array.isArray(params.variables)
        ? params.variables
        : params;
    const variables: Record<string, any> = {};
    for (const name of Object.keys(declared)) {
      if (source[name] !== undefined) variables[name] = source[name];
    }
    return {
      query: stored,
      variables,
      operationName: (operation.metadata as any)?.operationName,
    };
  }

  let variables: Record<string, any>;
  if (params.variables !== undefined && !isArg('variables')) {
    variables = params.variables;
  } else {
    const { query: _q, variables: _v, operationName: _o, ...rest } = params;
    variables = rest;
  }
  return {
    query: ownQuery ?? params.query,
    variables,
    operationName: params.operationName,
  };
}

/** The endpoint path imports stored before they kept the API's own address. */
const LEGACY_GRAPHQL_PATH = '/graphql';

/**
 * Where a tool generated from a GraphQL import sends its request: the
 * API's address, which is the endpoint it was imported from (the URL
 * that answered introspection, or the address the person gave).
 * GraphQL has one endpoint; the import stores no path of its own.
 *
 * Operations imported earlier carry the path `/graphql`, which used to
 * be appended to every address. When the address already has a path of
 * its own (`https://graphqlzero.almansi.me/api`) that path is the
 * endpoint and is used as it is; a bare host keeps getting `/graphql`,
 * as it did when it was imported.
 */
export function graphqlTargetUrl(baseUrl: string, endpoint?: string | null): string {
  const base = baseUrl || '';
  if (!endpoint) return base;
  if (endpoint === LEGACY_GRAPHQL_PATH) {
    try {
      const path = new URL(base).pathname;
      if (path !== '' && path !== '/') return base;
    } catch {
      /* not a URL: join as before */
    }
  }
  const trimmed = base.replace(/(?<!\/)\/+$/, '');
  const path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  if (trimmed.endsWith(path)) return trimmed;
  return `${trimmed}${path}`;
}
