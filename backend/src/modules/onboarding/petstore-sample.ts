/**
 * A small, self-contained OpenAPI 3 "Petstore" schema used to seed the
 * onboarding sample workspace. Kept intentionally tiny (three
 * operations) so tool generation is fast and the demo stays legible.
 */
export const PETSTORE_OPENAPI = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'Swagger Petstore', version: '1.0.0' },
  servers: [{ url: 'https://petstore.swagger.io/v1' }],
  paths: {
    '/pets': {
      get: {
        summary: 'List all pets',
        operationId: 'listPets',
        tags: ['pets'],
        parameters: [
          {
            name: 'limit',
            in: 'query',
            description: 'How many items to return at one time (max 100)',
            required: false,
            schema: { type: 'integer', format: 'int32' },
          },
        ],
        responses: {
          '200': {
            description: 'A paged array of pets',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/Pet' },
                },
              },
            },
          },
        },
      },
      post: {
        summary: 'Create a pet',
        operationId: 'createPets',
        tags: ['pets'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Pet' },
            },
          },
        },
        responses: { '201': { description: 'Null response' } },
      },
    },
    '/pets/{petId}': {
      get: {
        summary: 'Info for a specific pet',
        operationId: 'showPetById',
        tags: ['pets'],
        parameters: [
          {
            name: 'petId',
            in: 'path',
            required: true,
            description: 'The id of the pet to retrieve',
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            description: 'Expected response to a valid request',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Pet' },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Pet: {
        type: 'object',
        required: ['id', 'name'],
        properties: {
          id: { type: 'integer', format: 'int64' },
          name: { type: 'string' },
          tag: { type: 'string' },
        },
      },
    },
  },
});

/** Stamp written into every sample entity's `metadata` column. */
export const SAMPLE_METADATA = {
  sample: true,
  sampleWorkspace: 'petstore',
} as const;

export const SAMPLE_WORKSPACE_KEY = 'petstore';
