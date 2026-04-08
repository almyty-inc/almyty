import axios from 'axios';
import { AgentWebhookService } from '../agent-webhook.service';

// Factory mock — axios is a default export with methods on the function
// itself; the bare jest.mock('axios') leaves axios.post undefined.
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    post: jest.fn(),
  },
}));

const mockedAxios = axios as unknown as { post: jest.Mock };

describe('AgentWebhookService', () => {
  let service: AgentWebhookService;

  beforeEach(() => {
    service = new AgentWebhookService();
    mockedAxios.post.mockReset();
    mockedAxios.post.mockResolvedValue({ data: 'ok' });
  });

  function makeAgent(overrides: any = {}): any {
    return {
      id: 'agent-1',
      name: 'Test Agent',
      webhookUrl: 'https://example.com/hook',
      ...overrides,
    };
  }

  function makeExecution(overrides: any = {}): any {
    return {
      id: 'exec-1',
      status: 'completed',
      output: 'hello',
      executionTime: 1234,
      totalCost: 0.01,
      totalTokens: 50,
      error: null,
      ...overrides,
    };
  }

  // ── No-op when unconfigured ─────────────────────────────────────────

  it('does nothing when webhookUrl is empty', async () => {
    await service.sendExecutionWebhook(makeAgent({ webhookUrl: '' }), makeExecution());
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  // ── SSRF protection ─────────────────────────────────────────────────

  describe('SSRF protection', () => {
    it.each([
      ['localhost',           'http://localhost:8080/hook'],
      ['127.0.0.1',           'http://127.0.0.1/hook'],
      ['private 10.x',        'http://10.0.0.1/hook'],
      ['private 192.168.x',   'http://192.168.1.1/hook'],
      ['link-local',          'http://169.254.169.254/latest/meta-data/'],
      ['IPv6 loopback',       'http://[::1]/hook'],
      ['file://',             'file:///etc/passwd'],
      ['gopher://',           'gopher://internal/'],
      ['embedded creds',      'http://user:pass@example.com/'],
    ])('blocks %s', async (_label, url) => {
      await service.sendExecutionWebhook(makeAgent({ webhookUrl: url }), makeExecution());
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('allows a normal public HTTPS URL', async () => {
      await service.sendExecutionWebhook(
        makeAgent({ webhookUrl: 'https://hooks.example.com/cb' }),
        makeExecution(),
      );
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    });
  });

  // ── Payload size caps ───────────────────────────────────────────────

  describe('payload caps', () => {
    it('passes maxContentLength + maxBodyLength to axios', async () => {
      await service.sendExecutionWebhook(makeAgent(), makeExecution());

      const axiosOpts = mockedAxios.post.mock.calls[0][2];
      expect(axiosOpts).toMatchObject({
        timeout: 5000,
        maxContentLength: expect.any(Number),
        maxBodyLength: expect.any(Number),
      });
      expect(axiosOpts!.maxContentLength).toBeLessThanOrEqual(64 * 1024);
      expect(axiosOpts!.maxBodyLength).toBeLessThanOrEqual(2 * 1024 * 1024);
    });
  });

  // ── Output / error truncation ──────────────────────────────────────

  describe('payload truncation', () => {
    it('truncates a giant string output', async () => {
      const huge = 'x'.repeat(500 * 1024); // 500KB
      await service.sendExecutionWebhook(makeAgent(), makeExecution({ output: huge }));

      const body = mockedAxios.post.mock.calls[0][1] as any;
      expect(body.execution.output.length).toBeLessThan(huge.length);
      expect(body.execution.output).toContain('truncated');
    });

    it('truncates a long error message', async () => {
      const longErr = 'stack trace '.repeat(500);
      await service.sendExecutionWebhook(makeAgent(), makeExecution({ error: longErr }));

      const body = mockedAxios.post.mock.calls[0][1] as any;
      expect(body.execution.error.length).toBeLessThan(longErr.length);
      expect(body.execution.error).toContain('truncated');
    });

    it('JSON-stringifies and truncates an oversized object output', async () => {
      const fatObject = { items: Array.from({ length: 100_000 }, (_, i) => ({ i })) };
      await service.sendExecutionWebhook(makeAgent(), makeExecution({ output: fatObject }));

      const body = mockedAxios.post.mock.calls[0][1] as any;
      expect(typeof body.execution.output).toBe('string');
      expect(body.execution.output).toContain('truncated');
    });

    it('leaves small outputs untouched', async () => {
      await service.sendExecutionWebhook(makeAgent(), makeExecution({ output: 'small' }));
      const body = mockedAxios.post.mock.calls[0][1] as any;
      expect(body.execution.output).toBe('small');
    });
  });

  // ── Failure swallowing ──────────────────────────────────────────────

  it('does not throw if axios rejects', async () => {
    mockedAxios.post.mockRejectedValue(new Error('boom'));
    await expect(
      service.sendExecutionWebhook(makeAgent(), makeExecution()),
    ).resolves.not.toThrow();
  });
});
