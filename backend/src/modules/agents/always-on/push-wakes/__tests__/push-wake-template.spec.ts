import { parseExpiry, render, renderText, selectAll, selectOne } from '../push-wake-template';
import { PUSH_WAKE_PRESETS } from '../push-wake-presets';
import { checkSettings, checkSpec } from '../push-wake.types';

describe('push wake paths and templates', () => {
  const history = {
    history: [
      { id: '1', messagesAdded: [{ message: { id: 'm1' } }, { message: { id: 'm2' } }] },
      { id: '2', messages: [{ id: 'm9' }] },
      { id: '3', messagesAdded: [{ message: { id: 'm3' } }] },
    ],
    historyId: '77',
  };

  it('walks lists with [*] and picks with [key=value]', () => {
    expect(selectAll(history, 'history[*].messagesAdded[*].message.id')).toEqual(['m1', 'm2', 'm3']);
    const msg = { payload: { headers: [{ name: 'From', value: 'Ana <ana@x.test>' }, { name: 'Subject', value: 'Lunch' }] } };
    expect(selectOne(msg, 'payload.headers[name=Subject].value')).toBe('Lunch');
    expect(selectOne(msg, 'payload.headers[name=Cc].value')).toBeUndefined();
    expect(selectOne({ items: ['a', 'b'] }, 'items[1]')).toBe('b');
  });

  it('keeps a lone placeholder\'s type and leaves out what has no value', () => {
    const out = render(
      { query: { syncToken: '{{state.cursor}}', pageToken: '{{page}}', maxResults: 250 }, body: { id: '{{uuid}}', note: 'at {{now}}' } },
      { state: { cursor: 'tok' }, uuid: 'u-1', now: 'noon' },
    );
    expect(out).toEqual({ query: { syncToken: 'tok', maxResults: 250 }, body: { id: 'u-1', note: 'at noon' } });
    expect(render({ n: '{{count}}' }, { count: 3 })).toEqual({ n: 3 });
    expect(renderText('{{count}} new from {{last.from}}', { count: 2, last: { from: 'Ana' } })).toBe('2 new from Ana');
  });

  it('reads expiry as milliseconds, seconds or an ISO time', () => {
    expect(parseExpiry('1793000000000')?.toISOString()).toBe(new Date(1793000000000).toISOString());
    expect(parseExpiry(1793000000)?.toISOString()).toBe(new Date(1793000000000).toISOString());
    expect(parseExpiry('2026-10-29T10:00:00Z')?.toISOString()).toBe('2026-10-29T10:00:00.000Z');
    expect(parseExpiry('soon')).toBeNull();
    expect(parseExpiry(undefined)).toBeNull();
  });
});

describe('push wake specs are checked', () => {
  it('every preset is a valid spec (presets are data through the same check as a custom one)', () => {
    for (const preset of PUSH_WAKE_PRESETS) expect(() => checkSpec(preset.spec)).not.toThrow();
  });

  it('refuses a spec with no verification, a non-HTTPS key set, or renewal without subscribe', () => {
    expect(() => checkSpec({ summary: 'x' })).toThrow(/proves it came from the service/);
    expect(() => checkSpec({ verification: { method: 'oidc_jwt', issuers: ['i'], jwksUrl: 'http://keys.test' }, summary: 'x' })).toThrow(/HTTPS/);
    expect(() => checkSpec({ verification: { method: 'shared_token', headerName: 'x-t' }, renew: { everyMinutes: 60 }, summary: 'x' })).toThrow(/subscribe step/);
    expect(() =>
      checkSpec({ verification: { method: 'shared_token', headerName: 'x-t' }, changes: { operation: 'list', arguments: {}, itemsPath: 'items[*]', cursorPath: 'next', item: {} }, summary: 'x' }),
    ).toThrow(/each changed item/);
  });

  it('checks preset fields: required, pattern and defaults', () => {
    const gmail = PUSH_WAKE_PRESETS.find((p) => p.key === 'gmail')!;
    expect(() => checkSettings({}, gmail.fields)).toThrow(/pub\/sub topic/i);
    expect(() => checkSettings({ topicName: 'my-topic', pushServiceAccount: 'a@p.iam.gserviceaccount.com' }, gmail.fields)).toThrow(/does not look right/);
    expect(checkSettings({ topicName: 'projects/my-project/topics/almyty-gmail', pushServiceAccount: 'a@my-project.iam.gserviceaccount.com' }, gmail.fields)).toEqual({
      topicName: 'projects/my-project/topics/almyty-gmail',
      pushServiceAccount: 'a@my-project.iam.gserviceaccount.com',
      labelId: 'INBOX',
    });
  });
});
