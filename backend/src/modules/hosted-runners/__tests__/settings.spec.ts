import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  DEFAULT_HOSTED_RUNNER_SETTINGS,
  HostedRunnerSettingsService,
  deepMerge,
  hostedRunnersEnabled,
  loadHostedRunnerSettings,
  settingsProblems,
} from '../hosted-runner-settings';

describe('hosted runner settings', () => {
  it('ships Frane\'s decisions as defaults: idle 15 minutes within 5-120, kept 30 days with a notice on day 23', () => {
    expect(DEFAULT_HOSTED_RUNNER_SETTINGS.idleTimeoutMinutes).toEqual({ default: 15, min: 5, max: 120 });
    expect(DEFAULT_HOSTED_RUNNER_SETTINGS.suspendedRetention).toEqual({ keepDays: 30, noticeDay: 23 });
    expect(settingsProblems(DEFAULT_HOSTED_RUNNER_SETTINGS)).toEqual([]);
  });

  it('is off unless HOSTED_RUNNERS_ENABLED=true', () => {
    expect(hostedRunnersEnabled({})).toBe(false);
    expect(hostedRunnersEnabled({ HOSTED_RUNNERS_ENABLED: 'false' })).toBe(false);
    expect(hostedRunnersEnabled({ HOSTED_RUNNERS_ENABLED: '1' })).toBe(false);
    expect(hostedRunnersEnabled({ HOSTED_RUNNERS_ENABLED: 'true' })).toBe(true);
    expect(new HostedRunnerSettingsService(undefined, { HOSTED_RUNNERS_ENABLED: 'TRUE' }).enabled()).toBe(true);
  });

  it('takes every number from overrides: a file first, then inline JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hr-settings-'));
    const file = join(dir, 'settings.json');
    writeFileSync(file, JSON.stringify({ idleTimeoutMinutes: { default: 20 }, suspendedRetention: { keepDays: 60, noticeDay: 50 } }));
    const s = loadHostedRunnerSettings({
      HOSTED_RUNNERS_SETTINGS_FILE: file,
      HOSTED_RUNNERS_SETTINGS: JSON.stringify({ idleTimeoutMinutes: { max: 240 }, resourceClasses: { xl: { cpu: '8', memory: '16Gi', ephemeralStorage: '32Gi', volumeGi: 100 } } }),
      PUBLIC_API_URL: 'https://api.example.com',
    });
    expect(s.idleTimeoutMinutes).toEqual({ default: 20, min: 5, max: 240 });
    expect(s.suspendedRetention).toEqual({ keepDays: 60, noticeDay: 50 });
    expect(Object.keys(s.resourceClasses)).toEqual(['small', 'medium', 'large', 'xl']);
    expect(s.apiUrl).toBe('https://api.example.com');
  });

  it('takes the cluster CIDRs and the disruption budget from settings, and refuses ones that cannot work', () => {
    expect(DEFAULT_HOSTED_RUNNER_SETTINGS.cluster.clusterCidrs).toEqual([]);
    expect(DEFAULT_HOSTED_RUNNER_SETTINGS.cluster.disruptionBudget).toEqual({ minAvailable: null, maxUnavailable: 0 });
    const load = (cluster: unknown) => loadHostedRunnerSettings({ HOSTED_RUNNERS_SETTINGS: JSON.stringify({ cluster }) });
    expect(load({ clusterCidrs: ['198.18.0.0/16', 'fd00:10::/64'] }).cluster.clusterCidrs).toEqual(['198.18.0.0/16', 'fd00:10::/64']);
    expect(load({ disruptionBudget: { minAvailable: 1, maxUnavailable: null } }).cluster.disruptionBudget).toEqual({ minAvailable: 1, maxUnavailable: null });
    expect(load({ disruptionBudget: { maxUnavailable: '50%' } }).cluster.disruptionBudget.maxUnavailable).toBe('50%');
    for (const bad of [['10.0.0.0'], ['10.0.0.0/33'], ['fd00::/129'], ['cluster']]) expect(() => load({ clusterCidrs: bad })).toThrow(/clusterCidrs/);
    for (const bad of [{ minAvailable: 1 }, { maxUnavailable: null }, { maxUnavailable: -1 }, { maxUnavailable: 'half' }]) expect(() => load({ disruptionBudget: bad })).toThrow(/disruptionBudget/);
  });

  it('refuses settings that cannot work, at load', () => {
    expect(() => loadHostedRunnerSettings({ HOSTED_RUNNERS_SETTINGS: '{not json' })).toThrow(/not valid JSON/);
    expect(() => loadHostedRunnerSettings({ HOSTED_RUNNERS_SETTINGS: JSON.stringify({ idleTimeoutMinutes: { default: 200 } }) })).toThrow(/min <= default <= max/);
    expect(() => loadHostedRunnerSettings({ HOSTED_RUNNERS_SETTINGS: JSON.stringify({ suspendedRetention: { noticeDay: 40 } }) })).toThrow(/noticeDay must come before keepDays/);
    expect(() => loadHostedRunnerSettings({ HOSTED_RUNNERS_SETTINGS: JSON.stringify({ cluster: { runAsUser: 0 } }) })).toThrow(/never runs as root/);
    expect(() => loadHostedRunnerSettings({ HOSTED_RUNNERS_SETTINGS: JSON.stringify({ defaultResourceClass: 'huge' }) })).toThrow(/defaultResourceClass/);
  });

  it('clamps an idle timeout to the bounds and gives the default for none', () => {
    const s = new HostedRunnerSettingsService(DEFAULT_HOSTED_RUNNER_SETTINGS, {});
    expect(s.idleTimeout()).toBe(15);
    expect(s.idleTimeout(1)).toBe(5);
    expect(s.idleTimeout(999)).toBe(120);
    expect(s.idleTimeout(42)).toBe(42);
  });

  it('merges objects key by key and replaces arrays', () => {
    expect(deepMerge({ a: { b: 1, c: [1, 2] } }, { a: { c: [3] } })).toEqual({ a: { b: 1, c: [3] } });
  });
});
