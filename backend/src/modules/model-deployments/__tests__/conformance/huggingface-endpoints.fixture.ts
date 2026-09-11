/**
 * An in-memory stand-in for the Hugging Face Inference Endpoints v2 API,
 * faithful to the documented paths, states, price list and error codes.
 * Shared by the HF conformance spec (fixture mode) and the acceptance-gate
 * scenarios.
 *
 * The only token it accepts is `hf_valid`; an instance type of
 * `nvidia-h100-x8` triggers the quota error; an endpoint becomes running
 * on the first read after creation. `GET /v2/provider` answers with the
 * same shape the public route does, so `costSnapshot` can price a replica.
 */
export interface HfFixture {
  endpoints: Map<string, any>;
  http: any;
}

/** A trimmed copy of the live GET /v2/provider payload (read 2026-09-09). */
const PROVIDERS = {
  vendors: [
    {
      name: 'aws',
      status: 'available',
      regions: [
        {
          name: 'us-east-1',
          label: 'N. Virginia',
          status: 'available',
          computes: [
            { id: 'aws-us-east-1-nvidia-t4-x1', accelerator: 'gpu', instanceType: 'nvidia-t4', instanceSize: 'x1', architecture: 'NVIDIA T4', numAccelerators: 1, memoryGb: 16, pricePerHour: 0.6, status: 'available', quota: { maxAccelerators: 8, usedAccelerators: 0 } },
            { id: 'aws-us-east-1-nvidia-l4-x1', accelerator: 'gpu', instanceType: 'nvidia-l4', instanceSize: 'x1', architecture: 'NVIDIA L4', numAccelerators: 1, memoryGb: 24, pricePerHour: 0.8, status: 'available', quota: { maxAccelerators: 8, usedAccelerators: 0 } },
          ],
        },
        {
          name: 'eu-west-1',
          label: 'Ireland',
          status: 'available',
          computes: [
            { id: 'aws-eu-west-1-nvidia-a10g-x1', accelerator: 'gpu', instanceType: 'nvidia-a10g', instanceSize: 'x1', architecture: 'NVIDIA A10G', numAccelerators: 1, memoryGb: 24, pricePerHour: 1.0, status: 'available', quota: { maxAccelerators: 8, usedAccelerators: 0 } },
          ],
        },
      ],
    },
  ],
};

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
        if (url.endsWith('/v2/provider')) return { data: PROVIDERS };
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
