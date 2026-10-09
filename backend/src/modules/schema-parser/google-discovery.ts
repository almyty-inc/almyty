/**
 * Google's API descriptions, read as OpenAPI.
 *
 * Google publishes its APIs (Calendar, Gmail, Tasks, Drive, Sheets, ...)
 * as "discovery documents" (`kind: discovery#restDescription`), not as
 * OpenAPI. Pasting one used to be refused with "This link doesn't return
 * an API description". This turns one into the OpenAPI 3 document the
 * importer already reads: every method becomes an operation, its schemas
 * become components, and the sign-in becomes Google's OAuth 2.0 flow with
 * the scopes the API declares, so "Create one here" asks only for the
 * client ID and secret of the person's own Google Cloud app.
 *
 * Pure: no I/O.
 */

export const GOOGLE_AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Parameters every Google method accepts that are about transport, not the call (alt, fields, prettyPrint, ...). */
const TRANSPORT_PARAMETERS = new Set([
  '$.xgafv', 'access_token', 'alt', 'callback', 'fields', 'key', 'oauth_token', 'prettyPrint', 'quotaUser', 'upload_protocol', 'uploadType', 'userIp',
]);

export function isGoogleDiscoveryDocument(doc: unknown): boolean {
  const d = doc as any;
  return !!d && typeof d === 'object' && d.kind === 'discovery#restDescription' && typeof d.rootUrl === 'string';
}

/** A discovery schema (or property) as JSON Schema, with `$ref: "Event"` pointing into components. */
function schemaOf(s: any, depth = 0): any {
  if (!s || typeof s !== 'object' || depth > 32) return {};
  if (typeof s.$ref === 'string') return { $ref: `#/components/schemas/${s.$ref}` };
  const out: any = {};
  for (const key of ['type', 'format', 'description', 'enum', 'default', 'pattern', 'minimum', 'maximum', 'readOnly']) {
    if (s[key] !== undefined) out[key] = s[key];
  }
  if (out.type === 'any') delete out.type;
  if (s.properties && typeof s.properties === 'object') {
    out.properties = {};
    for (const [name, prop] of Object.entries(s.properties)) out.properties[name] = schemaOf(prop, depth + 1);
  }
  if (s.items) out.items = schemaOf(s.items, depth + 1);
  if (s.additionalProperties) out.additionalProperties = schemaOf(s.additionalProperties, depth + 1);
  return out;
}

/** `{+name}` (reserved expansion) is a plain path parameter to the importer. */
function pathOf(method: any): string {
  const raw = String(method.flatPath ?? method.path ?? '');
  return `/${raw.replace(/^\/+/, '').replace(/\{\+([^}]+)\}/g, '{$1}')}`;
}

function collectMethods(node: any, out: any[], depth = 0): void {
  if (!node || typeof node !== 'object' || depth > 16) return;
  for (const method of Object.values(node.methods ?? {})) out.push(method);
  for (const resource of Object.values(node.resources ?? {})) collectMethods(resource, out, depth + 1);
}

export function discoveryToOpenApi(doc: any): any {
  const rootUrl = String(doc.rootUrl ?? '').replace(/\/+$/, '');
  const servicePath = String(doc.servicePath ?? '').replace(/^\/+|\/+$/g, '');
  const scopes: Record<string, string> = {};
  for (const [scope, info] of Object.entries<any>(doc.auth?.oauth2?.scopes ?? {})) scopes[scope] = String(info?.description ?? '');

  const methods: any[] = [];
  collectMethods(doc, methods);

  const paths: Record<string, any> = {};
  for (const method of methods) {
    const httpMethod = String(method.httpMethod ?? 'GET').toLowerCase();
    const path = pathOf(method);
    const parameters = Object.entries<any>({ ...(doc.parameters ?? {}), ...(method.parameters ?? {}) })
      .filter(([name]) => !TRANSPORT_PARAMETERS.has(name))
      .map(([name, p]) => {
        const location = p.location === 'path' ? 'path' : 'query';
        const schema = schemaOf(p);
        return {
          name,
          in: location,
          required: location === 'path' ? true : p.required === true,
          ...(p.description ? { description: String(p.description) } : {}),
          schema: p.repeated ? { type: 'array', items: schema } : schema,
        };
      });
    const operation: any = {
      operationId: String(method.id ?? `${httpMethod}${path}`),
      summary: method.description ? String(method.description).split(/(?<=\.)\s/)[0] : undefined,
      description: method.description ? String(method.description) : undefined,
      parameters,
      responses: {
        '200': {
          description: 'Successful response',
          ...(method.response ? { content: { 'application/json': { schema: schemaOf(method.response) } } } : {}),
        },
      },
    };
    if (method.request) operation.requestBody = { content: { 'application/json': { schema: schemaOf(method.request) } } };
    if (Array.isArray(method.scopes) && method.scopes.length) operation.security = [{ Oauth2: method.scopes }];
    paths[path] = { ...(paths[path] ?? {}), [httpMethod]: operation };
  }

  const schemas: Record<string, any> = {};
  for (const [name, schema] of Object.entries<any>(doc.schemas ?? {})) schemas[name] = schemaOf(schema);

  return {
    openapi: '3.0.0',
    info: {
      title: String(doc.title ?? doc.name ?? 'Google API'),
      version: String(doc.version ?? ''),
      ...(doc.description ? { description: String(doc.description) } : {}),
    },
    servers: [{ url: servicePath ? `${rootUrl}/${servicePath}` : `${rootUrl}/` }],
    paths,
    components: {
      schemas,
      ...(Object.keys(scopes).length
        ? {
            securitySchemes: {
              Oauth2: {
                type: 'oauth2',
                description: 'Sign in with Google',
                flows: { authorizationCode: { authorizationUrl: GOOGLE_AUTHORIZATION_URL, tokenUrl: GOOGLE_TOKEN_URL, scopes } },
              },
            },
          }
        : {}),
    },
  };
}
