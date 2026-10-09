import axios from 'axios';

import { ToolHttpExecutor } from '../executors/tool-http.executor';
import { ToolStatus, ToolType } from '../../../entities/tool.entity';
import { fakeRepository } from '../../../test/fake-repository';

jest.mock('axios', () => {
  const fn: any = jest.fn();
  fn.isAxiosError = () => false;
  return { __esModule: true, default: fn, isAxiosError: () => false };
});

const mockedAxios = axios as unknown as jest.Mock;

/**
 * An imported API's tool calls its address plus the operation's path with
 * exactly one slash between them. Google's published descriptions declare
 * servers ending in "/" (https://gmail.googleapis.com/) and paths starting
 * with one (/gmail/v1/users/{userId}/messages); gluing them as-is sent
 * every Gmail and Tasks call to "//gmail/v1/...".
 */
describe('an API tool joins the address and the path with one slash', () => {
  const executor = new ToolHttpExecutor({ applyApiAuth: jest.fn(), applyInlineToolAuth: jest.fn() } as any, fakeRepository<any>([]) as any);
  const tool = { id: 'tool-1', name: 'gmail_users_messages_list', organizationId: 'org-1', status: ToolStatus.ACTIVE, type: ToolType.API, configuration: {} } as any;
  const call = async (baseUrl: string, endpoint: string) => {
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ status: 200, data: { messages: [] }, headers: {} });
    const api = { id: 'api-1', organizationId: 'org-1', baseUrl, headers: {}, timeoutMs: 1000 } as any;
    await executor.executeRestOperation(tool, { method: 'GET', endpoint, parameters: {} } as any, api, { userId: 'me' }, {} as any);
    return mockedAxios.mock.calls[0][0].url as string;
  };

  it('drops the doubled slash when the address ends in one', async () => {
    expect(await call('https://gmail.googleapis.com/', '/gmail/v1/users/{userId}/messages')).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages');
  });

  it('adds the slash when neither side has one', async () => {
    expect(await call('https://api.example.com/v2', 'orders')).toBe('https://api.example.com/v2/orders');
  });

  it('keeps an address with a path and a path that starts with a slash as before', async () => {
    expect(await call('https://www.googleapis.com/calendar/v3', '/users/me/calendarList')).toBe('https://www.googleapis.com/calendar/v3/users/me/calendarList');
  });
});
