import {
  ConnectionsGovernanceProcessor,
  CRON_ENV,
  DEFAULT_CRON,
  EXPIRY_REPEAT_JOB_ID,
  ROTATION_REPEAT_JOB_ID,
} from '../connections-governance.processor';

function build() {
  const queue = { add: jest.fn().mockResolvedValue(undefined), getRepeatableJobs: jest.fn().mockResolvedValue([]), removeRepeatableByKey: jest.fn().mockResolvedValue(undefined) };
  const governance = {
    organizationsWithPolicies: jest.fn().mockResolvedValue(['org-licensed', 'org-community']),
    enforceExpiry: jest.fn(async (organizationId: string) => ({ organizationId, warned: 1, expired: 0, revokedGrants: 0, enforce: false })),
    sweepRetention: jest.fn().mockResolvedValue(2),
    rotateDue: jest.fn(async (organizationId: string) => ({ organizationId, rotated: 1, failed: 0, manual: 0 })),
  };
  const licenses = { hasForOrg: jest.fn(async (org: string) => org === 'org-licensed') };
  return { processor: new ConnectionsGovernanceProcessor(queue as any, governance as any, licenses as any), queue, governance, licenses };
}

describe('ConnectionsGovernanceProcessor scheduling', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('is off under NODE_ENV=test and registers nothing', async () => {
    process.env.NODE_ENV = 'test';
    const { processor, queue } = build();
    expect(processor.isEnabled()).toBe(false);
    await processor.onApplicationBootstrap();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('defaults to daily 03:00 and honours the env override or off', () => {
    delete process.env[CRON_ENV];
    expect(build().processor.cron()).toBe(DEFAULT_CRON);
    expect(DEFAULT_CRON).toBe('0 3 * * *');
    process.env[CRON_ENV] = '15 2 * * *';
    expect(build().processor.cron()).toBe('15 2 * * *');
    process.env[CRON_ENV] = 'OFF';
    expect(build().processor.cron()).toBeUndefined();
    process.env.NODE_ENV = 'production';
    expect(build().processor.isEnabled()).toBe(false);
  });

  it('registers both repeatable jobs with stable ids and evicts a stale cron', async () => {
    process.env.NODE_ENV = 'production';
    process.env[CRON_ENV] = '0 5 * * *';
    const { processor, queue } = build();
    queue.getRepeatableJobs.mockResolvedValue([
      { id: EXPIRY_REPEAT_JOB_ID, cron: '0 3 * * *', key: 'stale-expiry' },
      { id: ROTATION_REPEAT_JOB_ID, cron: '0 5 * * *', key: 'current-rotation' },
      { id: 'something-else', cron: '0 1 * * *', key: 'other' },
    ]);
    await processor.onApplicationBootstrap();
    expect(queue.removeRepeatableByKey).toHaveBeenCalledTimes(1);
    expect(queue.removeRepeatableByKey).toHaveBeenCalledWith('stale-expiry');
    expect(queue.add).toHaveBeenCalledWith('expiry', {}, expect.objectContaining({ jobId: EXPIRY_REPEAT_JOB_ID, repeat: { cron: '0 5 * * *' } }));
    expect(queue.add).toHaveBeenCalledWith('rotation', {}, expect.objectContaining({ jobId: ROTATION_REPEAT_JOB_ID, repeat: { cron: '0 5 * * *' } }));
  });

  it('does not throw when Redis is unavailable at bootstrap', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env[CRON_ENV];
    const { processor, queue } = build();
    queue.getRepeatableJobs.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(processor.onApplicationBootstrap()).resolves.toBeUndefined();
  });
});

describe('ConnectionsGovernanceProcessor handlers', () => {
  it('expiry: enforces and sweeps retention only for licensed orgs with an expiry rule', async () => {
    const { processor, governance, licenses } = build();
    const summary = await processor.handleExpiry();
    expect(governance.organizationsWithPolicies).toHaveBeenCalledWith(['expiry_rule']);
    expect(licenses.hasForOrg).toHaveBeenCalledWith('org-community', 'connections_governance');
    expect(governance.enforceExpiry).toHaveBeenCalledTimes(1);
    expect(governance.enforceExpiry).toHaveBeenCalledWith('org-licensed');
    expect(governance.sweepRetention).toHaveBeenCalledWith('org-licensed');
    expect(summary).toEqual({ organizations: 1, results: [expect.objectContaining({ organizationId: 'org-licensed', warned: 1 })], retentionRemoved: 2 });
  });

  it('rotation: one failing org does not stop the sweep', async () => {
    const { processor, governance, licenses } = build();
    licenses.hasForOrg.mockResolvedValue(true);
    governance.rotateDue.mockImplementationOnce(async () => { throw new Error('boom'); });
    const summary = await processor.handleRotation();
    expect(governance.organizationsWithPolicies).toHaveBeenCalledWith(['rotation_rule']);
    expect(governance.rotateDue).toHaveBeenCalledTimes(2);
    expect(summary.organizations).toBe(2);
    expect(summary.results).toEqual([expect.objectContaining({ organizationId: 'org-community', rotated: 1 })]);
  });

  it('treats a license lookup failure as unlicensed', async () => {
    const { processor, governance, licenses } = build();
    licenses.hasForOrg.mockRejectedValue(new Error('db down'));
    const summary = await processor.handleExpiry();
    expect(governance.enforceExpiry).not.toHaveBeenCalled();
    expect(summary.organizations).toBe(0);
  });
});
