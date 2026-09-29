import { assertAwsRegion, assertGcpLocation } from '../vendor-region';
import { EgressError } from '../safe-fetch';
import { VertexAdapter } from '../../../modules/model-deployments/adapters/vertex.adapter';
import { AwsBedrockImportAdapter } from '../../../modules/model-deployments/adapters/aws-bedrock-import.adapter';
import { SageMakerAdapter } from '../../../modules/model-deployments/adapters/sagemaker.adapter';
import { NebiusAdapter } from '../../../modules/model-deployments/adapters/nebius.adapter';

/**
 * A tenant-written value spliced into a vendor hostname decides the host
 * unless it is checked: `https://${location}-aiplatform.googleapis.com`
 * with location `169.254.169.254#` is a request to the metadata address.
 */
const HOSTILE = [
  '169.254.169.254#',
  'evil.example/',
  'localhost:6379/x?',
  'us-central1.evil.example',
  'us-east-1@evil.example',
  '',
];

describe('assertGcpLocation', () => {
  it.each(['us-central1', 'europe-west4', 'northamerica-northeast1', 'asia-south1'])('accepts %s', (loc) => {
    expect(assertGcpLocation(loc)).toBe(loc);
  });

  it.each(HOSTILE)('refuses %j', (loc) => {
    expect(() => assertGcpLocation(loc)).toThrow(EgressError);
  });

  it('holds on the Vertex adapter URL builder', () => {
    expect(VertexAdapter.base('europe-west4')).toBe('https://europe-west4-aiplatform.googleapis.com/v1');
    expect(() => VertexAdapter.base('169.254.169.254#')).toThrow(EgressError);
  });
});

describe('assertAwsRegion', () => {
  it.each(['us-east-1', 'eu-central-1', 'ap-southeast-2', 'us-gov-west-1'])('accepts %s', (region) => {
    expect(assertAwsRegion(region)).toBe(region);
  });

  it.each(HOSTILE)('refuses %j', (region) => {
    expect(() => assertAwsRegion(region)).toThrow(EgressError);
  });

  it('holds on the Bedrock and SageMaker URL builders', () => {
    expect(AwsBedrockImportAdapter.openAiBase('us-east-1')).toBe('https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1');
    expect(() => AwsBedrockImportAdapter.openAiBase('evil.example/#')).toThrow(EgressError);
    expect(() => SageMakerAdapter.invokeUrl('evil.example/#', 'ep')).toThrow(EgressError);
  });
});

describe('Nebius hosts from providerConfig', () => {
  it('accepts a Nebius host', () => {
    expect(NebiusAdapter.nebiusOrigin('https://api.tokenfactory.nebius.com/', 'apiHost')).toBe('https://api.tokenfactory.nebius.com');
  });

  it.each([
    'http://api.tokenfactory.nebius.com',
    'https://169.254.169.254',
    'https://internal.svc.cluster.local',
    'https://nebius.com.evil.example',
    'https://user:pass@api.tokenfactory.nebius.com',
    'not a url',
  ])('refuses %s', (value) => {
    expect(() => NebiusAdapter.nebiusOrigin(value, 'apiHost')).toThrow(/apiHost/);
  });
});
