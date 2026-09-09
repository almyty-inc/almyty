import { CustomEndpointAdapter } from '../adapters/custom-endpoint.adapter';
import { assertAdapterContract } from '../adapters/adapter.interface';

describe('CustomEndpointAdapter', () => {
  const creds = { apiKey: 'k' };

  it('honours the contract and refuses the operations it cannot do', async () => {
    const a = new CustomEndpointAdapter({ get: jest.fn() } as any);
    expect(() => assertAdapterContract
(a)).not.toThrow();
    const ref = { url: 'https://x/v1' };
    await expect(a.deploy({} as any, creds)).rejects.toMatchObject({ code: 'ADAPTER_UNSUPPORTED_OPERATION' });
    await expect(a.scale(ref, 1, creds)).rejects.toMatchObject({ code: 'ADAPTER_UNSUPPORTED_OPERATION' });
    await expect(a.teardown(ref, creds)).rejects.toMatchObject({ code: 'ADAPTER_UNSUPPORTED_OPERATION' });
  });

  it('reports ready when /models lists the model, missing when it does not, degraded when unreachable', async () => {
    const get = jest.fn();
    const a = new CustomEndpointAdapter({ get } as any);
    get.mockResolvedValueOnce({ data: { data: [{ id: 'llama' }, { id: 'phi' }] } });
    expect(await a.readEndpoint({ url: 'https://x/v1/', model: 'llama' }, creds)).toMatchObject({ state: 'ready', url: 'https://x/v1', replicas: 1 });
    expect(get).toHaveBeenCalledWith('https://x/v1/models', { headers: { Authorization: 'Bearer k' } });
    get.mockResolvedValueOnce({ data: { data: [{ id: 'phi' }] } });
    expect((await a.readEndpoint({ url: 'https://x/v1', model: 'llama' }, creds)).state).toBe('missing');
    get.mockRejectedValueOnce(Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    expect((await a.readEndpoint({ url: 'https://x/v1', model: 'llama' }, creds)).state).toBe('degraded');
    get.mockRejectedValueOnce({ response: { status: 401 } });
    await expect(a.readEndpoint({ url: 'https://x/v1' }, creds)).rejects.toMatchObject({ code: 'ADAPTER_AUTH' });
  });

  it('prices from the ref when per-token numbers are given', async () => {
    const a = new CustomEndpointAdapter({ get: jest.fn() } as any);
    const snap
 = await a.costSnapshot({ url: 'https://x/v1', inPerMTok: 0.3, outPerMTok: 0.9, hourlyRateCents: 0 }, creds);
    expect(snap.perToken).toEqual({ inPerMTok: 0.3, outPerMTok: 0.9, currency: 'USD' });
    expect(snap.ratePerHourCents).toBe(0);
  });
});
