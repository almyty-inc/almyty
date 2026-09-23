import { HfRevisionResolver, HubFetch, ModelSourceUnresolvedError, hfPinRequest } from '../hf-revision.resolver';

const SHA = 'abcdef0123456789abcdef0123456789abcdef01';

describe('hfPinRequest', () => {
  it('asks for main when nothing is named, and for the named branch or tag otherwise', () => {
    expect(hfPinRequest('hf://meta-llama/Llama-3.1-8B-Instruct')).toEqual({ repository: 'meta-llama/Llama-3.1-8B-Instruct', revision: 'main' });
    expect(hfPinRequest('hf://Qwen/Qwen3-0.6B@main')).toEqual({ repository: 'Qwen/Qwen3-0.6B', revision: 'main' });
    expect(hfPinRequest('hf://Qwen/Qwen3-0.6B@v2.1')).toEqual({ repository: 'Qwen/Qwen3-0.6B', revision: 'v2.1' });
  });

  it('has nothing to resolve for a commit sha, another scheme, or a malformed repository', () => {
    expect(hfPinRequest(`hf://Qwen/Qwen3-0.6B@${SHA}`)).toBeNull();
    expect(hfPinRequest(`hf://Qwen/Qwen3-0.6B@${SHA.toUpperCase()}`)).toBeNull();
    expect(hfPinRequest('s3://bucket/qwen@etag')).toBeNull();
    expect(hfPinRequest('file:///models/qwen@abc')).toBeNull();
    expect(hfPinRequest('together://acme/qwen')).toBeNull();
    expect(hfPinRequest('hf://just-a-name')).toBeNull();
  });
});

describe('HfRevisionResolver', () => {
  const ok = (body: any) => jest.fn(async () => ({ ok: true, status: 200, json: async () => body }));

  it('pins to the sha the Hub returns, with a timeout on the call', async () => {
    const fetch = ok({ sha: SHA, id: 'Qwen/Qwen3-0.6B' });
    const resolver = new HfRevisionResolver(fetch as unknown as HubFetch);
    await expect(resolver.pin('hf://Qwen/Qwen3-0.6B')).resolves.toBe(`hf://Qwen/Qwen3-0.6B@${SHA}`);
    expect(fetch).toHaveBeenCalledWith('https://huggingface.co/api/models/Qwen/Qwen3-0.6B/revision/main', {
      headers: { Accept: 'application/json', 'Accept-Encoding': 'identity' },
      signal: expect.any(AbortSignal),
    });
  });

  it('encodes a revision with a slash in it', async () => {
    const fetch = ok({ sha: SHA });
    const pinned = await new HfRevisionResolver(fetch as unknown as HubFetch).pin('hf://Qwen/Qwen3-0.6B@refs/pr/1');
    expect((fetch.mock.calls[0] as any[])[0]).toBe('https://huggingface.co/api/models/Qwen/Qwen3-0.6B/revision/refs%2Fpr%2F1');
    expect(pinned).toBe(`hf://Qwen/Qwen3-0.6B@${SHA}`);
  });

  it('sends the token as a bearer header only when there is one', async () => {
    const fetch = ok({ sha: SHA });
    const resolver = new HfRevisionResolver(fetch as unknown as HubFetch);
    await resolver.pin('hf://acme/private', 'hf_secret');
    expect((fetch.mock.calls[0] as any[])[1].headers).toEqual({ Accept: 'application/json', 'Accept-Encoding': 'identity', Authorization: 'Bearer hf_secret' });
  });

  it('makes no call for a reference it has nothing to do for', async () => {
    const fetch = ok({ sha: SHA });
    const resolver = new HfRevisionResolver(fetch as unknown as HubFetch);
    await expect(resolver.pin(`hf://a/b@${SHA}`)).resolves.toBe(`hf://a/b@${SHA}`);
    await expect(resolver.pin('s3://bucket/x@1')).resolves.toBe('s3://bucket/x@1');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses a 404, a timeout and an answer with no commit, naming the repository', async () => {
    const notFound = new HfRevisionResolver((async () => ({ ok: false, status: 404, json: async () => ({}) })) as unknown as HubFetch);
    await expect(notFound.pin('hf://nobody/nothing')).rejects.toThrow(ModelSourceUnresolvedError);
    await expect(notFound.pin('hf://nobody/nothing@dev')).rejects.toThrow('Could not find nobody/nothing (dev) on Hugging Face: no such repository or revision');

    const slow = new HfRevisionResolver((async () => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); }) as unknown as HubFetch);
    await expect(slow.pin('hf://a/b')).rejects.toThrow('Could not find a/b on Hugging Face: the Hub did not answer in time');

    const odd = new HfRevisionResolver(ok({ sha: 'not-a-sha' }) as unknown as HubFetch);
    await expect(odd.pin('hf://a/b')).rejects.toMatchObject({ code: 'MODEL_SOURCE_UNRESOLVED' });
  });
});
