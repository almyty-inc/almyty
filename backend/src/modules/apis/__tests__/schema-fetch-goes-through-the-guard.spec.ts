import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * The SSRF guard existed, was tested, and one of the two entrances walked
 * around it.
 *
 * `ApisImportHelper.fetchSchemaFromUrl()` runs validateUrl, caps the
 * inbound body at 15 MB and refuses redirects, and the REST route
 * (apis.controller.ts importSchema) has always called it. The MCP tool
 * `import_schema` did its own `axios.get(args.schemaUrl, { timeout:
 * 30000 })` instead -- no validateUrl, no maxContentLength, no
 * maxRedirects -- so an MCP client could have the server fetch
 * http://169.254.169.254/ or a loopback admin port and read the body back
 * out of the queued job.
 *
 * Not a function with no callers, but the same family and the same cause:
 * a guarded path and an unguarded one for the same operation, with nothing
 * that notices when a new call site takes the second.
 *
 * What it guards:
 *   1. every production axios/fetch of a caller-supplied schema URL goes
 *      through the helper rather than straight out;
 *   2. the helper still carries all three protections.
 */
const SRC = join(__dirname, '..', '..', '..');

function productionFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === '__tests__' || name === 'test' || name === 'scripts') continue;
      productionFiles(p, out);
    } else if (name.endsWith('.ts') && !name.includes('.spec.')) {
      out.push(p);
    }
  }
  return out;
}
/** Comments stripped: the fixed file documents the bad call it replaced. */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('every schema fetch goes through the guarded helper', () => {
  it('nothing fetches a schemaUrl directly', () => {
    const offenders: string[] = [];
    for (const path of productionFiles(SRC)) {
      const src = stripComments(readFileSync(path, 'utf8'));
      // A caller-supplied schema URL handed straight to a transport.
      if (/(?:axios(?:\.get)?|fetch)\(\s*(?:String\()?\w*\.?schemaUrl/i.test(src)) {
        offenders.push(path.slice(SRC.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the MCP import_schema tool uses the helper', () => {
    const mcp = readFileSync(join(SRC, 'modules', 'mcp', 'almyty-mcp.service.ts'), 'utf8');
    expect(mcp).toContain('fetchSchemaFromUrl(String(args.schemaUrl))');
  });

  it('the helper gates, pins, caps and refuses redirects', () => {
    const helper = readFileSync(join(SRC, 'modules', 'apis', 'apis-import.helper.ts'), 'utf8');
    const start = helper.indexOf('async fetchSchemaFromUrl(');
    expect(start).toBeGreaterThan(-1);
    const body = helper.slice(start, helper.indexOf('\n  }', start));

    // `assertOutboundUrlAllowed` replaced a direct `validateUrl` call when
    // #696's mechanism moved in here: same string check underneath, plus
    // the uniform refusal that does not leak whether a host or port exists.
    expect(body).toContain('assertOutboundUrlAllowed(url)');
    expect(body).toContain('maxContentLength');
    expect(body).toContain('maxRedirects: 0');
    // The string gate is not enough on its own. A public name whose A
    // record answers 169.254.169.254 passes it, so the connection is
    // pinned too -- this is the half #696 found and the REST door lacked.
    expect(body).toContain('httpAgent: ssrfSafeHttpAgent');
    expect(body).toContain('httpsAgent: ssrfSafeHttpsAgent');
    // The refusal must come before the request, not after it.
    expect(body.indexOf('assertOutboundUrlAllowed(url)')).toBeLessThan(body.indexOf('axios.get('));
  });
});
