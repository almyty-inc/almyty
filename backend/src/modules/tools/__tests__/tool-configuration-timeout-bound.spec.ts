import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateToolBodyDto, UpdateToolBodyDto } from '../dto/tools-controller.dto';

/**
 * `configuration` was validated as "an object" and nothing more, so a
 * tool could be saved with `configuration.timeout` of 10^9 ms. The script
 * executor handed that straight to the sandbox, where a worker spinning
 * under it held a slot of the process-wide pool for eleven days.
 *
 * A positive number of milliseconds, at most 300s (ExecuteToolDto.timeout
 * has the same ceiling). Everything else in
 * `configuration` is left alone: other keys (mcp, cache, rateLimit, ...)
 * are read by other paths and are not this check's business.
 */
describe('tool configuration.timeout is bounded at the API', () => {
  const base = { name: 'n', description: 'd', type: 'function', parameters: {} };

  async function errorsFor(cls: any, body: Record<string, any>): Promise<string[]> {
    const errors = await validate(plainToInstance(cls, body) as object);
    return errors.map((e) => e.property);
  }

  it.each([
    ['a timeout of 10^9 ms', 1_000_000_000],
    ['a timeout just past the cap', 300_001],
    ['a negative timeout', -1],
    ['zero', 0],
    ['a non-number', '30000'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('create refuses %s', async (_label, timeout) => {
    expect(await errorsFor(CreateToolBodyDto, { ...base, configuration: { timeout } })).toContain(
      'configuration',
    );
  });

  it.each([
    ['a timeout of 10^9 ms', 1_000_000_000],
    ['a non-number', '30000'],
  ])('update refuses %s', async (_label, timeout) => {
    expect(await errorsFor(UpdateToolBodyDto, { configuration: { timeout } })).toContain(
      'configuration',
    );
  });

  it.each([
    ['no timeout', { retries: 2 }],
    ['the default', { timeout: 30_000 }],
    ['the cap itself', { timeout: 300_000 }],
    ['other keys alongside', { timeout: 5_000, mcp: { sourceId: 's' }, cache: { enabled: true } }],
  ])('accepts %s', async (_label, configuration) => {
    expect(await errorsFor(CreateToolBodyDto, { ...base, configuration })).not.toContain(
      'configuration',
    );
    expect(await errorsFor(UpdateToolBodyDto, { configuration })).not.toContain('configuration');
  });
});
