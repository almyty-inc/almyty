import { MetricsRecorderService } from './metrics-recorder.service';
import { MetricType, MetricStatus } from '../../entities/usage-metric.entity';

describe('MetricsRecorderService', () => {
  it('builds a usage_metrics row with sensible defaults and saves it', () => {
    const saved: any[] = [];
    const repo: any = { save: jest.fn((m) => { saved.push(m); return Promise.resolve(m); }) };
    const recorder = new MetricsRecorderService(repo);

    recorder.record(MetricType.MCP_SESSION, { organizationId: 'org-1', gatewayId: 'gw-1' });

    expect(saved).toHaveLength(1);
    expect(saved[0].type).toBe(MetricType.MCP_SESSION);
    expect(saved[0].value).toBe(1);
    expect(saved[0].status).toBe(MetricStatus.SUCCESS);
    expect(saved[0].organizationId).toBe('org-1');
    expect(saved[0].gatewayId).toBe('gw-1');
    expect(saved[0].timestamp).toBeInstanceOf(Date);
  });

  it('honours explicit value, status, and dimensions', () => {
    const repo: any = { save: jest.fn().mockResolvedValue(undefined) };
    const recorder = new MetricsRecorderService(repo);

    recorder.record(MetricType.A2A_MESSAGE, {
      value: 3,
      status: MetricStatus.ERROR,
      dimensions: { agentId: 'a-9' },
    });

    const m = repo.save.mock.calls[0][0];
    expect(m.value).toBe(3);
    expect(m.status).toBe(MetricStatus.ERROR);
    expect(m.dimensions).toEqual({ agentId: 'a-9' });
  });

  it('no-ops (does not throw) when no repository is wired', () => {
    const recorder = new MetricsRecorderService(undefined);
    expect(() => recorder.record(MetricType.MCP_TOOL_CALL, { organizationId: 'o' })).not.toThrow();
  });

  it('swallows repository save rejections (fire-and-forget)', async () => {
    const repo: any = { save: jest.fn().mockRejectedValue(new Error('db down')) };
    const recorder = new MetricsRecorderService(repo);
    expect(() => recorder.record(MetricType.UTCP_MANUAL, {})).not.toThrow();
    // Let the rejected promise settle without surfacing an unhandled rejection.
    await new Promise((r) => setImmediate(r));
  });
});
