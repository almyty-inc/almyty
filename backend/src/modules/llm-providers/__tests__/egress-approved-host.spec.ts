import { BadRequestException } from '@nestjs/common';

// Real safe-request under test; axios replaced with a callable mock so
// no request ever leaves the process.
jest.mock('axios', () => {
  const fn: any = jest.fn(() => Promise.resolve({ data: {} }));
  fn.default = fn;
  return fn;
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const axios = require('axios');

import { callLlmProviderHttp, llmCallOptionsFor } from '../providers/safe-request';
import { agentsExempting } from '../../../common/security/ssrf-safe-agent';
import { LlmProvider, LlmProviderType } from '../../../entities/llm-provider.entity';

/**
 * The call path honours the host the save-time gate approved.
 *
 * This exists because the stamp is worthless on its own: the service can
 * record an allowlisted host perfectly and, if nothing reads it at call
 * time, the pinning lookup still refuses the name and the organization's
 * allowlist achieves nothing. Removing the field from llmCallOptionsFor
 * left the service tests entirely green, which is exactly the shape of
 * bug that keeps reaching staging here.
 */
const provider = (configuration: Record<string, unknown>): LlmProvider => {
  const p = new LlmProvider();
  p.type = LlmProviderType.CUSTOM;
  p.configuration = configuration as any;
  return p;
};

describe('an approved host reaches the outbound call', () => {
  beforeEach(() => (axios as jest.Mock).mockClear());

  it('carries the stamp from the row into the call options', () => {
    const opts = llmCallOptionsFor(provider({ apiUrl: 'http://gpu-1.internal:8000/v1', egressApprovedHost: 'gpu-1.internal' }));
    expect(opts.egressApprovedHost).toBe('gpu-1.internal');
  });

  it('dials an approved private host with the agents that exempt it', async () => {
    const p = provider({ apiUrl: 'http://10.0.0.5:8000/v1', egressApprovedHost: '10.0.0.5' });
    await callLlmProviderHttp({ url: 'http://10.0.0.5:8000/v1/chat/completions', method: 'POST' }, llmCallOptionsFor(p));

    const sent = (axios as jest.Mock).mock.calls[0][0];
    expect(sent.httpAgent).toBe(agentsExempting('10.0.0.5').httpAgent);
    expect(sent.maxRedirects).toBe(0);
  });

  it('still refuses a private host that was never approved', async () => {
    const p = provider({ apiUrl: 'http://10.0.0.9:8000/v1' });
    await expect(
      callLlmProviderHttp({ url: 'http://10.0.0.9:8000/v1/chat/completions' }, llmCallOptionsFor(p)),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(axios as jest.Mock).not.toHaveBeenCalled();
  });

  it('refuses a DIFFERENT private host on a provider that has an approval', async () => {
    // The stamp approves one host. A URL that wandered somewhere else --
    // a rewritten row, a path built from a response -- is not covered by
    // it, and the string gate has to say so before the agents matter.
    const p = provider({ apiUrl: 'http://10.0.0.5:8000/v1', egressApprovedHost: '10.0.0.5' });
    await expect(
      callLlmProviderHttp({ url: 'http://169.254.169.254/latest/meta-data/' }, llmCallOptionsFor(p)),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('leaves a public provider on the strict agents', async () => {
    const p = provider({ apiUrl: 'https://api.example.com/v1' });
    await callLlmProviderHttp({ url: 'https://api.example.com/v1/chat/completions' }, llmCallOptionsFor(p));

    const sent = (axios as jest.Mock).mock.calls[0][0];
    expect(sent.httpAgent).not.toBe(agentsExempting('api.example.com').httpAgent);
  });
});
