import axios from 'axios';
import { readFileSync } from 'fs';
import { join } from 'path';

import { detectApiSchema } from '../schema-detect';
import { OpenAPIParserService } from '../parsers/openapi-parser.service';
import { SchemaParserService } from '../schema-parser.service';
import { ToolHttpExecutor } from '../../tools/executors/tool-http.executor';
import { ToolStatus, ToolType } from '../../../entities/tool.entity';
import { fakeRepository } from '../../../test/fake-repository';

jest.mock('axios', () => {
  const fn: any = jest.fn();
  fn.isAxiosError = () => false;
  return { __esModule: true, default: fn, isAxiosError: () => false };
});

const mockedAxios = axios as unknown as jest.Mock;

/**
 * Building the onboarding tutorial on Google Drive: creating a file with
 * `fields: "id,webViewLink"` sent `fields` in the JSON body, where Drive
 * ignores it, so the answer never had the link. Drive's standard
 * parameters (the discovery document's top-level `parameters`) and its
 * per-method `location: "query"` parameters go in the query string. The
 * fixture is Google's Drive v3 discovery document, trimmed to four methods
 * of `files` and the schemas they use.
 */
const drive = readFileSync(join(__dirname, '..', '__fixtures__', 'google-drive-discovery.json'), 'utf8');

describe('A Drive tool imported from its discovery document', () => {
  let operations: any[];

  beforeAll(async () => {
    const found = detectApiSchema(drive, { sourceUrl: 'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest' });
    const parsed = await new SchemaParserService(new OpenAPIParserService(), {} as any, {} as any, {} as any).parseApiSchema(found.content, found.type);
    operations = parsed.operations as any[];
  });

  const named = (id: string) => operations.find(o => (o.operationId ?? o.name) === id);

  it('declares fields and the method query parameters as query parameters', () => {
    const create = named('drive.files.create');
    expect(Object.keys(create.parameters.query)).toEqual(expect.arrayContaining(['fields', 'supportsAllDrives', 'quotaUser']));
    expect(create.parameters.body).toBeDefined();
    expect(Object.keys(create.parameters.query)).not.toEqual(expect.arrayContaining(['key', 'access_token', 'alt']));
    expect(Object.keys(named('drive.files.list').parameters.query)).toEqual(expect.arrayContaining(['fields', 'q', 'pageSize']));
  });

  it('sends fields in the query string and only the file in the body when creating a file', async () => {
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ status: 200, data: { id: 'f1', webViewLink: 'https://drive.google.com/f1' }, headers: {} });
    const executor = new ToolHttpExecutor(
      { applyApiAuth: jest.fn(), applyInlineToolAuth: jest.fn() } as any,
      fakeRepository<any>([{ id: 'org-1', settings: {} }]) as any,
    );
    const create = named('drive.files.create');
    const api = { id: 'api-1', organizationId: 'org-1', baseUrl: 'https://www.googleapis.com/drive/v3/', headers: {} } as any;
    const tool = { id: 't-1', name: 'drive_files_create', organizationId: 'org-1', status: ToolStatus.ACTIVE, type: ToolType.API, configuration: {} } as any;
    const operation = { method: String(create.method).toUpperCase(), endpoint: create.endpoint ?? create.path, parameters: create.parameters } as any;

    const result = await executor.executeRestOperation(
      tool,
      operation,
      api,
      { name: 'Weekly report', mimeType: 'application/vnd.google-apps.document', fields: 'id,webViewLink', supportsAllDrives: true },
      {} as any,
    );

    expect(result.success).toBe(true);
    const config = mockedAxios.mock.calls[0][0];
    expect(config.url).toBe('https://www.googleapis.com/drive/v3/files');
    expect(config.params).toEqual({ fields: 'id,webViewLink', supportsAllDrives: true });
    expect(config.data).toEqual({ name: 'Weekly report', mimeType: 'application/vnd.google-apps.document' });
  });
});
