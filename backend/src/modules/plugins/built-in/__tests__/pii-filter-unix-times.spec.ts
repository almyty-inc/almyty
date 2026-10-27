import { PiiFilterPlugin, isUnixTimeInContext } from '../pii-filter.plugin';
import { PluginHookType } from '../../types/plugin.types';

/**
 * A run step that read Stripe payouts showed `"arrival_date": "******0800"`:
 * the ten digits of a Unix time match the phone pattern. A Unix time where
 * a time is meant stays as it is; a phone number is still masked.
 */
describe('PII filter: Unix times are not phone numbers', () => {
  const plugin = new PiiFilterPlugin();
  const settings = () => ({ ...plugin.getPluginDefinition().configuration.settings });
  const filter = async (data: unknown, s: any = settings()) =>
    (await plugin.filterPiiFromData({ hookType: PluginHookType.DATA_FILTER, data } as any, s)).data;

  it('keeps a Unix time in a time-named field', async () => {
    const out = await filter({ arrival_date: '1696204800', created: '1696118400', available_on: '1696204800', periodStart: '1696204800' });
    expect(out).toEqual({ arrival_date: '1696204800', created: '1696118400', available_on: '1696204800', periodStart: '1696204800' });
  });

  it('keeps a Unix time written after a time-named key in text (a tool result as JSON text)', async () => {
    const text = '{"id":"po_1","amount":5000,"arrival_date": 1696204800,"created":1696118400}';
    expect(await filter({ output: text })).toEqual({ output: text });
    expect(await filter('created=1696118400&limit=10')).toBe('created=1696118400&limit=10');
  });

  it('keeps a Unix time next to an ISO date', async () => {
    const text = 'Paid out 1696204800 (2023-10-02T00:00:00Z)';
    expect(await filter(text)).toBe(text);
  });

  it('still masks phone numbers, including ten bare digits under a phone key or with no time around', async () => {
    const out: any = await filter({
      phone: '2125551234',
      contact: 'Call 212-555-1234 today',
      note: 'reach me on 2125551234',
      created: '212-555-1234',
    });
    expect(out.phone).toBe('******1234');
    expect(out.contact).toBe('Call ********1234 today');
    expect(out.note).toBe('reach me on ******1234');
    // Separators make it a phone number whatever the field says.
    expect(out.created).toBe('********1234');
    expect(await filter('{"phone": "1696204800"}')).toBe('{"phone": "******0800"}');
  });

  it('masks numbers outside the Unix-time range even in a time field', async () => {
    expect(await filter({ created: '5551234567' })).toEqual({ created: '******4567' });
  });

  it('masks them again with keepUnixTimestamps: false, and takes its own field pattern', async () => {
    expect(await filter({ created: '1696118400' }, { ...settings(), keepUnixTimestamps: false })).toEqual({ created: '******8400' });
    expect(await filter({ when_paid: '1696118400', created: '1696118400' }, { ...settings(), timestampFieldPattern: '^when_' })).toEqual({
      when_paid: '1696118400',
      created: '******8400',
    });
  });

  it('defaults keep Unix times on, with the field pattern visible in the settings', () => {
    expect(settings()).toMatchObject({ keepUnixTimestamps: true, timestampFieldPattern: expect.any(String) });
    expect(isUnixTimeInContext('1696204800', '1696204800', 0, 'expires_at', {})).toBe(true);
    expect(isUnixTimeInContext('1696204800', '1696204800', 0, 'mobile', {})).toBe(false);
  });
});
