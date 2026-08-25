import {
  APPLE_API_KEY_FILENAME,
  CERTIFICATE_FILENAME,
  SIGNING_TOOL,
  appleNotarizeArgs,
  appleSignArgs,
  authenticodeSignArgs,
  describeSigningFailure,
  identityFromConfig,
  signingReadiness,
} from '../build-signing';
import type { ToolchainRunner } from '../build-toolchain';

const runner = (available: boolean): ToolchainRunner => ({
  available: jest.fn().mockResolvedValue(available),
  run: jest.fn(),
});

describe('identityFromConfig', () => {
  const complete = {
    certificate: Buffer.from('p12-bytes').toString('base64'),
    certificatePassword: 'hunter2',
    appleApiKeyId: 'KEY1',
    appleApiIssuer: 'ISS1',
    appleApiKey: '-----BEGIN PRIVATE KEY-----',
  };

  it('decodes the certificate the vault stored as base64', () => {
    const { identity } = identityFromConfig('apple', complete);
    expect(identity!.certificate.toString()).toBe('p12-bytes');
  });

  it('needs nothing at all when the platform signs nothing', () => {
    const { identity, missing } = identityFromConfig('none', null);
    expect(identity).toBeNull();
    expect(missing).toEqual([]);
  });

  it('refuses a half-filled credential rather than signing partly', () => {
    // A build that reports "signed" without a real signature is worse
    // than one that reports unsigned.
    const { identity, missing } = identityFromConfig('apple', {
      certificate: complete.certificate,
    });
    expect(identity).toBeNull();
    expect(missing).toContain('the certificate password');
  });

  it('names every missing Apple notarisation field, not just the first', () => {
    const { missing } = identityFromConfig('apple', {
      certificate: complete.certificate,
      certificatePassword: 'x',
    });
    expect(missing).toEqual([
      'an App Store Connect key id',
      'an App Store Connect issuer id',
      'an App Store Connect private key',
    ]);
  });

  it('does not ask Windows for Apple notarisation fields', () => {
    const { identity, missing } = identityFromConfig('authenticode', {
      certificate: complete.certificate,
      certificatePassword: 'hunter2',
    });
    expect(missing).toEqual([]);
    expect(identity!.kind).toBe('authenticode');
  });

  it('treats a missing config as a missing certificate', () => {
    expect(identityFromConfig('apple', undefined).missing).toEqual(['a signing certificate']);
  });

  it('ignores a non-string certificate rather than throwing on it', () => {
    const { identity, missing } = identityFromConfig('authenticode', {
      certificate: { oops: true },
      certificatePassword: 'x',
    });
    expect(identity).toBeNull();
    expect(missing).toContain('a signing certificate');
  });
});

describe('signingReadiness', () => {
  it('is ready when the platform needs no signature', async () => {
    const r = runner(false);
    await expect(signingReadiness('none', r)).resolves.toEqual({ ready: true, reason: null });
    expect(r.available).not.toHaveBeenCalled();
  });

  it('names the tool the deployment is missing', async () => {
    const result = await signingReadiness('apple', runner(false));
    expect(result.ready).toBe(false);
    expect(result.reason).toContain('rcodesign');
  });

  it('is ready when the tool is installed', async () => {
    await expect(signingReadiness('authenticode', runner(true))).resolves.toEqual({
      ready: true,
      reason: null,
    });
  });
});

describe('signing arguments', () => {
  it('passes the Apple password by file, never on the command line', () => {
    // An argument list is readable via ps by every process on the host,
    // and a build host runs other tenants' builds.
    const args = appleSignArgs('/w/app', '/w/cert.p12', '/w/pw');
    expect(args).toContain('--p12-password-file');
    expect(args).not.toContain('--p12-password');
    expect(args.join(' ')).not.toContain('hunter2');
  });

  it('asks for the hardened runtime, which notarisation requires', () => {
    expect(appleSignArgs('/w/app', '/w/c', '/w/p')).toEqual(
      expect.arrayContaining(['--code-signature-flags', 'runtime']),
    );
  });

  it('staples the notarisation ticket so the app works offline', () => {
    // Without the staple, a machine with no network reaches Gatekeeper's
    // fallback and refuses the app.
    expect(appleNotarizeArgs('/w/app', '/w/key.json')).toContain('--staple');
  });

  it('timestamps an Authenticode signature', () => {
    // An untimestamped signature stops verifying when the certificate
    // expires, which breaks every copy already shipped.
    const args = authenticodeSignArgs('/w/app.exe', '/w/c.pfx', 'pw', '/w/out.exe');
    expect(args).toContain('-t');
    expect(args.join(' ')).toContain('timestamp');
  });

  it('writes the signed Windows binary to a separate path', () => {
    // osslsigncode refuses to sign in place.
    const args = authenticodeSignArgs('/w/app.exe', '/w/c.pfx', 'pw', '/w/out.exe');
    expect(args[args.indexOf('-in') + 1]).toBe('/w/app.exe');
    expect(args[args.indexOf('-out') + 1]).toBe('/w/out.exe');
  });

  it('passes every argument separately, so a path can never be parsed as a flag', () => {
    const args = authenticodeSignArgs('/w/my app.exe', '/w/c.pfx', 'p w', '/w/o.exe');
    expect(args).toContain('/w/my app.exe');
    expect(args).toContain('p w');
  });
});

describe('describeSigningFailure', () => {
  const result = (output: string) => ({ ok: false, output, error: 'exit 1' });

  it('names a wrong password, which the operator can fix', () => {
    expect(describeSigningFailure('apple', result('Mac verify failure'))).toMatch(/password/i);
  });

  it('names an expired certificate', () => {
    expect(describeSigningFailure('apple', result('certificate has expired'))).toMatch(/expired/i);
  });

  it('does not pass the tool output through', () => {
    // The output carries the argument list, and often the path the
    // certificate was written to. This text goes in a web page.
    const message = describeSigningFailure(
      'authenticode',
      result('failed reading /tmp/almyty-build-abc/signing-certificate.p12'),
    );
    expect(message).not.toContain('/tmp/almyty-build-abc');
    expect(message).toContain('osslsigncode');
  });
});

describe('constants', () => {
  it('maps each signing kind to the tool that performs it', () => {
    expect(SIGNING_TOOL.none).toBeNull();
    expect(SIGNING_TOOL.apple).toBe('rcodesign');
    expect(SIGNING_TOOL.authenticode).toBe('osslsigncode');
  });

  it('keeps secret filenames fixed, so cleanup never has to guess', () => {
    expect(CERTIFICATE_FILENAME).toBe('signing-certificate.p12');
    expect(APPLE_API_KEY_FILENAME).toBe('notarisation-key.json');
  });
});
