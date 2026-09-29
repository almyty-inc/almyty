import { VISITOR_PRIVACY_DEFAULTS, visitorPrivacyFrom } from '../agent-channel.entity';

describe('visitorPrivacyFrom', () => {
  it('gives an agent with nothing stored the defaults', () => {
    expect(visitorPrivacyFrom(null)).toEqual(VISITOR_PRIVACY_DEFAULTS);
    expect(visitorPrivacyFrom(undefined)).toEqual(VISITOR_PRIVACY_DEFAULTS);
    expect(visitorPrivacyFrom({})).toEqual(VISITOR_PRIVACY_DEFAULTS);
  });

  it('defaults to visitors keeping control and their words staying out of shared memory', () => {
    const d = visitorPrivacyFrom(null);
    expect(d.visitorCanDelete).toBe(true);
    expect(d.visitorCanExport).toBe(true);
    expect(d.visitorMemory).toBe(false);
    expect(d.retentionDays).toBeNull();
  });

  it('honours stored values field by field', () => {
    expect(visitorPrivacyFrom({ visitorCanDelete: false })).toMatchObject({ visitorCanDelete: false, visitorCanExport: true });
    expect(visitorPrivacyFrom({ visitorMemory: true }).visitorMemory).toBe(true);
    expect(visitorPrivacyFrom({ retentionDays: 30 }).retentionDays).toBe(30);
  });

  it('treats a nonsense retention as unset', () => {
    expect(visitorPrivacyFrom({ retentionDays: 0 }).retentionDays).toBeNull();
    expect(visitorPrivacyFrom({ retentionDays: -5 }).retentionDays).toBeNull();
    expect(visitorPrivacyFrom({ retentionDays: 7.9 }).retentionDays).toBe(7);
    expect(visitorPrivacyFrom({ retentionDays: Number.NaN }).retentionDays).toBeNull();
  });
});
