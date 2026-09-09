/**
 * An in-memory stand-in for the Hugging Face Inference Endpoints API,
 * faithful to the documented paths, states and error codes. Shared by the
 * HF conformance spec (fixture mode) and the acceptance-gate scenarios.
 *
 * The only token it accepts is `hf_valid`; an instance type of
 * `nvidia-h100-x8` triggers the quota error; an endpoint becomes running
 * on the first read after creation.
 */
export interface HfFixture {
  endpoints: Map<string, any>;
  http: any;
}

export function hfFixtureHttp(): HfFixture {
  const endpoints = new Map<string, any>();
  const authed = (config: any) => {
    const auth = config?.headers?.Authorization ?? '';
    if (auth !== 'Bearer hf_valid') {
      throw Object.assign(new Error('401'), { response: { status: 401, data: { error: 'Invalid credentials in Authorization header' } } });
    }
  };
  const parse = (url: string) => {
    const m = url.match(/\/v2\/endpoint\/([^/]+)(?:\/([^/]+))?(?:\/(pause|resume|scale-to-zero))?$/);
    return { namespace: m?.[1], name: m?.[2], action: m?.[3] };
  };
  const notFound = () => Object.assign(new Error('404'), { response: { status: 404, data: { error: 'not found' } } });
  return {
    endpoints,
    http: {
      post: jest.fn(async (url: string, body: any, config: any) => {
        authed(config);
        const { name, action } = parse(url);
        if (!name) {
          if (body?.compute?.instanceType === 'nvidia-h100-x8') {
            throw Object.assign(new Error('402'), { response: { status: 402, data: { error: 'Quota exceeded for instance type' } } });
          }
          const ep = { ...body, status: { state: 'initializing', url: `https://${body.name}.endpoints.huggingface.cloud`, readyReplica: 0, targetReplica: 1 } };
          endpoints.set(body.name, ep);
          return { data: ep };
        }
        const ep = endpoints.get(name);
        if (!ep) throw notFound();
        if (action === 'scale-to-zero') ep.status = { ...ep.status, state: 'scaledToZero', readyReplica: 0, targetReplica: 0 };
        if (action === 'resume') ep.status = { ...ep.status, state: 'running', readyReplica: ep.compute.scaling.minReplica || 1 };
        if (action === 'pause') ep.status = { ...ep.status, state: 'paused', readyReplica: 0 };
        return { data: ep };
      }),
      get: jest.fn(async (url: string, config: any) => {
        authed(config);
        const { name } = parse(url);
        const ep = endpoints.get(name!);
        if (!ep) throw notFound();
        if (ep.status.state === 'initializing') ep.status = { ...ep.status, state: 'running', readyReplica: 1 };
        return { data: ep };
      }),
      put: jest.fn(async (url: string, body: any, config: any) => {
        authed(config);
        const { name } = parse(url);
        const ep = endpoints.get(name!);
        if (!ep) throw notFound();
        ep.compute = { ...ep.compute, scaling: { ...ep.compute.scaling, ...body.compute.scaling } };
        ep.status = { ...ep.status, state: 'updating' };
        return { data: ep };
      }),
      delete: jest.fn(async (url: string, config: any) => {
        authed(config);
        const { name } = parse(url);
        if (!endpoints.delete(name!)) throw notFound();
        return { data: {} };
      }),
    },
  };
}
