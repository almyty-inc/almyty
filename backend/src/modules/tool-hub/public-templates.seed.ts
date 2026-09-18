import { Repository, IsNull } from 'typeorm';

import { ToolTemplate } from '../../entities/tool-template.entity';
import { ToolExecutionMethod } from '../../entities/tool.entity';

/**
 * The public catalogue: templates with `organizationId IS NULL`, which
 * every tenant sees.
 *
 * No HTTP route creates one -- publishing always stamps the caller's
 * organization -- because a tenant able to write the public catalogue is a
 * tenant able to put a tool of its choosing in front of every other
 * tenant. So the public rows come from here, applied by an operator with
 * database access via `npm run seed:tool-templates`.
 *
 * Everything in this list is a public, documented, keyless or
 * read-only-with-your-own-token API, and carries no header or query value
 * that is not a `{placeholder}` the installing organization fills in.
 */
export interface PublicTemplateSeed {
  name: string;
  description: string;
  provider: string;
  category: string;
  tags: string[];
  apiName: string;
  baseUrl: string;
  authType: 'none' | 'api_key' | 'bearer' | 'basic' | 'oauth2';
  setupInstructions?: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  queryParams?: Record<string, string>;
  parameters: Record<string, any>;
}

export const PUBLIC_TOOL_TEMPLATES: PublicTemplateSeed[] = [
  {
    name: 'Weather forecast',
    description:
      'Hourly and daily forecast for a WGS84 latitude/longitude. Keyless: Open-Meteo requires no credential for non-commercial use.',
    provider: 'Open-Meteo',
    category: 'weather',
    tags: ['weather', 'forecast', 'geo'],
    apiName: 'Open-Meteo',
    baseUrl: 'https://api.open-meteo.com',
    authType: 'none',
    method: 'GET',
    path: '/v1/forecast',
    queryParams: {
      latitude: '{latitude}',
      longitude: '{longitude}',
      current_weather: '{current_weather}',
    },
    parameters: {
      type: 'object',
      properties: {
        latitude: { type: 'number', description: 'WGS84 latitude, -90 to 90' },
        longitude: { type: 'number', description: 'WGS84 longitude, -180 to 180' },
        current_weather: {
          type: 'boolean',
          description: 'Include the current conditions block',
          default: true,
        },
      },
      required: ['latitude', 'longitude'],
    },
  },
  {
    name: 'Get a GitHub repository',
    description:
      'Read a repository: description, default branch, stars, topics, licence. Works unauthenticated at a low rate limit; a token raises it.',
    provider: 'GitHub',
    category: 'developer',
    tags: ['github', 'repository', 'source-control'],
    apiName: 'GitHub REST API',
    baseUrl: 'https://api.github.com',
    authType: 'bearer',
    setupInstructions:
      'Optional. Add a GitHub personal access token as a credential to raise the rate limit and read private repositories.',
    method: 'GET',
    path: '/repos/{owner}/{repo}',
    parameters: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Account or organization that owns the repository' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'Search Wikipedia',
    description: 'Full-text search of Wikipedia article titles and extracts. Keyless.',
    provider: 'Wikipedia',
    category: 'search',
    tags: ['wikipedia', 'search', 'reference'],
    apiName: 'Wikipedia API',
    baseUrl: 'https://en.wikipedia.org',
    authType: 'none',
    method: 'GET',
    path: '/w/api.php',
    queryParams: {
      action: 'query',
      list: 'search',
      format: 'json',
      srsearch: '{query}',
      srlimit: '{limit}',
    },
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search terms' },
        limit: { type: 'integer', description: 'Results to return', default: 10 },
      },
      required: ['query'],
    },
  },
];

function toRow(seed: PublicTemplateSeed): Partial<ToolTemplate> {
  return {
    name: seed.name,
    description: seed.description,
    provider: seed.provider,
    providerIcon: null,
    category: seed.category,
    tags: seed.tags,
    executionMethod: ToolExecutionMethod.HTTP,
    httpConfig: {
      method: seed.method,
      path: seed.path,
      ...(seed.queryParams ? { queryParams: seed.queryParams } : {}),
    },
    parameters: seed.parameters,
    configuration: {},
    examples: [],
    apiConfig: {
      name: seed.apiName,
      baseUrl: seed.baseUrl,
      authRequirements: {
        type: seed.authType,
        ...(seed.setupInstructions ? { setupInstructions: seed.setupInstructions } : {}),
      },
    },
    sdkConfig: null,
    sdkMap: null,
    isBuiltIn: true,
    organizationId: null,
    version: '1.0.0',
    createdBy: null,
    sourceToolId: null,
  };
}

/**
 * Apply the public catalogue.
 *
 * Idempotent, and safe to re-run: it matches on (name, organizationId IS
 * NULL), which the `tool_templates_public_name_uq` index makes unique, and
 * refreshes the definition in place. `installCount` is never touched, so
 * re-running does not reset what the catalogue has recorded, and rows an
 * operator added by hand and are not in this list are left alone -- this
 * seeder never deletes.
 */
export async function seedPublicToolTemplates(
  repository: Repository<ToolTemplate>,
  seeds: PublicTemplateSeed[] = PUBLIC_TOOL_TEMPLATES,
): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;

  for (const seed of seeds) {
    const row = toRow(seed);
    const existing = await repository.findOne({
      where: { name: seed.name, organizationId: IsNull() },
    });

    if (existing) {
      await repository.save({ ...existing, ...row, id: existing.id });
      updated += 1;
    } else {
      await repository.save(repository.create(row));
      created += 1;
    }
  }

  return { created, updated };
}
