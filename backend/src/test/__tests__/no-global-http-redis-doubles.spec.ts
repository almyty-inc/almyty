import { readFileSync } from 'fs';
import { join } from 'path';
import axios from 'axios';

/**
 * The global jest setup runs before every spec. It used to mock `axios`
 * (get/post/put/delete/patch/request as bare jest.fn()s answering
 * `undefined`) and `redis` (createClient returning a bag of jest.fn()s):
 * a spec reaching an outbound call or a redis command passed without
 * knowing it had, and a spec that declared its own `jest.mock('axios')`
 * got the setup's double instead of the automock it asked for. These pin
 * that both libraries are real under the setup.
 */
describe('global jest setup and axios / redis', () => {
  it('axios is the real library, not a bag of jest.fn()s', () => {
    expect(jest.isMockFunction(axios.get)).toBe(false);
    expect(jest.isMockFunction(axios.post)).toBe(false);
    expect(typeof axios.create).toBe('function');
    expect(typeof axios.isAxiosError).toBe('function');
    expect(axios.create({ baseURL: 'http://example.invalid' }).defaults.baseURL).toBe('http://example.invalid');
  });

  it('redis is the real library', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const redis = require('redis');
    expect(jest.isMockFunction(redis.createClient)).toBe(false);
    const client = redis.createClient({ url: 'redis://127.0.0.1:1' });
    // A real client is not connected until asked to be.
    expect(client.isOpen).toBe(false);
  });

  it('the setup file does not mock axios or redis', () => {
    const source = readFileSync(join(__dirname, '..', 'setup.ts'), 'utf8');
    expect(source).not.toMatch(/jest\.(mock|doMock)\(\s*['"`](axios|redis|ioredis)['"`]/);
  });
});
