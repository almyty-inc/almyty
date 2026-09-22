import { APP_PRIVACY_DEFAULTS, appPrivacyFrom } from '../agent-app.entity';

describe('appPrivacyFrom', () => {
  it('gives an app with nothing stored the defaults', () => {
    expect(appPrivacyFrom(null)).toEqual(APP_PRIVACY_DEFAULTS);
    expect(appPrivacyFrom(undefined)).toEqual(APP_PRIVACY_DEFAULTS);
    expect(appPrivacyFrom({})).toEqual(APP_PRIVACY_DEFAULTS);
  });

  it('defaults to visitors keeping control and their words staying out of shared memory', () => {
    const d = appPrivacyFrom(null);
    expect(d.visitorCanDelete).toBe(true);
    expect(d.visitorCanExport).toBe(true);
    expect(d.visitorMemory).toBe(false);
    expect(d.retentionDays).toBeNull();
  });

  it('honours stored values field by field', () => {
    expect(appPrivacyFrom({ visitorCanDelete: false })).toMatchObject({ visitorCanDelete: false, visitorCanExport: true });
    expect(appPrivacyFrom({ visitorMemory: true }).visitorMemory).toBe(true);
    expect(appPrivacyFrom({ retentionDays: 30 }).retentionDays).toBe(30);
  });

  it('treats a nonsense retention as unset', () => {
    expect(appPrivacyFrom({ retentionDays: 0 }).retentionDays).toBeNull();
    expect(appPrivacyFrom({ retentionDays: -5 }).retentionDays).toBeNull();
    expect(appPrivacyFrom({ retentionDays: 7.9 }).retentionDays).toBe(7);
    expect(appPrivacyFrom({ retentionDays: Number.NaN }).retentionDays).toBeNull();
  });
});
