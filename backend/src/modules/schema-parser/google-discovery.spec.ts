import { readFileSync } from 'fs';
import { join } from 'path';

import { ApiType } from '../../entities/api.entity';
import { detectApiSchema } from './schema-detect';
import { discoveryToOpenApi, GOOGLE_AUTHORIZATION_URL, GOOGLE_TOKEN_URL } from './google-discovery';
import { OpenAPIParserService } from './parsers/openapi-parser.service';
import { SchemaParserService } from './schema-parser.service';

/**
 * Google publishes its APIs as discovery documents, not OpenAPI. Pasting
 * https://tasks.googleapis.com/$discovery/rest?version=v1 into Connect an
 * API said "This link doesn't return an API description". The fixture is
 * Google's real Tasks document, as published.
 */
const tasks = readFileSync(join(__dirname, '__fixtures__', 'google-tasks-discovery.json'), 'utf8');

describe("Google's discovery documents", () => {
  it('are read as OpenAPI: name, address and a Google sign-in with the scopes the API declares', () => {
    const found = detectApiSchema(tasks, { sourceUrl: 'https://tasks.googleapis.com/$discovery/rest?version=v1' });
    expect(found).toMatchObject({ type: ApiType.OPENAPI, format: 'openapi3', name: 'Google Tasks API', baseUrl: 'https://tasks.googleapis.com' });
    expect(found.auth).toEqual({
      type: 'oauth2',
      oauth2: {
        flow: 'authorization_code',
        authorizationUrl: GOOGLE_AUTHORIZATION_URL,
        tokenUrl: GOOGLE_TOKEN_URL,
        scopes: ['https://www.googleapis.com/auth/tasks', 'https://www.googleapis.com/auth/tasks.readonly'],
      },
    });
  });

  it('turn every method into an operation the parser reads, with its path and body parameters', async () => {
    const found = detectApiSchema(tasks);
    const parsed = await new SchemaParserService(new OpenAPIParserService(), {} as any, {} as any, {} as any).parseApiSchema(found.content, found.type);
    const ids = parsed.operations.map((o: any) => o.operationId ?? o.name);
    expect(ids).toEqual(expect.arrayContaining(['tasks.tasklists.list', 'tasks.tasks.list', 'tasks.tasks.insert']));
    expect(parsed.operations).toHaveLength(14);
    const list = parsed.operations.find((o: any) => (o.operationId ?? o.name) === 'tasks.tasks.list') as any;
    expect(list.endpoint ?? list.path).toBe('/tasks/v1/lists/{tasklist}/tasks');
  });

  it('leave out the transport parameters every Google method takes', () => {
    const doc = discoveryToOpenApi(JSON.parse(tasks));
    const names = doc.paths['/tasks/v1/users/@me/lists'].get.parameters.map((p: any) => p.name);
    expect(names).not.toEqual(expect.arrayContaining(['alt', 'key', 'prettyPrint', 'quotaUser', 'oauth_token', 'fields']));
    expect(names).toEqual(expect.arrayContaining(['maxResults', 'pageToken']));
  });

  it('point $refs at components and keep reserved-expansion paths as plain parameters', () => {
    const doc = discoveryToOpenApi({
      kind: 'discovery#restDescription',
      rootUrl: 'https://gmail.googleapis.com/',
      servicePath: '',
      title: 'Gmail API',
      schemas: { Message: { type: 'object', properties: { raw: { type: 'string' }, labelIds: { type: 'array', items: { type: 'string' } } } } },
      resources: {
        users: {
          resources: {
            messages: {
              methods: {
                send: { id: 'gmail.users.messages.send', path: 'gmail/v1/users/{userId}/messages/send', httpMethod: 'POST', parameters: { userId: { type: 'string', location: 'path', required: true } }, request: { $ref: 'Message' }, response: { $ref: 'Message' } },
                get: { id: 'x.get', path: 'v1/{+name}', httpMethod: 'GET', parameters: { name: { type: 'string', location: 'path' } } },
              },
            },
          },
        },
      },
    });
    expect(doc.servers[0].url).toBe('https://gmail.googleapis.com/');
    expect(doc.paths['/gmail/v1/users/{userId}/messages/send'].post.requestBody.content['application/json'].schema).toEqual({ $ref: '#/components/schemas/Message' });
    expect(doc.paths['/v1/{name}'].get.parameters[0]).toMatchObject({ name: 'name', in: 'path', required: true });
    expect(doc.components.schemas.Message.properties.labelIds).toEqual({ type: 'array', items: { type: 'string' } });
  });
});
