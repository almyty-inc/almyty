import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * There is no register-endpoint path any more.
 *
 * A server someone runs by hand (vLLM, TGI, llama.cpp, a LiteLLM proxy) is
 * a `custom` LLM provider plus an ordinary card against it: POST
 * /llm-providers, then POST /models. The dedicated route was a second way
 * to write a provider row, with its own DTO, its own service method and its
 * own CLI command, and every one of those had to be kept in step with the
 * ordinary path by hand. This reads the sources as text so that bringing
 * any of them back fails here rather than quietly reopening that door.
 */
const BACKEND_SRC = join(__dirname, '..', '..', '..');
const REPO = join(BACKEND_SRC, '..', '..');

const read = (path: string) => readFileSync(path, 'utf8');

const SOURCES: Array<[string, string]> = [
  ['controller', join(BACKEND_SRC, 'modules/model-catalog/model-catalog.controller.ts')],
  ['service', join(BACKEND_SRC, 'modules/model-catalog/model-catalog.service.ts')],
  ['dto', join(BACKEND_SRC, 'modules/model-catalog/dto/model-catalog-controller.dto.ts')],
  ['models CLI', join(REPO, 'packages/models-cli/src/index.ts')],
];

describe('the register-endpoint path stays removed', () => {
  it.each(SOURCES)('%s names no register-endpoint route, method, DTO or command', (_label, path) => {
    const source = read(path);
    expect(source).not.toMatch(/register-endpoint/i);
    expect(source).not.toMatch(/registerEndpoint/i);
    expect(source).not.toMatch(/ENDPOINT_REGISTRATION_UNAVAILABLE/);
  });

  it('the catalog controller declares no POST route besides the ordinary ones', () => {
    const posts = [...read(SOURCES[0][1]).matchAll(/@Post\(\s*(?:'([^']*)')?\s*\)/g)].map((m) => m[1] ?? '');
    expect(posts.sort()).toEqual(['', ':id/validate', 'route-preview', 'sync']);
  });

  it('the catalog service no longer depends on the endpoint-provider helper', () => {
    expect(read(SOURCES[1][1])).not.toMatch(/EndpointProviderHelper/);
  });
});
