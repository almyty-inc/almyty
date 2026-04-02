import { SdkCodeAssemblerService } from '../sdk-code-assembler.service';
import { SdkConfig } from '../types';

describe('SdkCodeAssemblerService', () => {
  let assembler: SdkCodeAssemblerService;

  beforeEach(() => {
    assembler = new SdkCodeAssemblerService();
  });

  it('should assemble a simple require + function call', () => {
    const config: SdkConfig = {
      packageName: 'lodash',
      version: '^4.17.21',
      imports: [{ name: '_', isDefault: true }],
      call: {
        methodPath: '_.chunk',
        args: [
          { type: 'parameter', key: 'array' },
          { type: 'literal', value: 3 },
        ],
      },
    };

    const code = assembler.assemble(config);

    expect(code).toContain("const _ = require('lodash');");
    expect(code).toContain('_.chunk(');
    expect(code).toContain('parameters["array"]');
    expect(code).toContain('3');
    expect(code).toContain('return result;');
  });

  it('should assemble AWS command pattern: S3Client + PutObjectCommand', () => {
    const config: SdkConfig = {
      packageName: '@aws-sdk/client-s3',
      version: '^3.0.0',
      imports: [
        { name: 'S3Client', isDefault: false },
        { name: 'PutObjectCommand', isDefault: false },
      ],
      construct: {
        className: 'S3Client',
        args: [
          {
            type: 'object',
            properties: {
              region: { type: 'credential', key: 'aws_region' },
              credentials: {
                type: 'object',
                properties: {
                  accessKeyId: { type: 'credential', key: 'aws_access_key_id' },
                  secretAccessKey: { type: 'credential', key: 'aws_secret_access_key' },
                },
              },
            },
          },
        ],
      },
      call: {
        methodPath: 'send',
        args: [
          {
            type: 'class_instance',
            className: 'PutObjectCommand',
            args: [
              {
                type: 'object',
                properties: {
                  Bucket: { type: 'parameter', key: 'bucket' },
                  Key: { type: 'parameter', key: 'key' },
                  Body: { type: 'parameter', key: 'body' },
                },
              },
            ],
          },
        ],
      },
    };

    const code = assembler.assemble(config);

    expect(code).toContain(
      "const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');",
    );
    expect(code).toContain('const client = new S3Client(');
    expect(code).toContain('credentials["aws_region"]');
    expect(code).toContain('credentials["aws_access_key_id"]');
    expect(code).toContain('credentials["aws_secret_access_key"]');
    expect(code).toContain('new PutObjectCommand(');
    expect(code).toContain('parameters["bucket"]');
    expect(code).toContain('parameters["key"]');
    expect(code).toContain('parameters["body"]');
    expect(code).toContain('client.send(');
    expect(code).toContain('return result;');
  });

  it('should assemble chained API: Stripe customers.create', () => {
    const config: SdkConfig = {
      packageName: 'stripe',
      version: '^14.0.0',
      imports: [{ name: 'Stripe', isDefault: true }],
      construct: {
        className: 'Stripe',
        args: [{ type: 'credential', key: 'stripe_secret_key' }],
      },
      call: {
        methodPath: 'customers.create',
        args: [
          {
            type: 'object',
            properties: {
              email: { type: 'parameter', key: 'email' },
              name: { type: 'parameter', key: 'name' },
            },
          },
        ],
      },
    };

    const code = assembler.assemble(config);

    expect(code).toContain("const Stripe = require('stripe');");
    expect(code).toContain('const client = new Stripe(');
    expect(code).toContain('credentials["stripe_secret_key"]');
    expect(code).toContain('client.customers.create(');
    expect(code).toContain('parameters["email"]');
    expect(code).toContain('parameters["name"]');
  });

  it('should render literal values: numbers, strings, booleans, null', () => {
    const config: SdkConfig = {
      packageName: 'test-pkg',
      version: '1.0.0',
      imports: [{ name: 'doStuff', isDefault: false }],
      call: {
        methodPath: 'doStuff',
        args: [
          { type: 'literal', value: 42 },
          { type: 'literal', value: 'hello world' },
          { type: 'literal', value: true },
          { type: 'literal', value: false },
          { type: 'literal', value: null },
        ],
      },
    };

    const code = assembler.assemble(config);

    expect(code).toContain('42');
    expect(code).toContain('"hello world"');
    expect(code).toContain('true');
    expect(code).toContain('false');
    expect(code).toContain('null');
  });

  it('should render parameter references', () => {
    const config: SdkConfig = {
      packageName: 'test-pkg',
      version: '1.0.0',
      imports: [{ name: 'fn', isDefault: false }],
      call: {
        methodPath: 'fn',
        args: [
          { type: 'parameter', key: 'userId' },
          { type: 'parameter', key: 'page-number' },
        ],
      },
    };

    const code = assembler.assemble(config);

    expect(code).toContain('parameters["userId"]');
    expect(code).toContain('parameters["page-number"]');
  });

  it('should render credential references', () => {
    const config: SdkConfig = {
      packageName: 'test-pkg',
      version: '1.0.0',
      imports: [{ name: 'fn', isDefault: false }],
      call: {
        methodPath: 'fn',
        args: [{ type: 'credential', key: 'api_token' }],
      },
    };

    const code = assembler.assemble(config);

    expect(code).toContain('credentials["api_token"]');
  });

  it('should render deeply nested objects', () => {
    const config: SdkConfig = {
      packageName: 'test-pkg',
      version: '1.0.0',
      imports: [{ name: 'fn', isDefault: false }],
      call: {
        methodPath: 'fn',
        args: [
          {
            type: 'object',
            properties: {
              level1: {
                type: 'object',
                properties: {
                  level2: {
                    type: 'object',
                    properties: {
                      value: { type: 'literal', value: 'deep' },
                    },
                  },
                },
              },
            },
          },
        ],
      },
    };

    const code = assembler.assemble(config);

    expect(code).toContain('level1:');
    expect(code).toContain('level2:');
    expect(code).toContain('"deep"');
  });

  it('should render array values', () => {
    const config: SdkConfig = {
      packageName: 'test-pkg',
      version: '1.0.0',
      imports: [{ name: 'fn', isDefault: false }],
      call: {
        methodPath: 'fn',
        args: [
          {
            type: 'array',
            items: [
              { type: 'literal', value: 1 },
              { type: 'literal', value: 2 },
              { type: 'literal', value: 3 },
            ],
          },
        ],
      },
    };

    const code = assembler.assemble(config);

    expect(code).toContain('[1, 2, 3]');
  });

  it('should handle default export with const X = require(...)', () => {
    const config: SdkConfig = {
      packageName: 'axios',
      version: '^1.0.0',
      imports: [{ name: 'axios', isDefault: true }],
      call: {
        methodPath: 'axios.get',
        args: [{ type: 'parameter', key: 'url' }],
      },
    };

    const code = assembler.assemble(config);

    expect(code).toContain("const axios = require('axios');");
    // Should NOT have destructuring
    expect(code).not.toContain('const { axios }');
  });

  it('should produce valid JavaScript that can be parsed without syntax errors', () => {
    const configs: SdkConfig[] = [
      // Simple function
      {
        packageName: 'pkg',
        version: '1.0.0',
        imports: [{ name: 'fn', isDefault: false }],
        call: {
          methodPath: 'fn',
          args: [{ type: 'literal', value: 'hello' }],
        },
      },
      // AWS-style
      {
        packageName: '@aws-sdk/client-s3',
        version: '^3.0.0',
        imports: [
          { name: 'S3Client', isDefault: false },
          { name: 'GetObjectCommand', isDefault: false },
        ],
        construct: {
          className: 'S3Client',
          args: [
            {
              type: 'object',
              properties: {
                region: { type: 'literal', value: 'us-east-1' },
              },
            },
          ],
        },
        call: {
          methodPath: 'send',
          args: [
            {
              type: 'class_instance',
              className: 'GetObjectCommand',
              args: [
                {
                  type: 'object',
                  properties: {
                    Bucket: { type: 'parameter', key: 'bucket' },
                    Key: { type: 'parameter', key: 'key' },
                  },
                },
              ],
            },
          ],
        },
      },
      // Nested objects + arrays
      {
        packageName: 'complex',
        version: '1.0.0',
        imports: [{ name: 'doIt', isDefault: false }],
        call: {
          methodPath: 'doIt',
          args: [
            {
              type: 'object',
              properties: {
                tags: {
                  type: 'array',
                  items: [
                    { type: 'literal', value: 'a' },
                    { type: 'literal', value: 'b' },
                  ],
                },
                nested: {
                  type: 'object',
                  properties: {
                    flag: { type: 'literal', value: true },
                    count: { type: 'literal', value: 0 },
                  },
                },
              },
            },
          ],
        },
      },
    ];

    for (const config of configs) {
      const code = assembler.assemble(config);

      // Wrap in an async function since the generated code uses `await`
      // and provides `parameters` / `credentials` as globals
      const wrapped = `
        (async function() {
          const parameters = {};
          const credentials = {};
          const require = () => ({});
          ${code}
        })
      `;

      // new Function() will throw if there's a syntax error
      expect(() => new Function(wrapped)).not.toThrow();
    }
  });

  it('should handle mixed default and named imports', () => {
    const config: SdkConfig = {
      packageName: 'some-pkg',
      version: '1.0.0',
      imports: [
        { name: 'SomePkg', isDefault: true },
        { name: 'HelperA', isDefault: false },
        { name: 'HelperB', isDefault: false },
      ],
      construct: {
        className: 'SomePkg',
        args: [],
      },
      call: {
        methodPath: 'run',
        args: [],
      },
    };

    const code = assembler.assemble(config);

    expect(code).toContain("const SomePkg = require('some-pkg');");
    expect(code).toContain("const { HelperA, HelperB } = require('some-pkg');");
  });

  it('should render empty object and empty array', () => {
    const config: SdkConfig = {
      packageName: 'test-pkg',
      version: '1.0.0',
      imports: [{ name: 'fn', isDefault: false }],
      call: {
        methodPath: 'fn',
        args: [
          { type: 'object', properties: {} },
          { type: 'array', items: [] },
        ],
      },
    };

    const code = assembler.assemble(config);

    expect(code).toContain('{}');
    expect(code).toContain('[]');
  });
});
