import axios from 'axios';
import { readFileSync } from 'fs';
import { join } from 'path';

import { ToolHttpExecutor } from '../executors/tool-http.executor';
import { ToolStatus, ToolType } from '../../../entities/tool.entity';
import { fakeRepository } from '../../../test/fake-repository';
import { OpenAPIParserService } from '../../schema-parser/parsers/openapi-parser.service';
import { detectApiSchema } from '../../schema-parser/schema-detect';

jest.mock('axios', () => {
  const fn: any = jest.fn();
  fn.isAxiosError = () => false;
  return { __esModule: true, default: fn, isAxiosError: () => false };
});

const mockedAxios = axios as unknown as jest.Mock;

/**
 * Open-Meteo's forecast.yml declares its servers on the path, not the
 * document. The API's address and every generated tool must call the
 * server the description names for that operation, with the operation's
 * own `servers` over its path's (OpenAPI 3 precedence).
 */
describe('API tools call the server their path or operation declares', () => {
  const executor = new ToolHttpExecutor(
    { applyApiAuth: jest.fn(), applyInlineToolAuth: jest.fn() } as any,
    fakeRepository<any>([{ id: 'org-1', settings: {} }]) as any,
  );
  const tool = { id: 'tool-1', name: 'forecast', organizationId: 'org-1', status: ToolStatus.ACTIVE, type: ToolType.API, configuration: {} } as any;
  const text = readFileSync(join(__dirname, '../../schema-parser/__fixtures__/openapi3-path-servers.yaml'), 'utf8');

  async function imported() {
    const detected = detectApiSchema(text, { sourceUrl: 'https://raw.githubusercontent.com/open-meteo/open-meteo/main/openapi/forecast.yml' });
    const parser = new OpenAPIParserService();
    const operations = await parser.extractOperations(await parser.parseSchema(detected.content));
    const api = { id: 'api-1', organizationId: 'org-1', baseUrl: detected.baseUrl, headers: {}, timeoutMs: 1000 } as any;
    const byId = (id: string) => operations.find((o) => o.operationId === id)!;
    return { api, byId };
  }

  beforeEach(() => {
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ status: 200, data: { ok: true }, headers: {} });
  });

  it('a path-level server becomes the API address, and the tool calls it', async () => {
    const { api, byId } = await imported();
    expect(api.baseUrl).toBe('https://api.open-meteo.com');

    const result = await executor.executeRestOperation(tool, byId('getForecast'), api, { latitude: 52.52, longitude: 13.41 }, {} as any);

    expect(result.success).toBe(true);
    const config = mockedAxios.mock.calls[0][0];
    expect(config.url).toBe('https://api.open-meteo.com/v1/forecast');
    expect(config.params).toEqual({ latitude: 52.52, longitude: 13.41 });
  });

  it('an operation-level server wins over its path and the API address', async () => {
    const { api, byId } = await imported();
    expect(byId('getArchive').metadata).toEqual({ serverUrl: 'https://archive-api.open-meteo.com' });
    expect(byId('getForecast').metadata).toBeNull();

    await executor.executeRestOperation(tool, byId('getArchive'), api, { latitude: 52.52 }, {} as any);

    expect(mockedAxios.mock.calls[0][0].url).toBe('https://archive-api.open-meteo.com/v1/archive');
  });
});
