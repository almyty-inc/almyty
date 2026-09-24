// The raw module: the namespace import is a getter wrapper jest cannot spy on.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rawDns: typeof import('dns') = require('dns');

import { GrpcCallerService } from '../grpc-caller.service';

/**
 * gRPC tools had the string check on api.baseUrl and nothing after it:
 * grpc-js resolves the name itself and takes no lookup hook, so a public
 * name whose A record answered 169.254.169.254 (DNS rebinding) was dialled.
 * With pinDns the caller resolves through the SSRF-safe lookup and dials
 * the approved address.
 */
describe('GrpcCallerService DNS pinning', () => {
  const svc = new GrpcCallerService();
  const pinTarget = (target: string) => (svc as any).pinTarget(target);

  const answer = (address: string, family: number) =>
    jest.spyOn(rawDns, 'lookup').mockImplementation(((_host: string, _opts: any, cb: any) =>
      cb(null, address, family)) as any);

  afterEach(() => jest.restoreAllMocks());

  it('refuses a public name that resolves to the metadata address', async () => {
    answer('169.254.169.254', 4);
    const res = await svc.call({
      protoSource: '',
      baseUrl: 'https://rebind.example.com',
      serviceName: 'S',
      methodName: 'M',
      request: {},
      pinDns: true,
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Refused to connect: SSRF blocked/);
  });

  it('refuses a name that resolves to loopback before loading the proto', async () => {
    answer('127.0.0.1', 4);
    const res = await svc.call({
      protoSource: 'not a proto',
      baseUrl: 'internal.example.com:50051',
      serviceName: 'S',
      methodName: 'M',
      request: {},
      pinDns: true,
    });
    expect(res.error).toMatch(/Refused to connect/);
  });

  it('dials the approved address and keeps the name for authority and TLS', async () => {
    answer('93.184.216.34', 4);
    await expect(pinTarget('api.example.com:443')).resolves.toEqual({
      target: 'ipv4:93.184.216.34:443',
      channelOptions: {
        'grpc.default_authority': 'api.example.com:443',
        'grpc.ssl_target_name_override': 'api.example.com',
      },
    });
  });

  it('brackets an IPv6 answer', async () => {
    answer('2606:2800:220:1::1', 6);
    const { target } = await pinTarget('api.example.com:443');
    expect(target).toBe('ipv6:[2606:2800:220:1::1]:443');
  });

  it('does not set a TLS name override for an address literal', async () => {
    answer('93.184.216.34', 4);
    const { channelOptions } = await pinTarget('93.184.216.34:443');
    expect(channelOptions['grpc.ssl_target_name_override']).toBeUndefined();
  });
});
