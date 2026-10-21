import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * A throwaway certificate authority and a server certificate it signed for
 * localhost / 127.0.0.1, made with the openssl CLI in a temp directory.
 * Nothing is checked in: the keys exist only for the test run.
 */
export interface TestCa {
  /** The CA certificate, PEM as openssl writes it. */
  caCert: string;
  /** Server certificate (signed by the CA) and its key, for https.createServer. */
  serverCert: string;
  serverKey: string;
}

function openssl(args: string[], cwd: string): void {
  execFileSync('openssl', args, { cwd, stdio: 'pipe' });
}

export function makeTestCa(commonName = 'almyty test CA'): TestCa {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'almyty-test-ca-'));
  try {
    fs.writeFileSync(path.join(dir, 'ca.cnf'), [
      '[req]', 'distinguished_name=dn', 'prompt=no', 'x509_extensions=v3',
      '[dn]', `CN=${commonName}`,
      '[v3]', 'basicConstraints=critical,CA:TRUE', 'keyUsage=critical,keyCertSign,cRLSign', 'subjectKeyIdentifier=hash',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'leaf.cnf'), [
      '[req]', 'distinguished_name=dn', 'prompt=no',
      '[dn]', 'CN=localhost',
      '[v3]', 'basicConstraints=CA:FALSE', 'keyUsage=critical,digitalSignature', 'extendedKeyUsage=serverAuth',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ].join('\n'));
    const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];
    openssl(['req', '-x509', ...ec, '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '3650', '-config', 'ca.cnf'], dir);
    openssl(['req', '-new', ...ec, '-keyout', 'leaf.key', '-out', 'leaf.csr', '-config', 'leaf.cnf'], dir);
    openssl(['x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-set_serial', '01', '-days', '3650', '-out', 'leaf.pem', '-extfile', 'leaf.cnf', '-extensions', 'v3'], dir);
    return {
      caCert: fs.readFileSync(path.join(dir, 'ca.pem'), 'utf8'),
      serverCert: fs.readFileSync(path.join(dir, 'leaf.pem'), 'utf8'),
      serverKey: fs.readFileSync(path.join(dir, 'leaf.key'), 'utf8'),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
